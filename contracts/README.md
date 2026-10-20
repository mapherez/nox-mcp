# Gestão dos contratos existentes

`contracts/` é a única fonte oficial dos seis schemas partilhados e dos valores de `defaults.json`. O corpus `conformance.json` contém exemplos usados nas três linguagens. Esta consolidação não cria contratos para CLI, Gateway ou Portal, nem altera autenticação ou versões dos protocolos.

## Ficheiros gerados

Executar na raiz do repositório:

```sh
npm run contracts:sync
npm run contracts:check
```

O primeiro comando sincroniza:

- `go/contracts/*.schema.json` e `rust/contracts/*.schema.json`;
- `go/contracts/conformance.json` e `rust/contracts/conformance.json`;
- `typescript/src/contracts.generated.ts`, com os validadores Zod;
- `typescript/src/defaults.json`, `go/defaults.go` e `rust/src/defaults.rs`.

Estes ficheiros são versionados e devem acompanhar a alteração da fonte no mesmo commit. Não devem ser editados manualmente. `contracts:check` apenas lê: falha se faltar um ficheiro, existir uma cópia obsoleta ou houver divergência. A comparação ignora apenas a diferença entre finais de linha LF e CRLF.

A geração é uma operação de manutenção, não uma dependência da compilação nativa. Go continua a usar `go:embed`; Rust continua a usar `include_str!` dentro da própria crate. Nem `go build` nem `cargo build` executam Node ou precisam de procurar schemas fora do pacote instalado. Não se usam symlinks, `build.rs` ou hooks de instalação para gerar contratos.

O tarball TypeScript contém o JavaScript/declarações compilados e o JSON de defaults, como antes. Os consumidores não precisam do gerador nem da pasta oficial de fontes. O mapa de exports mantém-se.

## Interpretação e compatibilidade

Os schemas existentes continuam em JSON Schema draft-07. Não se fecharam objetos, não se tornaram campos opcionais obrigatórios e não se apertaram os requisitos dos manifestos. `_meta` foi explicitado no manifesto como campo opcional opaco: os objetos com `_meta.cli` e metadados personalizados são preservados, sem rejeitar valores que o schema anterior já aceitava como propriedades adicionais.

Os validadores TypeScript são gerados a partir dos schemas. Os objetos abertos preservam propriedades desconhecidas, incluindo extensões do manifesto, anotações e erros de domínio. Os schemas de entrada/saída das ferramentas são transportados como objetos JSON opacos, sem reescrever keywords, referências ou extensões do produto. A fábrica pública `createResponseSchema` mantém o suporte a erros definidos pelo consumidor.

O gerador suporta deliberadamente o subconjunto de JSON Schema usado nestes contratos; não é um conversor geral. Uma assertion não suportada causa erro de geração, em vez de ser ignorada. Não usa `z.fromJSONSchema` no runtime distribuído: essa API da dependência existente é utilizada apenas nos testes. Os validadores gerados conservam os tipos públicos usados pelos consumidores, incluindo o enum de versões com entrada TypeScript `string` e o schema ISO de datas.

Continuam a existir diferenças intencionais de responsabilidade que não podem ser eliminadas apertando a validação sem comprometer a compatibilidade:

| Superfície | Comportamento preservado e motivo |
| --- | --- |
| Validação estrutural de manifesto | TypeScript/Go e `validate_schema` Rust aceitam um `protocolVersion` não vazio até 32 caracteres, ferramentas repetidas e schemas representados por objetos JSON. Não significam que o manifesto seja executável por qualquer runtime. |
| `load_tools` Rust | Mantém protocolo `2.0`, nomes únicos e schemas MCP de tipo objeto. Os requisitos são anteriores a esta consolidação. Não foram impostos aos validadores TypeScript/Go. |
| Scopes no carregador Rust | `scope`/`requiredScopes` não são carregados automaticamente para `ServerOptions.required_scopes`. Campos ignorados pelo carregador continuam ignorados, incluindo valores que o validador estrutural rejeita. Alterar este comportamento poderia mudar a autorização de uma aplicação. |
| Metadados no carregador Rust | Objetos `_meta` são conservados em `rmcp::Tool`. Um valor escalar aceite pelo schema estrutural opaco continua a ser recusado pelo carregador; `null` representa ausência. |
| Projeções Rust | `load_tools` devolve tipos do SDK e `parse_server_frame` devolve o enum existente. Conservam os campos representáveis nesses tipos, mas não são APIs de round-trip de todas as propriedades JSON desconhecidas. Alargar os tipos/variantes públicos exigiria avaliar compatibilidade de código consumidor. |
| Defaults de erro | O parse TypeScript continua a materializar `retryable: false` quando omitido. Go/Rust validam o documento sem inserir defaults. O campo mantém-se opcional no contrato JSON. |
| Interface `ToolManifestEntry` | Os quatro booleanos de anotações continuam obrigatórios na interface TypeScript existente; o parser e o JSON Schema continuam a permitir anotações parciais. Tornar os membros da interface opcionais quebraria código que os lê como `boolean`. |
| Schemas de ferramentas | Zod, `jsonschema-go` e `jsonschema` Rust não são o mesmo motor. O corpus cobre assertions comuns; não promete equivalência para todos os dialetos, formatos e schemas arbitrários. |

As exceções do carregador constam dos exemplos com `loadTools` e, quando divergem de `valid`, `loaderReason`. São expectativas verificadas, não testes ignorados. Não se devem introduzir novas exceções para fazer um teste passar sem analisar a baseline e explicar o impacto.

`_meta.cli` mantém o significado atribuído pelo produto. Não existe aqui uma nova interpretação de comandos ou navegação. Os protocolos de ponte `1.0`/`2.0`, os envelopes, os prazos, os limites e os mecanismos de autenticação não foram alterados. O broker Rust local mantém os seus IDs com prefixo e prazos numéricos; não foi confundido com os frames WebSocket UUID/RFC3339.

## Alterar ou acrescentar um contrato

1. Consultar a [baseline histórica](../COMPATIBILITY_BASELINE.md) e identificar consumidores e entradas já aceites. A baseline descreve o estado auditado antes desta consolidação; não deve ser reescrita como se tivesse auditado código novo.
2. Editar apenas as fontes em `contracts/`. Preservar os campos e mensagens existentes; não acrescentar requisitos nem restringir valores sem uma decisão de compatibilidade. Quando um schema contém uma definição repetida dentro de um envelope, manter essas definições coerentes; o gerador verifica também esta consistência interna.
3. Acrescentar casos válidos, inválidos e de regressão a `conformance.json`. Cada caso tem `id` único, `schema`, `data` e `valid`. Os casos de manifesto incluem também `loadTools`. `schemaCases` contém schemas/valores de entrada e saída usados pelos três motores.
4. Se for um schema novo, registar o respetivo validador TypeScript no gerador e nos testes, e a leitura Rust no teste de conformidade. Acrescentar suporte explícito ao gerador quando uma nova assertion for necessária. O teste verifica que todos os schemas oficiais têm exemplos.
5. Executar a sincronização, rever o diff das fontes e dos ficheiros gerados e executar as verificações abaixo. Incluir todos os ficheiros gerados no commit.

```sh
npm run contracts:sync
npm run contracts:check
npm test
go test -mod=readonly ./...
cargo test --locked --manifest-path rust/Cargo.toml
npm run test:native-packages
npm run package:check
```

`test:native-packages` usa diretórios temporários: compila um consumidor Go com apenas os ficheiros do módulo, empacota/extrai a crate Rust, executa os testes da crate extraída e compila um consumidor dessa crate. Não altera repositórios de produtos. Este teste corre offline depois de as suites normais terem preenchido as caches das dependências.

O workflow `contracts.yml` executa estas verificações em pushes de branches e pull requests. A release volta a verificar sincronização, suites, pacote TypeScript e dependências nativas antes de publicar. `npm test` e `prepack` recusam ficheiros gerados desatualizados; não os corrigem silenciosamente.

## Limites desta fase

Não foram atualizadas dependências, versões de pacotes ou referências dos consumidores. Backend, Yard, Bot e NoteX não são modificados por estes comandos. As versões antigas instaladas, incluindo as do NoteX, continuam a usar os seus próprios artefactos; não são migradas nem regeneradas. O suporte a uma atualização futura de cada produto exige os respetivos testes de integração.
