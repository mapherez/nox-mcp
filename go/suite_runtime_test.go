package noxmcp

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/auth"
)

func suiteFixture(t *testing.T) (JSON, SuiteVerificationOptions, *VerifiedSuiteIdentity) {
	t.Helper()
	data, e := Contracts.ReadFile("contracts/suite-conformance.json")
	if e != nil {
		t.Fatal(e)
	}
	var corpus JSON
	json.Unmarshal(data, &corpus)
	c := object(corpus["crypto"])
	options := suiteFixtureOptions(c)
	id, e := VerifySuiteToken(text(c["userToken"]), options)
	if e != nil {
		t.Fatal(e)
	}
	return c, options, id
}
func TestSuiteRuntimeEnforcesVerifiedPolicyAndHTTPControls(t *testing.T) {
	c, verification, id := suiteFixture(t)
	policy, _ := NewSuitePolicy([]string{"nox:inspect"}, true)
	var calls atomic.Int32
	expectedRequestID := ""
	waitStarted, waitEnded := make(chan struct{}), make(chan struct{})
	schema := &jsonschema.Schema{Type: "object"}
	tools := []Tool{}
	for _, name := range []string{"inspect", "unclassified"} {
		tools = append(tools, Tool{Name: name, Description: name, InputSchema: schema, OutputSchema: schema, Execute: func(ctx ExecutionContext, input map[string]any) (map[string]any, error) {
			calls.Add(1)
			if ctx.UserID != "user-1" {
				t.Error("signed subject lost")
			}
			if expectedRequestID != "" && (ctx.RequestID != expectedRequestID || time.Until(ctx.DeadlineAt) > 15*time.Second) {
				t.Error("HTTP execution controls lost")
			}
			if input["wait"] == true {
				close(waitStarted)
				<-ctx.Done()
				close(waitEnded)
				return nil, ctx.Err()
			}
			return input, nil
		}})
	}
	runtime, e := NewSuite(Options{AppID: "fixture", Name: "fixture", Version: "1", Tools: tools}, SuiteRuntimeOptions{Verification: func() SuiteVerificationOptions { return verification }, Policies: map[string]SuitePolicy{"inspect": policy}, Clock: func() time.Time { return verification.Now }, AdditionalScopes: func(_ string, input map[string]any, _ ExecutionContext) ([]string, error) {
		if input["write"] == true {
			return []string{"nox:write"}, nil
		}
		return nil, nil
	}})
	if e != nil {
		t.Fatal(e)
	}
	info, _ := SuiteTokenInfo(id)
	if _, e = runtime.Execute(context.Background(), "inspect", map[string]any{}, info); e != nil {
		t.Fatal(e)
	}
	originalIssuer := verification.Issuer
	verification.Issuer = "different-authority"
	if _, e = runtime.Execute(context.Background(), "inspect", map[string]any{}, info); e == nil {
		t.Fatal("verified identity from another authority accepted")
	}
	verification.Issuer = originalIssuer
	for _, fake := range []*auth.TokenInfo{nil, {UserID: "forged", Scopes: []string{"nox:inspect", "nox:write"}, Extra: map[string]any{suiteIdentityKey: map[string]any{"valid": true}}}} {
		if _, e = runtime.Execute(context.Background(), "inspect", map[string]any{}, fake); e == nil {
			t.Fatal("unverified grant accepted")
		}
	}
	if _, e = runtime.Execute(context.Background(), "inspect", map[string]any{"write": true}, info); e == nil {
		t.Fatal("dynamic policy bypassed")
	}
	if _, e = runtime.Execute(context.Background(), "unclassified", map[string]any{}, info); e == nil {
		t.Fatal("unclassified exposed")
	}
	if calls.Load() != 1 {
		t.Fatal("unauthorized executor ran")
	}

	private, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	verification.Now = time.Now()
	key := verification.Keys["fixture-es256"]
	key.X = base64.RawURLEncoding.EncodeToString(private.X.FillBytes(make([]byte, 32)))
	key.Y = base64.RawURLEncoding.EncodeToString(private.Y.FillBytes(make([]byte, 32)))
	verification.Keys = map[string]SuiteSigningKey{"fixture-es256": key}
	fresh := func(token string) string {
		parts := strings.Split(token, ".")
		b, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var claims JSON
		json.Unmarshal(b, &claims)
		claims["iat"] = verification.Now.Unix()
		claims["nbf"] = verification.Now.Unix()
		claims["exp"] = verification.Now.Unix() + 300
		b, _ = json.Marshal(claims)
		message := parts[0] + "." + base64.RawURLEncoding.EncodeToString(b)
		hash := sha256.Sum256([]byte(message))
		r, s, _ := ecdsa.Sign(rand.Reader, private, hash[:])
		signature := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
		return message + "." + base64.RawURLEncoding.EncodeToString(signature)
	}
	userToken, probeToken := fresh(text(c["userToken"])), fresh(text(c["probeToken"]))
	post := func(method, token string, headers map[string]string) *httptest.ResponseRecorder {
		body := `{"jsonrpc":"2.0","id":1,"method":"` + method + `","params":{}}`
		if method == "tools/call" {
			body = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"inspect","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}`
		}
		req := httptest.NewRequest("POST", "https://inventory.example.com/mcp", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Mcp-Protocol-Version", "2026-07-28")
		req.Header.Set("Mcp-Method", method)
		if method == "tools/call" {
			req.Header.Set("Mcp-Name", "inspect")
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res := httptest.NewRecorder()
		runtime.HTTPHandler().ServeHTTP(res, req)
		return res
	}
	if res := post("tools/list", probeToken, nil); res.Code != 403 {
		t.Fatalf("probe list: %d %s", res.Code, res.Body)
	}
	if res := post("tools/call", userToken, nil); res.Code != 400 {
		t.Fatalf("missing controls: %d %s", res.Code, res.Body)
	}
	controls := map[string]string{"Nox-Request-Id": "7e36db7f-c74e-4f74-ad55-f26b4f220965", "Nox-Timeout-Ms": "20000", "Nox-Deadline-At": time.Now().Add(20 * time.Second).UTC().Format(time.RFC3339Nano)}
	// RFC3339 transport profile admits at most millisecond precision.
	controls["Nox-Deadline-At"] = time.Now().Add(20 * time.Second).UTC().Format("2006-01-02T15:04:05.000Z")
	expectedRequestID = controls["Nox-Request-Id"]
	if res := post("tools/call", userToken, controls); res.Code != 200 {
		t.Fatalf("authorized call: %d %s", res.Code, res.Body)
	}
	if calls.Load() != 2 {
		t.Fatal("HTTP execution failed")
	}

	parent, cancelHTTP := context.WithCancel(context.Background())
	body := `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"inspect","arguments":{"wait":true},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}`
	request := httptest.NewRequest("POST", "https://inventory.example.com/mcp", strings.NewReader(body)).WithContext(parent)
	for key, value := range map[string]string{"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": "Bearer " + userToken, "Mcp-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "inspect"} {
		request.Header.Set(key, value)
	}
	for key, value := range controls {
		request.Header.Set(key, value)
	}
	completed := make(chan struct{})
	go func() { defer close(completed); runtime.HTTPHandler().ServeHTTP(httptest.NewRecorder(), request) }()
	select {
	case <-waitStarted:
	case <-time.After(time.Second):
		cancelHTTP()
		t.Fatal("HTTP executor did not start")
	}
	cancelHTTP()
	select {
	case <-waitEnded:
	case <-time.After(time.Second):
		t.Fatal("HTTP cancellation lost across native session")
	}
	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("cancelled HTTP exchange did not finish")
	}
}
func TestSuiteCacheCoalescesAndInvalidationBlocksLateRenewal(t *testing.T) {
	_, verification, id := suiteFixture(t)
	var now atomic.Int64
	now.Store(verification.Now.UnixMilli())
	cache, e := NewSuiteAuthorizationCache(SuiteCacheOptions{MaxEntries: 1, Now: func() time.Time { return time.UnixMilli(now.Load()) }})
	if e != nil {
		t.Fatal(e)
	}
	p := SuiteAuthorizationPartition{CredentialPartition: strings.Repeat("A", 43), Issuer: verification.Issuer, Audience: verification.Audience, GatewayServiceID: verification.GatewayServiceID, ServiceCredentialRevision: verification.ServiceCredentialRevision, ProductID: verification.ProductID, AssociationID: verification.AssociationID, RegistrationRevision: verification.RegistrationRevision}
	var loads atomic.Int32
	started := make(chan struct{})
	finish := make(chan struct{})
	load := func(context.Context) (*VerifiedSuiteIdentity, error) {
		if loads.Add(1) == 1 {
			close(started)
		}
		<-finish
		return id, nil
	}
	var group sync.WaitGroup
	for i := 0; i < 20; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, e := cache.Refresh(context.Background(), p, load); e != nil {
				t.Error(e)
			}
		}()
	}
	<-started
	close(finish)
	group.Wait()
	if loads.Load() != 1 {
		t.Fatal("refresh was not coalesced")
	}
	cache.Invalidate(SuiteInvalidation{All: true})
	pending := make(chan error, 1)
	started = make(chan struct{})
	finish = make(chan struct{})
	go func() {
		_, e := cache.Refresh(context.Background(), p, func(context.Context) (*VerifiedSuiteIdentity, error) { close(started); <-finish; return id, nil })
		pending <- e
	}()
	<-started
	cache.Invalidate(SuiteInvalidation{All: true})
	if _, e := cache.Refresh(context.Background(), p, load); e == nil || e.Error() != "CACHE_LIMIT" {
		t.Fatalf("pending bound: %v", e)
	}
	close(finish)
	if e := <-pending; e == nil || e.Error() != "AUTHORIZATION_INVALIDATED" {
		t.Fatalf("late commit: %v", e)
	}
	if cache.Stats().Entries != 0 {
		t.Fatal("late grant cached")
	}
	if _, e := cache.Refresh(context.Background(), p, func(context.Context) (*VerifiedSuiteIdentity, error) { return id, nil }); e != nil {
		t.Fatal(e)
	}
	now.Store(id.ExpiresAt().UnixMilli())
	if got, e := cache.Get(p); e != nil || got != nil {
		t.Fatalf("expired cache: %v %v", got, e)
	}
}
