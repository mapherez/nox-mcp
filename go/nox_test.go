package noxmcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestToolMetadata(t *testing.T) {
	metadata := map[string]any{
		"cli":    "resource create",
		"custom": map[string]any{"flags": []any{"one", "two"}, "enabled": true, "count": float64(2), "value": nil},
	}
	for _, tc := range []struct {
		name string
		meta map[string]any
	}{{"with metadata", metadata}, {"without metadata", nil}} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			schema := &jsonschema.Schema{Type: "object", Properties: map[string]*jsonschema.Schema{"value": {Type: "string"}}, Required: []string{"value"}}
			tool := Tool{
				Name: "create_something", Title: "Test tool", Description: "Test description", Meta: tc.meta,
				InputSchema: schema, OutputSchema: schema, ReadOnly: true, Idempotent: true,
				Execute: func(execution ExecutionContext, input map[string]any) (map[string]any, error) {
					if execution.AppID != "test" || execution.RequestID == "" || execution.Err() != nil {
						t.Error("execution context changed")
					}
					deadline, ok := execution.Deadline()
					if !ok || !deadline.Equal(execution.DeadlineAt) || time.Until(deadline) <= 0 || time.Until(deadline) > time.Second {
						t.Error("configured timeout was not preserved")
					}
					return map[string]any{"value": input["value"]}, nil
				},
			}
			secured := tool
			secured.Name = "secured"
			secured.RequiredScopes = []string{"resource:write"}
			runtime, err := New(Options{AppID: "test", Name: "test", Version: "1.0.0", Timeout: time.Second, Tools: []Tool{tool, secured}})
			if err != nil {
				t.Fatal(err)
			}
			clientTransport, serverTransport := mcp.NewInMemoryTransports()
			serverSession, err := runtime.Server.Connect(ctx, serverTransport, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer serverSession.Close()
			client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1.0.0"}, nil)
			session, err := client.Connect(ctx, clientTransport, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			listed, err := session.ListTools(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(listed.Tools) != 2 {
				t.Fatalf("got %d tools, want 2", len(listed.Tools))
			}
			var got *mcp.Tool
			for _, entry := range listed.Tools {
				if entry.Name == tool.Name {
					got = entry
				}
			}
			if got == nil {
				t.Fatal("tool missing from tools/list")
			}
			if !reflect.DeepEqual(map[string]any(got.Meta), tc.meta) {
				t.Fatalf("metadata = %#v, want %#v", got.Meta, tc.meta)
			}
			// Check the public JSON field as well as the client's decoded metadata.
			data, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var wire map[string]any
			if err := json.Unmarshal(data, &wire); err != nil {
				t.Fatal(err)
			}
			if tc.meta != nil {
				if !reflect.DeepEqual(wire["_meta"], tc.meta) || got.Meta["cli"] != "resource create" {
					t.Fatalf("_meta not preserved: %s", data)
				}
			} else if _, exists := wire["_meta"]; exists {
				t.Fatal("_meta should be omitted for tools without metadata")
			}
			want := &mcp.Tool{Name: tool.Name, Title: tool.Title, Description: tool.Description, InputSchema: schema, OutputSchema: schema,
				Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: &tool.Destructive, IdempotentHint: true}}
			wantJSON, err := json.Marshal(want)
			if err != nil {
				t.Fatal(err)
			}
			var wantWire map[string]any
			if err := json.Unmarshal(wantJSON, &wantWire); err != nil {
				t.Fatal(err)
			}
			delete(wire, "_meta")
			if !reflect.DeepEqual(wire, wantWire) {
				t.Fatalf("tool description, schemas or annotations changed: got %#v, want %#v", wire, wantWire)
			}
			input := map[string]any{"value": "hello"}
			result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: tool.Name, Arguments: input})
			if err != nil {
				t.Fatal(err)
			}
			if result.IsError || !reflect.DeepEqual(result.StructuredContent, input) || len(result.Content) != 1 {
				t.Fatalf("unexpected result: %#v", result)
			}
			if text, ok := result.Content[0].(*mcp.TextContent); !ok || text.Text != `{"value":"hello"}` {
				t.Fatalf("unexpected text result: %#v", result.Content)
			}
			for _, tc := range []struct {
				name, code string
				args       map[string]any
			}{{tool.Name, "INVALID_INPUT", map[string]any{}}, {secured.Name, "FORBIDDEN", input}} {
				response, err := session.CallTool(ctx, &mcp.CallToolParams{Name: tc.name, Arguments: tc.args})
				if err != nil {
					t.Fatal(err)
				}
				body, ok := response.StructuredContent.(map[string]any)
				if !response.IsError || !ok || body["code"] != tc.code {
					t.Fatalf("expected %s, got %#v", tc.code, response)
				}
			}
			_, err = runtime.Execute(ctx, secured.Name, input, &auth.TokenInfo{UserID: "user", Scopes: []string{"resource:write"}})
			if err != nil {
				t.Fatalf("authorized execution failed: %v", err)
			}
			cancelled, cancelRequest := context.WithCancel(ctx)
			cancelRequest()
			_, err = runtime.Execute(cancelled, tool.Name, input, nil)
			var public *Error
			if !errors.As(err, &public) || public.Code != "CANCELLED" {
				t.Fatalf("expected cancellation, got %v", err)
			}
		})
	}
}
