// Test-only host. test/policy simulates a trusted host authorization resolver.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	nox "github.com/mapherez/nox-mcp/go"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net"
	"net/http"
	"os"
	"sync/atomic"
)

func main() {
	data, err := nox.Contracts.ReadFile("contracts/discovery-conformance.json")
	must(err)
	var c map[string]json.RawMessage
	must(json.Unmarshal(data, &c))
	var tool mcp.Tool
	must(json.Unmarshal(c["tool"], &tool))
	var cli nox.JSON
	must(json.Unmarshal(c["cli"], &cli))
	var executions atomic.Int64
	type policyKey struct{}
	manifest, _ := json.Marshal(nox.JSON{"schemaVersion": 1, "protocolVersion": "2.0", "tools": []json.RawMessage{c["tool"]}})
	runtime, err := nox.NewFromManifestWithDiscovery(nox.Options{AppID: "fixture", Name: "fixture", Version: "0.5.0", Tools: []nox.Tool{{Name: tool.Name, Execute: func(_ nox.ExecutionContext, input map[string]any) (map[string]any, error) {
		executions.Add(1)
		if input["id"] == "domain-error" {
			return nil, &nox.Error{Code: "CONFLICT", Message: "Visible domain error"}
		}
		return map[string]any{"name": input["id"]}, nil
	}}}}, manifest, nox.DiscoveryOptions{ServerID: "fixture", Descriptors: map[string]nox.JSON{tool.Name: cli}, ResolveView: func(ctx context.Context, _ *mcp.RequestExtra, _ []*mcp.Tool) (string, []string, []string, nox.JSON, error) {
		policy, _ := ctx.Value(policyKey{}).(string)
		if policy == "revoked" {
			return policy, []string{}, nil, nil, nil
		}
		if policy == "unavailable" {
			return policy, nil, []string{tool.Name}, nil, nil
		}
		return policy, nil, nil, nil, nil
	}})
	must(err)
	server := runtime.Server
	type counterResult struct {
		mcp.ResultBase
		Count int64 `json:"count"`
	}
	must(mcp.AddReceivingCustomMethod(server, "test/executions", func(context.Context, *mcp.ServerSession, *mcp.ParamsBase) (*counterResult, error) {
		return &counterResult{Count: executions.Load()}, nil
	}))
	// Test-only late failure after committing a progress notification to SSE.
	type lateParams struct {
		mcp.ParamsBase
		Code int `json:"code"`
	}
	must(mcp.AddReceivingCustomMethod(server, "test/stream-capability", func(ctx context.Context, ss *mcp.ServerSession, params *lateParams) (*mcp.ResultBase, error) {
		if err := ss.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: "late", Progress: 1}); err != nil {
			return nil, err
		}
		data, _ := json.Marshal(nox.JSON{"requiredCapabilities": nox.JSON{"extensions": nox.JSON{nox.DiscoveryExtension: nox.JSON{"version": nox.DiscoveryVersion}}}})
		code := params.Code
		if code == 0 {
			code = mcp.CodeMissingRequiredClientCapabilities
		}
		if code == mcp.CodeUnsupportedProtocolVersion {
			data, _ = json.Marshal(mcp.UnsupportedProtocolVersionData{Requested: "2099-01-01", Supported: []string{nox.DiscoveryProtocol}})
		} else if code != mcp.CodeMissingRequiredClientCapabilities {
			data = nil
		}
		return nil, &jsonrpc.Error{Code: int64(code), Message: "Test late protocol error", Data: data}
	}))
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			policy := "allowed"
			if params := req.GetParams(); params != nil {
				if p, ok := params.GetMeta()["test/policy"].(string); ok {
					policy = p
				}
			}
			return next(context.WithValue(ctx, policyKey{}, policy), method, req)
		}
	})
	if len(os.Args) > 1 && os.Args[1] == "--http" {
		listener, e := net.Listen("tcp", "127.0.0.1:0")
		must(e)
		fmt.Printf("http://%s/mcp\n", listener.Addr())
		sse := len(os.Args) > 2 && os.Args[2] == "--sse"
		must(http.Serve(listener, mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: !sse})))
	} else {
		must(server.Run(context.Background(), &mcp.StdioTransport{}))
	}
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
