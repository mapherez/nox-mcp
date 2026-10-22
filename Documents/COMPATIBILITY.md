# Compatibilidade e suporte

Este documento descreve o âmbito de suporte do SDK. Os manifests e lockfiles são a referência para versões declaradas; resultados de testes anteriores estão no [relatório arquivado](old/COMPATIBILITY_AUDIT.md). Uma aprovação de um SHA anterior não certifica uma revisão posterior.

## Matriz suportada

| Funcionalidade | TypeScript | Go | Rust |
| --- | --- | --- | --- |
| stdio e HTTP JSON, incluindo clientes MCP legados | Supported / Required | Supported / Required | Supported / Required |
| SSE, incluindo erros terminais após progresso | Supported / Required | Investigating / Future Support | Supported / Required |
| `tools/list`, discovery incremental e negociação MCP 2026-07-28 | Supported / Required | Supported / Required | Supported / Required |
| `_meta.cli`, descritores CLI opcionais, JCS/SHA-256, snapshots e cache | Supported / Required | Supported / Required | Supported / Required |
| Autorização, schemas de entrada/saída, erros e rejeição antes do executor | Supported / Required | Supported / Required | Supported / Required |
| Pacotes instaláveis, APIs públicas e consumidores com resolução própria | Supported / Required | Supported / Required | Supported / Required |

O suporte limita-se às funcionalidades e percursos testados. Não certifica todas as opções MCP nem as integrações dos produtos NoX, que têm versões e suites próprias.

## Dependências e APIs

- TypeScript: Node 24+, `@modelcontextprotocol/server ^2.3.1`, Ajv `^8.20.0` e Zod `^4.6.0`. Integrações opcionais: `@modelcontextprotocol/node ^2.0.0` e `ws ^8.19.0`. Node mínimo usa o npm distribuído com Node, sem override global.
- Go: Go 1.26+, SDK MCP Go 1.8.0 e restantes requisitos em `go.mod`. Os consumidores resolvem o próprio grafo por MVS.
- Rust: Rust 1.88+, `rmcp >=3.5.0, <4` e restantes requisitos em `rust/Cargo.toml`. Os consumidores mantêm o próprio resolver/lockfile. Para o MSRV, usar resolução de dependências compatível com a versão de Rust; os testes mínimos não herdam o lockfile do SDK.
- O pacote TypeScript expõe seis entradas: `@nox/mcp`, `/contract`, `/bridge`, `/bridge/client`, `/bridge/server` e `/node`. A build elimina saídas antigas antes de compilar.
- A autenticação é fornecida pela aplicação através das APIs existentes de credenciais, contexto e scopes. O SDK não implementa fluxos de identidade dos produtos nem emite API Keys.
- `contracts/` é a fonte oficial; as cópias geradas acompanham Go/Rust e compilam sem Node. Preservam-se `_meta.cli`, metadados personalizados e os protocolos de bridge existentes.

O perfil portátil e as diferenças legítimas das APIs nativas estão descritos em [manutenção dos contratos](../contracts/README.md). Para atualizar instalações antigas, consultar também as [notas históricas de migração](old/MIGRATION_0_5.md); a publicação de uma versão não migra consumidores automaticamente.

## Resultados e erros

Sucessos incluem `structuredContent` conforme ao `outputSchema`. Erros de ferramenta usam `isError: true` e o corpo JSON em `content[].text`, sem `structuredContent`. Clientes que anteriormente liam esse campo em erros devem ler o texto JSON. Códigos de domínio, `retryable`, detalhes e extensões válidas mantêm-se.

| Cenário moderno | JSON-RPC | HTTP JSON |
| --- | --- | --- |
| Extensão obrigatória ausente ou versão da extensão incompatível | `-32021`, com `requiredCapabilities` | 400 |
| Versão de protocolo desconhecida | `-32022`, com `requested` e `supported` | 400 |
| `protocolVersion` ou `clientCapabilities` obrigatórios ausentes | `-32602` | 400 |
| Parâmetros inválidos dentro do handler NoX | `-32602` | TS/rmcp 3.6: 200; Go/rmcp 3.5: 400 |
| Definição ou snapshot desatualizado | `-32602`, `STALE_DEFINITION` ou `STALE_CATALOG` | Mapeamento do SDK |
| Erro de autorização/domínio do runtime | Resultado MCP `isError: true` | 200 |

Em SSE suportado, um erro após o início do stream mantém HTTP 200 e chega como evento terminal do mesmo pedido. Stdio usa o mesmo envelope JSON-RPC, sem status HTTP. Clientes legados continuam a usar `initialize`, `tools/list` e `tools/call`; não se aplica a negociação moderna aos seus pedidos. Ver [discovery](DISCOVERY.md) para os detalhes.

## Validação obrigatória e release

O workflow `Supported / Required compatibility` (`.github/workflows/contracts.yml`) contém 17 jobs bloqueantes: conformidade Windows/Linux, consumidores mínimos/recentes por linguagem nesses sistemas, Rust recente em macOS e seletores Node adicionais. Falhar um requisito suportado bloqueia a publicação.

Comandos principais, executados na raiz:

```sh
npm test
go test -mod=readonly ./...
cargo test --locked --manifest-path rust/Cargo.toml
npm run test:conformance
npm run test:discovery
npm run test:native-packages
npm run package:check
npm run benchmark:discovery
```

Os consumidores externos são testados com resolução independente. No CI, `node scripts/check-consumers.mjs` recebe `NOX_CONSUMER_LANGUAGE=go|rust` e `NOX_CONSUMER_PROFILE=minimum|latest`. O tarball TypeScript usa `npm run package:check` com `NOX_CONSUMER_PROFILE`. Selecionar também `GOTOOLCHAIN` ou `RUSTUP_TOOLCHAIN` para ensaiar a toolchain mínima.

`npm run release` prepara e envia apenas o commit de intenção para master. Após a matriz aprovada, `workflow_run` verifica o SHA, as 17 aprovações, versões e ausência de tag/release; empacota sem repetir as suites e publica como última operação. O procedimento e a recuperação de falhas estão no [README](../README.md#releases).

O [relatório histórico](old/COMPATIBILITY_AUDIT.md#e-revisão-após-v060-release-única-e-remoção-da-integração-de-identidade) distingue os 198 testes locais dessa revisão dos 17 jobs remotos de um SHA anterior. Não usar esses números como resultado da revisão atual; consultar os logs do respetivo commit.

## Investigating / Future Support: SSE Go

No SDK MCP Go 1.8.0, `extractErrorStatus` / `stream.deliverLocked` podem escrever JSON bruto depois de já ter sido enviado progresso SSE. Os códigos `-32021`, `-32022`, `-32602` e `-32601` ficam fora de um evento `data:`; HTTP permanece 200 e um cliente SSE correto não recebe uma resposta terminal válida.

O handler HTTP NoX Go usa JSON e não sofre deste caso de erro tardio SSE. Stdio e HTTP JSON Go continuam suportados. SSE Go não tem garantia de conformidade completa; não foi criado transporte próprio, fork ou workaround de serialização.

`npm run diagnose:go-sse` reproduz o defeito e termina com código 1 perante framing inválido. O workflow `Investigating / Future Go SSE` tem apenas `workflow_dispatch`, sem `continue-on-error`, e não integra a release nem deve ser um check obrigatório. Os testes SSE válidos de TypeScript/Rust continuam obrigatórios.

Reconsiderar suporte quando existir correção upstream ou solução segura nas APIs oficiais e necessidade concreta de produto. Exigir testes de framing dos quatro códigos, resultados/erros, negociação e clientes legados em Windows/Linux, além da aprovação da matriz. Um diagnóstico que deixe de falhar não promove suporte automaticamente.
