# Auditoria de compatibilidade, robustez e qualidade

Data: 21 de outubro de 2026. Âmbito: apenas `nox-mcp`, versão pública **0.5.0**. Nenhuma release publicada, tag substituída ou aplicação consumidora alterada. Os consumidores referidos abaixo são aplicações temporárias criadas pelos testes, fora do checkout.

**Estado: release bloqueada pela conformidade SSE do SDK Go.** Compilar e passar testes de contratos não elimina este bloqueador. As matrizes Linux/macOS estão configuradas, mas não foram executadas localmente nem apresentadas como resultados de CI.

## A. Problemas identificados e corrigidos

### 1. Requisitos Rust inferiores às APIs utilizadas

`rust/Cargo.toml` permitia rmcp 3.0–3.2, mas o código usava a superfície moderna validada com 3.5: `ServerConfig`, `ServerHandler`, `CallToolResponse`, pedidos personalizados, capacidades de extensão, metadados por pedido e erros tipados `-32021`/`-32022`. O lockfile escolhia 3.5.0 e escondia a incompatibilidade do requisito declarado.

O mínimo de suporte é agora **`rmcp = "3.5.0"`**, nas dependências normais e de desenvolvimento. É um intervalo Cargo compatível (`^3.5.0`), não uma fixação `=3.5.0`. Os testes compilam todas as APIs públicas e executam os contratos com 3.5.0 e com resolução recente 3.6.0. Não se substituiu `ServerConfig` por tipos antigos. 3.5.0 é a base de suporte comprovada; não se afirma que cada método tenha sido introduzido precisamente nessa release.

O ensaio dos outros mínimos revelou problemas adicionais:

| Dependência | Problema demonstrado | Mínimo declarado nesta revisão |
| --- | --- | --- |
| chrono | 0.4.0 não tem a feature `std`; o grafo rmcp/schemars já exige uma versão muito superior. | 0.4.39, compilado/testado |
| serde_json | 1.0.127/1.0.140 não implementam `Default` em `CompactFormatter`, usado por jsonschema 0.58.0. | 1.0.145, compilado/testado |
| serde | serde_json 1.0.145 exige pelo menos 1.0.220. | 1.0.220, compilado/testado |
| tokio-util | 0.7.0 não reexporta `bytes` e a sua espera de cancelamento não satisfaz os requisitos `Sync` do transporte rmcp. | 0.7.16, compilado/testado |
| tokio | A seleção conjunta com tokio-stream exige um Tokio recente; `1` não descrevia uma base mínima ensaiada. | 1.43.0, compilado/testado |

Não houve atualização geral do grafo bloqueado. jsonschema, sha2, base64 e ryu-js mantêm os intervalos anteriores. Os mínimos escolhidos constituem uma combinação de suporte testada, sem pretender reconstruir a primeira release histórica de cada API.

### 2. MSRV não validado pelo lockfile

O SDK declara Rust 1.88. `cargo +1.88.0 check --locked --all-targets` revelou que `uuid 1.27.0` no lockfile exige Rust 1.89. O lockfile foi corrigido apenas para `uuid 1.26.0`. As restantes versões bloqueadas foram preservadas.

`.cargo/config.toml` configura resolução compatível com `rust-version`. Esta configuração **não é herdada por aplicações consumidoras**. Os testes externos definem explicitamente a mesma política e o MSRV da aplicação. Num consumidor que use Rust 1.88, configurar:

```toml
# .cargo/config.toml da aplicação
[resolver]
incompatible-rust-versions = "fallback"
```

O SDK não consegue impedir que uma aplicação escolha dependências transitivas futuras que exijam outra toolchain quando o próprio resolver ignora MSRV. O perfil recente é também testado com a toolchain atual, permitindo esse grafo mais recente.

### 3. Consumidores aparentemente externos reutilizavam a resolução interna

`scripts/check-native-packages.mjs` copiava o `Cargo.lock` e o grafo Go para os consumidores. Isso verificava inclusão de ficheiros e imports, mas não a resolução de uma aplicação independente.

Agora os consumidores criam os seus próprios lockfiles/sums. O novo `scripts/check-consumers.mjs` testa:

- Rust por Git local com revisão imutável da árvore de trabalho e por `path`, sem copiar `Cargo.lock`;
- aplicação Rust que declara `rmcp = "3.0"`, resolvendo uma versão admitida pelo SDK;
- rejeição obrigatória de uma aplicação que tente fixar `rmcp = "=3.2.0"`;
- mínimos de todas as dependências diretas e resolução compatível recente;
- compilação da aplicação de produção sem a feature `client`, seguida de `cargo check --all-targets`, testes reais de runtime/contratos e binários stdio/HTTP/SSE;
- módulo Go independente, `go mod tidy`, execução, `go vet` e os mesmos testes de transporte;
- tarball TypeScript instalado com peers estritamente válidos, todos os exports públicos, compilação e execução de uma aplicação TypeScript, descoberta e chamadas HTTP JSON/SSE.

`scripts/discovery-wire.mjs` é o verificador comum dos hosts do checkout e dos binários externos. Assim, um consumidor não passa apenas porque o exemplo compilou.

### 4. Erros de ferramenta confundidos com resultados de sucesso

TypeScript, Go e Rust incluíam o corpo do erro em `structuredContent`, embora anunciassem um `outputSchema` de sucesso. Os testes verificavam o corpo do erro, mas não o submetiam à validação de um cliente rigoroso. Isso podia esconder `FORBIDDEN` ou um erro de domínio atrás de uma falha do schema de sucesso.

**Alteração do envelope aprovada explicitamente pelo utilizador:** resultados `isError: true` deixam de incluir `structuredContent`. O mesmo corpo JSON, incluindo `code`, `message`, `retryable`, `details` e campos personalizados, permanece em `content[].text`. Os sucessos mantêm `structuredContent` e texto. `error.schema.json`, schemas de sucesso, nomes de funções e ferramentas não mudaram.

Ficheiros: `typescript/src/index.ts`, `go/nox.go` e `rust/src/lib.rs`. O Rust aceita ainda executores existentes que construam `CallToolResult::structured_error`; normaliza-os antes de responder ao cliente. O retorno idiomático `Runtime.Execute` Go não mudou.

Referências: [resultados e schemas MCP](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [erros do SDK TypeScript](https://ts.sdk.modelcontextprotocol.io/v2/servers/errors). Consumidores que liam erros em `structuredContent` precisam de passar a ler o JSON do bloco de texto.

### 5. Envelope moderno sem protocolVersion não estava coberto

O corpus partilhado inclui agora um pedido moderno sem `io.modelcontextprotocol/protocolVersion`, mantendo capacidades modernas e, no HTTP, o header de versão. Produz **`-32602` e HTTP 400**. Não é tratado como versão desconhecida (`-32022`) nem como cliente legado com handshake válido.

Referência: [requisitos do envelope e erros MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic).

### 6. A validação aceitava deliberadamente SSE inválido

Foi retirada a exceção que transformava o defeito SSE Go num teste aprovado. O verificador termina com erro após recolher os resultados dos transportes. A falha é reproduzida também num consumidor Go independente e bloqueia a release. Os detalhes e alternativas estão na secção D.

### 7. Declarações TypeScript não eram verificadas por um consumidor estrito

O `tsc` interno tinha `skipLibCheck` e os testes de instalação só importavam JavaScript. A compilação externa estrita encontrou `TS1543`: a declaração pública de `defaults` importava JSON sem atributo de importação NodeNext. `scripts/sync-contracts.mjs` gera agora `defaults.generated.ts` com o tipo estrutural a partir dos defaults oficiais. `contract.ts` usa esse tipo, preservando o mesmo objeto e valores; o `.d.ts` publicado já não importa JSON.

A entrada opcional `better-auth` arrastava declarações estrangeiras de Bun/Cloudflare/base de dados com erros de tipos. `typescript/src/better-auth.ts` publica agora projeções estruturais dos mesmos tipos de claims/opções, sem modificar o corpo da autenticação, callbacks ou requisitos. A igualdade com o upstream é verificada na compilação interna e nos perfis mínimo/recente do consumidor. Nenhum export foi renomeado. A aplicação que importa os sete exports NoX compila com `strict` **sem `skipLibCheck`**.

O ensaio separado de igualdade importa o plugin upstream e usa `skipLibCheck` apenas para as suas declarações estrangeiras; as asserções da aplicação continuam a ser verificadas. Isto não é uma alegação de que as declarações completas do Better Auth foram corrigidas; a limitação de importação direta dessa biblioteca permanece na secção D.

## B. Matriz real de compatibilidade

### Ambiente local e dependências

Plataforma local: **Windows x64**. Toolchains: Node **24.0.0 / 24.22.0**, npm **11.21.1 / 12.2.0**, Go **1.26.0 / 1.26.3**, Rust **1.88.0 / 1.95.0**. Não se afirma execução local em Linux/macOS.

| TypeScript: dependência direta/peer | Mínimo testado | Resolução recente testada |
| --- | --- | --- |
| @modelcontextprotocol/server | 2.3.1 | 2.3.1 |
| ajv | 8.20.0 | 8.20.0 |
| @modelcontextprotocol/node (opcional) | 2.0.0 | 2.1.1 |
| zod | 4.6.0 | 4.6.7 |
| ws (opcional) | 8.19.0 | 8.22.0 |
| better-auth / @better-auth/mcp (opcionais) | 1.7.2, componentes alinhados | 1.7.12 |

A compilação do consumidor usa TypeScript 5.9.3, `@types/node` 24.10.13 e `@types/ws` 8.18.1. A instalação do SDK é primeiro verificada sem TypeScript e sem hooks de compilação. O lockfile interno continua com os peers que já utilizava; a tabela recente corresponde à instalação externa, não a uma atualização do checkout.

| Go: módulo direto | Mínimo MVS testado | Resolução recente |
| --- | --- | --- |
| github.com/coder/websocket | 1.8.15 | 1.8.15 |
| github.com/golang-jwt/jwt/v5 | 5.3.1 | 5.3.1 |
| github.com/google/jsonschema-go | 0.4.3 | 0.4.3 |
| github.com/modelcontextprotocol/go-sdk | 1.8.0 | 1.8.0; defeito SSE pendente |

Os requisitos Go não mudaram. MVS impede versões inferiores às indicadas no `go.mod`; o módulo externo resolve o seu próprio grafo. 1.8.0 era a última versão publicada do SDK MCP Go na consulta efetuada nesta auditoria.

| Rust: dependência direta | Mínimo testado | Lockfile do SDK | Resolução recente testada |
| --- | --- | --- | --- |
| rmcp | 3.5.0 | 3.5.0 | 3.6.0 |
| jsonschema | 0.58.0 | 0.58.5 | 0.58.6 |
| chrono | 0.4.39 | 0.4.45 | 0.4.45 |
| serde | 1.0.220 | 1.0.229 | 1.0.229 |
| serde_json | 1.0.145 | 1.0.151 | 1.0.154 |
| tokio | 1.43.0 | 1.53.2 | 1.54.0 |
| tokio-util | 0.7.16 | 0.7.19 | 0.7.20 |
| sha2 | 0.10.9 | 0.10.9 | 0.10.9 |
| base64 | 0.23.1 | 0.23.1 | 0.23.1 |
| ryu-js | 1.0.0 | 1.0.3 | 1.0.3 |

Features rmcp de produção: `server`, `transport-streamable-http-server`, `transport-io`, com defaults desligados. Os consumidores acrescentam `client` para os testes; a biblioteca não depende da unificação acidental de features de desenvolvimento. O perfil mínimo é executado com Rust 1.88; o perfil recente com Rust 1.95. Os pins exatos existem apenas no consumidor mínimo temporário.

### Transportes e erros

| Cenário | JSON-RPC | HTTP JSON |
| --- | --- | --- |
| Extensão ausente ou versão incompatível | -32021, `requiredCapabilities` exato | 400 |
| Protocolo desconhecido | -32022, `requested` / `supported` | 400 |
| protocolVersion ou clientCapabilities obrigatórios ausentes | -32602 | 400 |
| Parâmetros inválidos dentro do handler NoX | -32602 | TS e rmcp 3.6: 200; Go e rmcp 3.5: 400 |
| Definição/snapshot desatualizados | -32602 com `STALE_DEFINITION` / `STALE_CATALOG` | Mapeamento do SDK |
| Erro de autorização/domínio do runtime | resultado MCP `isError: true`, texto JSON | 200 |
| Erro depois de progresso SSE | Mesmo erro JSON-RPC como evento terminal; HTTP já iniciado permanece 200 | Go 1.8.0 não conforme |

O mapeamento de erros de handler difere do erro obrigatório de envelope. O corpus distingue explicitamente rmcp 3.5 e 3.6; não relaxa o HTTP 400 obrigatório dos erros de negociação/envelope. Os clientes legados continuam com `initialize`, `tools/list` e `tools/call`; os métodos incrementais conservam a rejeição legada existente.

### CI configurado, ainda sem execução remota nesta sessão

- Contratos, regressões e transportes: Windows e Linux.
- Consumidores mínimos/recentes por linguagem: Windows e Linux; Rust recente também em macOS.
- Node mínimo 24.0.0 com npm 11.21.1; Node 24 recente, 26 e versão corrente.
- Go mínimo 1.26.0 e patch recente 1.26.x; Rust mínimo 1.88 e stable recente.
- A publicação depende do workflow reutilizável de compatibilidade. Não há `continue-on-error` nas verificações críticas. O defeito SSE mantém o resultado global em falha.

## C. Verificações de regressão

| Verificação | Evidência / falha que passa a detetar |
| --- | --- |
| `npm test` | 163 testes aprovados; preservação de execução, erros, limites, bridges e metadados |
| `go test -mod=readonly ./...` | Aprovado no grafo declarado |
| `cargo +1.88.0 test --all-targets --locked --manifest-path rust/Cargo.toml` | Aprovado; impede voltar a bloquear uma dependência incompatível com MSRV |
| `npm run test:conformance` | 18 observações idênticas entre linguagens; erros sem structuredContent, mesmo conteúdo funcional |
| `npm run test:discovery` | Hashes/JCS/CLI/cache/snapshots e negociação aprovados; **comando falha** nos quatro erros SSE Go |
| `npm run package:check -- --minimum` / `npm run package:check` | Instalação externa, exports, compilação, outputSchema rigoroso, autenticação/domínio e descoberta/cache em HTTP JSON/SSE |
| `npm run test:native-packages` | Aprovado: crate efetivamente empacotada e consumidores nativos com resolução própria |
| `npm run benchmark:discovery` | Aprovado: budgets preservados, resultados abaixo |
| `actionlint` | Workflows validados estaticamente; não equivale a execução remota |
| `npm run test:consumers -- --language=rust --minimum` | Git/path, sem lock herdado, todas as dependências diretas mínimas, rmcp 3.0 na aplicação, rejeição de 3.2, runtime e transportes |
| `npm run test:consumers -- --language=rust` | Mesmo ensaio com resolução recente |
| `npm run test:consumers -- --language=go [--minimum]` | Compilação/execução e erros JSON aprovados; teste SSE devolve falha obrigatória |

Para reproduzir o mínimo Rust, selecionar antes a toolchain (`RUSTUP_TOOLCHAIN=1.88.0`); para Go, `GOTOOLCHAIN=go1.26.0`. Estas variáveis aplicam-se ao processo de teste. `npm run test:native-packages` conserva a validação do pacote Cargo real e do módulo separado, agora com resolução independente no consumidor.

Os testes partilhados verificam alterações, remoções e disponibilidade; partições de autorização; catálogo completo antes de aceitar remoções; retenção da cache anterior perante falhas/parciais/tampering; invalidação durante sincronização; metadados desconhecidos e `_meta.cli`. O mesmo verificador de rede corre nos hosts do checkout e nos consumidores. Não se introduziram descritores, algoritmos de hash, contratos CLI ou mecanismos de autorização novos.

Os hosts de rede usam os runtimes NoX públicos nas três linguagens. O fixture Go anterior construía diretamente `mcp.Server.AddTool` e por isso não exercitava a normalização de erros do runtime NoX; passou a usar `NewFromManifestWithDiscovery`. Contadores reais de execução provam que `STALE_DEFINITION`, indisponibilidade e revogação são rejeitados antes do executor; a sincronização posterior remove ferramentas revogadas da cache. Um erro de domínio real é verificado pelo mesmo transporte.

O benchmark mantém os budgets: com 100 ferramentas, 175 929 bytes na descoberta convencional contra 11 863 bytes para uma ferramenta alterada (93,3% de redução); um catálogo sem alterações transfere 526 bytes. A descoberta incremental a frio é maior (203 851 bytes), como antes. São payloads sintéticos JSON-RPC sem compressão; uma cache MCP convencional ainda fresca também pode evitar transferências.

## D. Problemas ainda abertos

### Bloqueador: SSE inválido no SDK MCP Go 1.8.0

Causa: `mcp/streamable.go`, `extractErrorStatus` / `stream.deliverLocked`. Os erros `-32021`, `-32022`, `-32602` e `-32601` entram numa via que escreve JSON com status 400/404 sem verificar se já foi enviada uma notificação SSE. Depois dos headers/progresso, o status continua 200 e o erro é escrito fora de um evento `data:`. Um cliente SSE correto não recebe a resposta terminal.

Afeta handlers/middleware personalizados que emitem progresso e depois devolvem um desses códigos, incluindo integrações NoX que exponham o servidor através do handler SSE oficial. Não é um problema dos fingerprints/cache. A negociação NoX rejeita antes de emitir progresso; `Runtime.HTTPHandler()` Go usa respostas JSON e não sofre desse caso de erro tardio SSE.

Investigação: a API pública só permite escolher JSON/SSE, não corrigir o caminho interno que escreve a resposta. Não havia versão publicada superior a 1.8.0 na consulta. Forçar JSON globalmente retiraria streaming; reescrever o corpo num ResponseWriter seria um workaround de serialização; vendor/fork excederia uma correção pequena sustentável. Não se fez nenhuma dessas alterações.

Classificação: **bloqueador da release que anuncie conformidade SSE**. O teste fica vermelho, também nos consumidores independentes. Solução preferida: correção upstream e atualização justificada quando existir uma versão publicada corrigida. Publicar com suporte SSE reduzido exigiria uma decisão explícita e documentação do contrato de suporte; não foi assumida essa decisão.

### Integração Better Auth mínima requer componentes alinhados

`@better-auth/mcp 1.7.2` admite oauth-provider/core recentes por intervalos, mas estes podem exigir outro `better-call` e exports inexistentes no core antigo. A instalação mínima sem alinhamento falhou realmente na importação de `encodeDeterministicId`. O perfil mínimo instala `better-auth`, `@better-auth/mcp`, `@better-auth/core` e `@better-auth/oauth-provider` em 1.7.2 e valida peers com `--strict-peer-deps`; não usa `--force` ou `--legacy-peer-deps`. O perfil recente resolve a família atual normalmente.

Não bloqueia o SDK base; a integração opcional requer uma família coerente. Não se alteraram mecanismos de autenticação dos produtos. O npm 11.3.0 apresentou ainda um erro interno Arborist (`edgesOut`) nesta árvore; o mesmo ensaio passou com Node 24.0.0 / npm 11.21.1, usado agora na matriz mínima.

Ao importar diretamente as declarações completas do Better Auth 1.7.2, um projeto Node estrito encontra referências a `bun:sqlite`, tipos Cloudflare, `Timer` e um erro genérico do plugin organization. A declaração do adaptador NoX foi isolada desse grafo mantendo igualdade dos seus tipos; a importação direta da biblioteca estrangeira continua sujeita aos seus próprios requisitos/correções. Não se instalaram tipos de outros runtimes nem se modificaram os ficheiros de uma dependência para mascarar esse problema.

### Resultados de outras plataformas e tag já publicada

Linux/macOS e Node 26/corrente dependem da execução do novo CI. Configurar uma matriz não é evidência de aprovação. Até esses jobs passarem não se declara validação multiplataforma concluída.

A tag Git `v0.5.0` já publicada continua a referir o código antigo: esta revisão da árvore de trabalho não repara retroativamente instalações dessa tag. A publicação de uma futura versão e qualquer migração de aplicações permanecem fora desta tarefa.
