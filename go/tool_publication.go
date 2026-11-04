package noxmcp

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// standardTool projects the MCP response without mutating the discovery source.
func standardTool(tool *mcp.Tool) *mcp.Tool {
	if _, exists := tool.Meta["cli"]; !exists {
		return tool
	}
	projected := *tool
	projected.Meta = nil
	for key, value := range tool.Meta {
		if key != "cli" {
			if projected.Meta == nil {
				projected.Meta = mcp.Meta{}
			}
			projected.Meta[key] = value
		}
	}
	return &projected
}

func installStandardToolList(server *mcp.Server) {
	// Installed after discovery so its internal reads retain canonical tools.
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
			result, err := next(ctx, method, request)
			if err != nil || method != "tools/list" {
				return result, err
			}
			page := *result.(*mcp.ListToolsResult)
			page.Tools = make([]*mcp.Tool, len(page.Tools))
			for i, tool := range result.(*mcp.ListToolsResult).Tools {
				page.Tools[i] = standardTool(tool)
			}
			return &page, nil
		}
	})
}
