package noxmcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
)

type toolPolicy struct {
	Dialect                                     string
	Keywords, Maps, Single, Arrays, Annotations []string
	Formats                                     map[string]string
	AsciiClasses                                map[string]string
	MaxDepth                                    int
}

func readToolPolicy() toolPolicy {
	data, err := Contracts.ReadFile("contracts/tool-schema-policy.json")
	if err != nil {
		panic(err)
	}
	var policy toolPolicy
	if err := json.Unmarshal(data, &policy); err != nil {
		panic(err)
	}
	return policy
}

var sharedToolPolicy = readToolPolicy()
var sharedToolMeta = func() *jsonschema.Resolved {
	data, err := Contracts.ReadFile("contracts/tool-schema.meta.json")
	if err != nil {
		panic(err)
	}
	var schema jsonschema.Schema
	if err = json.Unmarshal(data, &schema); err != nil {
		panic(err)
	}
	compiled, err := schema.Resolve(nil)
	if err != nil {
		panic(err)
	}
	return compiled
}()

// CompileToolSchema compiles the common offline draft-07 profile without data mutation.
func CompileToolSchema(schema any) (*jsonschema.Resolved, error) {
	data, err := json.Marshal(schema)
	if err != nil {
		return nil, err
	}
	var root any
	if err = json.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	if err = sharedToolMeta.Validate(root); err != nil {
		return nil, err
	}
	policy := sharedToolPolicy
	var walk func(any, int, map[string]bool) (any, error)
	walk = func(raw any, depth int, refs map[string]bool) (any, error) {
		if depth > policy.MaxDepth {
			return nil, fmt.Errorf("excessive tool schema")
		}
		if _, ok := raw.(bool); ok {
			return raw, nil
		}
		node, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("invalid tool schema")
		}
		node = maps.Clone(node)
		var referenced any
		hasReference := false
		for key := range node {
			if !slices.Contains(policy.Keywords, key) && !strings.HasPrefix(key, "x-") {
				return nil, fmt.Errorf("unsupported schema keyword: %s", key)
			}
		}
		if dialect, present := node["$schema"]; present && dialect != policy.Dialect {
			return nil, fmt.Errorf("unsupported schema dialect")
		}
		if reference, present := node["$ref"]; present {
			ref, ok := reference.(string)
			if !ok || !strings.HasPrefix(ref, "#/") || refs[ref] {
				return nil, fmt.Errorf("invalid or recursive schema reference")
			}
			for key := range node {
				if key != "$ref" && key != "$schema" && key != "definitions" && !slices.Contains(policy.Annotations, key) && !strings.HasPrefix(key, "x-") {
					return nil, fmt.Errorf("assertion sibling of $ref")
				}
			}
			target := root
			for _, part := range strings.Split(ref[2:], "/") {
				if regexp.MustCompile(`~(?:[^01]|$)`).MatchString(part) {
					return nil, fmt.Errorf("invalid JSON Pointer escape")
				}
				key := strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
				switch value := target.(type) {
				case map[string]any:
					var found bool
					target, found = value[key]
					if !found {
						return nil, fmt.Errorf("unknown schema reference")
					}
				case []any:
					index, err := strconv.Atoi(key)
					if err != nil || index < 0 || index >= len(value) || strconv.Itoa(index) != key {
						return nil, fmt.Errorf("invalid array pointer")
					}
					target = value[index]
				default:
					return nil, fmt.Errorf("unknown schema reference")
				}
			}
			next := map[string]bool{}
			for k, v := range refs {
				next[k] = v
			}
			next[ref] = true
			referenced, err = walk(target, depth+1, next)
			if err != nil {
				return nil, err
			}
			hasReference = true
		}
		checkPattern := func(value any) (string, error) {
			pattern, ok := value.(string)
			if !ok {
				return "", fmt.Errorf("pattern outside portable profile")
			}
			var out strings.Builder
			inside := false
			runes := []rune(pattern)
			for i := 0; i < len(runes); i++ {
				char := runes[i]
				if char == '\\' && i+1 < len(runes) {
					i++
					next := string(runes[i])
					lower := strings.ToLower(next)
					if fragment := policy.AsciiClasses[lower]; fragment != "" {
						if inside && next != lower {
							return "", fmt.Errorf("negated shorthand inside class")
						}
						if inside {
							out.WriteString(fragment)
						} else {
							out.WriteString("[")
							if next != lower {
								out.WriteString("^")
							}
							out.WriteString(fragment + "]")
						}
					} else if strings.Contains(`nrtfv.^$|?*+()[]{}\`, next) {
						out.WriteString("\\" + next)
					} else if next == "/" || next == "-" {
						if next == "-" {
							out.WriteString(`\x2d`)
						} else {
							out.WriteString("/")
						}
					} else if next == "x" && i+2 < len(runes) && regexp.MustCompile(`^[0-9a-fA-F]{2}$`).MatchString(string(runes[i+1:i+3])) {
						out.WriteString(`\x` + string(runes[i+1:i+3]))
						i += 2
					} else {
						return "", fmt.Errorf("escape outside portable profile")
					}
				} else {
					if char == '\\' {
						return "", fmt.Errorf("incomplete pattern escape")
					}
					tail := string(runes[i:])
					if !inside && char == '(' && (strings.HasPrefix(tail, "(*") || (strings.HasPrefix(tail, "(?") && !strings.HasPrefix(tail, "(?:"))) {
						return "", fmt.Errorf("unsupported pattern group")
					}
					if inside && (char == '[' || strings.HasPrefix(tail, "&&") || strings.HasPrefix(tail, "--") || strings.HasPrefix(tail, "~~")) {
						return "", fmt.Errorf("nonportable character class")
					}
					if char == '[' {
						inside = true
						if strings.HasPrefix(tail, "[]") || strings.HasPrefix(tail, "[^]") {
							return "", fmt.Errorf("empty character class")
						}
					}
					if char == ']' {
						inside = false
					}
					if !inside && char == '.' {
						out.WriteString("[^\n\r\u2028\u2029]")
					} else {
						out.WriteRune(char)
					}
				}
			}
			result := out.String()
			_, err := regexp.Compile(result)
			return result, err
		}
		if pattern, ok := node["pattern"]; ok {
			prepared, err := checkPattern(pattern)
			if err != nil {
				return nil, err
			}
			node["pattern"] = prepared
		}
		if value, present := node["multipleOf"]; present {
			number, ok := value.(float64)
			if !ok || number <= 0 || number > 9007199254740991 || math.Trunc(number) != number {
				return nil, fmt.Errorf("portable multipleOf requires a positive safe integer")
			}
		}
		if patterns, ok := node["patternProperties"].(map[string]any); ok {
			normalized := map[string]any{}
			for p, value := range patterns {
				prepared, err := checkPattern(p)
				if err != nil {
					return nil, err
				}
				if _, exists := normalized[prepared]; exists {
					return nil, fmt.Errorf("colliding normalized patterns")
				}
				normalized[prepared] = value
			}
			node["patternProperties"] = normalized
		}
		for _, key := range policy.Maps {
			if children, present := node[key]; present {
				entries, ok := children.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("invalid schema map")
				}
				entries = maps.Clone(entries)
				node[key] = entries
				for name, child := range entries {
					prepared, err := walk(child, depth+1, refs)
					if err != nil {
						return nil, err
					}
					entries[name] = prepared
				}
			}
		}
		for _, key := range policy.Single {
			if child, present := node[key]; present {
				prepared, err := walk(child, depth+1, refs)
				if err != nil {
					return nil, err
				}
				node[key] = prepared
			}
		}
		for _, key := range policy.Arrays {
			if children, present := node[key]; present {
				list, ok := children.([]any)
				if !ok || len(list) == 0 {
					return nil, fmt.Errorf("invalid schema alternatives")
				}
				list = slices.Clone(list)
				node[key] = list
				for i, child := range list {
					prepared, err := walk(child, depth+1, refs)
					if err != nil {
						return nil, err
					}
					list[i] = prepared
				}
			}
		}
		if format, present := node["format"]; present {
			name, ok := format.(string)
			if !ok || policy.Formats[name] == "" {
				return nil, fmt.Errorf("unsupported asserted format")
			}
			list, _ := node["allOf"].([]any)
			node["allOf"] = append(list, map[string]any{"pattern": policy.Formats[name]})
		}
		if hasReference {
			return referenced, nil
		}
		return node, nil
	}
	prepared, err := walk(root, 0, map[string]bool{})
	if err != nil {
		return nil, err
	}
	if object, ok := prepared.(map[string]any); ok {
		object["$schema"] = policy.Dialect
	}
	data, err = json.Marshal(prepared)
	if err != nil {
		return nil, err
	}
	var compiled jsonschema.Schema
	if err = json.Unmarshal(data, &compiled); err != nil {
		return nil, err
	}
	return compiled.Resolve(nil)
}

func ValidateToolValue(schema, value any) bool {
	compiled, err := CompileToolSchema(schema)
	return err == nil && compiled.Validate(value) == nil
}

// LoadToolManifest preserves the entire document; it never grants authorization.
func LoadToolManifest(data []byte) (map[string]any, error) {
	if err := ValidateFrame("manifest", data); err != nil {
		return nil, err
	}
	var manifest map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&manifest); err != nil {
		return nil, err
	}
	if manifest["protocolVersion"] != BridgeProtocolVersion {
		return nil, fmt.Errorf("unsupported executable protocol")
	}
	names := map[string]bool{}
	for _, raw := range manifest["tools"].([]any) {
		tool := raw.(map[string]any)
		name := tool["name"].(string)
		if names[name] {
			return nil, fmt.Errorf("duplicate executable tool")
		}
		names[name] = true
		for _, key := range []string{"inputSchema", "outputSchema"} {
			schema := tool[key].(map[string]any)
			if schema["type"] != "object" {
				return nil, fmt.Errorf("executable tool schema must declare object")
			}
			if _, err := CompileToolSchema(schema); err != nil {
				return nil, err
			}
		}
	}
	return manifest, nil
}
