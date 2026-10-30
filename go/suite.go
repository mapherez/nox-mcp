// Shared Suite contracts. Issuance, networking and durable state belong to hosts.
package noxmcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

type SuiteError struct{ Code string }

func (e *SuiteError) Error() string  { return e.Code }
func suiteFailure(code string) error { return &SuiteError{code} }
func SuiteCapabilities() []string    { return []string{"nox:inspect", "nox:write", "nox:sensitive-read"} }

var suiteIDPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func ValidSuiteProductID(value string) bool {
	return len(value) > 0 && len(value) <= 64 && suiteIDPattern.MatchString(value)
}

// ParseSuiteJSON rejects duplicate keys, invalid Unicode, trailing data and
// excessive depth before ordinary JSON decoding could erase their meaning.
func ParseSuiteJSON(data []byte) (any, error) {
	return ParseSuiteJSONWithLimit(data, SuiteMaxPayloadBytes)
}
func ParseSuiteJSONWithLimit(data []byte, maxBytes int) (any, error) {
	if maxBytes <= 0 || len(data) > maxBytes || !utf8.Valid(data) || !suiteValidUnicode(data) {
		return nil, suiteFailure("INVALID_INTEGRATION")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		if depth > SuiteMaxDocumentDepth {
			return nil, suiteFailure("INVALID_INTEGRATION")
		}
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if delimiter, ok := token.(json.Delim); ok {
			switch delimiter {
			case '{':
				value := map[string]any{}
				for decoder.More() {
					keyToken, e := decoder.Token()
					if e != nil {
						return nil, e
					}
					key, ok := keyToken.(string)
					if !ok {
						return nil, suiteFailure("INVALID_INTEGRATION")
					}
					if _, found := value[key]; found {
						return nil, suiteFailure("INVALID_INTEGRATION")
					}
					child, e := read(depth + 1)
					if e != nil {
						return nil, e
					}
					value[key] = child
				}
				end, e := decoder.Token()
				if e != nil || end != json.Delim('}') {
					return nil, suiteFailure("INVALID_INTEGRATION")
				}
				return value, nil
			case '[':
				value := []any{}
				for decoder.More() {
					child, e := read(depth + 1)
					if e != nil {
						return nil, e
					}
					value = append(value, child)
				}
				end, e := decoder.Token()
				if e != nil || end != json.Delim(']') {
					return nil, suiteFailure("INVALID_INTEGRATION")
				}
				return value, nil
			default:
				return nil, suiteFailure("INVALID_INTEGRATION")
			}
		}
		return token, nil
	}
	value, err := read(0)
	if err != nil {
		return nil, suiteFailure("INVALID_INTEGRATION")
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, suiteFailure("INVALID_INTEGRATION")
	}
	return value, nil
}
func suiteValidUnicode(data []byte) bool {
	inString := false
	for i := 0; i < len(data); i++ {
		if data[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return false
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return false
		}
		v, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if v >= 0xdc00 && v <= 0xdfff {
			return false
		}
		if v >= 0xd800 && v <= 0xdbff {
			if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
				return false
			}
			low, e := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
			if e != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}

var suiteOriginPattern = regexp.MustCompile(`(?i)^https://(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?/?$`)
var suiteLabelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
var suiteNumericPattern = regexp.MustCompile(`^[0-9.]+$`)
var suiteDecimalPattern = regexp.MustCompile(`^[0-9]+$`)
var suiteHexHostPattern = regexp.MustCompile(`^0x[0-9a-f]+$`)

func NormalizeSuiteOrigin(input string) (string, error) {
	invalid := func() (string, error) { return "", suiteFailure("INVALID_ORIGIN") }
	if len(input) > 2048 {
		return invalid()
	}
	for _, c := range input {
		if c < 0x21 || c > 0x7e {
			return invalid()
		}
	}
	m := suiteOriginPattern.FindStringSubmatch(input)
	if m == nil {
		return invalid()
	}
	host := strings.ToLower(m[1])
	port := m[2]
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port {
			return invalid()
		}
	}
	if strings.HasPrefix(host, "[") {
		ip, err := netip.ParseAddr(host[1 : len(host)-1])
		if err != nil || !ip.Is6() {
			return invalid()
		}
		host = "[" + suiteIPv6(ip.As16()) + "]"
	} else if suiteNumericPattern.MatchString(host) {
		ip, err := netip.ParseAddr(host)
		if err != nil || !ip.Is4() {
			return invalid()
		}
	} else {
		labels := strings.Split(host, ".")
		if len(host) > 253 {
			return invalid()
		}
		if suiteDecimalPattern.MatchString(labels[len(labels)-1]) {
			return invalid()
		}
		if suiteHexHostPattern.MatchString(host) {
			return invalid()
		}
		for _, label := range labels {
			if len(label) > 63 || !suiteLabelPattern.MatchString(label) {
				return invalid()
			}
		}
	}
	if port == "443" {
		port = ""
	}
	if port != "" {
		port = ":" + port
	}
	return "https://" + host + port, nil
}
func suiteIPv6(bytes [16]byte) string {
	groups := make([]string, 8)
	bestStart, bestLength := -1, 1
	for i := 0; i < 8; i++ {
		n := uint16(bytes[2*i])<<8 | uint16(bytes[2*i+1])
		groups[i] = strconv.FormatUint(uint64(n), 16)
	}
	for i := 0; i < 8; {
		if groups[i] != "0" {
			i++
			continue
		}
		end := i
		for end < 8 && groups[end] == "0" {
			end++
		}
		if end-i > bestLength {
			bestStart, bestLength = i, end-i
		}
		i = end
	}
	if bestStart < 0 {
		return strings.Join(groups, ":")
	}
	return strings.Join(groups[:bestStart], ":") + "::" + strings.Join(groups[bestStart+bestLength:], ":")
}
func NormalizeSuitePath(input string) (string, error) {
	invalid := func() (string, error) { return "", suiteFailure("INVALID_SUITE_PATH") }
	if len(input) == 0 || len(input) > 2048 || input[0] != '/' || strings.HasPrefix(input, "//") {
		return invalid()
	}
	var result strings.Builder
	for i := 0; i < len(input); i++ {
		c := input[i]
		if c == '%' {
			if i+2 >= len(input) {
				return invalid()
			}
			n, e := strconv.ParseUint(input[i+1:i+3], 16, 8)
			if e != nil || n < 128 {
				return invalid()
			}
			result.WriteString(strings.ToUpper(input[i : i+3]))
			i += 2
		} else {
			if c > 127 || !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.ContainsRune("_~.!$&'()*+,;=:@/-", rune(c))) {
				return invalid()
			}
			result.WriteByte(c)
		}
	}
	decoded, e := url.PathUnescape(input)
	if e != nil || !utf8.ValidString(decoded) {
		return invalid()
	}
	for _, segment := range strings.Split(decoded, "/") {
		if segment == "." || segment == ".." {
			return invalid()
		}
	}
	for _, c := range decoded {
		if unicode.IsControl(c) || unicode.IsSpace(c) || c == '\ufeff' {
			return invalid()
		}
	}
	return result.String(), nil
}
func ResolveSuiteEndpoint(origin, path string) (string, error) {
	o, e := NormalizeSuiteOrigin(origin)
	if e != nil {
		return "", e
	}
	p, e := NormalizeSuitePath(path)
	if e != nil {
		return "", e
	}
	return o + p, nil
}
func NormalizeSuiteResource(resource string) (string, error) {
	if len(resource) < 8 {
		return "", suiteFailure("INVALID_ORIGIN")
	}
	i := strings.IndexByte(resource[8:], '/')
	if i < 0 {
		return "", suiteFailure("INVALID_ORIGIN")
	}
	i += 8
	return ResolveSuiteEndpoint(resource[:i], resource[i:])
}

var suiteDatePattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$`)

func ParseSuiteTimestamp(value string) (time.Time, error) {
	if !suiteDatePattern.MatchString(value) {
		return time.Time{}, suiteFailure("INVALID_INTEGRATION")
	}
	parsed, e := time.Parse(time.RFC3339Nano, value)
	if e != nil {
		return time.Time{}, suiteFailure("INVALID_INTEGRATION")
	}
	return parsed, nil
}
func CompareSuiteSequences(left, right string) (int, error) {
	valid := func(s string) bool {
		if len(s) == 0 || len(s) > 20 || (len(s) > 1 && s[0] == '0') {
			return false
		}
		for _, c := range s {
			if c < '0' || c > '9' {
				return false
			}
		}
		_, e := strconv.ParseUint(s, 10, 64)
		return e == nil
	}
	if !valid(left) || !valid(right) {
		return 0, suiteFailure("INVALID_SEQUENCE")
	}
	if left == right {
		return 0, nil
	}
	if len(left) < len(right) || (len(left) == len(right) && left < right) {
		return -1, nil
	}
	return 1, nil
}

var suiteSchemaDocuments sync.Map

func suiteWalk(schema, value any, preflight bool) error {
	s, v := object(schema), object(value)
	if value == nil {
		return nil
	}
	if text(s["type"]) == "array" {
		for _, child := range array(value) {
			if e := suiteWalk(s["items"], child, preflight); e != nil {
				return e
			}
		}
	}
	if text(s["type"]) == "object" && v != nil {
		props := object(s["properties"])
		if preflight {
			for _, name := range []string{"contractVersion", "version"} {
				if text(object(props[name])["const"]) == "1.0" {
					if val, ok := v[name].(string); ok && val != "1.0" {
						return suiteFailure("UNSUPPORTED_INTEGRATION")
					}
				}
			}
			if props["requires"] != nil && len(array(v["requires"])) > 0 {
				return suiteFailure("UNSUPPORTED_INTEGRATION")
			}
		}
		for key, child := range props {
			if val, found := v[key]; found {
				if e := suiteWalk(child, val, preflight); e != nil {
					return e
				}
			}
		}
		for _, branch := range array(s["oneOf"]) {
			literals, match := 0, true
			for key, child := range object(object(branch)["properties"]) {
				if constant, has := object(child)["const"]; has {
					literals++
					if v[key] != constant {
						match = false
					}
				}
			}
			if literals > 0 && match {
				if e := suiteWalk(branch, value, preflight); e != nil {
					return e
				}
			}
		}
	}
	if preflight {
		return nil
	}
	if props := object(s["properties"]); props["declaration"] != nil && props["productId"] != nil && v["productId"] != object(v["declaration"])["productId"] {
		return suiteFailure("INVALID_INTEGRATION")
	}
	switch text(s["x-nox-kind"]) {
	case "product-id":
		if !ValidSuiteProductID(text(value)) {
			return suiteFailure("INVALID_INTEGRATION")
		}
	case "origin":
		_, e := NormalizeSuiteOrigin(text(value))
		return e
	case "path":
		_, e := NormalizeSuitePath(text(value))
		return e
	case "timestamp":
		_, e := ParseSuiteTimestamp(text(value))
		return e
	case "sequence":
		_, e := CompareSuiteSequences(text(value), text(value))
		return e
	}
	return nil
}
func LoadSuiteDocument(name string, data []byte) (JSON, error) {
	return LoadSuiteDocumentWithLimit(name, data, SuiteMaxPayloadBytes)
}
func LoadSuiteDocumentWithLimit(name string, data []byte, maxBytes int) (JSON, error) {
	invalid := func() (JSON, error) { return nil, suiteFailure("INVALID_INTEGRATION") }
	value, e := ParseSuiteJSONWithLimit(data, maxBytes)
	if e != nil {
		return invalid()
	}
	doc := object(value)
	if doc == nil {
		return invalid()
	}
	var schema any
	if cached, ok := suiteSchemaDocuments.Load(name); ok {
		schema = cached
	} else {
		source, e := Contracts.ReadFile("contracts/suite-" + name + ".schema.json")
		if e != nil {
			return invalid()
		}
		if json.Unmarshal(source, &schema) != nil {
			return invalid()
		}
		suiteSchemaDocuments.Store(name, schema)
	}
	if e = suiteWalk(schema, value, true); e != nil {
		if e.Error() == "UNSUPPORTED_INTEGRATION" {
			return nil, e
		}
		return invalid()
	}
	if ValidateFrameWithLimit("suite-"+name, data, maxBytes) != nil || suiteWalk(schema, value, false) != nil {
		return invalid()
	}
	switch name {
	case "registration-record":
		if doc["productId"] != object(doc["declaration"])["productId"] {
			return invalid()
		}
	case "delegation-claims", "probe-claims":
		iat, exp, nbf := doc["iat"].(float64), doc["exp"].(float64), doc["nbf"].(float64)
		resource, e := NormalizeSuiteResource(text(doc["aud"]))
		if e != nil || resource != doc["aud"] || exp <= iat || exp-iat > 300 || nbf < iat || nbf >= exp {
			return invalid()
		}
		if name == "delegation-claims" {
			parts := strings.Split(text(doc["scope"]), " ")
			seen := map[string]bool{}
			for _, part := range parts {
				if seen[part] || (part != "nox:inspect" && part != "nox:write" && part != "nox:sensitive-read") {
					return invalid()
				}
				seen[part] = true
			}
			if !seen["nox:inspect"] {
				return invalid()
			}
		}
	case "provisioning":
		origin, _ := NormalizeSuiteOrigin(text(doc["backendOrigin"]))
		uri, e := NormalizeSuiteResource(text(doc["signingKeysUri"]))
		if e != nil || uri != doc["signingKeysUri"] || !strings.HasPrefix(uri, origin+"/") {
			return invalid()
		}
	case "registry-snapshot", "gateway-presentation":
		seen := map[string]bool{}
		for _, entry := range array(doc["products"]) {
			p := object(entry)
			id := text(p["productId"])
			if seen[id] {
				return invalid()
			}
			seen[id] = true
			if name == "registry-snapshot" && p["productId"] != object(p["declaration"])["productId"] {
				return invalid()
			}
		}
	}
	return doc, nil
}
func loadSuiteTyped[T any](name string, data []byte) (T, error) {
	var result T
	value, e := LoadSuiteDocument(name, data)
	if e != nil {
		return result, e
	}
	encoded, e := json.Marshal(value)
	if e != nil {
		return result, e
	}
	e = json.Unmarshal(encoded, &result)
	return result, e
}
func marshalSuiteDTO(value any, extra map[string]json.RawMessage) ([]byte, error) {
	data, e := json.Marshal(value)
	if e != nil {
		return nil, e
	}
	var fields map[string]json.RawMessage
	if e = json.Unmarshal(data, &fields); e != nil {
		return nil, e
	}
	for key, v := range extra {
		if _, found := fields[key]; found {
			return nil, fmt.Errorf("Suite extension shadows field %s", key)
		}
		fields[key] = v
	}
	return json.Marshal(fields)
}
func unmarshalSuiteDTO(data []byte, target any, known []string) (map[string]json.RawMessage, error) {
	if e := json.Unmarshal(data, target); e != nil {
		return nil, e
	}
	var extra map[string]json.RawMessage
	if e := json.Unmarshal(data, &extra); e != nil {
		return nil, e
	}
	for _, key := range known {
		delete(extra, key)
	}
	return extra, nil
}
func SuiteToolAlias(productID, name string) (string, error) {
	if !ValidSuiteProductID(productID) || !utf8.ValidString(name) || len(name) == 0 || utf8.RuneCountInString(name) > 64 {
		return "", suiteFailure("INVALID_GATEWAY")
	}
	alias := productID + "__" + name
	readable := len(alias) <= 64
	for _, c := range alias {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.ContainsRune("_.-", c)) {
			readable = false
		}
	}
	if readable {
		return alias, nil
	}
	hash, e := Fingerprint([]any{productID, name})
	if e != nil {
		return "", e
	}
	return "_" + hash, nil
}
func NewSuitePolicy(required []string, argumentDependent bool) (SuitePolicy, error) {
	seen := map[string]bool{}
	scopes := []string{}
	for _, s := range required {
		if !seen[s] {
			seen[s] = true
			scopes = append(scopes, s)
		}
	}
	data, _ := json.Marshal(JSON{"version": "1.0", "requiredScopes": scopes, "argumentDependent": argumentDependent})
	return LoadSuitePolicy(data)
}
func RequireSuiteScopes(grants []string, policy SuitePolicy, additional []string) ([]string, error) {
	data, e := json.Marshal(policy)
	if e != nil {
		return nil, suiteFailure("FORBIDDEN")
	}
	if _, e = LoadSuitePolicy(data); e != nil {
		return nil, e
	}
	have := map[string]bool{}
	for _, scope := range grants {
		have[scope] = true
	}
	seen := map[string]bool{}
	required := []string{}
	for _, scope := range append(append([]string{}, policy.RequiredScopes...), additional...) {
		if scope == "" || !have[scope] {
			return nil, suiteFailure("FORBIDDEN")
		}
		if !seen[scope] {
			seen[scope] = true
			required = append(required, scope)
		}
	}
	return required, nil
}
