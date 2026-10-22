# Contratos partilhados

`contracts/` é a fonte oficial dos seis schemas de protocolo, dos defaults, do perfil de schemas de ferramentas e do corpus de conformidade. O âmbito suportado está em [compatibilidade e suporte](../Documents/COMPATIBILITY.md). As auditorias e notas de migração anteriores estão no [arquivo histórico](../Documents/old/README.md).

## Responsabilidades

O Passo 2B acrescenta contratos opcionais separados para descritores CLI e discovery incremental, sem alterar os contratos anteriores. Consultar [discovery incremental](../Documents/DISCOVERY.md) para negociação, exemplos nas três linguagens, fingerprints, snapshots e cache. `cli.schema.json` e `discovery-*.schema.json` são validados pelos validadores JSON Schema nativos; o corpus adicional é `discovery-conformance.json`. `npm run contracts:sync` gera as cópias e os schemas TypeScript, e `npm run test:discovery` compara as implementações e os transportes reais.

Um manifesto estruturalmente válido não constitui uma autorização nem garante que pode ser executado.

| Operação | TypeScript | Go | Rust | Garantia |
| --- | --- | --- | --- | --- |
| Validação estrutural | `toolManifestSchema` | `ValidateFrame("manifest", ...)` | `validate_schema` com o schema oficial | Documento conforme a `manifest.schema.json`; não compila schemas de ferramentas. |
| Preparação para execução | `loadToolManifest` | `LoadToolManifest` | `load_manifest` | Validação estrutural, protocolo `2.0`, nomes únicos, entrada/saída de tipo objeto e compilação no perfil comum. Devolve o documento completo. |
| Associação e execução | `createServerFromManifest` | `NewFromManifest` | `McpServer::from_manifest` | Associa implementações fornecidas pela aplicação, valida entrada/saída e aplica requisitos de autorização. |

Na validação estrutural, `schemaVersion` continua a ser `1`, `protocolVersion` é uma string não vazia até 32 caracteres e os schemas de ferramentas são objetos JSON opacos. Ferramentas repetidas ou schemas não executáveis podem ser válidos nesta operação. As anotações são um objeto obrigatório, com booleanos opcionais. Os testes separam estes resultados dos requisitos de execução.

Na descoberta a partir de manifesto, a ausência de uma indicação mantém o significado MCP: `readOnlyHint` e `idempotentHint` têm valor efetivo `false`; `destructiveHint` e `openWorldHint` têm valor efetivo `true`. Alguns SDKs materializam os booleanos com valor efetivo `false`. O documento completo conserva a presença original dos campos.

Os carregadores de documentos conservam `_meta.cli`, metadados personalizados, extensões, propriedades desconhecidas e a distinção entre ausência e valor presente. `_meta` é opcional e, quando presente, tem de ser um objeto; `{}` é válido, `null`, arrays e escalares são inválidos. Não interpretamos `_meta.cli` como uma nova convenção de comandos.

Validar não transforma dados: não insere defaults, não converte tipos e não remove propriedades. `default` é uma anotação. Um campo omitido continua omitido, incluindo `retryable` num documento de erro. Propriedades desconhecidas são aceites nos objetos abertos dos contratos; nas ferramentas, vale o `additionalProperties` do respetivo schema.

## Scopes e confiança

- `scope` é uma descrição legada. Não concede acesso nem equivale a `requiredScopes`.
- `requiredScopes` declara requisitos de execução; cada elemento tem de ser uma string não vazia. Ausência ou lista vazia significa que o manifesto não acrescenta requisitos.
- O carregamento não atribui identidade nem permissões. A aplicação tem de aprovar o manifesto e associar executores de confiança.
- Os construtores a partir de manifesto unem os requisitos declarados aos requisitos configurados pela aplicação. O manifesto não pode remover uma restrição local.
- Os scopes concedidos vêm exclusivamente da identidade/autenticação: `auth.scopes` em TypeScript, `auth.TokenInfo` em Go e `ServerOptions.scopes` em Rust. Todos os requisitos têm de estar presentes; caso contrário a biblioteca devolve `FORBIDDEN` antes de executar.

TypeScript exige uma implementação em `bindings` para cada nome; Go exige-a em `Options.Tools`. Rust recebe um `Executor` de confiança, responsável pelo despacho dos nomes aprovados. Esta diferença de arquitetura não altera a política. Os mecanismos de autenticação de cada produto continuam sob responsabilidade desse produto.

O antigo `load_tools` Rust devolve apenas `Vec<rmcp::Tool>`, que não transporta a política de scopes. Passa a rejeitar manifestos com requisitos não vazios, em vez de os descartar silenciosamente. Usar `load_manifest` para inspeção ou `McpServer::from_manifest` para executar esses manifestos.

## Schemas de ferramentas

`compileToolSchema` / `CompileToolSchema` / `compile_tool_schema` compilam o mesmo perfil explícito, offline, de JSON Schema draft-07. As funções `validateToolValue` / `ValidateToolValue` / `validate_tool_value` devolvem falso para schemas inválidos ou valores inválidos. Os construtores a partir de manifesto utilizam este perfil para validar realmente as chamadas.

O perfil é definido em `tool-schema-policy.json`. Inclui tipos e uniões, objetos e propriedades, arrays homogéneos, limites, `enum`, `const`, `allOf`, `anyOf`, `oneOf`, `not`, referências locais e anotações. Subsquemas booleanos são suportados; as raízes de entrada e saída executáveis declaram `type: "object"` por serem ferramentas MCP.

Regras de portabilidade:

- Apenas o dialeto draft-07 indicado na política; keywords desconhecidas são recusadas. Extensões `x-*` são conservadas no documento e não introduzem validação.
- Apenas `$ref` local em JSON Pointer `#/...`, com escapes `~0`/`~1` e índices de arrays válidos. Referências remotas, ciclos e profundidade superior a 64 são recusados. Não há acesso à rede durante a compilação.
- Uma referência não pode ter assertions irmãs: draft-07 ignora-as e outros dialetos podem aplicá-las. Permitem-se anotações, definições e extensões sem significado de validação.
- `uuid` e `date-time` são os únicos formatos assertivos, usando os padrões dos envelopes oficiais: UUID com variante/versão reconhecida e data/hora com segundos e fuso explícito. Outros formatos são recusados. A semântica é a dos padrões versionados, não a totalidade das variantes das RFC.
- Regex usam grupos simples ou `(?:...)`, classes, quantificadores e escapes comuns. `\d`, `\w` e `\s` usam classes ASCII; as variantes maiúsculas negadas são permitidas fora de classes. `.` exclui LF, CR, U+2028 e U+2029; `$` exige o fim efetivo da string. Escapes hexadecimais de dois dígitos são suportados. Lookaround, backreferences, escapes Unicode/propriedades, classes aninhadas/interseções e construções específicas de um motor são recusados. Padrões de propriedades que colidam após normalização são recusados, para não perder assertions.
- `multipleOf` exige um inteiro positivo até `2^53−1`. Foi confirmada uma divergência dos motores com `0.3 / 0.1`; o perfil comum recusa divisores fracionários explicitamente. As APIs nativas continuam disponíveis para schemas mais abrangentes, sem promessa de equivalência nesses casos.
- Para números interoperáveis, utilizar valores finitos e inteiros dentro do intervalo exato do JavaScript (`±(2^53−1)`). Os tipos nativos Go/Rust podem representar mais precisão; este perfil não acrescenta aritmética decimal arbitrária ao JavaScript.

`tool-schema.meta.json` é a cópia versionada do meta-schema draft-07 distribuído pelo Ajv; permite verificar também em Go a validade do schema antes de o resolver. Ajv é a única nova dependência de execução TypeScript: fornece compilação draft-07 sem usar a conversão experimental JSON Schema → Zod. Não foram atualizadas as dependências existentes. Os três motores mantêm implementações próprias; as regras comuns são verificadas pelo corpus.

As APIs nativas `createServer` com Zod, `New` com schemas Go e `McpServer::new` com ferramentas do SDK Rust permanecem disponíveis. Refinamentos/transformações Zod, dialetos nativos e conteúdos ricos do SDK são funcionalidades próprias destas superfícies. Um manifesto partilhado usa os construtores e o perfil acima.

## Resultados, erros e execução

Nas chamadas comuns, o sucesso contém um objeto `structuredContent` validado pelo schema de saída e o mesmo JSON no bloco de texto. Entrada inválida produz `INVALID_INPUT`; saída inválida produz `INTERNAL`. Exceções/panics inesperados são convertidos em `INTERNAL` sem expor o erro interno ao cliente.

Um erro de ferramenta tem `isError: true` e um corpo conforme a `error.schema.json`. Códigos de domínio e propriedades adicionais continuam permitidos, incluindo `details` e `currentVersion`. Na fronteira de execução, `retryable` omitido é materializado como `false`; erros malformados e envelopes demasiado grandes dão origem a um erro `INTERNAL` mínimo. Esse erro mínimo pode exceder um limite configurado demasiado pequeno para conter qualquer erro válido.

Esse corpo de erro é transportado como JSON em `content[].text`, **sem `structuredContent`**. O campo `structuredContent` fica reservado aos resultados de sucesso que respeitam o `outputSchema` anunciado. Os consumidores podem validar o corpo de erro com `error.schema.json`. Ver [compatibilidade e migração](../Documents/COMPATIBILITY.md#resultados-e-erros).

O prazo é calculado uma vez à entrada da execução da biblioteca; inclui validação e execução e é transmitido ao executor. Uma chamada já cancelada não inicia o executor. A biblioteca volta a verificar prazo/cancelamento antes de aceitar um sucesso, impedindo que um resultado tardio seja tratado como confirmado. Não inclui autenticação ou processamento do transporte anterior à entrada no runtime.

Timeout usa `TIMEOUT`; cancelamento usa `CANCELLED`. Para leituras explicitamente marcadas, `retryable: true`; para outras operações, `retryable: false` e `details.outcome: "unknown"`. Cancelamento não garante rollback nem que um efeito externo não aconteceu. Um executor tem de cooperar com o contexto recebido.

Continuam legítimas estas diferenças:

| Superfície | Diferença e limite |
| --- | --- |
| Projeções SDK | `load_tools`, `parse_server_frame` Rust e tipos de descoberta Go/Rust só representam os campos do SDK. Usar o carregador completo para conservar todas as extensões; não fazer round-trip do manifesto através de tipos de descoberta. Metadados `_meta` de objetos continuam anunciados. |
| Erros Go | `Runtime.Execute` usa o retorno idiomático `error`; a normalização do envelope MCP ocorre no handler. Os testes comparam essa fronteira. |
| Cancelamento físico | Go/TypeScript retêm capacidade enquanto trabalho não cooperante continua; Rust pode abortar o futuro. Não existe preempção universal nem reversão de efeitos. |
| Transporte | O SDK pode suprimir a resposta quando a ligação/pedido é cancelado. O contrato define o resultado interno quando pode ser entregue; não exige resposta numa ligação encerrada. |
| Detalhes locais | Mensagens humanas, IDs gerados, representação do prazo e diagnósticos variam. Código, possibilidade de repetição, detalhes de resultado desconhecido e dados JSON são comparáveis. |

Os protocolos MCP, frames de bridge `1.0`/`2.0`, tickets, heartbeats e brokers locais não foram redesenhados. IDs com prefixo e prazos numéricos do broker Rust local continuam distintos dos envelopes WebSocket UUID/RFC3339.

## Geração e manutenção

```sh
npm run contracts:sync
npm run contracts:check
```

O gerador copia schemas, política, meta-schema e corpus para `go/contracts` e `rust/contracts`, gera os validadores Zod TypeScript, copia a política TypeScript e gera os defaults das três linguagens, incluindo o tipo estrutural `defaults.generated.ts` para declarações compatíveis com NodeNext. Estes resultados são versionados e acompanham as fontes no mesmo commit. Não os editar manualmente. `contracts:check` só lê e falha perante divergências, ficheiros em falta ou cópias obsoletas; ignora apenas LF/CRLF.

Go usa `go:embed`; Rust usa `include_str!`. Os pacotes instalados contêm as cópias necessárias e compilam sem Node, symlinks ou geração durante a build. O tarball TypeScript inclui JavaScript, declarações e os JSON de defaults/política. Não executa hooks de build no consumidor.

Para alterar um contrato:

1. Consultar a documentação de compatibilidade e, quando relevante, o arquivo de migrações; identificar operações, consumidores e impacto de compatibilidade.
2. Alterar as fontes oficiais. Se introduzir uma assertion nova, acrescentar suporte explícito ao gerador ou ao perfil, sem a ignorar num motor.
3. Acrescentar casos válidos, inválidos e regressões ao corpus. `cases` testa documentos, `executable` testa preparação e `loadTools` testa a limitação da projeção legada Rust. `schemaCases` separa validade do schema e do valor. `runtimeCases` descreve chamadas, autorização, erros e término.
4. Sincronizar, rever o diff e executar as verificações seguintes. Incluir os ficheiros gerados e documentar qualquer migração necessária.

```sh
npm run contracts:sync
npm test
go test -mod=readonly ./...
cargo test --locked --manifest-path rust/Cargo.toml
npm run test:conformance
npm run test:native-packages
npm run package:check
```

As suites usam os mesmos exemplos e expectativas, sem exceções por linguagem na validação/preparação comum. `test:conformance` executa os três runtimes, recolhe observações normalizadas e compara os JSON efetivamente produzidos: sucesso/erro, corpo, código, `retryable`, `details` e se o executor chegou a ser invocado. Verifica também a descoberta real dos metadados e schemas através dos SDKs. Exclui mensagens humanas, IDs e relógios. Os testes de transporte existentes cobrem HTTP/SDK em separado; o cancelamento controlado evita depender da supressão de respostas pelo transporte.

`test:native-packages` compila um consumidor Go isolado e uma crate Rust empacotada fora do checkout, sem a pasta oficial `contracts/` nem Node na build nativa. `package:check` instala o tarball, testa imports e HTTP JSON/SSE antes de instalar TypeScript e, depois, compila e executa uma aplicação consumidora estrita. `test:consumers -- --language=rust` e `--language=go` verificam aplicações com resolução própria; `--minimum` seleciona o perfil mínimo. A matriz de toolchains/dependências e os bloqueadores estão em [compatibilidade e suporte](../Documents/COMPATIBILITY.md). Os testes nativos de distribuição usam as caches preenchidas pelas suites normais.

O workflow de contratos executa estas verificações; a release consulta as aprovações do mesmo SHA, sem repetir a matriz nem as suites. `npm test` e `prepack` recusam ficheiros gerados desatualizados. Nenhum destes comandos atualiza Backend, Yard, Bot ou NoteX. Não editar as cópias geradas diretamente.
