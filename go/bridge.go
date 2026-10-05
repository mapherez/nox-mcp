package noxmcp

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/auth"
	"net/url"
	"sync"
	"time"
)

type BridgeOptions struct {
	URL, Ticket, AppVersion string
	Runtime                 *Runtime
	Identity                *auth.TokenInfo
}
type bridgeFrame struct {
	Type       string         `json:"type"`
	RequestID  string         `json:"requestId,omitempty"`
	Command    string         `json:"command,omitempty"`
	Input      map[string]any `json:"input,omitempty"`
	DeadlineAt string         `json:"deadlineAt,omitempty"`
}

// RunBridge makes a single connection. A caller may obtain a NEW ticket and reconnect;
// it must never replay requests. Disconnect cancels every execution from this generation.
func RunBridge(parent context.Context, options BridgeOptions) error {
	endpoint, err := url.Parse(options.URL)
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "wss" && !(endpoint.Scheme == "ws" && (endpoint.Hostname() == "127.0.0.1" || endpoint.Hostname() == "localhost" || endpoint.Hostname() == "::1"))) {
		return errors.New("secure bridge URL required")
	}
	if options.Runtime == nil || len(options.Ticket) < 32 || len(options.Ticket) > 512 || options.AppVersion == "" {
		return errors.New("bridge configuration required")
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, options.URL, nil)
	if err != nil {
		return errors.New("bridge connection failed")
	}
	defer conn.CloseNow()
	conn.SetReadLimit(int64(options.Runtime.options.MaxPayloadBytes))
	var writes sync.Mutex
	send := func(value any) error {
		data, err := json.Marshal(value)
		if err != nil || len(data) > options.Runtime.options.MaxPayloadBytes {
			return errors.New("bridge payload limit")
		}
		writes.Lock()
		defer writes.Unlock()
		writeCtx, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		return conn.Write(writeCtx, websocket.MessageText, data)
	}
	if err = send(map[string]any{"type": "authenticate", "ticket": options.Ticket}); err != nil {
		return errors.New("bridge authentication failed")
	}
	authCtx, stopAuth := context.WithTimeout(ctx, 8*time.Second)
	_, data, err := conn.Read(authCtx)
	stopAuth()
	if err != nil {
		return errors.New("bridge authentication failed")
	}
	var frame bridgeFrame
	if json.Unmarshal(data, &frame) != nil || frame.Type != "authenticated" {
		return errors.New("bridge authentication failed")
	}
	if err = send(map[string]any{"type": "ready", "protocolVersion": BridgeProtocolVersion, "appVersion": options.AppVersion}); err != nil {
		return errors.New("bridge ready failed")
	}
	var mu sync.Mutex
	active := map[string]context.CancelFunc{}
	seen := map[string]time.Time{}
	defer func() {
		mu.Lock()
		defer mu.Unlock()
		for _, stop := range active {
			stop()
		}
	}()
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			return errors.New("bridge disconnected")
		}
		if kind != websocket.MessageText || ValidateFrameWithLimit("server", data, options.Runtime.options.MaxPayloadBytes) != nil || json.Unmarshal(data, &frame) != nil {
			return errors.New("invalid bridge frame")
		}
		switch frame.Type {
		case "session_revoked":
			return errors.New("bridge session revoked")
		case "cancel":
			mu.Lock()
			if stop, ok := active[frame.RequestID]; ok {
				stop()
				delete(active, frame.RequestID)
			}
			mu.Unlock()
		case "request":
			deadline, err := time.Parse(time.RFC3339Nano, frame.DeadlineAt)
			if err != nil || !deadline.After(time.Now()) || frame.RequestID == "" {
				return errors.New("invalid bridge request")
			}
			mu.Lock()
			for id, end := range seen {
				if end.Before(time.Now()) {
					delete(seen, id)
				}
			}
			_, duplicate := seen[frame.RequestID]
			if duplicate || len(active) >= options.Runtime.options.MaxInFlight || len(seen) >= 4096 {
				mu.Unlock()
				return errors.New("duplicate or excessive bridge request")
			}
			requestCtx, stop := context.WithDeadline(ctx, deadline)
			active[frame.RequestID] = stop
			seen[frame.RequestID] = deadline
			mu.Unlock()
			request := frame
			go func() {
				defer stop()
				value, err := options.Runtime.Execute(requestCtx, request.Command, request.Input, options.Identity)
				mu.Lock()
				_, pending := active[request.RequestID]
				delete(active, request.RequestID)
				mu.Unlock()
				if !pending || requestCtx.Err() != nil {
					return
				}
				response := map[string]any{"type": "response", "requestId": request.RequestID, "ok": err == nil}
				if err == nil {
					response["result"] = value
				} else {
					var public *Error
					if !errors.As(err, &public) {
						public = failure("INTERNAL", "An internal error occurred")
					}
					response["error"] = public
				}
				if send(response) != nil {
					cancel()
				}
			}()
		default:
			return errors.New("unexpected bridge frame")
		}
	}
}

// CredentialStore keeps OS-specific secure storage outside the runtime.
type CredentialStore[T any] interface {
	Load(context.Context) (*T, error)
	Save(context.Context, T) error
	Delete(context.Context) error
}
