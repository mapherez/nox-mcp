// Package noxmcp supplies native MCP registration, validation and execution policies.
package noxmcp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"slices"
	"time"
)

type Error struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Retryable bool           `json:"retryable"`
	Details   map[string]any `json:"details,omitempty"`
}

func (e *Error) Error() string            { return e.Message }
func failure(code, message string) *Error { return &Error{Code: code, Message: message} }

type ExecutionContext struct {
	context.Context
	RequestID, AppID, UserID string
	Scopes                   []string
	DeadlineAt               time.Time
}

// CheckActive must be called immediately before any mutation after asynchronous work.
func (c ExecutionContext) CheckActive() error { return c.Err() }

type Tool struct {
	Name, Title, Description          string
	InputSchema, OutputSchema         *jsonschema.Schema
	RequiredScopes                    []string
	ReadOnly, Destructive, Idempotent bool
	Execute                           func(ExecutionContext, map[string]any) (map[string]any, error)
}
type Options struct {
	AppID, Name, Version         string
	Timeout                      time.Duration
	MaxPayloadBytes, MaxInFlight int
	Tools                        []Tool
}
type compiledTool struct {
	definition    Tool
	input, output *jsonschema.Resolved
}
type Runtime struct {
	options Options
	tools   map[string]compiledTool
	slots   chan struct{}
	Server  *mcp.Server
}

func New(options Options) (*Runtime, error) {
	if options.AppID == "" || options.Name == "" {
		return nil, errors.New("app and server identity required")
	}
	if options.Timeout == 0 {
		options.Timeout = time.Duration(DefaultTimeoutMS) * time.Millisecond
	}
	if options.MaxPayloadBytes == 0 {
		options.MaxPayloadBytes = MaxPayloadBytes
	}
	if options.MaxInFlight == 0 {
		options.MaxInFlight = MaxInFlightRequests
	}
	if options.Timeout < 0 || options.MaxPayloadBytes < 1 || options.MaxInFlight < 1 {
		return nil, errors.New("invalid limits")
	}
	r := &Runtime{options: options, tools: map[string]compiledTool{}, slots: make(chan struct{}, options.MaxInFlight)}
	r.Server = mcp.NewServer(&mcp.Implementation{Name: options.Name, Version: options.Version}, &mcp.ServerOptions{SupportedProtocolVersions: []string{"2025-11-25", "2026-07-28"}})
	for _, t := range options.Tools {
		if t.Name == "" || len(t.Name) > 64 || t.Execute == nil || t.InputSchema == nil || t.OutputSchema == nil {
			return nil, errors.New("invalid tool")
		}
		if _, exists := r.tools[t.Name]; exists {
			return nil, errors.New("duplicate tool")
		}
		input, err := t.InputSchema.Resolve(nil)
		if err != nil {
			return nil, fmt.Errorf("input schema: %w", err)
		}
		output, err := t.OutputSchema.Resolve(nil)
		if err != nil {
			return nil, fmt.Errorf("output schema: %w", err)
		}
		r.tools[t.Name] = compiledTool{t, input, output}
		r.Server.AddTool(&mcp.Tool{Name: t.Name, Title: t.Title, Description: t.Description, InputSchema: t.InputSchema, OutputSchema: t.OutputSchema, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: t.ReadOnly, DestructiveHint: &t.Destructive, IdempotentHint: t.Idempotent}}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var input map[string]any
			if len(req.Params.Arguments) > r.options.MaxPayloadBytes || json.Unmarshal(req.Params.Arguments, &input) != nil {
				return result(failure("INVALID_INPUT", "Invalid input"), true), nil
			}
			identity := auth.TokenInfoFromContext(ctx)
			if req.Extra != nil && req.Extra.TokenInfo != nil {
				identity = req.Extra.TokenInfo
			}
			value, err := r.Execute(ctx, req.Params.Name, input, identity)
			if err != nil {
				var public *Error
				if !errors.As(err, &public) {
					public = failure("INTERNAL", "An internal error occurred")
				}
				return r.boundedResult(public, true), nil
			}
			return r.boundedResult(value, false), nil
		})
	}
	return r, nil
}
func result(value any, isError bool) *mcp.CallToolResult {
	data, _ := json.Marshal(value)
	return &mcp.CallToolResult{IsError: isError, StructuredContent: value, Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}
}
func (r *Runtime) boundedResult(value any, isError bool) *mcp.CallToolResult {
	response := result(value, isError)
	data, err := json.Marshal(response)
	if err != nil || len(data) > r.options.MaxPayloadBytes {
		return result(failure("INTERNAL", "Invalid or oversized tool result"), true)
	}
	return response
}
func (r *Runtime) Execute(parent context.Context, name string, input map[string]any, identity *auth.TokenInfo) (map[string]any, error) {
	t, exists := r.tools[name]
	if !exists {
		return nil, failure("INVALID_INPUT", "Unknown tool")
	}
	scopes := []string{}
	user := ""
	if identity != nil {
		scopes = identity.Scopes
		user = identity.UserID
	}
	for _, required := range t.definition.RequiredScopes {
		if !slices.Contains(scopes, required) {
			return nil, failure("FORBIDDEN", "The requested operation is not allowed")
		}
	}
	data, err := json.Marshal(input)
	if err != nil || len(data) > r.options.MaxPayloadBytes || t.input.Validate(input) != nil {
		return nil, failure("INVALID_INPUT", "Invalid input")
	}
	ctx, cancel := context.WithTimeout(parent, r.options.Timeout)
	defer cancel()
	if ctx.Err() != nil {
		return nil, failure("CANCELLED", "The request was cancelled")
	}
	select {
	case r.slots <- struct{}{}:
	default:
		return nil, &Error{Code: "OVERLOADED", Message: "Too many requests", Retryable: true}
	}
	deadline, _ := ctx.Deadline()
	id := make([]byte, 16)
	if _, err = rand.Read(id); err != nil {
		<-r.slots
		return nil, failure("INTERNAL", "An internal error occurred")
	}
	execution := ExecutionContext{ctx, hex.EncodeToString(id), r.options.AppID, user, slices.Clone(scopes), deadline}
	type outcome struct {
		value map[string]any
		err   error
	}
	completed := make(chan outcome, 1)
	go func() {
		defer func() { <-r.slots }()
		defer func() {
			if recover() != nil {
				completed <- outcome{err: failure("INTERNAL", "An internal error occurred")}
			}
		}()
		value, err := t.definition.Execute(execution, input)
		completed <- outcome{value, err}
	}()
	select {
	case <-ctx.Done():
		code := "CANCELLED"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			code = "TIMEOUT"
		}
		e := &Error{Code: code, Message: "The request ended before a confirmed result", Retryable: t.definition.ReadOnly}
		if !t.definition.ReadOnly {
			e.Details = map[string]any{"outcome": "unknown"}
		}
		return nil, e
	case out := <-completed:
		if ctx.Err() != nil {
			return nil, failure("CANCELLED", "The request was cancelled")
		}
		if out.err != nil {
			return nil, out.err
		}
		data, err := json.Marshal(out.value)
		if err != nil || len(data) > r.options.MaxPayloadBytes || t.output.Validate(out.value) != nil {
			return nil, failure("INTERNAL", "Invalid tool result")
		}
		return out.value, nil
	}
}
func (r *Runtime) HTTPHandler() http.Handler {
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return r.Server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		req.Body = http.MaxBytesReader(w, req.Body, int64(r.options.MaxPayloadBytes))
		handler.ServeHTTP(w, req)
	})
}
func (r *Runtime) ServeStdio(ctx context.Context) error {
	return r.Server.Run(ctx, &mcp.StdioTransport{})
}

// Protect requires an issuer-specific cryptographic verifier and an uncached live grant check.
func Protect(handler http.Handler, verify auth.TokenVerifier, isActive func(context.Context, *auth.TokenInfo) bool, metadataURL string) (http.Handler, error) {
	if verify == nil || isActive == nil {
		return nil, errors.New("token verifier and live authorization required")
	}
	return auth.RequireBearerToken(func(ctx context.Context, token string, req *http.Request) (*auth.TokenInfo, error) {
		info, err := verify(ctx, token, req)
		if err != nil || info == nil || !isActive(ctx, info) {
			return nil, auth.ErrInvalidToken
		}
		return info, nil
	}, &auth.RequireBearerTokenOptions{ResourceMetadataURL: metadataURL})(handler), nil
}
