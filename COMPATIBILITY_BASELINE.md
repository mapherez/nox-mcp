# NoX MCP — baseline de compatibilidade

Data: 20 de outubro de 2026. Âmbito: análise do código local, sem alterações às implementações, dependências, schemas ou configurações.

## 1. Conclusão e âmbito da auditoria

O NoX MCP já fornece infraestrutura utilizada no código de quatro produtos: registo e descoberta de ferramentas, validação, resultados estruturados, controlo de execução e integração com transportes. O NoteX depende também das pontes desktop e dos brokers Rust. **A compatibilidade a preservar inclui estes comportamentos, os pontos de importação e as integrações específicas dos produtos; não se limita aos schemas JSON.**

Existe uma base útil para estudar novos contratos, mas ainda não há uma garantia uniforme de compatibilidade entre linguagens e versões. Há versões diferentes no NoteX, diferenças reais no tratamento de manifestos e cobertura desigual dos caminhos críticos. Não é possível concluir que uma atualização conjunta de todos os consumidores seria segura apenas porque os testes da biblioteca passam.

Foram analisadas as árvores de trabalho dos seguintes repositórios, inicialmente sem alterações indicadas por `git status`:

| Repositório local | Commit analisado |
| --- | --- |
| `nox-mcp` | `f19da3383dba682d8bfb9a613918786a4d6cb3e9` (`v0.4.3`) |
| `nox-backend` | `c5d945155b6a12130daba62b8534ab0f7129eeb0` |
| `nox-yard` | `253fff86e24e8056b9adccdd48e174b9d9b2ff28` |
| `notex` | `ce80f24395d4ca562449eb1f1bea47b7bcd46d67` |
| `nox-bot` | `fc1d4743c4785fdc160a4465526da3515a4932b6` |

A pesquisa de referências diretas abrangeu os ficheiros versionados de 30 repositórios em `D:/Projects_2`, incluindo estes cinco. Não foram identificados outros consumidores diretos nos ficheiros pesquisáveis, incluindo os projetos `nox-sync`, `nox-mobile`, `nox-AI`, `nox-bookmarks` e `notex_OLD`. Isto não exclui consumidores remotos, dependências indiretas ou ficheiros não versionados. No `metro-motion`, dois ficheiros da árvore de trabalho (`packages/shared-types/package.json` e `packages/shared-utils/package.json`) deram erro de permissões; a pesquisa dos manifests/lockfiles no respetivo `HEAD` não encontrou referências. Os quatro consumidores pedidos estavam acessíveis.

Não foram consultadas instalações em produção nem confirmadas as versões efetivamente em execução. As versões abaixo são as declaradas/resolvidas no código local. Não se consultaram branches remotos ou registos para inferir versões mais recentes.

## 2. Arquitetura atual

O repositório é uma biblioteca multilinguagem, sem serviço central de encaminhamento entre produtos:

- `contracts/`: seis schemas JSON Schema draft-07 e um ficheiro de valores por omissão.
- `typescript/`: pacote ESM `@nox/mcp`, com ferramentas baseadas em Zod, servidor MCP, HTTP, integração Node, autorização Better Auth e ponte WebSocket cliente/servidor.
- `go/`: pacote `github.com/mapherez/nox-mcp/go`, com runtime de ferramentas, HTTP/stdio, autorização Bearer/JWT, validação de frames e cliente de ponte WebSocket.
- `rust/`: crate `nox-mcp`, com servidor baseado em `rmcp`, carregamento de ferramentas, resultados, validação, broker para renderer e registo de execuções por geração. O transporte HTTP e a ligação WebSocket concretos do NoteX são montados pelo próprio produto.
- `scripts/` e `.github/workflows/release.yml`: sincronização de versões, testes, validação do pacote e publicação por tag.

Os seis schemas em `contracts/`, `go/contracts/` e `rust/contracts/` são atualmente idênticos. Os defaults TypeScript e os de `contracts/defaults.json` são semanticamente iguais; Go e Rust mantêm constantes próprias para parte desses valores. Não foi encontrado um teste dedicado que impeça estas cópias de divergirem.

As implementações partilham conceitos, mas **não expõem APIs nem mecanismos de validação totalmente equivalentes**. A infraestrutura própria centra-se em ferramentas; não existem contratos partilhados para menus, workflows, páginas ou módulos do Portal. Os nomes `GatewayOptions`/`installBridgeServer` no TypeScript referem-se à ponte desktop existente, não ao futuro NoX MCP Gateway.

## 3. API pública a preservar

### TypeScript / Node.js

O mapa `exports` de [package.json](package.json) é parte do contrato de instalação. Não existe uma entrada pública `@nox/mcp/http` nem uma exportação CommonJS `require`.

| Entrada pública | Superfície exposta |
| --- | --- |
| `@nox/mcp` | `createServer`, `createHttpHandler`; tipos `ExecutionContext`, `ToolDefinition`, `ServerOptions`, `HttpHandlerOptions`; reexportações de `contract` |
| `@nox/mcp/contract` | `defaults`; constantes `BRIDGE_PROTOCOL_VERSION`, `LEGACY_BRIDGE_PROTOCOL_VERSION`, `BRIDGE_REQUEST_TIMEOUT_MS`, `BRIDGE_HEARTBEAT_INTERVAL_MS`, `BRIDGE_OFFLINE_AFTER_MS`, `BRIDGE_TICKET_TTL_SECONDS`, `MAX_BRIDGE_FRAME_BYTES`, `MAX_IN_FLIGHT_REQUESTS`; `bridgeDeliveryPolicy`; `McpError`/`McpErrorBody`; schemas e funções descritos abaixo |
| `@nox/mcp/bridge` | `BridgeRegistry`; interfaces `BridgeSocket`, `SessionStore`, `BridgeConnection`, `BridgeOptions` |
| `@nox/mcp/bridge/client` | `connectBridge`, `BridgeClientOptions`; devolve um objeto com `close()` assíncrono |
| `@nox/mcp/bridge/server` | `installBridgeServer`, `closeSocket`, `GatewayOptions`, `GatewayLogger`; instalação devolve uma função de encerramento assíncrona |
| `@nox/mcp/node` | Reexportações SDK `toNodeHandler` e `serveStdio` |
| `@nox/mcp/better-auth` | `protectWithBetterAuth`, interface `Auth` |

Em `contract`, são públicos `bridgeErrorSchema`, `bridgeTicketSchema`, `bridgeAuthenticateSchema`, `bridgeReadySchema`, `bridgeRequestSchema`, `bridgeCancelSchema`, `bridgeResponseSchema`, `serverBridgeMessageSchema`, `desktopBridgeMessageSchema`, `toolManifestSchema`, `createResponseSchema`, `parseFrame` e os tipos `BridgeRequest`, `BridgeResponse`, `BridgeFrame`, `ToolManifestEntry`, `ToolManifest`.

`ToolDefinition` recebe nome, título opcional, descrição, `_meta` arbitrário, schemas Zod de entrada/saída, scopes, anotações e `execute`. O contexto entrega `requestId`, `appId`, `userId`, scopes, prazo ISO e `AbortSignal`. `ServerOptions` permite configurar identidade, ferramentas, autenticação, limites e `formatError`. `createServer` devolve diretamente o `McpServer` do SDK, expondo também essa dependência ao consumidor.

`BridgeRegistry` é extensível: o NoteX herda desta classe. São públicos `issueTicket`, `consumeTicket`, `attach`, `markReady`, `markPong`, `getPresence`, `dispatch`, `acceptResponse`, `detach`, `revokeUserConnection`, `closeStaleConnections` e `close`. Também fazem parte da integração os callbacks de sessões, validação de entrada/saída, classificação de leituras, schema de resposta e fábrica de erros. Os campos públicos de `BridgeConnection` incluem identidade, socket, estado, versão, geração, heartbeat e pedidos pendentes.

Fontes: [index.ts](typescript/src/index.ts), [contract.ts](typescript/src/contract.ts), [http.ts](typescript/src/http.ts), [bridge.ts](typescript/src/bridge.ts), [bridge-client.ts](typescript/src/bridge-client.ts), [bridge-server.ts](typescript/src/bridge-server.ts), [better-auth.ts](typescript/src/better-auth.ts).

### Go

| API pública | Contrato atual |
| --- | --- |
| `Error` | `Code`, `Message`, `Retryable`, `Details` e método `Error()`; serialização JSON com nomes em camelCase |
| `Tool`, `Options`, `New` | Schemas `*jsonschema.Schema`, metadados `Meta`, scopes, flags `ReadOnly`/`Destructive`/`Idempotent`, executor e limites |
| `Runtime` | Campo público `Server *mcp.Server`; métodos `Execute`, `HTTPHandler`, `ServeStdio` |
| `ExecutionContext` | Integra `context.Context`; expõe `RequestID`, `AppID`, `UserID`, `Scopes`, `DeadlineAt` e `CheckActive()` |
| `Protect`, `JWTVerifier` | Adaptadores de autenticação; dependem dos tipos do SDK e de `jwt.Keyfunc` |
| `Contracts`, `ValidateFrame`, `ValidateFrameWithLimit` | Schemas embebidos e validação por nome (`desktop`, `error`, `manifest`, `request`, `response`, `server`) |
| `BridgeOptions`, `RunBridge` | Cliente WebSocket de uma ligação, com runtime e identidade fornecidos pela aplicação |
| `CredentialStore[T]` | `Load`, `Save`, `Delete`, com `context.Context`; armazenamento concreto pertence ao produto |
| Constantes | `BridgeProtocolVersion`, `DefaultTimeoutMS`, `MaxPayloadBytes`, `MaxInFlightRequests` |

Os executores recebem/devolvem `map[string]any`. `Execute` permite execução direta sem transporte; o HTTP acrescenta o envelope MCP. Go não expõe aqui um registo de ligações servidor equivalente a `BridgeRegistry`, nem uma função equivalente a `load_tools` Rust.

Fontes: [nox.go](go/nox.go), [contracts.go](go/contracts.go), [jwt.go](go/jwt.go), [bridge.go](go/bridge.go), [defaults.go](go/defaults.go).

### Rust

| API pública | Contrato atual |
| --- | --- |
| `RequestEvent` | `request_id`, `command`, `input`, `deadline_at`, `generation`; serialização em camelCase |
| `BrokerError`, `BrokerOptions`, `RequestBroker<T>` | Erros `InvalidRequest`, `Overloaded`, `RendererUnavailable`, `Timeout`, `Cancelled`, `UnknownRequest`; métodos `new`, `is_pending`, `dispatch`, `respond`, `cancel`, `cancel_all` |
| `ExecutionRegistry` | `default`, `with_limit`, `open`, `register`, `register_for`, `is_pending`, `cancel`, `clear`, `generation`; controlo de geração, duplicados e prazos |
| `now_ms`, `parse_deadline`, `validate_schema` | Tempo em milissegundos, leitura de RFC3339 e validação JSON Schema com formatos |
| `load_tools` | Manifesto JSON para `Vec<rmcp::model::Tool>`; exige schema `1`, protocolo de ponte `2.0`, nomes únicos e schemas de ferramentas do tipo objeto |
| `tool_result`, `error_result` | Construção de `CallToolResult` estruturado com cópia textual JSON |
| `ExecutionContext`, `ServerOptions`, `Executor` | Contexto com identidade, scopes, prazo numérico e `CancellationToken`; `is_active()`; scopes exigidos configurados por nome de ferramenta |
| `McpServer<E>` | `new`, implementação de `ServerHandler`; campos públicos `name`, `version`, `instructions`, `tools`, `executor` |
| `ServerFrame`, `parse_server_frame` | Frames recebidos do servidor; `into_request()` converte um pedido para `RequestEvent` |
| `CredentialStore<T>` | Trait com tipo associado `Error` e métodos `load`, `save`, `delete` |
| Constantes | `BRIDGE_PROTOCOL_VERSION`, `DEFAULT_TIMEOUT_MS`, `MAX_PAYLOAD_BYTES`, `MAX_IN_FLIGHT_REQUESTS` |

Fonte: [lib.rs](rust/src/lib.rs) e [defaults.rs](rust/src/defaults.rs). Os tipos `Tool` e `CallToolResult` pertencem a `rmcp`; não são contratos independentes desse SDK.

## 4. Comportamentos e contratos existentes

### Ferramentas, resultados e execução

- Preservar nomes canónicos, schemas de entrada/saída, títulos/descrições, anotações e metadados descobertos. `_meta` é opcional e arbitrário; `_meta.cli` já é usado pelos quatro produtos como caminho local de comando. Não existe ainda uma convenção versionada para menus ou workflows.
- Preservar `structuredContent` e o conteúdo textual JSON equivalente. Erros de ferramenta usam `isError` e um corpo estruturado; erros HTTP/JSON-RPC de transporte são uma fronteira diferente.
- O erro base tem `code`, `message`, `retryable` e `details` opcional. Os códigos são extensíveis, não um enum fechado da biblioteca. Produtos acrescentam códigos e, no NoteX, `currentVersion` através de schemas/callbacks próprios.
- Preservar validação de entrada/saída, recusa de execução sem scopes exigidos, limites de payload e concorrência, timeout, cancelamento e sanitização de erros internos. Estes controlos não substituem a autorização de domínio dos produtos.
- Timeout/cancelamento não garantem rollback de efeitos. Nos caminhos normais de término antecipado, operações de escrita podem devolver `details.outcome = "unknown"`, enquanto leituras podem ser repetíveis. Os executores continuam responsáveis por verificar atividade antes de efeitos após trabalho assíncrono.
- TypeScript e Go mantêm ocupada a vaga de execução enquanto o trabalho do executor não terminar, mesmo quando o cliente já recebeu um timeout. Em Rust, o timeout/cancelamento interrompe a espera pelo future; tarefas destacadas pelo produto continuam a exigir cuidados próprios.
- Os identificadores de execução não têm um único formato entre linguagens: UUID em TypeScript, hexadecimal no runtime Go e `nox-N` no servidor Rust. O formato UUID obrigatório dos frames de ponte é outro contrato.

### Ponte desktop e defaults

| Valor | Baseline |
| --- | --- |
| Protocolo da ponte atual / legado | `2.0` / `1.0` |
| Versão do schema de manifesto | `1` |
| Timeout de pedido | 20 000 ms |
| Heartbeat / estado offline | 15 000 ms / 45 000 ms |
| Validade do ticket | 30 segundos |
| Payload / pedidos em simultâneo | 2 097 152 bytes / 32 |

Frames desktop: `authenticate`, `ready`, `response`. Frames servidor: `authenticated`, `request`, `cancel`, `session_revoked`. Pedidos transportam `requestId`, `command`, `input`, `deadlineAt`; respostas distinguem `ok: true/result` de `ok: false/error`. Tickets têm 32–512 caracteres e alfabeto base64url. UUID, UTF-8, tamanho e prazo são validados nas fronteiras correspondentes.

A política TypeScript declarada é sem fila, sem replay, falha dos pedidos pendentes ao desligar e ticket de utilização única. Uma nova ligação substitui a anterior do utilizador. O cancelamento remoto é enviado apenas a ligações de protocolo `2.0`; o registo aceita também `1.0`. Revogação de sessão, heartbeat e respostas tardias não podem reativar trabalho antigo. Clientes de ponte TypeScript/Go exigem `wss`, admitindo `ws` para loopback.

**Não confundir os dois usos de `RequestEvent`:** o broker Rust local gera IDs com prefixo e `deadlineAt` como string de milissegundos; os frames WebSocket exigem UUID e data RFC3339. O renderer do NoteX aceita ambos. Unificar estes formatos sem atender aos consumidores quebraria a integração local.

### HTTP e autenticação

O HTTP TypeScript `0.4.3` é stateless, com JSON por omissão e SSE por opção. Suporta os fluxos legado (`initialize`, `tools/list`, `tools/call`) e moderno (`server/discover` e chamadas de ferramentas). O legado responde à notificação de inicialização com `202` vazio; GET/DELETE recebem `405`. A negociação respeita `Accept`, incluindo exclusões `q=0`; pedidos incompatíveis recebem `406` antes de executar ferramentas. Subscrições modernas continuam a usar SSE. JSON não entrega notificações intermédias. O handler expõe `fetch`, `notify`, `bus` e `close`; desligar/encerrar cancela trabalho ativo e resolve os intercâmbios pendentes.

O corpo HTTP TypeScript está limitado separadamente a 4 MiB; `maxPayloadBytes` limita entrada e resposta das ferramentas. O envelope duplica o resultado em texto e estrutura, pelo que o tamanho do objeto de domínio não corresponde diretamente ao tamanho final. Go usa HTTP stateless com `JSONResponse: true`, limita o corpo pelo valor configurado e anuncia os protocolos MCP `2025-11-25` e `2026-07-28`. O NoteX configura o HTTP Rust no próprio produto.

`protectWithBetterAuth` e `Protect` exigem verificação da autorização ativa por pedido, além da validade do token. `JWTVerifier` exige issuer, audience, expiração e subject, com algoritmos RS256/ES256/EdDSA e resolução de chaves confiada à aplicação. Estes adaptadores não são um mecanismo universal de API Key: Backend, Yard, NoteX e Bot têm fronteiras diferentes, descritas abaixo.

Os limites pertencem às instâncias de runtime/servidor. Em particular, a fábrica HTTP TypeScript cria servidores para os pedidos; não se deve interpretar `maxInFlightRequests` como quota global automática de um serviço. O Yard acrescenta o seu próprio limite global HTTP.

## 5. Consumidores e versões efetivas no código

| Produto / componente | Linguagem | Dependência declarada e resolução local |
| --- | --- | --- |
| NoX Backend, `backend/` | Go | `github.com/mapherez/nox-mcp v0.4.3`, confirmado em `go.mod`/`go.sum`; sem `replace` local |
| NoX Yard | Go | Mesmo módulo `v0.4.3`, confirmado em `go.mod`/`go.sum`; sem `replace` local |
| NoX Bot | TypeScript | Tarball GitHub Release `v0.4.3`; lockfile resolve `@nox/mcp 0.4.3` |
| NoteX, raiz | TypeScript | Tarball `v0.4.3`; lockfile resolve `node_modules/@nox/mcp` para `0.4.3` |
| NoteX, `backend/` | TypeScript | Tarball `v0.4.1`; lockfile mantém `backend/node_modules/@nox/mcp 0.4.1` |
| NoteX, `packages/notex-mcp-contract/` | TypeScript | Tarball `v0.4.1`; lockfile mantém uma cópia `0.4.1` neste workspace |
| NoteX, `src-tauri/` | Rust | Dependência Git sem tag/rev no manifest; lockfile fixa `fd1b688d700b37caf96961c15f6d7022a09ab7a4`, com versão interna da crate `0.1.0` |

No NoteX, atualizar apenas a dependência da raiz não atualiza necessariamente o backend ou o pacote de contratos. O código de `scripts/update-nox-mcp.mjs` procura as declarações nos workspaces; o estado atual dos manifests continua misto. A dependência Rust é resolvida pelo Cargo separadamente.

### NoX Backend

[mcp.go](../nox-backend/backend/internal/app/mcp.go) importa o pacote Go e usa `New`, `Tool`, `Options`, `Runtime.HTTPHandler`, `ExecutionContext.CheckActive` e `Error`. Constrói schemas a partir dos mesmos tipos Go usados na execução. Expõe dez ferramentas: saúde, informação, identidade, seis operações de vault e listagem de ficheiros. Atribui `_meta.cli` a todas e rejeita mapeamentos em falta/duplicados.

O endpoint `/mcp` usa os limites por omissão. Saúde e informação são públicas; as restantes operações resolvem a API Key através do código do Backend e transportam utilizador/erro num contexto privado. Não usam `Protect`/`JWTVerifier` da biblioteca. Devem continuar a existir erros estruturados `AUTH_REQUIRED`/`AUTH_FAILED`, autorização por proprietário e os códigos de domínio, em vez de uma exigência global de OAuth para todo o catálogo. A conversão de resultados preserva inteiros `int64` de revisões/tamanhos, evitando arredondamento por `float64`.

### NoX Yard

[server.go](../nox-yard/internal/mcpapi/server.go) usa `Tool`, `New`, `Runtime`, `Error` e o contexto Go para adaptar a fachada de aplicação. Expõe ferramentas de inventário, configuração, containers/projetos, Compose, remoção, jobs e atualização, com `_meta.cli` e anotações explícitas. Tem limites próprios: **60 segundos, 8 MiB e 32 execuções**.

A autenticação está em [machine.go](../nox-yard/internal/httpapi/machine.go): listener MCP próprio, `/mcp`, desativado por omissão, token Bearer de máquina ou modo anónimo explicitamente configurado. Uma credencial fornecida mas inválida nunca recua para anónimo. As políticas `Write`/`Secrets` filtram a descoberta e são verificadas novamente na execução. `NewHandler` prepara quatro catálogos e acrescenta um limite global de 32 pedidos HTTP. Não é correto descrever o estado atual como um endpoint sempre ativo e anónimo.

Preservar erros e resultados parciais da fachada, identificadores de alvos, confirmações/fingerprints de operações destrutivas, seguimento por jobs e o campo legado `intervalMinutes` da ferramenta de atualização. O timeout não confirma o resultado de uma mutação.

### NoteX

O [backend MCP](../notex/backend/src/mcp.ts) usa `createHttpHandler`, `resolveAuth`, `requiredScopes` e `formatError`. `protectWithBetterAuth` protege tanto MCP como a API desktop, com verificação ativa de autorização. Os scopes são `notex:read`, `notex:create`, `notex:edit`, `notex:delete`; a identidade é passada em `authInfo.extra.userId`.

O [registo de ponte](../notex/backend/src/bridge/registry.ts) herda de `BridgeRegistry`, fornece schemas e erros próprios e adapta presença offline em `notex_status`. A [instalação WebSocket](../notex/backend/src/bridge/server.ts) fornece `parseDesktopFrame` próprio. Sessões, tickets, revogação e substituição de ligações são parte da integração efetiva.

O [pacote de contratos do NoteX](../notex/packages/notex-mcp-contract/src/index.ts) importa constantes, defaults, `createResponseSchema`, ticket e `parseFrame`; define 34 ferramentas, aliases CLI, schemas de domínio e um manifesto próprio. O backend transforma estas definições em ferramentas TypeScript e o desktop carrega o manifesto via `load_tools` Rust.

No desktop, [mcp_local_server.rs](../notex/src-tauri/src/mcp_local_server.rs) implementa `Executor`, cria `McpServer` e monta HTTP JSON stateless em loopback. [mcp_request_broker.rs](../notex/src-tauri/src/mcp_request_broker.rs) usa `RequestBroker<DesktopResponse>` com prefixo `local-mcp-`. [mcp_bridge.rs](../notex/src-tauri/src/mcp_bridge.rs) implementa o armazenamento de credenciais e usa `ExecutionRegistry`, `ServerFrame`, `parse_server_frame` e `parse_deadline`. O renderer verifica prazos numéricos ou ISO e a atividade dos pedidos antes de mutações.

Devem ser preservados `expectedVersion`, `currentVersion`, conflitos, edições locais pendentes, tradução de erros offline e a separação entre operações locais e remotas. O NoteX mapeia `APP_OFFLINE`/`CANCELLED` para `NOTEX_OFFLINE`; os seus erros próprios não conservam todos os `details` do erro base. Esta é uma diferença já existente, não uma garantia uniforme de informação sobre resultados incertos.

### NoX Bot

[mcp.ts](../nox-bot/src/services/mcp.ts) usa `ToolDefinition`, `ExecutionContext`, `McpError` e `toNodeHandler`. Expõe 14 ferramentas de estado, guild, canais, envio de mensagens, plugins e Quick Commands. Todas têm `_meta.cli`; entradas usam objetos Zod estritos. Os erros de domínio são adaptados por `formatError`, incluindo `WRITE_UNCONFIRMED` com resultado desconhecido.

O endpoint `/mcp/guilds/:guildId` é montado no listener do dashboard e não exige autenticação própria. A execução fica ligada à guild do URL e volta a validar a instalação e as permissões relevantes. Preservar revisões, isolamento entre guilds, redação de segredos, cancelamento antes de enviar mensagens e encerramento que aguarda operações aceites.

Apesar de já depender de `0.4.3`, [mcpHttp.ts](../nox-bot/src/services/mcpHttp.ts) mantém o adaptador HTTP para clientes legados criado para `0.4.1`: combina `createServer` com o transporte JSON do SDK e delega os pedidos modernos ao handler da biblioteca. Portanto, atualizar a versão não eliminou esta segunda implementação de negociação/cancelamento. Não foi removida nesta auditoria.

### Dependências externas relevantes

| Componente | Requisitos / versões resolvidas relevantes |
| --- | --- |
| Biblioteca TypeScript | Node `>=24`; TypeScript `5.9.3`; SDK servidor/cliente `2.3.1`, adaptador Node `2.1.1`, Zod `4.6.5`, Better Auth/MCP `1.7.7`, `ws 8.22.0` no lockfile |
| Peers TypeScript | Zod `^4.6.0` obrigatório; Node SDK `^2.0.0`, Better Auth/MCP `^1.7.2` e `ws ^8.19.0` opcionais no pacote, mas necessários para os respetivos adaptadores |
| Go | Biblioteca/Backend pedem Go `1.26.0`; Yard pede `1.26.9`. Os três declaram SDK Go `1.8.0` e `jsonschema-go 0.4.3`; a biblioteca usa também `coder/websocket 1.8.15` e JWT `5.3.1` |
| Rust | Rust mínimo `1.88`, edition 2021; `rmcp = "3.0"` resolve `3.5.0` no lockfile da biblioteca e `3.2.0` no NoteX; `jsonschema` da biblioteca resolve `0.58.5` |
| NoteX TypeScript | Lockfile contém SDK servidor `2.0.0` no backend e `2.3.1` na raiz; adaptador Node `2.0.0`, Better Auth/MCP `1.7.2`, Zod `4.6.5`, `ws 8.21.3` |
| Bot TypeScript | Node `>=24 <25`; SDK servidor/cliente `2.3.1`, adaptador Node `2.0.0`, Zod `4.6.0` no lockfile |

Fontes das versões: manifests e lockfiles dos cinco repositórios. Os SDKs e validadores atravessam as APIs públicas; a sua atualização pode afetar tipos, serialização e transportes mesmo sem mudar os nomes das funções NoX.

TypeScript é distribuído pelo asset `nox-mcp.tgz` de uma GitHub Release; o pacote está marcado `private`. Rust tem `publish = false`; Go resolve tags do módulo na raiz. Preservar estes caminhos, o conteúdo compilado e as declarações de tipos do tarball. As versões do pacote, schema do manifesto, protocolo da ponte e protocolo MCP são eixos distintos.

## 6. Diferenças e problemas confirmados

1. **Versionamento misto no NoteX.** Confirmado pelos manifests e lockfiles, incluindo Rust `0.1.0` num commit antigo. Não significa, por si só, que o produto esteja avariado; significa que `0.4.3` não descreve todos os seus componentes.
2. **Metadados de manifesto não têm paridade.** `ToolDefinition` TypeScript e `Tool.Meta` Go preservam `_meta` no registo direto; Rust atual preserva-o em `load_tools`. Porém, `ToolManifestEntry`/`toolManifestSchema` da biblioteca TypeScript não declaram `_meta`: uma análise em memória confirmou que o parser o remove. O JSON Schema de manifesto não o declara, mas permite propriedades adicionais. No commit Rust fixado pelo NoteX, `load_tools` também não copia `_meta` para `Tool`; a diferença foi confirmada contra o histórico Git local. O manifesto próprio do NoteX já contém `_meta.cli`.
3. **Scopes no manifesto não equivalem a autorização automática.** O schema partilhado admite `scope` e `requiredScopes`; o carregador Rust não os transfere para `ServerOptions.required_scopes`. O NoteX remoto impõe scopes no backend. Não se pode inferir a mesma política no servidor local apenas a partir do manifesto.
4. **Validação de manifestos desigual.** TypeScript aceita qualquer `protocolVersion` não vazio dentro do limite e não verifica nomes duplicados no parser; Rust exige `2.0`, unicidade e schemas de objeto. O tipo TypeScript exige os quatro booleanos de anotações, mas o seu schema permite que faltem. Os schemas JSON permitem campos adicionais; objetos Zod podem eliminá-los durante o parse.
5. **Mudança HTTP entre versões.** O diff `v0.4.1..v0.4.3` confirma o novo handler TypeScript com JSON por omissão e opção SSE. As implementações Go e o código Rust não mudam nesse intervalo, além da versão da crate. Clientes presos a SSE/notificações intermédias precisam de avaliação própria; o NoteX backend continua em `0.4.1` e o Bot mantém um adaptador local.
6. **Documentação desfasada.** `nox-backend/docs/mcp.md` e `nox-bot/docs/mcp.md` ainda referem `0.4.1`; o README/`typescript/HTTP_VALIDATION.md` da biblioteca ainda usam linguagem de próxima release. Há também decisões antigas do Yard que descrevem acesso anónimo permanente, contrariadas pelo código atual de configuração/autorização. A baseline usa o código, não essas descrições históricas.
7. **Instabilidade observada num teste HTTP.** Na primeira execução, o teste `json legacy disconnect and close cancel once without pending exchanges` recebeu `TypeError` onde esperava `AbortError`. Os 20 testes HTTP passaram na repetição. É uma falha intermitente observada, com causa por esclarecer; não demonstra, isoladamente, uma falha funcional reproduzível no produto.

## 7. Testes e validação

### O que foi executado nesta auditoria

| Verificação | Resultado / limites |
| --- | --- |
| TypeScript `5.9.3`, configuração real, `noEmit` | Sem diagnósticos; emissão adicional apenas em memória corresponde aos 17 artefactos existentes em `dist` |
| Testes TypeScript de ferramentas | 3/3 passaram |
| Testes TypeScript HTTP | Primeira execução: 19/20; repetição: 20/20. Node `24.21.0`, através do runner Node disponível |
| Testes de versionamento/release | 11/11 passaram, usando repositórios temporários de teste |
| `go test -mod=readonly ./...` | Passou com Go `1.26.3`, sem rede, após colocar a cache num diretório temporário acessível |
| `go test -mod=readonly -cover ./...` | Passou; **30,0% das instruções** cobertas no pacote Go |
| `cargo test --locked --offline --manifest-path rust/Cargo.toml` | 2 testes unitários e 3 de integração passaram; artefactos de compilação direcionados para diretório temporário |
| Coerência dos contratos | Comparação dos seis schemas nas três localizações; defaults JSON comparados semanticamente |

Não se executou `npm test` diretamente porque inclui emissão de ficheiros; usaram-se os testes existentes e validou-se o `dist` sem o reconstruir. O pacote não foi instalado/empacotado de novo. Não se executaram suites completas dos consumidores, chamadas a serviços reais, Docker/Discord, nem testes de clientes desktop externos. O Go instalado é inferior ao requisito atual do Yard. Os resultados históricos em `HTTP_VALIDATION.md` são evidência anterior, não validações repetidas nesta auditoria.

### Cobertura existente e lacunas

| Área | Evidência existente | Lacunas relevantes |
| --- | --- | --- |
| TypeScript: ferramentas/HTTP | `typescript/test/tools.test.mjs` e `http.test.mjs`: metadados, schemas, scopes, resultados, JSON/SSE, duas gerações MCP, negociação, limites, timeout, cancelamento, subscrições e encerramento | Não há percentagem de cobertura configurada; instabilidade de desconexão por esclarecer; limites entre instâncias e cenários prolongados não estão demonstrados |
| TypeScript: ponte/autorização | Sem testes dedicados destes módulos no repositório da biblioteca | Ticket expirado/reutilizado, revogação, heartbeat, gerações, clientes de ponte e Better Auth dependem sobretudo da validação feita pelos produtos |
| Go | `go/nox_test.go`: metadados, descoberta e chamadas em memória, contexto, schemas, scopes e contexto previamente cancelado | Cobertura de 30,0%; faltam testes próprios de HTTP/stdio, `RunBridge`, schemas de frames, `Protect`/JWT, timeout durante execução, saturação e saída inválida/oversized |
| Rust | Dois testes de registo/broker e três testes de metadados/chamadas com transporte em memória | Faltam testes sistemáticos de parser de frames, manifestos inválidos, prazos, limites, timeout/cancelamento do servidor, gerações e sobrecarga; os testes atuais não demonstram HTTP real nem paridade entre SDKs |
| Contratos entre linguagens | Schemas duplicados atualmente iguais | Não há corpus comum executado nas três linguagens nem verificação automática das cópias/defaults, campos desconhecidos, scopes ou manifesto com `_meta` |
| Release/distribuição | Onze testes de scripts; `check-package.mjs` verifica pacote e consumidor HTTP instalado; workflow corre as três suites numa tag `v*` | Verificação de instalação não repetida nesta auditoria; não há workflow separado de PR/branch no repositório; não existe matriz automática com os quatro consumidores e versões antigas |

Os consumidores têm testes relevantes, inspecionados mas não executados aqui:

- Backend, `backend/internal/app/mcp_test.go`: catálogo/CLI, autenticação, propriedade, ciclo de vaults, estado partilhado HTTP/MCP, sanitização e preservação de `int64`.
- Yard, `internal/mcpapi/*_test.go` e `internal/httpapi/machine_test.go`: catálogo/anotações, permissões e segredos, rotação de token, configuração, erros parciais, jobs e timeout com resultado desconhecido.
- NoteX, `backend/test/`: sessões/tickets, desligar/religar sem replay, WebSocket real, Origin, OAuth e ambas as gerações MCP. Há testes do contrato, dispatcher/mutações e testes Rust de credenciais/frames/servidor local. Não substituem uma matriz contra a biblioteca atual, porque as dependências estão fixadas em versões diferentes.
- Bot, `tests/mcp.test.mjs`: JSON nas duas gerações, 14 ferramentas e CLI, isolamento por guild, revisões, segredos, falhas da base de dados, cancelamento de envio e shutdown. Exercitam também o adaptador HTTP próprio.

## 8. Riscos potenciais para Gateway, CLI e Portal

Estes pontos são riscos de evolução, não funcionalidades em falta que esta auditoria implemente:

- **Encaminhamento e identidade:** os produtos não partilham o mesmo mecanismo de autenticação. Backend tem ferramentas públicas e erros por ferramenta; Yard tem políticas por pedido; NoteX usa OAuth e sessões desktop; Bot liga a autoridade à guild do URL. Uma API Key de Gateway não pode ser tratada como suporte já existente em todos eles.
- **Descoberta variável:** o catálogo do Yard depende das permissões; presença/sessões afetam o NoteX; a guild afeta o Bot. Guardar um catálogo sem respeitar esse contexto pode revelar ferramentas ou encaminhá-las incorretamente.
- **Nomes e navegação:** `_meta.cli` é prática real, mas não um contrato versionado. Há aliases iguais entre produtos, como `status` e `health`, e convenções de nomes canónicos diferentes. Os schemas de ferramentas existentes também não asseguram uma UI completa para formulários ou workflows.
- **Metadados adicionais:** parsers antigos podem ignorar ou remover campos novos. A mera adição de uma propriedade JSON não garante que atravesse manifestos, bibliotecas antigas e descoberta até ao CLI/Portal.
- **Transporte e duração:** JSON/SSE, prazos, desconexões, limites de payload e âmbito de concorrência diferem. Encadear pedidos através de outro serviço pode ultrapassar prazos ou repetir mutações cujo resultado é desconhecido.
- **Atualizações independentes:** uma alteração de SDK, requisito de runtime, caminho de importação, tipo público ou artefacto de release pode quebrar consumidores antes de qualquer novo contrato ser usado. O NoteX mostra que versões antigas e novas coexistem.
- **Módulos de Portal:** não existe neste repositório um contrato de carregamento de páginas/componentes. Não foi auditado um Portal consumidor; não há base para afirmar compatibilidade de módulos frontend nesta fase.

## 9. Preparação para o Passo 2

O repositório está preparado para iniciar o desenho com uma baseline concreta, mas **não está demonstrada a segurança de uma expansão transversal ou atualização simultânea dos produtos**. O estado alpha anunciado no README não elimina as dependências já existentes.

Antes de avançar, precisamos de discutir:

1. Que versões de biblioteca, SDKs e runtimes serão suportadas, incluindo os três estados do NoteX e a continuidade do protocolo de ponte `1.0`.
2. Que comportamentos e formatos atuais são obrigatórios em todas as linguagens e quais permanecem específicos do produto, incluindo manifestos, metadados, scopes e erros.
3. Como a futura descoberta deve respeitar identidade, permissões, disponibilidade, produto e guild, sem alterar as fronteiras de autorização existentes.
4. O significado de `_meta.cli` já publicado e as garantias de preservação de campos desconhecidos nos consumidores atuais.
5. As expectativas de JSON/SSE, notificações, cancelamento, resultado desconhecido e limites numa operação encaminhada.
6. Que validações de regressão serão exigidas para os quatro consumidores, incluindo a falha HTTP intermitente e os caminhos de ponte/autorização pouco cobertos.

Esta baseline não define os novos contratos nem propõe alterações de implementação. Regista o que existe e o que terá de continuar a funcionar quando esse desenho começar.
