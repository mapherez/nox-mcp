package noxmcp

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestSharedRuntimeConformance(t *testing.T) {
	data, _ := Contracts.ReadFile("contracts/conformance.json")
	var corpus struct {
		RuntimeManifest map[string]any
		RuntimeCases    []struct {
			ID                                        string
			Input, Result                             map[string]any
			RequiredScopes, Grants, AppRequiredScopes []string
			Scope, Behavior                           string
			ReadOnly                                  *bool
			MaxPayloadBytes                           int
			Expect                                    map[string]any
		}
	}
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	report := []map[string]any{}
	for _, example := range corpus.RuntimeCases {
		t.Run(example.ID, func(t *testing.T) {
			encoded, _ := json.Marshal(corpus.RuntimeManifest)
			var manifest map[string]any
			json.Unmarshal(encoded, &manifest)
			tool := manifest["tools"].([]any)[0].(map[string]any)
			scopes := example.RequiredScopes
			if scopes == nil {
				scopes = []string{}
			}
			tool["requiredScopes"] = scopes
			if example.Scope != "" {
				tool["scope"] = example.Scope
			}
			readOnly := true
			if example.ReadOnly != nil {
				readOnly = *example.ReadOnly
			}
			tool["annotations"].(map[string]any)["readOnlyHint"] = readOnly
			encoded, _ = json.Marshal(manifest)
			started := make(chan struct{})
			var executed atomic.Bool
			runtime, err := NewFromManifest(Options{AppID: "conformance", Name: "conformance", Version: "1", Timeout: 30 * time.Millisecond, MaxPayloadBytes: example.MaxPayloadBytes, Tools: []Tool{{Name: "echo", RequiredScopes: example.AppRequiredScopes, Execute: func(ctx ExecutionContext, input map[string]any) (map[string]any, error) {
				close(started)
				executed.Store(true)
				if example.Behavior == "pre-cancel" {
					t.Error("pre-cancelled request executed")
				}
				if example.Behavior == "invalid-error" {
					return nil, &Error{Message: "Invalid error"}
				}
				if example.Behavior == "custom-error" {
					return nil, &Error{Code: "CONFLICT", Message: "Domain conflict", Details: map[string]any{"version": 2}}
				}
				if example.Behavior == "panic" {
					panic("PRIVATE SECRET")
				}
				if example.Behavior == "timeout" || example.Behavior == "cancel" {
					<-ctx.Done()
					return map[string]any{"value": "late"}, nil
				}
				if !reflect.DeepEqual(input, example.Input) {
					t.Error("input changed")
				}
				return example.Result, nil
			}}}}, encoded)
			if err != nil {
				t.Fatal(err)
			}
			discoveryCtx, discoveryCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer discoveryCancel()
			clientTransport, serverTransport := mcp.NewInMemoryTransports()
			serverSession, err := runtime.Server.Connect(discoveryCtx, serverTransport, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer serverSession.Close()
			client := mcp.NewClient(&mcp.Implementation{Name: "conformance", Version: "1"}, nil)
			clientSession, err := client.Connect(discoveryCtx, clientTransport, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer clientSession.Close()
			listed, err := clientSession.ListTools(discoveryCtx, nil)
			if err != nil {
				t.Fatal(err)
			}
			listedJSON, _ := json.Marshal(listed.Tools[0])
			var listedTool map[string]any
			json.Unmarshal(listedJSON, &listedTool)
			for _, key := range []string{"_meta", "inputSchema", "outputSchema"} {
				if !reflect.DeepEqual(listedTool[key], tool[key]) {
					t.Fatalf("discovery changed %s: %#v", key, listedTool[key])
				}
			}
			listedAnnotations := listedTool["annotations"].(map[string]any)
			declaredAnnotations := tool["annotations"].(map[string]any)
			for hint, fallback := range map[string]bool{"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": true} {
				actual, ok := listedAnnotations[hint]
				if !ok {
					actual = fallback
				}
				expected, ok := declaredAnnotations[hint]
				if !ok {
					expected = fallback
				}
				if actual != expected {
					t.Fatalf("annotation default changed: %s", hint)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if example.Behavior == "pre-cancel" {
				cancel()
			}
			if example.Behavior == "cancel" {
				go func() { <-started; cancel() }()
			}
			value, err := runtime.Execute(ctx, "echo", example.Input, &auth.TokenInfo{Scopes: example.Grants})
			var response any
			if err != nil {
				public, ok := err.(*Error)
				if !ok {
					public = failure("INTERNAL", "An internal error occurred")
				}
				response = runtime.boundedResult(public, true)
			} else {
				response = runtime.boundedResult(value, false)
			}
			bytes, _ := json.Marshal(response)
			var wire map[string]any
			json.Unmarshal(bytes, &wire)
			body := wire["structuredContent"].(map[string]any)
			var textBody any
			json.Unmarshal([]byte(wire["content"].([]any)[0].(map[string]any)["text"].(string)), &textBody)
			if !reflect.DeepEqual(textBody, body) {
				t.Fatal("text differs from structured result")
			}
			failed, _ := wire["isError"].(bool)
			actual := map[string]any{"id": example.ID, "isError": failed, "executed": executed.Load()}
			if failed {
				actual["code"] = body["code"]
				actual["retryable"] = body["retryable"]
				if details, ok := body["details"]; ok {
					actual["details"] = details
				}
				if strings.Contains(string(bytes), "PRIVATE SECRET") {
					t.Fatal("internal error leaked")
				}
			} else {
				actual["body"] = body
			}
			expected := example.Expect
			expected["id"] = example.ID
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("got %#v, want %#v", actual, expected)
			}
			report = append(report, actual)
		})
	}
	if file := os.Getenv("NOX_CONFORMANCE_REPORT"); file != "" {
		data, _ := json.Marshal(report)
		if err := os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
