import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'nox-conformance-'));
try {
    const runs = [['typescript', process.execPath, ['--test', 'typescript/test/runtime-conformance.test.mjs']], ['go', 'go', ['test', '-count=1', '-mod=readonly', './go', '-run', '^TestSharedRuntimeConformance$']], ['rust', 'cargo', ['test', '--locked', '--manifest-path', 'rust/Cargo.toml', '--test', 'runtime_conformance']]];
    const reports = [];
    for (const [language, command, args] of runs) {
        const file = resolve(temporary, `${language}.json`);
        execFileSync(command, args, { cwd: root, env: { ...process.env, NOX_CONFORMANCE_REPORT: file }, stdio: 'inherit' });
        reports.push(JSON.parse(await readFile(file, 'utf8')));
    }
    for (const report of reports.slice(1))
        assert.deepEqual(report, reports[0], 'Cross-language runtime behavior diverged');
    console.log(`Identical runtime observations in TypeScript, Go and Rust (${reports[0].length} shared scenarios).`);
}
finally {
    assert.equal(dirname(temporary), resolve(tmpdir()));
    await rm(temporary, { recursive: true, force: true });
}
