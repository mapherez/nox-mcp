import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'typescript/dist');
assert.equal(dirname(output),resolve(root,'typescript'));
// Remove obsolete JS/declarations when an entry point has been removed.
await rm(output,{recursive:true,force:true});
execFileSync(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'-p','typescript/tsconfig.json'],{cwd:root,stdio:'inherit'});
