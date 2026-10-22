> **Documento histórico arquivado.** As versões, resultados e indicações de estado abaixo pertencem às revisões descritas. Consultar a [documentação atual](../README.md).

# Auditoria de compatibilidade, robustez e qualidade

Data: 21 de outubro de 2026. Âmbito: apenas `nox-mcp`, versão publicada atual **0.6.0**. Nenhuma release publicada, tag substituída ou aplicação consumidora alterada. Os consumidores referidos abaixo são aplicações temporárias criadas pelos testes, fora do checkout.

**Registo histórico:** os 17/17 jobs indicados na secção B pertencem à revisão anterior `9b45842`. Não são resultados da revisão atual. A atualização após v0.6.0 simplifica a publicação, retira a integração de identidade não pretendida e torna o diagnóstico SSE Go exclusivamente manual. Os resultados desta revisão são registados no final do documento.

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

Foi retirada a exceção que transformava o defeito SSE Go num teste aprovado. Com a decisão posterior de adiar esse transporte, o reproducer passou para `scripts/investigate-go-sse.mjs` e um workflow separado. Continua a terminar com erro perante JSON bruto depois de progresso. O verificador obrigatório não anuncia Go SSE como suportado; mantém as verificações SSE de TypeScript/Rust e todos os testes de stdio/HTTP JSON. Os detalhes e critérios de retoma estão na secção D.

### 7. Declarações TypeScript não eram verificadas por um consumidor estrito

O `tsc` interno tinha `skipLibCheck` e os testes de instalação só importavam JavaScript. A compilação externa estrita encontrou `TS1543`: a declaração pública de `defaults` importava JSON sem atributo de importação NodeNext. `scripts/sync-contracts.mjs` gera agora `defaults.generated.ts` com o tipo estrutural a partir dos defaults oficiais. `contract.ts` usa esse tipo, preservando o mesmo objeto e valores; o `.d.ts` publicado já não importa JSON.

A integração de identidade específica foi retirada por decisão explícita posterior. O consumidor estrito valida agora os seis exports atuais, sem dependências nem projeções de tipos desse fornecedor. A build limpa as saídas anteriores, impedindo que módulos/declarations removidos continuem a acompanhar o pacote. Os callbacks de credenciais, contexto, scopes e erros mantêm-se.

### 8. Falhas reais do CI no Windows

O [run 39652399162](https://github.com/mapherez/nox-mcp/actions/runs/39652399162), no commit `64b580d`, teve 17 jobs: 10 aprovados e 7 falhados. Foram consultados os logs de todos os jobs falhados. Não revelaram outra categoria de erro além das duas falhas Windows abaixo e do SSE Go agora adiado.

- **Argumentos npm/PowerShell:** no perfil mínimo, `--language` e `--minimum` foram interpretados pelo npm como configuração, deixando o script sem argumentos. O job Rust executou Go (predefinição `all`) com uma toolchain Go não selecionada. A matriz chama agora diretamente `node scripts/check-consumers.mjs` com `NOX_CONSUMER_LANGUAGE` e `NOX_CONSUMER_PROFILE`. O parser exige seleção completa, válida e sem conflitos; imprime a linguagem/perfil efetivos. O pacote TypeScript usa o mesmo perfil explícito, sem encaminhar flags pelo npm. Testes cobrem as quatro combinações nativas e rejeitam configuração incompleta/inválida/conflituosa.
- **Raiz Git:** a comparação lexical de `resolve(...)` rejeitava caminhos Windows equivalentes, incluindo nomes curtos dos diretórios temporários. `update-version.mjs` usa agora `realpath` nos dois caminhos e compara as raízes canonizadas. Não usa prefixos nem elimina verificações de árvore limpa, branch, tags, identidade, ficheiros alterados, rollback; o novo fluxo faz push apenas do SHA de preparação, sem tags. Uma integração por junction/symlink comprova a aceitação do mesmo repositório; outra confirma que um subdiretório com ficheiros de versão válidos continua rejeitado. Os testes de release só alteram repositórios temporários.

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

Features rmcp de produção: `server`, `transport-streamable-http-server`, `transport-io`, com defaults desligados. Os consumidores acrescentam `client` para os testes; uma compilação separada sem essa feature verifica a configuração de produção. O perfil mínimo é executado com Rust 1.88; o perfil recente com Rust 1.95 localmente e 1.99.1 no CI. Os pins exatos existem apenas no consumidor mínimo temporário.

### Transportes e erros

| Funcionalidade / transporte | TypeScript | Go | Rust |
| --- | --- | --- | --- |
| stdio e HTTP JSON, clientes legados | Supported / Required | Supported / Required | Supported / Required |
| SSE, incluindo framing de erros após progresso | Supported / Required | Investigating / Future Support | Supported / Required |
| tools/list convencional; discovery incremental e negociação moderna | Supported / Required | Supported / Required | Supported / Required |
| CLI metadata, JCS/fingerprints, snapshots, cache e autorização | Supported / Required | Supported / Required | Supported / Required |
| Resultados/schemas, erros de domínio e rejeição antes do executor | Supported / Required | Supported / Required | Supported / Required |
| Pacote/API pública e consumidor com resolução própria | Supported / Required | Supported / Required | Supported / Required |

Esta tabela limita a garantia às funcionalidades e percursos testados do SDK; não certifica todas as funcionalidades opcionais da especificação MCP nem integrações de produtos não executadas nesta tarefa.

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

### CI obrigatório e diagnóstico separado

- Contratos, regressões e transportes: Windows e Linux.
- Consumidores mínimos/recentes por linguagem: Windows e Linux; Rust recente também em macOS.
- Node mínimo 24.0.0 com o npm distribuído com Node; Node 24 recente, 26 e versão corrente.
- Go mínimo 1.26.0 e patch recente 1.26.x; Rust mínimo 1.88 e stable recente.
- `contracts.yml`: **Supported / Required**, 17 jobs obrigatórios; a publicação consulta as aprovações deste SHA por `workflow_run`, sem repetir o workflow. Qualquer falha bloqueia a release.
- `investigating-go-sse.yml`: **Investigating / Future**, dois diagnósticos Windows/Linux. O teste inválido continua vermelho, sem `continue-on-error`, num workflow independente do grafo de release. Tem exclusivamente `workflow_dispatch`, sem push/PR, e não deve ser um check obrigatório de branch protection.
- Execução remota concluída no commit [`9b45842`](https://github.com/mapherez/nox-mcp/commit/9b4584291c866ab7e988809942d3e44dc0aebdbf), branch [`codex/compatibility-finalization`](https://github.com/mapherez/nox-mcp/tree/codex/compatibility-finalization). O [run obrigatório 39662771266](https://github.com/mapherez/nox-mcp/actions/runs/39662771266) terminou com **success, 17/17 jobs**. O [run Investigating 39662771414](https://github.com/mapherez/nox-mcp/actions/runs/39662771414) terminou com **failure, 2/2 reproduções do defeito conhecido**. Este registo de resultados foi acrescentado ao relatório local depois da execução, sem alterar o código validado.

| Ambiente remoto efetivamente testado | Toolchains observadas |
| --- | --- |
| Linux x64 | Node 24.0.0 / 24.21.0 / 24.22.0 / 26.12.1; Go 1.26.0 / 1.26.9; Rust 1.88.0 / 1.99.1 |
| Windows x64 | Node 24.0.0 / 24.22.0; Go 1.26.0 / 1.26.9; Rust 1.88.0 / 1.99.1 |
| macOS arm64 | Rust 1.99.1, consumidor Git/path recente; Node 24.21.0 no verificador |

Os dois seletores Node `26` e `node` resolveram ambos **26.12.1** neste run; não constituem evidência de outro major. Esse run histórico instalava npm 11.21.1; a revisão atual retirou esse override e validou Node 24.0.0/npm 11.3.0. As dependências diretas efetivas coincidem com as tabelas mínimo/recente acima. O job Rust mínimo Windows confirma explicitamente `language=rust, profile=minimum`, seguido de rmcp 3.5.0, sem executar Go.

| Job obrigatório | Resultado remoto |
| --- | --- |
| conformance / ubuntu-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828419) |
| conformance / windows-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828775) |
| consumer / go / latest / ubuntu-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828942) |
| consumer / go / latest / windows-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439829496) |
| consumer / go / minimum / ubuntu-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439829059) |
| consumer / go / minimum / windows-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828977) |
| consumer / rust / latest / macos-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828453) |
| consumer / rust / latest / ubuntu-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439829005) |
| consumer / rust / latest / windows-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828529) |
| consumer / rust / minimum / ubuntu-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828980) |
| consumer / rust / minimum / windows-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828870) |
| consumer / typescript / latest / ubuntu-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439829380) |
| consumer / typescript / latest / windows-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828426) |
| consumer / typescript / minimum / ubuntu-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828987) |
| consumer / typescript / minimum / windows-latest | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439829150) |
| Node / 26 | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439827925) |
| Node / node | [Aprovado](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828380) |

Os testes TypeScript registaram **168 aprovações no Windows** e **167 no Linux**; a diferença é o teste adicional de extração com GNU tar do Git no Windows. Não há testes falhados, cancelados ou ignorados nessas suites. Ambos os jobs de conformidade passaram os 18 cenários partilhados, empacotamento nativo, consumidor TypeScript instalado, budgets de payloads e a matriz de discovery/transportes suportados. Os jobs de consumidores Rust executaram `check --all-targets`, integração Git/path e a rejeição da exigência incompatível rmcp 3.2; os jobs Go/TypeScript validaram os seus próprios grafos mínimos/recentes.

## C. Verificações de regressão

| Verificação | Evidência / falha que passa a detetar |
| --- | --- |
| `npm test` | 168 testes aprovados localmente; execução, erros, limites, bridges, metadados, seleção CI e raízes Git |
| `go test -mod=readonly ./...` | Aprovado no grafo declarado |
| `cargo +1.88.0 test --all-targets --locked --manifest-path rust/Cargo.toml` | Aprovado localmente; confirma o grafo interno no MSRV. O CI mínimo valida separadamente a resolução do consumidor |
| `npm run test:conformance` | 18 observações idênticas entre linguagens; erros sem structuredContent, mesmo conteúdo funcional |
| `npm run test:discovery` | Hashes/JCS/CLI/cache/snapshots e negociação; stdio/HTTP JSON nas três linguagens e SSE TypeScript/Rust, obrigatórios |
| `npm run diagnose:go-sse` | **Não conforme / Investigating**: reproduz os quatro erros SSE Go e termina com código 1; não é aprovação de conformidade |
| `npm run package:check -- --minimum` / `npm run package:check` | Instalação externa, exports, compilação, outputSchema rigoroso, autenticação/domínio e descoberta/cache em HTTP JSON/SSE |
| `npm run test:native-packages` | Aprovado: crate efetivamente empacotada e consumidores nativos com resolução própria |
| `npm run benchmark:discovery` | Aprovado: budgets preservados, resultados abaixo |
| `actionlint` | Workflows validados estaticamente; não equivale a execução remota |
| `npm run test:consumers -- --language=rust --minimum` | Git/path, sem lock herdado, todas as dependências diretas mínimas, rmcp 3.0 na aplicação, rejeição de 3.2, runtime e transportes |
| `npm run test:consumers -- --language=rust` | Mesmo ensaio com resolução recente |
| `npm run test:consumers -- --language=go [--minimum]` | Compilação/execução, stdio/HTTP JSON, negociação moderna e clientes legados, sem anunciar SSE Go |

Para reproduzir o mínimo Rust, selecionar antes a toolchain (`RUSTUP_TOOLCHAIN=1.88.0`); para Go, `GOTOOLCHAIN=go1.26.0`. Estas variáveis aplicam-se ao processo de teste. `npm run test:native-packages` conserva a validação do pacote Cargo real e do módulo separado, agora com resolução independente no consumidor.

No CI, a invocação nativa é `node scripts/check-consumers.mjs` com ambas as variáveis `NOX_CONSUMER_LANGUAGE=rust|go` e `NOX_CONSUMER_PROFILE=minimum|latest`. Para o tarball, `npm run package:check` com `NOX_CONSUMER_PROFILE`. Assim, cada job comprova exclusivamente a seleção definida, independentemente do encaminhamento de argumentos npm no Windows.

Os testes partilhados verificam alterações, remoções e disponibilidade; partições de autorização; catálogo completo antes de aceitar remoções; retenção da cache anterior perante falhas/parciais/tampering; invalidação durante sincronização; metadados desconhecidos e `_meta.cli`. O mesmo verificador de rede corre nos hosts do checkout e nos consumidores. Não se introduziram descritores, algoritmos de hash, contratos CLI ou mecanismos de autorização novos.

Os hosts de rede usam os runtimes NoX públicos nas três linguagens. O fixture Go anterior construía diretamente `mcp.Server.AddTool` e por isso não exercitava a normalização de erros do runtime NoX; passou a usar `NewFromManifestWithDiscovery`. Contadores reais de execução provam que `STALE_DEFINITION`, indisponibilidade e revogação são rejeitados antes do executor; a sincronização posterior remove ferramentas revogadas da cache. Um erro de domínio real é verificado pelo mesmo transporte.

O benchmark mantém os budgets: com 100 ferramentas, 175 929 bytes na descoberta convencional contra 11 863 bytes para uma ferramenta alterada (93,3% de redução); um catálogo sem alterações transfere 526 bytes. A descoberta incremental a frio é maior (203 851 bytes), como antes. São payloads sintéticos JSON-RPC sem compressão; uma cache MCP convencional ainda fresca também pode evitar transferências.

## D. Problemas ainda abertos

### Investigating / Future Support: SSE Go

Causa: `mcp/streamable.go`, `extractErrorStatus` / `stream.deliverLocked`. Os erros `-32021`, `-32022`, `-32602` e `-32601` entram numa via que escreve JSON com status 400/404 sem verificar se já foi enviada uma notificação SSE. Depois dos headers/progresso, o status continua 200 e o erro é escrito fora de um evento `data:`. Um cliente SSE correto não recebe a resposta terminal.

Afeta handlers/middleware personalizados que emitem progresso e depois devolvem um desses códigos, incluindo integrações NoX que exponham o servidor através do handler SSE oficial. Não é um problema dos fingerprints/cache. A negociação NoX rejeita antes de emitir progresso; `Runtime.HTTPHandler()` Go usa respostas JSON e não sofre desse caso de erro tardio SSE.

Investigação: a API pública só permite escolher JSON/SSE, não corrigir o caminho interno que escreve a resposta. Não havia versão publicada superior a 1.8.0 na consulta. Forçar JSON globalmente retiraria streaming; reescrever o corpo num ResponseWriter seria um workaround de serialização; vendor/fork excederia uma correção pequena sustentável. Não se fez nenhuma dessas alterações.

Classificação aprovada: **Investigating / Future Support**, sem bloquear os requisitos atuais. Nenhuma funcionalidade identificada da NoX Suite depende deste comportamento, segundo a decisão de âmbito do utilizador; não se acederam aos produtos para o voltar a auditar. Stdio e HTTP JSON Go continuam suportados. A API de transporte não foi removida nem substituída, mas a sua utilização em SSE permanece fora da garantia de suporte desta revisão.

Reprodução: `npm run diagnose:go-sse`, com SDK Go 1.8.0, responde HTTP 200 após progresso e encontra JSON fora de `data:` para os quatro códigos. O comando mantém código de saída 1; o workflow separado identifica-o como falha, sem transformá-lo em sucesso nem o misturar nos jobs obrigatórios. Não se criaram transportes próprios, forks, mudanças de arquitetura ou workarounds de serialização.

Reconsiderar quando existir uma correção upstream publicada ou uma solução segura pelas APIs oficiais, acompanhada de uma necessidade concreta do produto. Antes de promover suporte, exigir testes de framing terminal dos quatro códigos, chamadas/resultados/erros, negociação e clientes legados, em Windows/Linux, e aprovação explícita da alteração à matriz de suporte. Um diagnóstico que deixe de falhar não promove suporte automaticamente.

### Resultados de outras plataformas e tag já publicada

Os resultados remotos completos da revisão atual constam da secção B: os 17 jobs obrigatórios passaram, incluindo Windows/Linux, macOS Rust recente e Node corrente. Não ficaram bloqueadores identificados nos requisitos suportados testados; SSE Go mantém a classificação separada.

A tag Git `v0.5.0` já publicada continua a referir o código antigo: esta revisão da árvore de trabalho não repara retroativamente instalações dessa tag. A publicação de uma futura versão e qualquer migração de aplicações permanecem fora desta tarefa.

## E. Revisão após v0.6.0: release única e remoção da integração de identidade

### Alterações e ficheiros

| Área | Ficheiros |
| --- | --- |
| Triggers e publicação | `.github/workflows/contracts.yml`, `.github/workflows/release.yml`, `.github/workflows/investigating-go-sse.yml` |
| Preparação e gate da release | `scripts/release.mjs`, `scripts/update-version.mjs`, `scripts/release-policy.mjs`, `scripts/publish-release.mjs` |
| Build e instalação | `scripts/build.mjs`, `scripts/check-package.mjs`, `package.json`, `package-lock.json` |
| Regressões | `scripts/build.test.mjs`, `scripts/update-version.test.mjs`, `scripts/publish-release.test.mjs` |
| Integração retirada | Fonte do adaptador de identidade eliminada; export, peers, dependências de desenvolvimento, tipos projetados, teste de paridade e pins de componentes removidos |
| Documentação | `README.md`, `COMPATIBILITY_AUDIT.md`, `COMPATIBILITY_BASELINE.md`, `DISCOVERY.md`, `MIGRATION_0_5.md`, `contracts/README.md` |

O lockfile não ganhou dependências e perdeu 23 entradas. O pacote tem seis pontos de entrada: raiz, contract, bridge, bridge/client, bridge/server e node. A build limpa `typescript/dist` antes de compilar; um teste isolado sem modificar o checkout demonstra a eliminação de JS e declarações obsoletos. A instalação/compilação estrita verifica os seis exports reais no tarball. O npm mínimo deixou de ser atualizado globalmente: o ensaio Node 24.0.0/npm 11.3.0 passou sem esse workaround.

Não se substituiu o fornecedor removido. Credenciais, contexto, scopes, permissões, rejeições antes do executor e contratos de erros continuam nos mecanismos existentes. As API Keys pertencem ao NoX Backend; Google Account e o futuro NoX Account continuam responsabilidades dos produtos. Não foram implementados fluxos de identidade. Go/Rust, schemas e protocolos não tiveram alterações nesta revisão.

### Fluxo final

1. `npm run release` exige master limpo, verifica versões/major Go/tags e prepara um commit com `NoX-Release: X.Y.Z`. Só esse SHA é enviado para master, com `--no-follow-tags`.
2. O push executa a matriz obrigatória de 17 jobs uma vez. Não há `workflow_call` nem testes locais duplicados; PRs para master também usam a matriz, sem outro CI de push na branch de origem.
3. `workflow_run` aceita apenas conclusão aprovada de um push master deste repositório e intenção explícita. O publicador confirma identidade/path do workflow, run, SHA, branch atual e as 17 aprovações; tentativas posteriores substituem apenas os jobs repetidos do mesmo SHA.
4. O pacote é reconstruído com o lockfile do commit aprovado: instalação sem hooks, build e `npm pack --ignore-scripts`. Não se repetem suites nem `contracts:check`/prepack. A versão do pacote e a integridade da árvore são verificadas antes de qualquer escrita remota.
5. A tag anotada aponta para o SHA aprovado. A release fica draft até o upload terminar e o tamanho do asset ser confirmado. Torná-la pública é a última operação API. A concorrência global serializa os publicadores; objetos existentes não são substituídos.

Uma versão já preparada mas sem intenção exige um commit de autorização, eventualmente vazio. Repetir a mesma intenção reutiliza o SHA. Uma falha depois de criar a tag pode deixar tag/draft não publicados; a recuperação exige revisão explícita, sem apagar ou substituir versões automaticamente. Antes da primeira utilização, instalar estes workflows em master num commit normal, sem intenção de release. O listener `workflow_run` tem de existir no branch predefinido, conforme a [documentação GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).

O diagnóstico SSE Go conserva os scripts e testes, mas tem exclusivamente `workflow_dispatch`. Não foi executado nem investigado nesta tarefa. A falha intermitente Rust não foi investigada e não motivou alterações.

### Testes efetivamente executados nesta revisão

Plataforma: Windows x64. A nova publicação foi exercitada contra uma API HTTP local e repositórios Git temporários, sem qualquer escrita no GitHub real.

| Verificação | Resultado |
| --- | --- |
| `npm ci --ignore-scripts` e `npm test` | Aprovados; 198 testes, zero falhas/skips/cancelamentos |
| Gate/publicador | HTTP real simulado; 17 jobs, SHA, versão, forks/PRs, jobs em falta/duplicados/falhados/ignorados, tentativas, master concorrente, tags/releases existentes, falhas de build/upload; nenhuma publicação antecipada |
| Preparação Git | Master, árvore limpa, aliases Windows, versão/major Go, rollback, cancelamento, push sem tags mesmo com followTags, rejeição non-fast-forward e retry do mesmo SHA |
| `go test -mod=readonly ./...` e `cargo test --locked --manifest-path rust/Cargo.toml` | Aprovados, sem modificar as suites nativas |
| `npm run test:conformance` | 18 observações idênticas nas três linguagens, incluindo autorização e erros |
| `npm run test:discovery` | Aprovado no âmbito suportado, stdio/HTTP JSON nas três linguagens e SSE TypeScript/Rust |
| `npm run package:check`, perfis mínimo/recente | Aprovados; consumidores reais, HTTP legado/moderno JSON/SSE, seis exports e TypeScript estrito |
| Consumidor mínimo Node | Node 24.0.0/npm 11.3.0; instalação e compilação aprovadas sem override npm |
| Consumidores Go mínimo/recente | Go 1.26.0/1.26.3; resolução própria, execução e transportes aprovados |
| Consumidores Rust mínimo/recente | Rust 1.88/1.95, rmcp 3.5/3.6; Git/path, produção sem feature client, integração e transportes aprovados |
| `npm run test:native-packages` | Pacotes nativos instalados e executados fora do checkout |
| `npm run benchmark:discovery` | Budgets preservados; 93,3% de redução para uma alteração em 100 ferramentas |
| `actionlint`, `git diff --check` | Aprovados |

Os 17 jobs remotos da secção B são evidência histórica, não uma execução da nova revisão. Não se lançou uma release real nem se alteraram aplicações consumidoras. A tag `v0.6.0` continua no commit `726c53f77608d33bf59849d7b851b7ed36a5900b`; a versão pública dos manifests permanece 0.6.0. Não foram observadas regressões nos testes executados; a integração do listener/publisher no GitHub real continua dependente da instalação normal dos workflows em master, sem publicar nesta tarefa.
