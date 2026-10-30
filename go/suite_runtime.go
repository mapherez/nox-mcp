package noxmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const suiteIdentityKey = "nox.verified-suite-identity"
const suiteHTTPContextKey = "nox.suite-http-context"

type suiteControlsKey struct{}

// SuiteRuntimeOptions contains trusted local policy and trust snapshot callbacks.
type SuiteRuntimeOptions struct {
	Verification     func() SuiteVerificationOptions
	Policies         map[string]SuitePolicy
	LocalScopes      func(*VerifiedSuiteIdentity) []string
	IsActive         func(*VerifiedSuiteIdentity) bool
	AdditionalScopes func(string, map[string]any, ExecutionContext) ([]string, error)
	Clock            func() time.Time
}

func (c *SuiteRuntimeOptions) now() time.Time {
	if c.Clock != nil {
		return c.Clock()
	}
	return time.Now()
}
func SuiteTokenInfo(identity *VerifiedSuiteIdentity) (*auth.TokenInfo, error) {
	if identity == nil || !identity.valid {
		return nil, suiteFailure("INVALID_DELEGATION")
	}
	scopes := []string{}
	user := ""
	if identity.kind == "user" {
		for _, v := range array(identity.Context()["scopes"]) {
			scopes = append(scopes, text(v))
		}
		user = text(identity.context["userId"])
	}
	return &auth.TokenInfo{UserID: user, Scopes: scopes, Expiration: identity.ExpiresAt(), Extra: map[string]any{suiteIdentityKey: identity}}, nil
}
func suiteIdentity(info *auth.TokenInfo) *VerifiedSuiteIdentity {
	if info == nil {
		return nil
	}
	v, _ := info.Extra[suiteIdentityKey].(*VerifiedSuiteIdentity)
	return v
}
func (c *SuiteRuntimeOptions) grants(info *auth.TokenInfo, method string) (*VerifiedSuiteIdentity, []string, error) {
	identity := suiteIdentity(info)
	if e := RequireSuiteMethod(identity, method, c.now()); e != nil {
		return nil, nil, e
	}
	// A brand from another verifier is not authority for this configured runtime.
	// Recheck the token against this endpoint's current pinned trust snapshot.
	verification := c.Verification()
	verification.Now = c.now()
	var e error
	identity, e = VerifySuiteToken(identity.AccessToken(), verification)
	if e != nil {
		return nil, nil, e
	}
	if c.IsActive != nil && !c.IsActive(identity) {
		return nil, nil, suiteFailure("INVALID_DELEGATION")
	}
	scopes := []string{}
	if identity.kind == "user" {
		for _, v := range array(identity.Context()["scopes"]) {
			scopes = append(scopes, text(v))
		}
	}
	if c.LocalScopes != nil {
		for _, scope := range c.LocalScopes(identity) {
			if scope == "" || strings.HasPrefix(scope, "nox:") {
				return nil, nil, suiteFailure("INVALID_INTEGRATION")
			}
			scopes = append(scopes, scope)
		}
	}
	return identity, scopes, nil
}
func NewSuite(options Options, config SuiteRuntimeOptions, discovery ...DiscoveryOptions) (*Runtime, error) {
	if config.Verification == nil {
		return nil, errors.New("Suite verification snapshot required")
	}
	policies := map[string]SuitePolicy{}
	for name, p := range config.Policies {
		b, e := json.Marshal(p)
		if e != nil {
			return nil, e
		}
		p, e = LoadSuitePolicy(b)
		if e != nil {
			return nil, e
		}
		if p.ArgumentDependent && config.AdditionalScopes == nil {
			return nil, errors.New("argument-dependent policy requires AdditionalScopes")
		}
		policies[name] = p
	}
	config.Policies = policies
	classified := []Tool{}
	for _, tool := range options.Tools {
		policy, ok := policies[tool.Name]
		if !ok {
			continue
		}
		meta := map[string]any{}
		for k, v := range tool.Meta {
			meta[k] = v
		}
		p, _ := suiteDTOObject(policy)
		meta["nox/authorization"] = p
		tool.Meta = meta
		tool.RequiredScopes = append(slices.Clone(tool.RequiredScopes), policy.RequiredScopes...)
		classified = append(classified, tool)
	}
	options.Tools = classified
	d := DiscoveryOptions{ServerID: options.Name, ResolveView: func(context.Context, *mcp.RequestExtra, []*mcp.Tool) (string, []string, []string, JSON, error) {
		return "suite", nil, nil, nil, nil
	}}
	if len(discovery) > 0 {
		d = discovery[0]
	}
	original := d.ResolveView
	if original == nil {
		return nil, errors.New("discovery view resolver required")
	}
	d.ResolveView = func(ctx context.Context, extra *mcp.RequestExtra, tools []*mcp.Tool) (string, []string, []string, JSON, error) {
		if extra == nil {
			return "", nil, nil, nil, suiteFailure("INVALID_DELEGATION")
		}
		identity, scopes, e := config.grants(extra.TokenInfo, "tools/list")
		if e != nil {
			return "", nil, nil, nil, e
		}
		id, visible, unavailable, presentation, e := original(ctx, extra, tools)
		if e != nil {
			return "", nil, nil, nil, e
		}
		allowed := []string{}
		for _, tool := range options.Tools {
			if visible != nil && !slices.Contains(visible, tool.Name) {
				continue
			}
			if allSuiteScopes(scopes, tool.RequiredScopes) {
				allowed = append(allowed, tool.Name)
			}
		}
		partition, e := Fingerprint([]any{id, identity.claims["iss"], identity.context, scopes})
		return partition, allowed, unavailable, presentation, e
	}
	r, e := newRuntime(options, nil, &d)
	if e != nil {
		return nil, e
	}
	r.suite = &config
	r.Server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			var info *auth.TokenInfo
			if extra := req.GetExtra(); extra != nil {
				info = extra.TokenInfo
			}
			if _, _, e := config.grants(info, method); e != nil {
				return nil, e
			}
			return next(ctx, method, req)
		}
	})
	return r, nil
}
func allSuiteScopes(grants, required []string) bool {
	for _, s := range required {
		if !slices.Contains(grants, s) {
			return false
		}
	}
	return true
}
func (r *Runtime) suiteHTTPHandler(handler http.Handler) http.Handler {
	inner := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
			return
		}
		info := auth.TokenInfoFromContext(req.Context())
		identity := suiteIdentity(info)
		data, e := io.ReadAll(http.MaxBytesReader(w, req.Body, int64(r.options.MaxPayloadBytes)))
		if e != nil {
			http.Error(w, "payload_limit", 413)
			return
		}
		value, e := ParseSuiteJSONWithLimit(data, r.options.MaxPayloadBytes)
		if e != nil {
			http.Error(w, "invalid_request", 400)
			return
		}
		messages, ok := value.([]any)
		if !ok {
			messages = []any{value}
		}
		hasCall := false
		for _, raw := range messages {
			message := object(raw)
			method := text(message["method"])
			if method == "" {
				http.Error(w, "invalid_request", 400)
				return
			}
			if e = RequireSuiteMethod(identity, method, r.suite.now()); e != nil {
				http.Error(w, "forbidden", 403)
				return
			}
			hasCall = hasCall || method == "tools/call"
		}
		if hasCall {
			raw := req.Header.Get("Nox-Timeout-Ms")
			timeout, e := strconv.ParseInt(raw, 10, 64)
			if e != nil || strconv.FormatInt(timeout, 10) != raw {
				http.Error(w, "invalid_controls", 400)
				return
			}
			controls, e := SuiteRequestBudget(SuiteRequestControls{req.Header.Get("Nox-Request-Id"), req.Header.Get("Nox-Deadline-At"), timeout}, time.Now(), r.options.Timeout, SuiteClockSafetyMS*time.Millisecond)
			if e != nil {
				status := 400
				if e.Error() == "TIMEOUT" {
					status = 408
				}
				http.Error(w, e.Error(), status)
				return
			}
			deadline, _ := ParseSuiteTimestamp(controls.DeadlineAt)
			ctx, cancel := context.WithDeadline(req.Context(), deadline)
			defer cancel()
			ctx = context.WithValue(ctx, suiteControlsKey{}, controls)
			req = req.Clone(ctx)
			// The native transport may replace the HTTP context with a session
			// context; preserve the already shortened budget in request headers.
			req.Header.Set("Nox-Request-Id", controls.RequestID)
			req.Header.Set("Nox-Deadline-At", controls.DeadlineAt)
			req.Header.Set("Nox-Timeout-Ms", strconv.FormatInt(controls.TimeoutMS, 10))
		}
		req.Body = io.NopCloser(bytes.NewReader(data))
		info.Extra[suiteHTTPContextKey] = req.Context()
		handler.ServeHTTP(w, req)
	})
	return auth.RequireBearerToken(func(ctx context.Context, token string, req *http.Request) (*auth.TokenInfo, error) {
		options := r.suite.Verification()
		options.Now = r.suite.now()
		identity, e := VerifySuiteToken(token, options)
		if e != nil || r.suite.IsActive != nil && !r.suite.IsActive(identity) {
			return nil, auth.ErrInvalidToken
		}
		info, e := SuiteTokenInfo(identity)
		if e != nil {
			return nil, auth.ErrInvalidToken
		}
		return info, nil
	}, nil)(inner)
}

func (r *Runtime) suiteExecutionContext(parent context.Context, headers http.Header, identity *auth.TokenInfo) (context.Context, context.CancelFunc, error) {
	raw := headers.Get("Nox-Timeout-Ms")
	timeout, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || strconv.FormatInt(timeout, 10) != raw {
		return nil, nil, failure("INVALID_INPUT", "Invalid Suite request controls")
	}
	controls, err := SuiteRequestBudget(SuiteRequestControls{headers.Get("Nox-Request-Id"), headers.Get("Nox-Deadline-At"), timeout}, time.Now(), r.options.Timeout, 0)
	if err != nil {
		if err.Error() == "TIMEOUT" {
			return nil, nil, failure("TIMEOUT", "The request timed out")
		}
		return nil, nil, failure("INVALID_INPUT", "Invalid Suite request controls")
	}
	deadline, _ := ParseSuiteTimestamp(controls.DeadlineAt)
	ctx, cancel := context.WithDeadline(parent, deadline)
	stop := func() bool { return false }
	if identity != nil {
		if lifetime, ok := identity.Extra[suiteHTTPContextKey].(context.Context); ok {
			stop = context.AfterFunc(lifetime, func() {
				// The bounded native deadline supplies TIMEOUT; disconnects cancel.
				if lifetime.Err() != context.DeadlineExceeded {
					cancel()
				}
			})
		}
	}
	return context.WithValue(ctx, suiteControlsKey{}, controls), func() { stop(); cancel() }, nil
}
