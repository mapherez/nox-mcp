import { execFileSync } from 'node:child_process';
import { basename, dirname, relative, resolve, sep } from 'node:path';

export function extractArchive(archive, destination) {
  const source = resolve(archive);
  const directory = dirname(source);
  const target = relative(directory, resolve(destination)).split(sep).join('/') || '.';
  // GNU tar treats C: in an absolute Windows archive path as a remote host.
  // Relative paths with forward slashes also avoid backslash escape handling.
  execFileSync('tar', ['-xzf', basename(source), '-C', target], {
    cwd: directory, stdio: 'inherit',
  });
}
