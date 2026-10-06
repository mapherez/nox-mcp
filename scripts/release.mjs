import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateVersion, validateVersion } from './update-version.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function release(root, input, { check = () => {
  if (!process.env.npm_execpath) throw new Error('Executa com npm run release -- X.Y.Z.');
  const npm = (...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, stdio: 'inherit' });
  npm('ci', '--ignore-scripts');
  npm('test');
  execFileSync('go', ['test', '-mod=readonly', './...'], { cwd: root, stdio: 'inherit' });
  execFileSync('cargo', ['test', '--locked', '--manifest-path', 'rust/Cargo.toml'], { cwd: root, stdio: 'inherit' });
  npm('run', 'package:check');
} } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const { version } = await validateVersion(root, input);
  const tag = `v${version}`;
  if (git('status', '--porcelain')) throw new Error('A arvore Git tem alteracoes. Faz commit ou stash antes da release.');
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  // Check origin before touching manifests. Never replace a local or remote tag.
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) {
    throw new Error(`A tag ${tag} ja existe em origin; escolhe uma nova versao.`);
  }
  await updateVersion(root, version, { beforeCommit: check });
  try {
    // Both refs succeed together, with no force and no unrelated tags.
    git('push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tag}:refs/tags/${tag}`);
  } catch (error) {
    throw new Error(`Push falhou. O commit e a tag ${tag} ficaram locais. Corrige a causa e repete: git push --atomic origin HEAD:refs/heads/${branch} refs/tags/${tag}:refs/tags/${tag}`, { cause: error });
  }
  return `https://github.com/mapherez/nox-mcp/releases/download/${tag}/nox-mcp.tgz`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    if (process.argv.length !== 3) throw new Error('Uso: npm run release -- X.Y.Z');
    const url = await release(repoRoot, process.argv[2]);
    console.log('Commit e tag publicados. O GitHub Actions esta a testar e a gerar a release.');
    console.log(`Quando o workflow terminar: npm install ${url}`);
  })().catch(error => {
    console.error(error.stderr?.toString().trim() || error.message);
    if (error.cause) console.error(error.cause.stderr?.toString().trim() || error.cause.message);
    process.exitCode = 1;
  });
}
