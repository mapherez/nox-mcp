import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';

const commands = ['tar'];
// Exercise the GNU implementation behind Git Bash as well as Windows bsdtar.
if (process.platform === 'win32') {
  for (const programFiles of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const gnuTar = resolve(programFiles, 'Git/usr/bin/tar.exe');
    if (existsSync(gnuTar)) commands.push(gnuTar);
  }
}

for (const command of commands) test(`extract crate from an absolute path with spaces using ${command}`, async t => {
  const env = { ...process.env };
  if (command !== 'tar') {
    // GNU tar also needs gzip from the same Git installation on PATH.
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = dirname(command) + delimiter + (env[pathKey] ?? '');
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'nox archive test '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = resolve(temporary, 'source files');
  const archives = resolve(temporary, 'package target');
  const destination = resolve(temporary, 'unpacked files');
  const manifest = 'nox-mcp-0.5.0/contracts/manifest.json';
  await mkdir(resolve(source, 'nox-mcp-0.5.0/contracts'), { recursive: true });
  await mkdir(archives);
  await mkdir(destination);
  const contents = JSON.stringify({ description: 'Contrato de conformidade', _meta: { cli: 'echo' } });
  await writeFile(resolve(source, manifest), contents);
  execFileSync(command, ['-czf', 'fixture.crate', '-C', relative(archives, source).split(sep).join('/'), '.'], { cwd: archives, env });
  const archive = resolve(archives, 'fixture.crate');
  // The absolute archive path includes a drive colon on Windows. Passing it
  // directly to GNU tar -f reproduced the release failure.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { extractArchive } from ${JSON.stringify(new URL('./extract-archive.mjs', import.meta.url).href)};
    extractArchive(process.argv[1], process.argv[2]);
  `, archive, destination], { env });
  assert.equal(await readFile(resolve(destination, manifest), 'utf8'), contents);
  assert.ok(existsSync(archive), 'Extraction must leave the original crate intact');
});
