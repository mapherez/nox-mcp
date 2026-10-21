# Metadados CLI e discovery incremental NoX

Funcionalidade opcional do Passo 2B, ainda sem nova release. A versão pública mantém-se em `0.5.0`. As APIs existentes, os manifestos, a autenticação e as bridges mantêm os seus contratos.

## Compatibilidade e negociação

`tools/list` continua a devolver ferramentas MCP completas. `_meta.cli`, schemas, annotations e metadados personalizados continuam disponíveis para clientes convencionais. Os descritores avançados são documentos separados: não são inseridos em `_meta`, nem duplicam os schemas.

A extensão é identificada por `nox/discovery`, seguindo o formato MCP `prefixo/nome`. O servidor anuncia em `server/discover`:

```json
{
  "extensions": {
    "nox/discovery": { "versions": ["1.0"], "maxBatchSize": 64 }
  }
}
```

Os métodos são `nox/tools/catalog` e `nox/tools/definitions`, sobre o transporte MCP já utilizado: stdio ou Streamable HTTP. Não há um endpoint REST adicional.

O cliente consulta `server/discover`, verifica a extensão e escolhe `1.0`. Cada pedido da extensão inclui:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {
      "extensions": { "nox/discovery": { "version": "1.0" } }
    }
  }
}
```

As capacidades não são inferidas de um pedido anterior. Uma versão incompatível ou capacidades ausentes produzem `EXTENSION_NOT_NEGOTIATED`. Em protocolos anteriores, ou sem a extensão anunciada, o consumidor utiliza `tools/list` e a cache MCP convencional. Os helpers incrementais não fazem downgrade silencioso: o consumidor escolhe o caminho depois da descoberta.

Referências: [versionamento MCP](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [cache MCP](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching), [JCS, RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).

## Ferramentas e descritores

Uma ferramenta simples só precisa do contrato existente:

```json
{
  "name": "item_get",
  "title": "Consultar item",
  "inputSchema": {
    "type": "object",
    "properties": { "id": { "type": "string", "title": "Identificador" } },
    "required": ["id"]
  },
  "annotations": { "readOnlyHint": true },
  "_meta": { "cli": "item show" }
}
```

Os segmentos de `_meta.cli` definem o caminho de navegação. Um nó pode ter uma ação e subcomandos. Tipos, títulos, descrições, obrigatoriedade, enums e sugestões vêm do schema. `default` não insere argumentos automaticamente. `navigation` permite ajustar `label`, `group` e `order`; rótulos comuns de grupos/produtos podem ser publicados uma vez em `presentation` no catálogo. Apresentação não identifica servidores nem concede autorização.

Para uma operação de eliminação, o schema da ferramenta define `projectId`, `id`, `fingerprint` e `confirm`; pode exigir `confirm: {"const": true}`. O descritor associado pode ser:

```json
{
  "version": "1.0",
  "parameters": {
    "/projectId": {
      "options": { "tool": "project_list", "itemsPointer": "/projects" },
      "order": 10
    },
    "/id": {
      "options": { "tool": "item_list", "input": ["/projectId"] },
      "order": 20
    }
  },
  "preview": {
    "tool": "item_delete_preview",
    "input": ["/projectId", "/id"],
    "bind": { "/fingerprint": "/fingerprint" },
    "reviewPointer": "/summary"
  },
  "confirmation": {
    "mode": "typed",
    "message": "Confirme a eliminação do item apresentado.",
    "matchPointer": "/id",
    "bindPointer": "/confirm"
  }
}
```

Semântica comum:

- Caminhos são JSON Pointers RFC 6901; não são expressões executáveis.
- `options` implica `control: "select"`. Por omissão, a lista vem de `structuredContent` em `/items`, com valor `/id` e rótulo `/name` relativos a cada opção. Não se tenta interpretar blocos de texto como JSON.
- `input` copia os caminhos indicados dos argumentos principais para os mesmos caminhos da ferramenta auxiliar. Um valor ausente continua ausente; não há coerção de tipos. `input` e `arguments` são alternativas.
- `arguments` mapeia nomes de argumentos para bindings explícitos: `{"value":42}`, `{"from":"input","pointer":"/id"}` ou `{"from":"step","step":"preview","pointer":"/fingerprint"}`. O último lê `structuredContent` do passo indicado.
- As referências a argumentos definem dependências: mudar o projeto invalida a seleção do item e os resultados dependentes.
- No percurso compacto, `preview.bind` mapeia destinos nos argumentos principais para caminhos do resultado estruturado do preview; `reviewPointer` seleciona a informação a apresentar.
- `confirmation.mode` é `boolean` ou `typed`. Em `typed`, `matchPointer` é obrigatório e lê os argumentos principais. `bindPointer` só permite atribuir `true` depois da confirmação explícita. A aprovação fica associada aos argumentos e ao preview revistos; qualquer alteração invalida-a.
- Depois da confirmação, o cliente chama a própria ferramenta. Os auxiliares são resolvidos pelo nome canónico no mesmo servidor, com a autorização atual. Opções e previews devem ser ferramentas apropriadas para leitura; o cliente mantém a sua política de confiança.

Workflows mais longos usam `workflow`, uma lista sequencial de passos com `id` único e `type: "input" | "call" | "confirm"`. Passos `input` declaram `parameters`; passos `call` declaram `tool` e os bindings; passos `confirm` declaram `confirmation`. Referências a resultados só podem apontar para passos anteriores. Não se mistura `workflow` com o percurso compacto `preview`/`confirmation`.

```json
{
  "version": "1.0",
  "workflow": [
    { "id": "choose", "type": "input", "parameters": ["/id"] },
    {
      "id": "preview", "type": "call", "tool": "item_delete_preview",
      "arguments": { "id": { "from": "input", "pointer": "/id" } }
    },
    {
      "id": "approve", "type": "confirm",
      "confirmation": { "mode": "typed", "matchPointer": "/id", "bindPointer": "/confirm" }
    },
    {
      "id": "execute", "type": "call", "tool": "item_delete",
      "arguments": {
        "id": { "from": "input", "pointer": "/id" },
        "fingerprint": { "from": "step", "step": "preview", "pointer": "/fingerprint" },
        "confirm": { "from": "input", "pointer": "/confirm" }
      }
    }
  ]
}
```

`interpretCli` / `InterpretCLI` / `interpret_cli` validam e expandem as convenções de apresentação sem alterar o documento original. Não conduzem interações nem executam passos. Os campos opcionais desconhecidos são preservados. Novas funcionalidades que afetem execução devem declarar-se em `requires`; uma funcionalidade obrigatória desconhecida bloqueia o percurso avançado. A versão 1 reconhece `dynamic-options`, `preview`, `confirmation` e `workflow`.

A confirmação do cliente e as annotations são indicações, não autorização. O produto verifica permissões, revisão de domínio e validade do preview no executor, incluindo chamadas feitas por clientes genéricos.

## Integração TypeScript

Os exports estão na entrada existente `@nox/mcp`. Ferramentas simples continuam a usar `createServer` sem opções adicionais.

```ts
import { createServer, createHttpHandler, interpretCli } from '@nox/mcp';
import { z } from 'zod';

const tool = {
  name: 'item_get', description: 'Consultar item', _meta: { cli: 'item show' },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ name: z.string() }),
  execute: async (input: unknown) => ({ name: (input as { id: string }).id }),
};

const options = {
  appId: 'example', name: 'example', version: '1', tools: [tool],
  discovery: {
    serverId: 'example-installation-01',
    descriptors: { item_get: interpretCli({ version: '1.0' }) },
    resolveView: async (context, tools) => {
      const policy = await resolveCurrentPolicy(context); // fornecido pelo produto
      return {
        viewId: policy.opaqueRevision,
        visible: tools.filter(t => policy.canCall(t.name)).map(t => t.name),
        unavailable: policy.unavailableTools,
      };
    },
  },
};
const server = createServer(options); // ligar ao transporte stdio existente
const http = createHttpHandler(options); // ou montar o handler HTTP existente
```

`createServerFromManifest` aceita a mesma opção `discovery`. `installDiscovery(server, options)` permite integrar um `McpServer` do SDK diretamente; instalar **antes** de registar ferramentas. Os handles devolvidos por `registerTool` continuam a permitir `update`, `remove`, `enable` e `disable`. A listagem padrão e a extensão usam esses mesmos handles. `discovery.service` permite partilhar um `DiscoveryService` entre fábricas; `createHttpHandler` faz essa partilha automaticamente.

Para o cliente, fornecer um adaptador que envie o método e os parâmetros no transporte MCP já ligado, devolvendo o objeto `result` ou rejeitando erros JSON-RPC:

```ts
import { DiscoveryCache, discoveryMeta } from '@nox/mcp';

// Uma instância por origem de confiança e partição de credenciais, sem guardar a API Key.
const cache = new DiscoveryCache('configured-server-01', 'account-a:tenant-01');
await cache.sync(requestMcp); // requestMcp(method, params) -> Promise<result>
await cache.sync(requestMcp); // definições inalteradas não voltam a ser pedidas

const definition = cache.definitions.get('item_get');
await requestMcp('tools/call', {
  name: definition.tool.name, arguments: { id: '42' },
  _meta: {
    ...discoveryMeta(),
    'nox/discovery': { expectedFingerprint: definition.fingerprint },
  },
});
```

`sync` serializa sincronizações concorrentes, verifica hashes e só faz commit quando todas as páginas e lotes são válidos. `clear()` impede também o commit de uma sincronização antiga ainda em curso.

## Integração Go

As APIs antigas `New` e `NewFromManifest` não mudam. Utilizar `NewWithDiscovery(options, discoveryOptions)` ou `NewFromManifestWithDiscovery(options, manifestBytes, discoveryOptions)` para ativar a extensão no runtime.

```go
runtime, err := noxmcp.NewWithDiscovery(options, noxmcp.DiscoveryOptions{
    ServerID: "example-installation-01",
    Descriptors: map[string]noxmcp.JSON{
        "item_get": {"version": "1.0"},
    },
    ResolveView: func(ctx context.Context, extra *mcp.RequestExtra, tools []*mcp.Tool) (
        string, []string, []string, noxmcp.JSON, error,
    ) {
        // Resolve live policy from the trusted context/extra.TokenInfo.
        return policyRevision, visibleNames, unavailableNames, nil, nil
    },
})
// runtime.HTTPHandler() ou runtime.ServeStdio(ctx)
```

Uma lista `visible` nula permite todas as ferramentas registadas; uma lista vazia oculta todas. O mesmo resolvedor é aplicado à listagem padrão, às definições e às chamadas. O resolvedor tem de incluir as restrições de autorização do produto; as verificações de scopes já existentes no runtime continuam a aplicar-se na execução.

Para um `mcp.Server` próprio, anunciar `DiscoveryCapability()` em `ServerOptions.Capabilities.Extensions` e chamar `InstallDiscovery`. Instalar middleware que prepara o contexto **depois** de `InstallDiscovery`, para ficar exterior ao middleware da extensão, conforme a ordem do SDK Go. O middleware HTTP de autenticação continua exterior ao handler.

```go
caps := &mcp.ClientCapabilities{}
caps.AddExtension(noxmcp.DiscoveryExtension, noxmcp.JSON{"version": noxmcp.DiscoveryVersion})
client := mcp.NewClient(info, &mcp.ClientOptions{Capabilities: caps})
if err := noxmcp.RegisterDiscoveryClient(client); err != nil { /* handle */ }
// session := client.Connect(...) usando o transporte existente
cache, _ := noxmcp.NewDiscoveryCache("configured-server-01", "account-a:tenant-01")
err = cache.Sync(ctx, noxmcp.DiscoverySessionRequest(session))
definitions := cache.Definitions()
```

`DiscoveryCache.Sync` aceita também um callback `DiscoveryRequest` para outros adaptadores. `Definitions()` devolve cópias. `Clear()` elimina o estado sob o mesmo lock da sincronização.

## Integração Rust

O construtor e `ServerOptions` existentes mantêm-se. Acrescentar `.with_discovery(...)` ao servidor:

```rust
use nox_mcp::discovery::{Discovery, ServerDiscovery, View};
use std::sync::Arc;

let server = server.with_discovery(ServerDiscovery {
    service: Discovery::new("example-installation-01")?,
    resolve_view: Arc::new(move |context, tools| {
        let policy = resolve_current_policy(context)?; // fornecido pelo produto
        let definitions = tools.iter().filter(|t| policy.can_call(&t.name))
            .map(|tool| serde_json::json!({"tool": tool})).collect();
        Ok(View { id: policy.opaque_revision, definitions, presentation: None })
    }),
});
```

Cada elemento de `definitions` pode acrescentar `cli` e `availability`. O resolvedor só pode selecionar ferramentas reais e acrescentar esses campos: uma definição MCP substituída é rejeitada. Não usar metadados enviados pelo cliente para conceder acesso. A aplicação continua a fornecer o contexto autorizado e o executor.

O mesmo servidor pode ser ligado ao stdio ou ao `StreamableHttpService` do `rmcp`. Em fábricas HTTP, clonar um servidor/configuração partilhados conserva a memoização de fingerprints.

```rust
use nox_mcp::discovery::Cache;
let mut cache = Cache::new("configured-server-01", "account-a:tenant-01")?;
cache.sync(|method, params| request_mcp(method, params)).await?;
let definitions = cache.definitions();
```

O callback assíncrono devolve o `result` como `serde_json::Value` ou `DiscoveryError`. Pode usar o cliente `rmcp` e `ClientRequest::CustomRequest`; os parâmetros já incluem os metadados de negociação. Configurar também a capacidade da extensão no cliente para que o SDK a publique nos pedidos. Consultar `server/discover` antes de escolher a sincronização incremental.

Os servidores de teste em `scripts/fixtures/`, `go/testdata/` e `rust/examples/discovery_fixture.rs` mostram a montagem completa dos transportes. **A política `test/policy` nesses fixtures é uma simulação exclusiva de testes, não um mecanismo de autenticação para produtos.**

## Catálogo, snapshots e fingerprints

`nox/tools/catalog` aceita `ifCatalog` ou paginação com `catalog`, `cursor` e `limit`. O limite predefinido é 1 000 entradas; o máximo solicitado é 10 000. A resposta contém `serverId`, `viewId`, `catalog`, `ttlMs`, `cacheScope: "private"` e entradas `{name, fingerprint, availability?}`. Um catálogo igual produz `notModified: true` sem reenviar entradas.

`nox/tools/definitions` recebe `{catalog, tools: [{name, fingerprint}]}` e devolve `{resultType:"complete", catalog, definitions:[{fingerprint,tool,cli?}]}`. O máximo é 64 definições por pedido, sujeito ao limite de bytes (4 MiB por omissão no serviço de discovery). Um lote demasiado grande produz `PAYLOAD_LIMIT`; o consumidor pode repetir com lotes menores. Os helpers não persistem estado parcial.

O snapshot é o hash da identidade do servidor, visão autorizada, entradas ordenadas e apresentação comum. Todas as páginas e pedidos de definições têm de coincidir com a visão atual. Uma alteração produz `STALE_CATALOG`: reiniciar a sincronização. Não há histórico de snapshots nem definições antigas consultáveis por hash. Um snapshot idêntico continua válido porque representa o mesmo conteúdo e contexto; TTL é uma indicação de frescura, não uma autorização nem uma data de expiração do token.

Só remover entradas ausentes depois de receber todo o catálogo. Falhas de rede, respostas incompletas, duplicados, alteração de snapshot ou hash incorreto deixam a cache anterior intacta. Uma revogação completa devolve um catálogo vazio autorizado; um erro de autenticação exige que o consumidor deixe de usar o contexto/cache correspondente.

O fingerprint é `base64url(SHA-256(JCS({tool,cli?})))`, sem padding: 43 caracteres. Inclui todos os schemas, annotations e metadados publicados. Não inclui `availability`, TTL, apresentação comum, envelopes nem o próprio hash. Ausência difere de `null`; arrays mantêm a ordem; nomes e chaves usam ordenação UTF-16. Não se normaliza Unicode. JCS rejeita números não finitos e strings inválidas e representa números segundo binary64/ECMAScript, incluindo o arredondamento dos tokens inteiros JSON. Trabalhar com valores JSON; um parser que já perdeu informação não a consegue recuperar. Não usar números JSON para identificadores de precisão arbitrária: estes devem ser strings. Os vetores comuns incluem os extremos e os limites de arredondamento IEEE 754 da RFC.

Os serviços memoizam hashes por conteúdo, com um limite interno de 4 096 entradas. A consulta continua a percorrer o inventário autorizado: a primeira versão não implementa um log de deltas. Mudanças de código do executor não representadas na definição não alteram o hash.

O cliente usa uma cache por origem configurada de confiança e partição local de credenciais, separada ainda por `serverId`, `viewId` e pelo perfil fixo de protocolo/extensão. Não usar apenas `serverInfo.name`. O servidor fornece um `serverId` estável por instalação e um `viewId` opaco que distingue utilizadores, tenants e revisões relevantes de política. Não incluir tokens ou API Keys nesses campos. `sync` revalida sempre o catálogo; o consumidor pode evitar a chamada enquanto a cache estiver fresca, respeitando TTL e notificações MCP aplicáveis.

`expectedFingerprint`, quando fornecido em `_meta["nox/discovery"]` numa chamada, compara a definição atual antes do dispatch para o executor. `STALE_DEFINITION` exige atualizar a definição e repetir qualquer revisão/consentimento. `FORBIDDEN` oculta ferramentas fora da visão; `UNAVAILABLE` impede executar uma ferramenta temporariamente indisponível. As rejeições da extensão usam JSON-RPC `-32602` com `data.reason`. Os erros de domínio do executor mantêm os envelopes MCP existentes. O consumidor deve tratar ambos como falha, sem interpretar texto como autorização. Os clientes verificam também o hash do catálogo completo antes de aceitar remoções.

## Gestão dos contratos e testes

`contracts/` é a fonte oficial. Os novos schemas estão separados dos seis contratos da 0.5.0. O corpus `discovery-conformance.json` cobre schemas, descritores, números e Unicode. O gerador publica os schemas TypeScript e copia schemas/corpus para os pacotes nativos; não são necessários scripts Node na compilação externa Go/Rust.

Para alterar um contrato:

1. Alterar a fonte em `contracts/`, preservando as APIs e os contratos anteriores.
2. Acrescentar casos positivos/negativos e vetores comuns; comportamentos novos obrigatórios exigem negociação explícita.
3. Executar `npm run contracts:sync`.
4. Executar `npm test`, `go test -mod=readonly ./...`, `cargo test --locked --manifest-path rust/Cargo.toml`, `npm run test:conformance`, `npm run test:discovery` e `npm run test:native-packages`.
5. Executar `npm run benchmark:discovery` e rever a evolução dos payloads.

O CI compara as observações das três linguagens e exercita servidores reais nos seis pares linguagem/transporte. Os testes existentes da 0.5.0 continuam ativos. Os testes de pacotes confirmam a utilização fora do checkout.

## Medições e limites

`npm run benchmark:discovery` mede pedidos e respostas JSON-RPC minificados, em bytes UTF-8, sem compressão. Usa catálogos sintéticos com schemas iguais nos dois percursos e descritores opcionais em 25% das ferramentas:

| Ferramentas | `tools/list` completo | Incremental inicial | Sem alterações | Uma alterada | Uma removida |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 17 799 | 21 173 | 526 | 3 853 | 1 318 |
| 100 | 175 929 | 203 851 | 526 | 11 863 | 9 328 |
| 1 000 | 1 758 129 | 2 033 665 | 526 | 91 963 | 89 428 |

Uma ferramenta alterada reduz a transferência em 78,4%, 93,3% e 94,8%, respetivamente. A primeira carga custa mais porque transfere o catálogo e os descritores. Uma cache MCP convencional ainda fresca também pode transferir zero bytes. Estes números não são medições de latência nem de produtos em produção; compressão e composição dos schemas alteram os resultados.

Não existem nesta implementação renderização terminal, execução automática de workflows, armazenamento persistente de cache, discovery entre servidores ou produtos CLI/Gateway. Os auxiliares de seleção/preview e a sua autorização pertencem ao servidor do produto. As dependências novas de produção Rust são `sha2`, `base64` e `ryu-js`, necessárias ao hash e à representação JCS; `axum` é apenas uma dependência de desenvolvimento para testar HTTP real. Os SDKs MCP existentes não foram atualizados.
