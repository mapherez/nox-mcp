import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { readVersionFiles, updateVersion, validateVersion } from './update-version.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function release(root, input, { check = () => {} } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const { version } = await validateVersion(root, input);
  const tag = `v${version}`;
  if (git('status', '--porcelain')) throw new Error('A arvore Git tem alteracoes. Faz commit ou stash antes da release.');
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  if (branch !== 'master') throw new Error('A preparacao de release exige a branch master.');
  // Check origin before touching manifests. Never replace a local or remote tag.
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) {
    throw new Error(`A tag ${tag} ja existe em origin; escolhe uma nova versao.`);
  }
  await updateVersion(root, version, { beforeCommit: check, allowCurrentVersion: true, releaseIntent: true });
  const sha = git('rev-parse', 'HEAD');
  try {
    // Explicit SHA and --no-follow-tags prevent implicit pushes of local tags.
    git('push', '--no-follow-tags', 'origin', `${sha}:refs/heads/master`);
  } catch (error) {
    throw new Error(`Push falhou. O commit ${sha} ficou local, sem criar tags. Corrige a causa e repete npm run release -- ${version}.`, { cause: error });
  }
  return `https://github.com/mapherez/nox-mcp/releases/download/${tag}/nox-mcp.tgz`;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === await realpath(fileURLToPath(import.meta.url))) {
  (async () => {
    if (process.argv.length > 3) throw new Error('Uso: npm run release [-- X.Y.Z]');
    let version = process.argv[2];
    if (version === undefined) {
      const files = await readVersionFiles(repoRoot);
      const current = files[0].versions[0];
      console.log(`Versao atual (package.json): ${current}`);
      for (const file of files) console.log(`  ${file.path}: ${file.versions.join(', ')}`);
      if (files.some(file => file.versions.some(value => value !== current))) {
        console.log('Existem versoes inconsistentes; todas serao sincronizadas com a versao escolhida.');
      }
      console.log('A release prepara um commit em master. O CI valida o SHA antes de criar a tag e publicar.');
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      process.stdout.write('Versao a publicar (Enter para cancelar): ');
      try {
        for await (const line of reader) { version = line; break; }
      } finally { reader.close(); }
      if (!version?.trim()) { console.log('Cancelado.'); return; }
    }
    const url = await release(repoRoot, version);
    console.log('Commit enviado para master, sem tag. O GitHub Actions publica apenas se os 17 jobs desse SHA forem aprovados.');
    console.log(`Quando o workflow terminar: npm install ${url}`);
  })().catch(error => {
    console.error(error.stderr?.toString().trim() || error.message);
    if (error.cause) console.error(error.cause.stderr?.toString().trim() || error.cause.message);
    process.exitCode = 1;
  });
}
