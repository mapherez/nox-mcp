import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function jsonFile(path, original, lock = false) {
  const document = JSON.parse(original);
  if (document.name !== '@nox/mcp' || (lock && document.packages?.['']?.name !== '@nox/mcp')) {
    throw new Error(`Pacote inesperado em ${path}.`);
  }
  const versions = lock ? [document.version, document.packages[''].version] : [document.version];
  return { path, original, versions, render(version) {
    document.version = version;
    if (lock) document.packages[''].version = version;
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    return JSON.stringify(document, null, 2).replaceAll('\n', newline) + (original.endsWith('\n') ? newline : '');
  } };
}

function tomlFile(path, original, lock = false) {
  const pattern = lock
    ? /^\[\[package\]\]\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/gm
    : /^\[package\]\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/gm;
  const blocks = [...original.matchAll(pattern)].filter(match => /^name\s*=\s*"nox-mcp"\s*$/m.test(match[0]));
  if (blocks.length !== 1) throw new Error(`Esperava um unico pacote nox-mcp em ${path}.`);
  const block = blocks[0];
  const field = /^(version[ \t]*=[ \t]*")([^"]+)(")/m;
  const version = block[0].match(field)?.[2];
  if (!version) throw new Error(`Versao do pacote ausente em ${path}.`);
  return { path, original, versions: [version], render(version) {
    const updated = block[0].replace(field, (_, prefix, old, suffix) => prefix + version + suffix);
    return original.slice(0, block.index) + updated + original.slice(block.index + block[0].length);
  } };
}

export async function readVersionFiles(root) {
  const paths = ['package.json', 'package-lock.json', 'rust/Cargo.toml', 'rust/Cargo.lock'];
  const texts = await Promise.all(paths.map(path => readFile(resolve(root, path), 'utf8')));
  return paths.map((path, index) => index < 2
    ? jsonFile(path, texts[index], index === 1)
    : tomlFile(path, texts[index], index === 3));
}

export async function updateVersion(root, input) {
  const version = input.trim().replace(/^v/, '');
  const parsed = version.match(versionPattern);
  if (!parsed) throw new Error('Versao invalida. Usa X.Y.Z ou X.Y.Z-prerelease (ex.: 0.4.0 ou 0.4.0-beta.1).');
  const files = await readVersionFiles(root);
  const module = await readFile(resolve(root, 'go.mod'), 'utf8');
  const modulePath = module.match(/^module\s+(\S+)/m)?.[1];
  const suffix = modulePath?.match(/\/v([1-9]\d*)$/)?.[1];
  const majorSuffix = suffix && BigInt(suffix) >= 2n ? suffix : undefined;
  if (!modulePath || (BigInt(parsed[1]) >= 2n ? majorSuffix !== parsed[1] : majorSuffix !== undefined)) {
    throw new Error(`A versao ${version} exige primeiro migrar o module path Go para o major correspondente (v2+ usa /vN).`);
  }
  if (resolve(git(root, 'rev-parse', '--show-toplevel')) !== resolve(root)) {
    throw new Error('Executa o script no repositorio nox-mcp, nao num repositorio pai.');
  }
  git(root, 'symbolic-ref', '--quiet', 'HEAD');
  if (git(root, 'status', '--porcelain')) throw new Error('A arvore Git tem alteracoes. Faz commit ou stash antes de atualizar a versao.');
  const tag = `v${version}`;
  if (git(root, 'tag', '--list', tag)) throw new Error(`A tag ${tag} ja existe; escolhe uma nova versao.`);
  git(root, 'var', 'GIT_AUTHOR_IDENT');
  git(root, 'var', 'GIT_COMMITTER_IDENT');
  const updates = files.map(file => ({ ...file, updated: file.render(version) })).filter(file => file.original !== file.updated);
  if (!updates.length) throw new Error('Os ficheiros ja usam essa versao; escolhe uma nova versao.');
  const head = git(root, 'rev-parse', 'HEAD');
  try {
    for (const file of updates) await writeFile(resolve(root, file.path), file.updated);
    git(root, 'add', '--', ...updates.map(file => file.path));
    git(root, 'commit', '-m', `chore: release ${tag}`);
  } catch (error) {
    // Restore only our version edits when the release commit was not created.
    if (git(root, 'rev-parse', 'HEAD') === head) {
      for (const file of updates) await writeFile(resolve(root, file.path), file.original);
      git(root, 'restore', '--staged', '--', ...updates.map(file => file.path));
    }
    throw error;
  }
  // A tag failure leaves the release commit intact for inspection and retry.
  try {
    git(root, 'tag', '-a', tag, '-m', `Release ${tag}`);
  } catch (error) {
    throw new Error(`Commit de versao criado, mas a tag ${tag} falhou. Corrige o erro e cria a tag nesse commit.`, { cause: error });
  }
  return tag;
}

async function main() {
  if (process.argv.length > 3) throw new Error('Uso: npm run version:update [-- X.Y.Z]');
  const files = await readVersionFiles(repoRoot);
  const current = files[0].versions[0];
  console.log(`Versao atual (package.json): ${current}`);
  for (const file of files) console.log(`  ${file.path}: ${file.versions.join(', ')}`);
  if (files.some(file => file.versions.some(version => version !== current))) {
    console.log('Existem versoes inconsistentes; todas serao sincronizadas com a versao escolhida.');
  }
  console.log('A atualizacao cria um commit e uma tag Git local. Nao faz push.');
  let version = process.argv[2];
  if (!version) {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('Nova versao (Enter para cancelar): ');
    try {
      for await (const line of reader) { version = line; break; }
    } finally { reader.close(); }
  }
  if (!version?.trim()) { console.log('Cancelado.'); return; }
  const tag = await updateVersion(repoRoot, version);
  console.log(`Versoes sincronizadas; commit e tag ${tag} criados.`);
  console.log(`Para publicar: git push --follow-tags`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stderr?.toString().trim() || error.message);
    if (error.cause) console.error(error.cause.stderr?.toString().trim() || error.cause.message);
    process.exitCode = 1;
  });
}
