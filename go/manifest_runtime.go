package noxmcp

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// NewFromManifest binds an application-approved manifest to trusted Options.Tools.
// Manifest requirements restrict execution; they never supply identity or grants.
func NewFromManifest(options Options, data []byte) (*Runtime, error) {
	return newFromManifest(options, data)
}

// NewFromManifestWithDiscovery preserves the portable manifest boundary and adds the optional extension.
func NewFromManifestWithDiscovery(options Options, data []byte, discovery DiscoveryOptions) (*Runtime, error) {
	return newFromManifest(options, data, &discovery)
}
func newFromManifest(options Options, data []byte, discovery ...*DiscoveryOptions) (*Runtime, error) {
	document, err := LoadToolManifest(data)
	if err != nil {
		return nil, err
	}
	bindings := map[string]Tool{}
	for _, tool := range options.Tools {
		if _, exists := bindings[tool.Name]; exists {
			return nil, fmt.Errorf("duplicate binding")
		}
		bindings[tool.Name] = tool
	}
	tools := []Tool{}
	annotationsByName := map[string]*mcp.ToolAnnotations{}
	for _, entry := range document["tools"].([]any) {
		raw := entry.(map[string]any)
		name := raw["name"].(string)
		binding, exists := bindings[name]
		if !exists || binding.Execute == nil {
			return nil, fmt.Errorf("missing trusted implementation: %s", name)
		}
		var definition struct {
			Name, Title, Description  string
			RequiredScopes            []string
			InputSchema, OutputSchema json.RawMessage
		}
		encoded, _ := json.Marshal(raw)
		if err = json.Unmarshal(encoded, &definition); err != nil {
			return nil, err
		}
		tool := binding
		tool.Title = definition.Title
		tool.Description = definition.Description
		tool.Meta, _ = raw["_meta"].(map[string]any)
		tool.RequiredScopes = slices.Clone(binding.RequiredScopes)
		for _, scope := range definition.RequiredScopes {
			if !slices.Contains(tool.RequiredScopes, scope) {
				tool.RequiredScopes = append(tool.RequiredScopes, scope)
			}
		}
		tool.InputSchema = nil
		tool.OutputSchema = nil
		if err = json.Unmarshal(definition.InputSchema, &tool.InputSchema); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(definition.OutputSchema, &tool.OutputSchema); err != nil {
			return nil, err
		}
		annotations := raw["annotations"].(map[string]any)
		annotationJSON, _ := json.Marshal(annotations)
		var declared mcp.ToolAnnotations
		if err = json.Unmarshal(annotationJSON, &declared); err != nil {
			return nil, err
		}
		annotationsByName[name] = &declared
		tool.ReadOnly, _ = annotations["readOnlyHint"].(bool)
		tool.Destructive, _ = annotations["destructiveHint"].(bool)
		tool.Idempotent, _ = annotations["idempotentHint"].(bool)
		tool.OpenWorld = nil
		if hint, exists := annotations["openWorldHint"].(bool); exists {
			tool.OpenWorld = &hint
		}
		tools = append(tools, tool)
	}
	options.Tools = tools
	runtime, err := newRuntime(options, annotationsByName, discovery...)
	if err != nil {
		return nil, err
	}
	for _, entry := range document["tools"].([]any) {
		tool := entry.(map[string]any)
		name := tool["name"].(string)
		compiled := runtime.tools[name]
		compiled.input, err = CompileToolSchema(tool["inputSchema"])
		if err != nil {
			return nil, err
		}
		compiled.output, err = CompileToolSchema(tool["outputSchema"])
		if err != nil {
			return nil, err
		}
		runtime.tools[name] = compiled
	}
	return runtime, nil
}
