# Migração para 0.5.0

A versão `0.5.0` está preparada no repositório, **sem release publicada**. O incremento minor numa biblioteca ainda `0.x` assinala as correções incompatíveis. Não atualizar consumidores implicitamente: instalar uma versão/tag explícita, rever o lockfile e testar cada produto antes de adotar esta versão.

As versões do protocolo de bridge (`1.0`/`2.0`) e do schema de manifesto (`1`) não mudam: os envelopes mantêm-se e a alteração está na validação e execução da biblioteca. Não foi redesenhado o protocolo MCP. A baseline da auditoria permanece inalterada.

## Alterações incompatíveis confirmadas

| Antes | A partir de 0.5.0 | Migração |
| --- | --- | --- |
| O schema estrutural aceitava `_meta` escalar/array/null; o carregador Rust tinha outra interpretação. | `_meta`, quando presente, é um objeto em todas as linguagens. Objetos vazios, `_meta.cli` e propriedades personalizadas são conservados. | Omitir metadados ausentes; transportar valores personalizados dentro de um objeto. Não substituir `{}` por `null`. |
| O parse TypeScript inseria `retryable: false` num documento que não tinha o campo; Go/Rust não o inseriam. | A validação estrutural não modifica documentos. Apenas a fronteira de execução materializa `false` nos erros produzidos. | Se o código lê o parser diretamente, usar `error.retryable ?? false` ou distinguir explicitamente ausência. |
| `ToolManifestEntry.annotations` exigia quatro booleanos no tipo TypeScript, embora o JSON permitisse omiti-los. | Os quatro membros são opcionais, como no contrato. | Rever leituras que assumiam `boolean` obrigatório; usar `=== true` para reconhecer uma indicação explícita. |
| Rust `load_tools` ignorava `requiredScopes`, incluindo valores malformados. | Valida o manifesto completo e rejeita requisitos não vazios, porque `Vec<Tool>` não os transporta. | Para executar manifestos com requisitos, usar `McpServer::from_manifest`; para inspeção sem perdas, usar `load_manifest`. Não eliminar requisitos para contornar a validação. |
| Rust `load_tools` aceitava objetos de schema sem garantir que eram compiláveis. Os motores aplicavam assertions/formatos de forma diferente. | Preparação verifica o perfil comum e falha cedo perante schemas inválidos ou não portáveis. | Validar os manifestos no CI. Adaptar schemas ao perfil documentado; conservar APIs nativas quando a ferramenta depende deliberadamente de outro dialeto. |
| Requisitos vazios podiam chegar à execução com significados diferentes. | `requiredScopes: [""]` e requisitos vazios nas configurações nativas são inválidos. | Remover strings vazias; manter a lista vazia apenas quando não há requisitos. Scopes concedidos continuam a vir da autenticação. |
| Comprimentos podiam contar bytes Go/Rust ou unidades UTF-16 TypeScript. | Limites dos contratos contam pontos de código Unicode, incluindo nomes até 64 caracteres. | Não truncar nomes por bytes. Não há alteração dos nomes das ferramentas existentes. |
| SDK/validação TypeScript podia produzir erros fora da fronteira NoX; saída inválida podia ser confundida com erro de entrada. Rust não uniformizava erros/panics do executor. | Entrada inválida → `INVALID_INPUT`; saída/erro malformado e falha inesperada → `INTERNAL`. Erros estruturados são validados, sanitizados e limitados. | Rever clientes/testes que dependiam de erros SDK, mensagens internas ou erros sem corpo estruturado; manter códigos de domínio e detalhes válidos. |
| Alguns caminhos de cancelamento/prazo divergiam no código, `retryable`, detalhes e aceitação de resultados tardios. | Prazo único desde a entrada no runtime; `TIMEOUT`/`CANCELLED`, repetição apenas para leitura explícita e resultado desconhecido nas restantes operações. | Respeitar o sinal/contexto e o prazo recebido. Tratar `details.outcome: "unknown"` sem repetir escritas automaticamente. |
| Rust `McpServer::new` podia aceitar nomes repetidos, schemas inválidos e políticas para ferramentas inexistentes. | Rejeita essas configurações no arranque. | Corrigir nomes/políticas e schemas antes de criar o servidor. |
| `Tool` Go não representava `openWorldHint`. | Acrescentado `OpenWorld *bool`; `nil` significa ausência. | Usar literais com nomes de campos. Literais posicionais precisam de adaptação ao novo campo. |

Os novos carregadores completos e construtores a partir de manifesto não substituem as APIs nativas. São a via explícita para partilhar o mesmo JSON e as mesmas regras de validação entre linguagens. A associação só aceita executores fornecidos pela aplicação; não executa código proveniente de metadados. Requisitos declarados são unidos à política local e nunca concedidos ao utilizador.

O perfil comum recusa dialetos/keywords/formatos desconhecidos, referências remotas ou recursivas e regex não portáveis. Suporta `multipleOf` apenas com inteiro positivo seguro: confirmou-se que Go rejeitava `0.3` com divisor `0.1`, enquanto Rust o aceitava. A restrição é explícita nas três implementações; não se promete equivalência decimal arbitrária. As APIs nativas mantêm a sua abrangência anterior. Ver [regras completas](contracts/README.md#schemas-de-ferramentas).

Ajv é acrescentado como dependência de execução TypeScript para compilação draft-07. Não se atualizaram as versões das dependências já existentes. Go/Rust continuam a compilar como dependências externas sem scripts Node.

## Impacto previsto nos consumidores

As referências abaixo foram consultadas apenas em leitura. Não foram alterados código, dependências ou lockfiles dos produtos, nem foram executadas as suas suites de integração. As versões instaladas continuam independentes deste checkout.

| Produto | Dependência observada | Impacto de uma atualização futura |
| --- | --- | --- |
| NoX Backend | Go `v0.4.3`, ferramentas construídas no código | Os literais existentes usam nomes de campos. Rever erros de validação, prazos, cancelamento e scopes; pode continuar a usar `New`. |
| NoX Yard | Go `v0.4.3`, ferramentas e workflows no código | Mesmas verificações do Backend, incluindo cancelamento de operações com efeitos. Preservar nomes, schemas e `_meta.cli`. |
| NoX Bot | TypeScript `0.4.3`, schemas Zod e `formatError` | Mantém `createServer`/adaptador Node e schemas nativos. Testar erros de domínio e `WRITE_UNCONFIRMED`, validação e cancelamento. Um formatter tem de produzir um corpo de erro válido. |
| NoteX | TypeScript `0.4.3` na raiz e `0.4.1` no backend/contratos; Rust `0.1.0` fixado em `fd1b688d700b37caf96961c15f6d7022a09ab7a4` | **Intocado.** Não atualizar nesta fase. Uma migração futura exige ensaiar o manifesto real, `load_tools`/scopes, extensões de erro, bridges, tickets, broker desktop e integração entre versões. |

O NoteX não recebe esta normalização através de geração ou da CI do `nox-mcp`: os artefactos e referências fixadas continuam a usar as versões anteriores. Não se afirma compatibilidade automática de `0.5.0` com código ainda não migrado/testado.

## Adoção explícita

1. Manter a referência atual até existir uma release aprovada. Não substituir a versão instalada por uma branch móvel.
2. Rever as alterações e validar os manifestos reais com as novas funções. Projeções SDK não conservam o documento integral.
3. Se adotar os construtores de manifesto, fornecer bindings/executor de confiança, política local e identidade autenticada em separado. Testar permissão em falta, autorização explícita e impossibilidade de retirar requisitos locais.
4. Executar as suites do produto: erros, limites, cancelamento, transportes e, quando aplicável, desktop/bridge.
5. Atualizar a dependência e o lockfile apenas nesse produto, de forma deliberada. A publicação e estas atualizações não fazem parte deste passo.

A equivalência é verificada para os contratos e perfil comuns, com as diferenças legítimas de SDK/transporte descritas em [contracts/README.md](contracts/README.md). O desenho dos novos contratos pode partir desta base; publicação e migração dos produtos continuam a ser decisões posteriores.
