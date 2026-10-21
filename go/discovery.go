package noxmcp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"
	"unicode/utf8"
)

const DiscoveryExtension = "nox/discovery"
const DiscoveryVersion = "1.0"
const DiscoveryProtocol = "2026-07-28"

type JSON = map[string]any

func discoveryError(reason string) error { return fmt.Errorf("%s", reason) }
func DiscoveryMeta() JSON {
	return JSON{mcp.MetaKeyProtocolVersion: DiscoveryProtocol, mcp.MetaKeyClientCapabilities: JSON{"extensions": JSON{DiscoveryExtension: JSON{"version": DiscoveryVersion}}}}
}
func DiscoveryCapability() JSON {
	return JSON{"versions": []string{DiscoveryVersion}, "maxBatchSize": 64}
}
func jsonValue(value any) (any, error) {
	b, e := json.Marshal(value)
	if e != nil {
		return nil, e
	}
	var v any
	e = json.Unmarshal(b, &v)
	return v, e
}
func jsonObject(value any) JSON { v, _ := jsonValue(value); m, _ := v.(map[string]any); return m }
func array(value any) []any     { a, _ := value.([]any); return a }
func object(value any) JSON     { m, _ := value.(map[string]any); return m }
func text(value any) string     { s, _ := value.(string); return s }
func number(value any) int      { f, _ := value.(float64); return int(f) }
func utf16Less(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}
func checkJCSNative(v reflect.Value) error {
	if !v.IsValid() {
		return nil
	}
	switch v.Kind() {
	case reflect.Interface, reflect.Pointer:
		if !v.IsNil() {
			return checkJCSNative(v.Elem())
		}
	case reflect.String:
		if !utf8.ValidString(v.String()) {
			return discoveryError("INVALID_JCS")
		}
	case reflect.Map:
		for _, k := range v.MapKeys() {
			if e := checkJCSNative(k); e != nil {
				return e
			}
			if e := checkJCSNative(v.MapIndex(k)); e != nil {
				return e
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			if e := checkJCSNative(v.Index(i)); e != nil {
				return e
			}
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				if e := checkJCSNative(v.Field(i)); e != nil {
					return e
				}
			}
		}
	}
	return nil
}

// Canonicalize implements RFC 8785 UTF-16 ordering and ECMAScript number formatting.
func Canonicalize(value any) (string, error) {
	v, e := jsonValue(value)
	if e != nil {
		return "", e
	}
	if e := checkJCSNative(reflect.ValueOf(value)); e != nil {
		return "", e
	}
	var encode func(any) (string, error)
	quote := func(s string) (string, error) {
		if !utf8.ValidString(s) {
			return "", discoveryError("INVALID_JCS")
		}
		var b strings.Builder
		b.WriteByte('"')
		for _, r := range s {
			switch r {
			case '"':
				b.WriteString(`\"`)
			case '\\':
				b.WriteString(`\\`)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if r < 0x20 {
					fmt.Fprintf(&b, `\u%04x`, r)
				} else {
					b.WriteRune(r)
				}
			}
		}
		b.WriteByte('"')
		return b.String(), nil
	}
	encode = func(x any) (string, error) {
		switch t := x.(type) {
		case nil:
			return "null", nil
		case bool:
			return strconv.FormatBool(t), nil
		case string:
			return quote(t)
		case float64:
			if math.IsNaN(t) || math.IsInf(t, 0) {
				return "", discoveryError("INVALID_JCS")
			}
			if t == 0 {
				return "0", nil
			}
			format := byte('f')
			if math.Abs(t) < 1e-6 || math.Abs(t) >= 1e21 {
				format = 'e'
			}
			s := strconv.FormatFloat(t, format, -1, 64)
			if i := strings.IndexByte(s, 'e'); i >= 0 {
				exponent, _ := strconv.Atoi(s[i+1:])
				sign := ""
				if exponent >= 0 {
					sign = "+"
				}
				s = s[:i] + "e" + sign + strconv.Itoa(exponent)
			}
			return s, nil
		case []any:
			parts := []string{}
			for _, item := range t {
				s, e := encode(item)
				if e != nil {
					return "", e
				}
				parts = append(parts, s)
			}
			return "[" + strings.Join(parts, ",") + "]", nil
		case map[string]any:
			keys := []string{}
			for key := range t {
				keys = append(keys, key)
			}
			sort.Slice(keys, func(i, j int) bool {
				a, b := utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))
				for k := 0; k < len(a) && k < len(b); k++ {
					if a[k] != b[k] {
						return a[k] < b[k]
					}
				}
				return len(a) < len(b)
			})
			parts := []string{}
			for _, key := range keys {
				k, e := quote(key)
				if e != nil {
					return "", e
				}
				s, e := encode(t[key])
				if e != nil {
					return "", e
				}
				parts = append(parts, k+":"+s)
			}
			return "{" + strings.Join(parts, ",") + "}", nil
		}
		return "", discoveryError("INVALID_JCS")
	}
	return encode(v)
}
func Fingerprint(value any) (string, error) {
	s, e := Canonicalize(value)
	if e != nil {
		return "", e
	}
	h := sha256.Sum256([]byte(s))
	return base64.RawURLEncoding.EncodeToString(h[:]), nil
}
func validateDiscovery(schema string, value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return discoveryError("INVALID_DISCOVERY")
	}
	if ValidateFrameWithLimit(schema, b, 16*1024*1024) != nil {
		return discoveryError("INVALID_DISCOVERY")
	}
	return nil
}

// InterpretCLI validates and expands defaults; it does not execute a workflow.
func InterpretCLI(value JSON) (JSON, error) {
	if e := validateDiscovery("cli", value); e != nil {
		return nil, e
	}
	c := jsonObject(value)
	for _, v := range array(c["requires"]) {
		if !strings.Contains("|dynamic-options|preview|confirmation|workflow|", "|"+text(v)+"|") {
			return nil, discoveryError("UNSUPPORTED_FEATURE")
		}
	}
	if c["workflow"] != nil && (c["preview"] != nil || c["confirmation"] != nil) {
		return nil, discoveryError("INVALID_CLI")
	}
	source := func(v JSON) error {
		if v["input"] != nil && v["arguments"] != nil {
			return discoveryError("INVALID_CLI")
		}
		return nil
	}
	confirm := func(v JSON) error {
		if v["mode"] == "typed" {
			if _, ok := v["matchPointer"].(string); !ok {
				return discoveryError("INVALID_CLI")
			}
		}
		return nil
	}
	for _, v := range object(c["parameters"]) {
		p := object(v)
		if o := object(p["options"]); o != nil {
			if e := source(o); e != nil {
				return nil, e
			}
			if p["control"] == nil {
				p["control"] = "select"
			}
			for k, v := range (JSON{"itemsPointer": "/items", "valuePointer": "/id", "labelPointer": "/name"}) {
				if o[k] == nil {
					o[k] = v
				}
			}
		}
	}
	if e := source(object(c["preview"])); e != nil {
		return nil, e
	}
	if e := confirm(object(c["confirmation"])); e != nil {
		return nil, e
	}
	steps := map[string]bool{}
	for _, v := range array(c["workflow"]) {
		s := object(v)
		id := text(s["id"])
		if steps[id] {
			return nil, discoveryError("INVALID_CLI")
		}
		if e := source(s); e != nil {
			return nil, e
		}
		if s["type"] == "call" && s["tool"] == nil || s["type"] == "input" && s["parameters"] == nil || s["type"] == "confirm" && s["confirmation"] == nil {
			return nil, discoveryError("INVALID_CLI")
		}
		for _, v := range object(s["arguments"]) {
			b := object(v)
			if b["from"] == "step" && !steps[text(b["step"])] {
				return nil, discoveryError("INVALID_CLI")
			}
		}
		if e := confirm(object(s["confirmation"])); e != nil {
			return nil, e
		}
		steps[id] = true
	}
	return c, nil
}

type DiscoveryView struct {
	ViewID       string
	Definitions  []JSON
	Presentation JSON
}
type DiscoveryService struct {
	ServerID string
	TTLMS    int
	MaxBytes int
	mu       sync.Mutex
	hashes   map[string]discoveryHash
}
type discoveryHash struct {
	definition JSON
	hash       string
}

func NewDiscovery(serverID string) (*DiscoveryService, error) {
	if serverID == "" {
		return nil, discoveryError("INVALID_DISCOVERY")
	}
	return &DiscoveryService{ServerID: serverID, TTLMS: 30000, MaxBytes: 4 * 1024 * 1024, hashes: map[string]discoveryHash{}}, nil
}
func (s *DiscoveryService) snapshot(view DiscoveryView) ([]JSON, []JSON, string, error) {
	if view.ViewID == "" || s.ServerID == "" || s.TTLMS < 0 || s.MaxBytes < 1 {
		return nil, nil, "", discoveryError("INVALID_DISCOVERY")
	}
	defs := []JSON{}
	for _, v := range view.Definitions {
		d := jsonObject(v)
		if cli, present := d["cli"]; present && cli == nil {
			return nil, nil, "", discoveryError("INVALID_DISCOVERY")
		}
		if availability, present := d["availability"]; present && availability == nil {
			return nil, nil, "", discoveryError("INVALID_DISCOVERY")
		}
		if d["cli"] != nil {
			if _, e := InterpretCLI(object(d["cli"])); e != nil {
				return nil, nil, "", e
			}
		}
		if e := validateDiscovery("discovery-definitions", JSON{"resultType": "complete", "catalog": "check", "definitions": []any{JSON{"tool": d["tool"], "fingerprint": strings.Repeat("a", 43)}}}); e != nil {
			return nil, nil, "", e
		}
		defs = append(defs, d)
	}
	sort.Slice(defs, func(i, j int) bool {
		return utf16Less(text(object(defs[i]["tool"])["name"]), text(object(defs[j]["tool"])["name"]))
	})
	rows := []JSON{}
	seen := map[string]bool{}
	for _, d := range defs {
		name := text(object(d["tool"])["name"])
		if seen[name] {
			return nil, nil, "", discoveryError("INVALID_DISCOVERY")
		}
		seen[name] = true
		bundle := JSON{"tool": d["tool"]}
		if d["cli"] != nil {
			bundle["cli"] = d["cli"]
		}
		s.mu.Lock()
		if s.hashes == nil {
			s.hashes = map[string]discoveryHash{}
		}
		cached, exists := s.hashes[name]
		if !exists || !reflect.DeepEqual(cached.definition, bundle) {
			hash, err := Fingerprint(bundle)
			if err != nil {
				s.mu.Unlock()
				return nil, nil, "", err
			}
			cached = discoveryHash{jsonObject(bundle), hash}
			if len(s.hashes) >= 4096 {
				s.hashes = map[string]discoveryHash{}
			}
			s.hashes[name] = cached
		}
		s.mu.Unlock()
		hash := cached.hash
		row := JSON{"name": name, "fingerprint": hash}
		if a := d["availability"]; a != nil {
			if a != "available" && a != "unavailable" {
				return nil, nil, "", discoveryError("INVALID_DISCOVERY")
			}
			row["availability"] = a
		}
		rows = append(rows, row)
	}
	identity := JSON{"serverId": s.ServerID, "viewId": view.ViewID, "tools": rows}
	if view.Presentation != nil {
		identity["presentation"] = view.Presentation
	}
	hash, e := Fingerprint(identity)
	return defs, rows, hash, e
}
func (s *DiscoveryService) bounded(v JSON) (JSON, error) {
	b, e := json.Marshal(v)
	if e != nil || len(b) > s.MaxBytes {
		return nil, discoveryError("PAYLOAD_LIMIT")
	}
	return v, nil
}
func (s *DiscoveryService) Catalog(view DiscoveryView, params JSON) (JSON, error) {
	if params == nil {
		params = JSON{}
	}
	if e := validateDiscovery("discovery-catalog-request", params); e != nil {
		return nil, e
	}
	p := jsonObject(params)
	_, rows, hash, e := s.snapshot(view)
	if e != nil {
		return nil, e
	}
	result := JSON{"resultType": "complete", "serverId": s.ServerID, "viewId": view.ViewID, "catalog": hash, "ttlMs": s.TTLMS, "cacheScope": "private"}
	if p["catalog"] != nil && p["catalog"] != hash {
		return nil, discoveryError("STALE_CATALOG")
	}
	if p["cursor"] != nil && (p["catalog"] == nil || p["ifCatalog"] != nil) {
		return nil, discoveryError("INVALID_DISCOVERY")
	}
	if p["ifCatalog"] == hash {
		result["notModified"] = true
		return s.bounded(result)
	}
	cursor, limit := number(p["cursor"]), 1000
	if p["limit"] != nil {
		limit = number(p["limit"])
	}
	if cursor > len(rows) {
		return nil, discoveryError("INVALID_DISCOVERY")
	}
	end := min(cursor+limit, len(rows))
	result["tools"] = rows[cursor:end]
	if end < len(rows) {
		result["nextCursor"] = end
	}
	if view.Presentation != nil {
		result["presentation"] = view.Presentation
	}
	return s.bounded(result)
}
func (s *DiscoveryService) Definitions(view DiscoveryView, params JSON) (JSON, error) {
	if e := validateDiscovery("discovery-definitions-request", params); e != nil {
		return nil, e
	}
	p := jsonObject(params)
	defs, rows, hash, e := s.snapshot(view)
	if e != nil {
		return nil, e
	}
	if p["catalog"] != hash {
		return nil, discoveryError("STALE_CATALOG")
	}
	out := []JSON{}
	seen := map[string]bool{}
	for _, v := range array(p["tools"]) {
		ref := object(v)
		name := text(ref["name"])
		if seen[name] {
			return nil, discoveryError("INVALID_DISCOVERY")
		}
		seen[name] = true
		found := false
		for i, row := range rows {
			if row["name"] == name && row["fingerprint"] == ref["fingerprint"] {
				d := JSON{"tool": defs[i]["tool"], "fingerprint": row["fingerprint"]}
				if defs[i]["cli"] != nil {
					d["cli"] = defs[i]["cli"]
				}
				out = append(out, d)
				found = true
				break
			}
		}
		if !found {
			return nil, discoveryError("STALE_CATALOG")
		}
	}
	return s.bounded(JSON{"resultType": "complete", "catalog": hash, "definitions": out})
}
func (s *DiscoveryService) Guard(view DiscoveryView, name string, meta JSON) error {
	for _, d := range view.Definitions {
		if object(d["tool"])["name"] != name {
			continue
		}
		if d["availability"] == "unavailable" {
			return discoveryError("UNAVAILABLE")
		}
		if v, ok := meta[DiscoveryExtension]; ok {
			settings := object(v)
			bundle := JSON{"tool": d["tool"]}
			if d["cli"] != nil {
				bundle["cli"] = d["cli"]
			}
			hash, e := Fingerprint(bundle)
			if e != nil {
				return e
			}
			if settings == nil || settings["expectedFingerprint"] != hash {
				return discoveryError("STALE_DEFINITION")
			}
		}
		return nil
	}
	return discoveryError("FORBIDDEN")
}

type DiscoveryRequest func(context.Context, string, JSON) (JSON, error)
type DiscoveryCache struct {
	mu                          sync.Mutex
	Origin, CredentialPartition string
	catalog                     JSON
	definitions                 map[string]JSON
}

func NewDiscoveryCache(origin, partition string) (*DiscoveryCache, error) {
	if origin == "" || partition == "" {
		return nil, discoveryError("INVALID_DISCOVERY")
	}
	return &DiscoveryCache{Origin: origin, CredentialPartition: partition, definitions: map[string]JSON{}}, nil
}
func (c *DiscoveryCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.catalog = nil
	c.definitions = map[string]JSON{}
}
func (c *DiscoveryCache) Definitions() map[string]JSON {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := map[string]JSON{}
	for k, v := range c.definitions {
		out[k] = jsonObject(v)
	}
	return out
}
func (c *DiscoveryCache) Sync(ctx context.Context, request DiscoveryRequest) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	params := JSON{"_meta": DiscoveryMeta()}
	if c.catalog != nil {
		params["ifCatalog"] = c.catalog["catalog"]
	}
	first, e := request(ctx, "nox/tools/catalog", params)
	if e != nil {
		return e
	}
	if e = validateDiscovery("discovery-catalog", first); e != nil {
		return e
	}
	first = jsonObject(first)
	if first["notModified"] == true {
		if c.catalog == nil || first["catalog"] != c.catalog["catalog"] || first["serverId"] != c.catalog["serverId"] || first["viewId"] != c.catalog["viewId"] {
			return discoveryError("INVALID_DISCOVERY")
		}
		c.catalog["ttlMs"] = first["ttlMs"]
		return nil
	}
	entries := append([]any{}, array(first["tools"])...)
	page := first
	for page["nextCursor"] != nil {
		if number(page["nextCursor"]) != len(entries) || len(entries) > 100000 {
			return discoveryError("INVALID_DISCOVERY")
		}
		page, e = request(ctx, "nox/tools/catalog", JSON{"catalog": first["catalog"], "cursor": page["nextCursor"], "_meta": DiscoveryMeta()})
		if e != nil {
			return e
		}
		if e = validateDiscovery("discovery-catalog", page); e != nil {
			return e
		}
		page = jsonObject(page)
		if page["catalog"] != first["catalog"] || page["serverId"] != first["serverId"] || page["viewId"] != first["viewId"] || len(array(page["tools"])) == 0 {
			return discoveryError("STALE_CATALOG")
		}
		entries = append(entries, array(page["tools"])...)
	}
	same := c.catalog != nil && first["serverId"] == c.catalog["serverId"] && first["viewId"] == c.catalog["viewId"]
	identity := JSON{"serverId": first["serverId"], "viewId": first["viewId"], "tools": entries}
	if first["presentation"] != nil {
		identity["presentation"] = first["presentation"]
	}
	hash, err := Fingerprint(identity)
	if err != nil {
		return err
	}
	if hash != first["catalog"] {
		return discoveryError("INVALID_CATALOG")
	}
	next := map[string]JSON{}
	missing := []JSON{}
	seen := map[string]bool{}
	for _, v := range entries {
		ref := object(v)
		name := text(ref["name"])
		if seen[name] {
			return discoveryError("INVALID_DISCOVERY")
		}
		seen[name] = true
		if same && c.definitions[name] != nil && c.definitions[name]["fingerprint"] == ref["fingerprint"] {
			next[name] = c.definitions[name]
		} else {
			missing = append(missing, JSON{"name": name, "fingerprint": ref["fingerprint"]})
		}
	}
	for offset := 0; offset < len(missing); offset += 64 {
		batch := missing[offset:min(offset+64, len(missing))]
		r, e := request(ctx, "nox/tools/definitions", JSON{"catalog": first["catalog"], "tools": batch, "_meta": DiscoveryMeta()})
		if e != nil {
			return e
		}
		if e = validateDiscovery("discovery-definitions", r); e != nil {
			return e
		}
		r = jsonObject(r)
		if r["catalog"] != first["catalog"] || len(array(r["definitions"])) != len(batch) {
			return discoveryError("STALE_CATALOG")
		}
		for _, v := range array(r["definitions"]) {
			d := object(v)
			name := text(object(d["tool"])["name"])
			bundle := JSON{"tool": d["tool"]}
			if d["cli"] != nil {
				bundle["cli"] = d["cli"]
				if _, e := InterpretCLI(object(d["cli"])); e != nil {
					return e
				}
			}
			hash, e := Fingerprint(bundle)
			if e != nil {
				return e
			}
			valid := false
			for _, ref := range batch {
				if ref["name"] == name && ref["fingerprint"] == d["fingerprint"] {
					valid = true
				}
			}
			if !valid || next[name] != nil || hash != d["fingerprint"] {
				return discoveryError("INVALID_FINGERPRINT")
			}
			next[name] = jsonObject(d)
		}
	}
	first["tools"] = entries
	delete(first, "nextCursor")
	c.catalog = first
	c.definitions = next
	return nil
}

type DiscoveryOptions struct {
	ServerID    string
	Service     *DiscoveryService
	Descriptors map[string]JSON
	ResolveView func(context.Context, *mcp.RequestExtra, []*mcp.Tool) (viewID string, visible, unavailable []string, presentation JSON, err error)
}
type discoveryParams struct {
	raw JSON
	mcp.ParamsBase
	IfCatalog string `json:"ifCatalog,omitempty"`
	Catalog   string `json:"catalog,omitempty"`
	Cursor    *int   `json:"cursor,omitempty"`
	Limit     *int   `json:"limit,omitempty"`
	Tools     []JSON `json:"tools,omitempty"`
}

func (p *discoveryParams) UnmarshalJSON(data []byte) error {
	type plain discoveryParams
	if err := json.Unmarshal(data, (*plain)(p)); err != nil {
		return err
	}
	var raw JSON
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	p.raw = raw
	return nil
}
func (p discoveryParams) MarshalJSON() ([]byte, error) {
	if p.raw != nil {
		copy := jsonObject(p.raw)
		if p.Meta != nil {
			copy["_meta"] = p.Meta
		}
		return json.Marshal(copy)
	}
	type plain discoveryParams
	return json.Marshal(plain(p))
}

type discoveryResult struct {
	mcp.ResultBase
	Data JSON
}

func (r *discoveryResult) UnmarshalJSON(data []byte) error { return json.Unmarshal(data, &r.Data) }

// RegisterDiscoveryClient enables the custom methods on an official Go MCP client.
func RegisterDiscoveryClient(client *mcp.Client) error {
	for _, method := range []string{"nox/tools/catalog", "nox/tools/definitions"} {
		if err := mcp.AddSendingCustomMethod[*discoveryParams, *discoveryResult](client, method); err != nil {
			return err
		}
	}
	return nil
}
func DiscoverySessionRequest(session *mcp.ClientSession) DiscoveryRequest {
	return func(ctx context.Context, method string, params JSON) (JSON, error) {
		p := &discoveryParams{}
		data, err := json.Marshal(params)
		if err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, p); err != nil {
			return nil, err
		}
		r, err := mcp.CallCustomMethod[*discoveryParams, *discoveryResult](ctx, session, method, p)
		if err != nil {
			return nil, err
		}
		return r.Data, nil
	}
}

// InstallDiscovery also supports applications registering tools directly on mcp.Server.
// Configure DiscoveryCapability in ServerOptions.Capabilities before constructing that server.
func InstallDiscovery(server *mcp.Server, options DiscoveryOptions) error {
	return installDiscovery(server, options)
}

func (r *discoveryResult) MarshalJSON() ([]byte, error) { return json.Marshal(r.Data) }
func NewWithDiscovery(options Options, discovery DiscoveryOptions) (*Runtime, error) {
	return newRuntime(options, nil, &discovery)
}
func installDiscovery(server *mcp.Server, options DiscoveryOptions) error {
	service := options.Service
	if service == nil {
		var err error
		service, err = NewDiscovery(options.ServerID)
		if err != nil {
			return err
		}
	}
	if service.ServerID != options.ServerID {
		return discoveryError("INVALID_DISCOVERY")
	}
	if options.ResolveView == nil {
		return errors.New("discovery authorization view resolver required")
	}
	for _, cli := range options.Descriptors {
		if _, e := InterpretCLI(cli); e != nil {
			return e
		}
	}
	for _, method := range []string{"nox/tools/catalog", "nox/tools/definitions"} {
		if e := mcp.AddReceivingCustomMethod(server, method, func(context.Context, *mcp.ServerSession, *discoveryParams) (*discoveryResult, error) {
			return nil, discoveryError("INVALID_DISCOVERY")
		}); e != nil {
			return e
		}
	}
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			extension := method == "nox/tools/catalog" || method == "nox/tools/definitions"
			if !extension && method != "tools/list" && method != "tools/call" {
				return next(ctx, method, req)
			}
			wireError := func(e error) (mcp.Result, error) {
				return nil, &jsonrpc.Error{Code: -32602, Message: e.Error(), Data: json.RawMessage(fmt.Sprintf(`{"reason":%q}`, e.Error()))}
			}
			params := jsonObject(req.GetParams())
			if extension {
				meta := object(params["_meta"])
				settings := object(object(object(meta[mcp.MetaKeyClientCapabilities])["extensions"])[DiscoveryExtension])
				// Protocol support is checked by the SDK before dispatch. Keep the
				// existing fallback for supported legacy protocols separate.
				if meta[mcp.MetaKeyProtocolVersion] != DiscoveryProtocol {
					return wireError(discoveryError("EXTENSION_NOT_NEGOTIATED"))
				}
				if object(meta[mcp.MetaKeyClientCapabilities]) == nil {
					return wireError(discoveryError("INVALID_DISCOVERY"))
				}
				if settings["version"] != DiscoveryVersion {
					required := &mcp.ClientCapabilities{}
					required.AddExtension(DiscoveryExtension, JSON{"version": DiscoveryVersion})
					// SDK 1.8 serializes the deprecated Roots struct as roots:{}.
					// Require only the extension, not an additional roots capability.
					data, _ := json.Marshal(JSON{"requiredCapabilities": JSON{"extensions": required.Extensions}})
					return nil, &jsonrpc.Error{Code: mcp.CodeMissingRequiredClientCapabilities, Message: "Missing required client capability", Data: data}
				}
			}
			ss := req.GetSession().(*mcp.ServerSession)
			tools := []*mcp.Tool{}
			cursor := ""
			for {
				result, e := next(ctx, "tools/list", &mcp.ListToolsRequest{Session: ss, Params: &mcp.ListToolsParams{Cursor: cursor}, Extra: req.GetExtra()})
				if e != nil {
					return nil, e
				}
				list := result.(*mcp.ListToolsResult)
				tools = append(tools, list.Tools...)
				if list.NextCursor == "" {
					break
				}
				cursor = list.NextCursor
			}
			id, visible, unavailable, presentation, e := options.ResolveView(ctx, req.GetExtra(), tools)
			if e != nil {
				return wireError(discoveryError("FORBIDDEN"))
			}
			view := DiscoveryView{ViewID: id, Presentation: presentation, Definitions: []JSON{}}
			filtered := []*mcp.Tool{}
			contains := func(a []string, s string) bool {
				for _, v := range a {
					if v == s {
						return true
					}
				}
				return false
			}
			for _, tool := range tools {
				if visible != nil && !contains(visible, tool.Name) {
					continue
				}
				filtered = append(filtered, tool)
				d := JSON{"tool": jsonObject(tool)}
				if cli := options.Descriptors[tool.Name]; cli != nil {
					d["cli"] = cli
				}
				if contains(unavailable, tool.Name) {
					d["availability"] = "unavailable"
				}
				view.Definitions = append(view.Definitions, d)
			}
			if method == "tools/list" {
				// Keep the SDK's cursor, cache hints and result fields. Filter the
				// requested standard page; only the extension aggregates a snapshot.
				result, err := next(ctx, method, req)
				if err != nil {
					return nil, err
				}
				page := *result.(*mcp.ListToolsResult)
				page.Tools = []*mcp.Tool{}
				allowed := map[string]bool{}
				for _, t := range filtered {
					allowed[t.Name] = true
				}
				for _, t := range result.(*mcp.ListToolsResult).Tools {
					if allowed[t.Name] {
						page.Tools = append(page.Tools, t)
					}
				}
				return &page, nil
			}
			if method == "tools/call" {
				if e := service.Guard(view, text(params["name"]), object(params["_meta"])); e != nil {
					return wireError(e)
				}
				return next(ctx, method, req)
			}
			var result JSON
			if method == "nox/tools/catalog" {
				result, e = service.Catalog(view, params)
			} else {
				result, e = service.Definitions(view, params)
			}
			if e != nil {
				return wireError(e)
			}
			return &discoveryResult{Data: result}, nil
		}
	})
	return nil
}
