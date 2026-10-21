import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Ajv } from 'ajv';
import { z } from 'zod';
import { MissingRequiredClientCapabilityError, UnsupportedProtocolVersionError, SUPPORTED_PROTOCOL_VERSIONS, ProtocolError, ProtocolErrorCode, type McpServer, type ServerContext, type Tool } from '@modelcontextprotocol/server';
import { discoverySchemas } from './discovery-contracts.generated.js';

export const DISCOVERY_EXTENSION = 'nox/discovery';
export const DISCOVERY_VERSION = '1.0';
export const DISCOVERY_PROTOCOL = '2026-07-28';
export const discoveryCapability = { versions: [DISCOVERY_VERSION], maxBatchSize: 64 };
export function discoveryMeta() {
  return { 'io.modelcontextprotocol/protocolVersion': DISCOVERY_PROTOCOL,
    'io.modelcontextprotocol/clientCapabilities': { extensions: { [DISCOVERY_EXTENSION]: { version: DISCOVERY_VERSION } } } };
}
export class DiscoveryError extends Error {
  constructor(public readonly reason: string) { super(reason); }
}
function fail(reason: string): never { throw new DiscoveryError(reason); }
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = Object.fromEntries(Object.entries(discoverySchemas).map(([name, schema]) => [name, ajv.compile(schema)]));
export function validateDiscovery(name: keyof typeof discoverySchemas, value: unknown): void {
  if (!validators[name](value)) fail('INVALID_DISCOVERY');
}

/** RFC 8785. Reject non-JSON values instead of silently dropping/coercing them. */
export function canonicalize(value: unknown): string {
  const seen = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('INVALID_JCS'); return JSON.stringify(v); }
    if (typeof v === 'string') { if (/\p{Surrogate}/u.test(v)) fail('INVALID_JCS'); return JSON.stringify(v); }
    if (typeof v !== 'object' || v === null || seen.has(v)) return fail('INVALID_JCS');
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) result = '[' + Array.from(v, encode).join(',') + ']';
    else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail('INVALID_JCS');
      result = '{' + Object.keys(v).sort().map(key => encode(key) + ':' + encode((v as Record<string, unknown>)[key])).join(',') + '}';
    }
    seen.delete(v); return result;
  };
  return encode(value);
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(canonicalize(value)).digest('base64url'); }
export interface CliDescriptor {
  version: '1.0'; requires?: string[];
  navigation?: Record<string, unknown>; parameters?: Record<string, Record<string, unknown>>;
  preview?: Record<string, unknown>; confirmation?: Record<string, unknown>;
  workflow?: Record<string, unknown>[];
  [key: string]: unknown;
}
export function interpretCli(value: unknown): CliDescriptor {
  validateDiscovery('cli', value);
  const cli = structuredClone(value) as CliDescriptor;
  if (cli.requires?.some(feature => !['dynamic-options', 'preview', 'confirmation', 'workflow'].includes(feature))) fail('UNSUPPORTED_FEATURE');
  if (cli.workflow && (cli.preview || cli.confirmation)) fail('INVALID_CLI');
  const checkSource = (source: Record<string, unknown>) => { if (source.input && source.arguments) fail('INVALID_CLI'); };
  for (const parameter of Object.values(cli.parameters ?? {})) {
    if (parameter.options) {
      const options = parameter.options as Record<string, unknown>; checkSource(options);
      parameter.control ??= 'select'; options.itemsPointer ??= '/items'; options.valuePointer ??= '/id'; options.labelPointer ??= '/name';
    }
  }
  const confirm = (c?: Record<string, unknown>) => { if (c?.mode === 'typed' && typeof c.matchPointer !== 'string') fail('INVALID_CLI'); };
  if (cli.preview) checkSource(cli.preview); confirm(cli.confirmation);
  const steps = new Set<string>();
  for (const step of cli.workflow ?? []) {
    if (steps.has(step.id as string)) fail('INVALID_CLI');
    checkSource(step);
    if (step.type === 'call' && !step.tool || step.type === 'input' && !step.parameters || step.type === 'confirm' && !step.confirmation) fail('INVALID_CLI');
    for (const binding of Object.values((step.arguments ?? {}) as Record<string, Record<string, unknown>>)) if (binding.from === 'step' && !steps.has(binding.step as string)) fail('INVALID_CLI');
    confirm(step.confirmation as Record<string, unknown> | undefined); steps.add(step.id as string);
  }
  return cli;
}
export interface Definition { tool: Tool; cli?: CliDescriptor }
export interface CatalogEntry { name: string; fingerprint: string; availability?: 'available' | 'unavailable' }
export interface DiscoveryView { viewId: string; definitions: (Definition & { availability?: 'available' | 'unavailable' })[]; presentation?: Record<string, unknown> }
export interface Catalog {
  resultType: 'complete'; serverId: string; viewId: string; catalog: string; ttlMs: number; cacheScope: 'private';
  tools?: CatalogEntry[]; nextCursor?: number; notModified?: true; presentation?: Record<string, unknown>; [key:string]:unknown;
}
export interface DefinitionsResult { resultType: 'complete'; catalog: string; definitions: (Definition & { fingerprint: string })[]; [key:string]:unknown }
/** No historical definitions are served: every operation uses a current authorized view. */
export class DiscoveryService {
  private readonly hashes = new Map<string,{definition:Definition;hash:string}>();
  constructor(public readonly serverId: string, public readonly ttlMs = 30000, public readonly maxBytes = 4 * 1024 * 1024) {
    if (!serverId || !Number.isSafeInteger(ttlMs) || ttlMs < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('INVALID_DISCOVERY');
  }
  private snapshot(view: DiscoveryView) {
    if (!view.viewId) fail('INVALID_DISCOVERY');
    const definitions = view.definitions.map(({ tool, cli, availability }) => {
      if(!tool || typeof tool!=='object')fail('INVALID_DISCOVERY');
      const definition: Definition = cli ? { tool, cli } : { tool };
      if(cli===null || availability!==undefined && !['available','unavailable'].includes(availability))fail('INVALID_DISCOVERY');
      let cached=this.hashes.get(tool.name);
      if (!cached || !isDeepStrictEqual(cached.definition,definition)) {
        validateDiscovery('discovery-definitions',{resultType:'complete',catalog:'validation',definitions:[{...definition,fingerprint:'a'.repeat(43)}]});
        if (cli) interpretCli(cli);
        cached={definition:structuredClone(definition),hash:fingerprint(definition)};
        if(this.hashes.size>=4096)this.hashes.clear();
        this.hashes.set(tool.name,cached);
      }
      const entry: CatalogEntry = { name: tool.name, fingerprint: cached.hash, ...(availability ? { availability } : {}) };
      if (!entry.name || availability && !['available', 'unavailable'].includes(availability)) fail('INVALID_DISCOVERY');
      return { entry, definition: structuredClone(definition) };
    }).sort((a,b) => a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0);
    if (new Set(definitions.map(d => d.entry.name)).size !== definitions.length) fail('INVALID_DISCOVERY');
    const tools = definitions.map(d => d.entry);
    const catalog = fingerprint({ serverId: this.serverId, viewId: view.viewId, tools, ...(view.presentation ? { presentation: view.presentation } : {}) });
    return { definitions, tools, catalog };
  }
  private bounded<T>(result: T): T { if (Buffer.byteLength(JSON.stringify(result)) > this.maxBytes) fail('PAYLOAD_LIMIT'); return result; }
  catalog(view: DiscoveryView, params: Record<string, unknown> = {}): Catalog {
    validateDiscovery('discovery-catalog-request', params);
    const snapshot = this.snapshot(view);
    const base: Catalog = { resultType:'complete', serverId:this.serverId, viewId:view.viewId, catalog:snapshot.catalog, ttlMs:this.ttlMs, cacheScope:'private' };
    if (params.catalog && params.catalog !== snapshot.catalog) fail('STALE_CATALOG');
    if (params.cursor !== undefined && !params.catalog || params.cursor !== undefined && params.ifCatalog) fail('INVALID_DISCOVERY');
    if (params.ifCatalog === snapshot.catalog) return this.bounded({ ...base, notModified:true });
    const cursor = (params.cursor ?? 0) as number, limit = (params.limit ?? 1000) as number;
    if (cursor > snapshot.tools.length) fail('INVALID_DISCOVERY');
    const tools = snapshot.tools.slice(cursor,cursor+limit), next = cursor + tools.length;
    return this.bounded({ ...base, tools, ...(view.presentation ? { presentation: view.presentation } : {}), ...(next < snapshot.tools.length ? { nextCursor:next } : {}) });
  }
  definitions(view: DiscoveryView, params: { catalog: string; tools: { name: string; fingerprint: string }[] }): DefinitionsResult {
    validateDiscovery('discovery-definitions-request', params);
    const snapshot = this.snapshot(view);
    if (params.catalog !== snapshot.catalog) fail('STALE_CATALOG');
    if (new Set(params.tools.map(t => t.name)).size !== params.tools.length) fail('INVALID_DISCOVERY');
    return this.bounded({ resultType:'complete', catalog:snapshot.catalog, definitions:params.tools.map(ref => {
      const found = snapshot.definitions.find(d => d.entry.name === ref.name && d.entry.fingerprint === ref.fingerprint);
      if (!found) return fail('STALE_CATALOG');
      return { ...found.definition, fingerprint:found.entry.fingerprint };
    }) });
  }
  guard(view: DiscoveryView, name: string, meta?: Record<string, unknown>) {
    const definition = view.definitions.find(d => d.tool.name === name);
    if (!definition) fail('FORBIDDEN');
    if (definition.availability === 'unavailable') fail('UNAVAILABLE');
    const settings = meta?.[DISCOVERY_EXTENSION] as Record<string, unknown> | undefined;
    if (settings !== undefined) {
      const { availability: _, ...bundle } = definition;
      if (!settings || typeof settings.expectedFingerprint !== 'string' || settings.expectedFingerprint !== fingerprint(bundle)) fail('STALE_DEFINITION');
    }
  }
}
export type DiscoveryRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
/** One cache object per trusted origin and credential partition. Commit only after all pages/batches verify. */
export class DiscoveryCache {
  private state?: { catalog: Catalog; definitions: Map<string, Definition & { fingerprint:string }> };
  private pending=Promise.resolve();
  private generation=0;
  constructor(public readonly origin: string, public readonly credentialPartition: string) { if (!origin || !credentialPartition) fail('INVALID_DISCOVERY'); }
  clear() { this.generation++;this.state = undefined; }
  get definitions(): ReadonlyMap<string, Definition & { fingerprint:string }> { return structuredClone(this.state?.definitions??new Map()); }
  get catalog(): Catalog | undefined { return this.state && structuredClone(this.state.catalog); }
  sync(request: DiscoveryRequest): Promise<void> {
    const generation=this.generation;
    const work=this.pending.then(()=>{if(generation!==this.generation)fail('CACHE_INVALIDATED');return this.synchronize(request,generation)});
    this.pending=work.catch(()=>{});return work;
  }
  private async synchronize(request: DiscoveryRequest,generation:number): Promise<void> {
    const old = this.state;
    const first = await request('nox/tools/catalog', { ...(old ? { ifCatalog:old.catalog.catalog } : {}), _meta:discoveryMeta() }) as Catalog;
    validateDiscovery('discovery-catalog', first);
    if (first.notModified) { if (!old || first.catalog !== old.catalog.catalog || first.serverId !== old.catalog.serverId || first.viewId !== old.catalog.viewId) fail('INVALID_DISCOVERY');if(generation!==this.generation)fail('CACHE_INVALIDATED'); const catalog={...old.catalog,...structuredClone(first)};delete catalog.notModified;this.state = { ...old, catalog }; return; }
    const entries = [...first.tools!]; let page = first;
    while (page.nextCursor !== undefined) {
      if (page.nextCursor !== entries.length || entries.length > 100000) fail('INVALID_DISCOVERY');
      page = await request('nox/tools/catalog', { catalog:first.catalog, cursor:page.nextCursor, _meta:discoveryMeta() }) as Catalog;
      validateDiscovery('discovery-catalog', page);
      if (page.catalog !== first.catalog || page.serverId !== first.serverId || page.viewId !== first.viewId || !page.tools?.length || page.notModified) fail('STALE_CATALOG');
      entries.push(...page.tools!);
    }
    if (new Set(entries.map(t=>t.name)).size !== entries.length) fail('INVALID_DISCOVERY');
    if(fingerprint({serverId:first.serverId,viewId:first.viewId,tools:entries,...(first.presentation?{presentation:first.presentation}:{})})!==first.catalog)fail('INVALID_CATALOG');
    const sameView = old?.catalog.serverId === first.serverId && old?.catalog.viewId === first.viewId;
    const next = new Map<string, Definition & { fingerprint:string }>();
    const missing: CatalogEntry[] = [];
    for (const entry of entries) {
      const cached = sameView ? old?.definitions.get(entry.name) : undefined;
      if (cached?.fingerprint === entry.fingerprint) next.set(entry.name, cached); else missing.push(entry);
    }
    for (let offset=0;offset<missing.length;offset+=64) {
      const batch = missing.slice(offset,offset+64).map(({ name,fingerprint })=>({name,fingerprint}));
      const response = await request('nox/tools/definitions', { catalog:first.catalog, tools:batch, _meta:discoveryMeta() }) as DefinitionsResult;
      validateDiscovery('discovery-definitions', response);
      if (response.catalog !== first.catalog || response.definitions.length !== batch.length) fail('STALE_CATALOG');
      for (const definition of response.definitions) {
        const { fingerprint: hash,...bundle } = definition;
        if (!batch.some(ref=>ref.name===bundle.tool.name && ref.fingerprint===hash) || next.has(bundle.tool.name) || fingerprint(bundle)!==hash) fail('INVALID_FINGERPRINT');
        if (bundle.cli) interpretCli(bundle.cli); next.set(bundle.tool.name, structuredClone(definition));
      }
    }
    if(generation!==this.generation)fail('CACHE_INVALIDATED');
    const catalog={...structuredClone(first),tools:entries};delete catalog.nextCursor;
    this.state = { catalog, definitions:next };
  }
}

export interface DiscoveryOptions {
  serverId: string; ttlMs?: number; maxBytes?: number;
  service?: DiscoveryService;
  descriptors?: Record<string, CliDescriptor>;
  /** Return an opaque, non-secret authorization/policy revision; hidden tools are omitted. */
  resolveView(context: ServerContext, tools: readonly Tool[]): { viewId:string; visible?: readonly string[]; unavailable?: readonly string[]; presentation?:Record<string,unknown> } | Promise<{ viewId:string; visible?:readonly string[]; unavailable?:readonly string[]; presentation?:Record<string,unknown> }>;
}
/** Install before registering tools. Uses the very same registered handles as tools/list and tools/call. */
export function installDiscovery(server: McpServer, options: DiscoveryOptions): void {
  const service = options.service ?? new DiscoveryService(options.serverId, options.ttlMs, options.maxBytes);
  if(service.serverId!==options.serverId)fail('INVALID_DISCOVERY');
  for (const cli of Object.values(options.descriptors ?? {})) interpretCli(cli);
  const original = server.registerTool.bind(server);
  const setHandler=server.server.setRequestHandler.bind(server.server);
  type ToolList={tools:Tool[];[key:string]:unknown};
  let listTools:(request:unknown,context:ServerContext)=>ToolList|Promise<ToolList>=()=>({tools:[]});
  const view = async (context: ServerContext,listed?:Tool[]): Promise<DiscoveryView> => {
    const tools=JSON.parse(JSON.stringify(listed??(await listTools({method:'tools/list',params:{}},context)).tools)) as Tool[];
    const policy = await options.resolveView(context, tools);
    return {viewId:policy.viewId,presentation:policy.presentation,definitions:tools.filter(t=>!policy.visible || policy.visible.includes(t.name)).map(tool=>({tool,...(options.descriptors?.[tool.name] ? {cli:options.descriptors[tool.name]} : {}),...(policy.unavailable?.includes(tool.name) ? {availability:'unavailable' as const} : {})}))};
  };
  const boundary = async <T>(work:()=>T|Promise<T>):Promise<T> => { try { return await work(); } catch(error) { if (error instanceof DiscoveryError) throw new ProtocolError(ProtocolErrorCode.InvalidParams,error.reason,{reason:error.reason}); throw error; } };
  const negotiated = (ctx:ServerContext) => {
    const envelope = ctx.mcpReq.envelope as Partial<ReturnType<typeof discoveryMeta>> | undefined;
    const settings = envelope?.['io.modelcontextprotocol/clientCapabilities']?.extensions?.[DISCOVERY_EXTENSION];
    const requested=envelope?.['io.modelcontextprotocol/protocolVersion'];
    // HTTP validates this at its entry. An already-open stdio connection can
    // still dispatch a later request with an unknown revision in SDK 2.3.1.
    // SUPPORTED_PROTOCOL_VERSIONS is the SDK's legacy compatibility list.
    const supported=[DISCOVERY_PROTOCOL,...SUPPORTED_PROTOCOL_VERSIONS];
    if(typeof requested==='string'&&!supported.includes(requested)) throw new UnsupportedProtocolVersionError({supported,requested});
    if (requested !== DISCOVERY_PROTOCOL) fail('EXTENSION_NOT_NEGOTIATED');
    if (!envelope?.['io.modelcontextprotocol/clientCapabilities']) fail('INVALID_DISCOVERY');
    if (settings?.version !== DISCOVERY_VERSION) throw new MissingRequiredClientCapabilityError({
      requiredCapabilities: { extensions: { [DISCOVERY_EXTENSION]: { version: DISCOVERY_VERSION } } },
    });
  };
  server.server.registerCapabilities({extensions:{[DISCOVERY_EXTENSION]:discoveryCapability}});
  server.server.setRequestHandler('nox/tools/catalog',{params:z.record(z.string(),z.unknown())},(params,ctx)=>boundary(async()=>{negotiated(ctx);return service.catalog(await view(ctx),params);}));
  server.server.setRequestHandler('nox/tools/definitions',{params:z.record(z.string(),z.unknown())},(params,ctx)=>boundary(async()=>{negotiated(ctx);return service.definitions(await view(ctx),params as never);}));
  const listAuthorized=async(request:unknown,ctx:ServerContext)=>boundary(async()=>{const result=await listTools(request,ctx);return {...result,tools:(await view(ctx,result.tools)).definitions.map(d=>d.tool)};});
  server.registerTool = ((name:string,config:Record<string,unknown>,handler:(input:unknown,ctx:ServerContext)=>unknown) => {
    // Capture the SDK's public list handler during registration. Its own registry
    // remains authoritative, including schema conversion, icons and future fields.
    const previous=server.server.setRequestHandler;
    server.server.setRequestHandler=((method:string,...args:unknown[])=>{
      if(method==='tools/list'&&typeof args[0]==='function'){listTools=args[0] as typeof listTools;setHandler('tools/list',listAuthorized);}
      else if(method==='tools/call'&&typeof args[0]==='function'){
        const call=args[0] as (request:unknown,context:ServerContext)=>unknown;
        setHandler('tools/call',((request:{params:{name:string}},ctx:ServerContext)=>boundary(async()=>{service.guard(await view(ctx),request.params.name,ctx.mcpReq._meta as Record<string,unknown>);return call(request,ctx);})) as never);
      }
      else (setHandler as (...args:unknown[])=>void)(method,...args);
    }) as typeof server.server.setRequestHandler;
    try{return original(name,config as never,handler as never);}
    finally{server.server.setRequestHandler=previous;}
  }) as typeof server.registerTool;
}
