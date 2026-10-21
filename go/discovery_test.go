package noxmcp

import (
	"context"
	"encoding/json"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDiscoveryOfficialClient(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	caps := &mcp.ServerCapabilities{}
	caps.AddExtension(DiscoveryExtension, DiscoveryCapability())
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "0.5.0"}, &mcp.ServerOptions{Capabilities: caps, SupportedProtocolVersions: []string{DiscoveryProtocol}})
	c := discoveryCorpus(t)
	var tool mcp.Tool
	data, _ := json.Marshal(c["tool"])
	if e := json.Unmarshal(data, &tool); e != nil {
		t.Fatal(e)
	}
	server.AddTool(&tool, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{StructuredContent: JSON{"name": "ok"}}, nil
	})
	if e := InstallDiscovery(server, DiscoveryOptions{ServerID: "official-client", Descriptors: map[string]JSON{tool.Name: object(c["cli"])}, ResolveView: func(context.Context, *mcp.RequestExtra, []*mcp.Tool) (string, []string, []string, JSON, error) {
		return "authorized", nil, nil, nil, nil
	}}); e != nil {
		t.Fatal(e)
	}
	clientCaps := &mcp.ClientCapabilities{}
	clientCaps.AddExtension(DiscoveryExtension, JSON{"version": DiscoveryVersion})
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, &mcp.ClientOptions{Capabilities: clientCaps})
	if e := RegisterDiscoveryClient(client); e != nil {
		t.Fatal(e)
	}
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	cs, e := client.Connect(ctx, ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer cs.Close()
	cache, _ := NewDiscoveryCache("memory-test", "credential-a")
	if e := cache.Sync(ctx, DiscoverySessionRequest(cs)); e != nil {
		t.Fatal(e)
	}
	if len(cache.Definitions()) != 1 {
		t.Fatal("missing definition")
	}
	if e := cache.Sync(ctx, DiscoverySessionRequest(cs)); e != nil {
		t.Fatal(e)
	}
}

func discoveryCorpus(t *testing.T) JSON {
	t.Helper()
	data, e := Contracts.ReadFile("contracts/discovery-conformance.json")
	if e != nil {
		t.Fatal(e)
	}
	var c JSON
	if e = json.Unmarshal(data, &c); e != nil {
		t.Fatal(e)
	}
	return c
}
func discoveryTestView(c JSON) DiscoveryView {
	return DiscoveryView{ViewID: "user-a:policy-1", Definitions: []JSON{{"tool": jsonObject(c["tool"]), "cli": jsonObject(c["cli"])}}}
}
func TestSharedDiscoveryConformance(t *testing.T) {
	c := discoveryCorpus(t)
	report := JSON{"jcs": []any{}, "cli": []any{}, "schemas": []any{}}
	for _, v := range array(c["schemaCases"]) {
		fixture := object(v)
		valid := validateDiscovery(text(fixture["schema"]), fixture["data"]) == nil
		if valid != fixture["valid"] {
			t.Fatal(fixture)
		}
		report["schemas"] = append(array(report["schemas"]), valid)
	}
	for _, v := range array(c["jcs"]) {
		fixture := object(v)
		canonical, e := Canonicalize(fixture["input"])
		if e != nil || canonical != fixture["canonical"] {
			t.Fatalf("JCS %s != %s: %v", canonical, fixture["canonical"], e)
		}
		hash, e := Fingerprint(fixture["input"])
		if e != nil {
			t.Fatal(e)
		}
		report["jcs"] = append(array(report["jcs"]), JSON{"canonical": canonical, "hash": hash})
	}
	for _, v := range array(c["cliCases"]) {
		fixture := object(v)
		normalized, e := InterpretCLI(object(fixture["value"]))
		if (e == nil) != fixture["valid"] {
			t.Fatalf("%s: %v", fixture["name"], e)
		}
		if e != nil {
			report["cli"] = append(array(report["cli"]), JSON{"error": e.Error()})
		} else {
			report["cli"] = append(array(report["cli"]), normalized)
		}
	}
	s, _ := NewDiscovery("test-installation")
	view := discoveryTestView(c)
	initial, e := s.Catalog(view, nil)
	if e != nil {
		t.Fatal(e)
	}
	report["initial"] = initial
	defs, e := s.Definitions(view, JSON{"catalog": initial["catalog"], "tools": initial["tools"]})
	if e != nil {
		t.Fatal(e)
	}
	report["definitions"] = defs
	tool := object(view.Definitions[0]["tool"])
	tool["description"] = text(tool["description"]) + " Alterado."
	newTool := jsonObject(c["tool"])
	newTool["name"] = "new_tool"
	view.Definitions = append(view.Definitions, JSON{"tool": newTool})
	changed, e := s.Catalog(view, nil)
	if e != nil {
		t.Fatal(e)
	}
	report["changed"] = changed
	if path := os.Getenv("NOX_DISCOVERY_REPORT"); path != "" {
		data, _ := json.Marshal(report)
		if e := os.WriteFile(path, data, 0600); e != nil {
			t.Fatal(e)
		}
	}
}
func TestDiscoveryCacheAndFailures(t *testing.T) {
	c := discoveryCorpus(t)
	s, _ := NewDiscovery("srv")
	cache, _ := NewDiscoveryCache("trusted-origin", "credential-a")
	view := discoveryTestView(c)
	downloads := []string{}
	failRequest := false
	tamper := false
	request := func(_ context.Context, method string, p JSON) (JSON, error) {
		if method == "nox/tools/catalog" {
			p["limit"] = 1
			return s.Catalog(view, p)
		}
		if failRequest {
			return nil, discoveryError("DISCONNECTED")
		}
		for _, v := range array(jsonObject(p)["tools"]) {
			downloads = append(downloads, text(object(v)["name"]))
		}
		r, e := s.Definitions(view, p)
		if tamper && e == nil {
			r = jsonObject(r)
			object(object(array(r["definitions"])[0])["tool"])["description"] = "tampered"
		}
		return r, e
	}
	sync := func() {
		t.Helper()
		if e := cache.Sync(context.Background(), request); e != nil {
			t.Fatal(e)
		}
	}
	sync()
	if !reflect.DeepEqual(downloads, []string{"example_item_get"}) {
		t.Fatal(downloads)
	}
	downloads = nil
	sync()
	if len(downloads) != 0 {
		t.Fatal(downloads)
	}
	added := jsonObject(c["tool"])
	added["name"] = "added"
	view.Definitions = append(view.Definitions, JSON{"tool": added})
	sync()
	if !reflect.DeepEqual(downloads, []string{"added"}) {
		t.Fatal(downloads)
	}
	downloads = nil
	object(view.Definitions[0]["tool"])["description"] = "changed"
	sync()
	if !reflect.DeepEqual(downloads, []string{"example_item_get"}) {
		t.Fatal(downloads)
	}
	downloads = nil
	view.Definitions[0]["availability"] = "unavailable"
	sync()
	if len(downloads) != 0 {
		t.Fatal(downloads)
	}
	view.Definitions = view.Definitions[:1]
	sync()
	if len(cache.Definitions()) != 1 {
		t.Fatal("removed tool retained")
	}
	before := cache.Definitions()
	object(view.Definitions[0]["tool"])["description"] = "changed-again"
	failRequest = true
	if cache.Sync(context.Background(), request) == nil {
		t.Fatal("failure accepted")
	}
	if !reflect.DeepEqual(before, cache.Definitions()) {
		t.Fatal("partial commit")
	}
	failRequest = false
	tamper = true
	if e := cache.Sync(context.Background(), request); e == nil || !strings.Contains(e.Error(), "INVALID_FINGERPRINT") {
		t.Fatal(e)
	}
	tamper = false
	view.ViewID = "user-b"
	sync()
	if !reflect.DeepEqual(downloads[len(downloads)-1:], []string{"example_item_get"}) {
		t.Fatal(downloads)
	}
	view.ViewID = "revoked"
	view.Definitions = nil
	sync()
	if len(cache.Definitions()) != 0 {
		t.Fatal("revocation retained tools")
	}
}
func TestDiscoverySnapshotAuthorizationAndGuard(t *testing.T) {
	s, _ := NewDiscovery("srv")
	view := discoveryTestView(discoveryCorpus(t))
	catalog, e := s.Catalog(view, nil)
	if e != nil {
		t.Fatal(e)
	}
	wire := jsonObject(catalog)
	ref := object(array(wire["tools"])[0])
	name := text(ref["name"])
	if e := s.Guard(view, name, JSON{DiscoveryExtension: JSON{"expectedFingerprint": ref["fingerprint"]}}); e != nil {
		t.Fatal(e)
	}
	if e := s.Guard(view, name, JSON{DiscoveryExtension: JSON{"expectedFingerprint": "old"}}); e == nil || e.Error() != "STALE_DEFINITION" {
		t.Fatal(e)
	}
	view.ViewID = "revoked"
	view.Definitions = nil
	if _, e := s.Definitions(view, JSON{"catalog": catalog["catalog"], "tools": []any{ref}}); e == nil || e.Error() != "STALE_CATALOG" {
		t.Fatal(e)
	}
	if e := s.Guard(view, name, nil); e == nil || e.Error() != "FORBIDDEN" {
		t.Fatal(e)
	}
	if _, e := s.Catalog(view, JSON{"cursor": 1}); e == nil {
		t.Fatal("unbound cursor")
	}
	if _, e := s.Catalog(view, JSON{"unknown": true}); e == nil {
		t.Fatal("unknown field")
	}
	s.MaxBytes = 1
	if _, e := s.Catalog(view, nil); e == nil {
		t.Fatal("payload limit")
	}
}
