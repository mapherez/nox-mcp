# NoX MCP

Bibliotecas para uso privado, em alpha. Cada app fornece as suas tools e handlers.

## TypeScript / Node 24+

Instalação diretamente do GitHub, com acesso ao repo privado:

```sh
npm install "git+https://github.com/mapherez/nox-mcp.git"
```

A instalação compila a biblioteca através de `prepare`. O import é:

```ts
import { createServer } from '@nox/mcp';
```

Os ficheiros `package.json` e `package-lock.json` ficam na raiz; o código fica em
`typescript/src`. HTTP/stdio em Node requer `@modelcontextprotocol/node`; o bridge
requer `ws`. Better Auth é uma integração opcional.

## Rust / 1.88+

A crate `nox-mcp` está em `rust/` e pode ser usada como dependência Git ou path.

## Go / 1.26+

O módulo conserva o identificador que configuraste: `github.com/mapherez/nox-mcp`.
A biblioteca está no package `github.com/mapherez/nox-mcp/go`.

## Conteúdo

Código das três bibliotecas, schemas, defaults, manifests, lockfiles e licença.
A pasta não contém workflows, testes externos, exemplos ou scripts auxiliares.
Nenhuma biblioteca é publicada automaticamente em registos públicos.
