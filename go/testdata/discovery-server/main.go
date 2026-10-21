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
	caps := &mcp.ServerCapabilities{}
	caps.AddExtension(nox.DiscoveryExtension, nox.DiscoveryCapability())
	server := mcp.NewServer(&mcp.Implementation{Name: "fixture", Version: "0.5.0"}, &mcp.ServerOptions{Capabilities: caps, SupportedProtocolVersions: []string{"2025-11-25", "2026-07-28"}})
	// Test-only late failure after committing a progress notification to SSE.
	must(mcp.AddReceivingCustomMethod(server, "test/stream-capability", func(ctx context.Context, ss *mcp.ServerSession, _ *mcp.ParamsBase) (*mcp.ResultBase, error) {
		if err := ss.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: "late", Progress: 1}); err != nil {
			return nil, err
		}
		data, _ := json.Marshal(nox.JSON{"requiredCapabilities": nox.JSON{"extensions": nox.JSON{nox.DiscoveryExtension: nox.JSON{"version": nox.DiscoveryVersion}}}})
		return nil, &jsonrpc.Error{Code: mcp.CodeMissingRequiredClientCapabilities, Message: "Missing required client capability", Data: data}
	}))
	server.AddTool(&tool, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input map[string]any
		_ = json.Unmarshal(req.Params.Arguments, &input)
		out := map[string]any{"name": input["id"]}
		bytes, _ := json.Marshal(out)
		return &mcp.CallToolResult{StructuredContent: out, Content: []mcp.Content{&mcp.TextContent{Text: string(bytes)}}}, nil
	})
	type policyKey struct{}
	must(nox.InstallDiscovery(server, nox.DiscoveryOptions{ServerID: "fixture", Descriptors: map[string]nox.JSON{tool.Name: cli}, ResolveView: func(ctx context.Context, _ *mcp.RequestExtra, _ []*mcp.Tool) (string, []string, []string, nox.JSON, error) {
		policy, _ := ctx.Value(policyKey{}).(string)
		if policy == "revoked" {
			return policy, []string{}, nil, nil, nil
		}
		if policy == "unavailable" {
			return policy, nil, []string{tool.Name}, nil, nil
		}
		return policy, nil, nil, nil, nil
	}}))
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
