import type { McpServer, Tool } from '@modelcontextprotocol/server';

/** Project only the standard MCP response; never mutate the discovery source. */
export function standardTool(tool: Tool): Tool {
  if (!tool._meta || !Object.hasOwn(tool._meta, 'cli')) return tool;
  const metadata = { ...tool._meta };
  delete metadata.cli;
  const projected = { ...tool };
  if (Object.keys(metadata).length) projected._meta = metadata;
  else delete projected._meta;
  return projected;
}

/** Plain factories have no discovery middleware to project their list response. */
export function installStandardToolList(server: McpServer): void {
  const register = server.registerTool.bind(server);
  const setHandler = server.server.setRequestHandler.bind(server.server);
  type ToolList = { tools: Tool[]; [key: string]: unknown };
  server.registerTool = ((...registration: Parameters<typeof server.registerTool>) => {
    const previous = server.server.setRequestHandler;
    server.server.setRequestHandler = ((method: string, ...args: unknown[]) => {
      if (method === 'tools/list' && typeof args[0] === 'function') {
        const list = args[0] as (...input: unknown[]) => ToolList | Promise<ToolList>;
        setHandler('tools/list', (async (...input: unknown[]) => {
          const result = await list(...input);
          return { ...result, tools: result.tools.map(standardTool) };
        }) as never);
      } else (setHandler as (...input: unknown[]) => void)(method, ...args);
    }) as typeof server.server.setRequestHandler;
    try { return register(...registration); }
    finally { server.server.setRequestHandler = previous; }
  }) as typeof server.registerTool;
}
