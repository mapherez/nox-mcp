import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractArchive } from './extract-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'nox-native-packages-'));
const run = (command, args, cwd, env = process.env) => execFileSync(command, args, { cwd, env, stdio: 'inherit' });

try {
  // An external Go module sees only the module files and committed go/ sources.
  // No root contracts/, generator, symlink or go:generate is available to its build.
  const module = resolve(temporary, 'go-library');
  await mkdir(module);
  for (const file of ['go.mod', 'go.sum', 'go']) await cp(resolve(root, file), resolve(module, file), { recursive: true });
  const goConsumer = resolve(temporary, 'go-consumer');
  await mkdir(goConsumer);
  // Independent resolution: never seed a consumer with the SDK graph.
  const goVersion = (await readFile(resolve(root, 'go.mod'), 'utf8')).match(/^go (.+)$/m)[1];
  const goMod = `module example.invalid/native-consumer\ngo ${goVersion}\n`;
  await writeFile(resolve(goConsumer, 'go.mod'), goMod + `\nrequire github.com/mapherez/nox-mcp v0.0.0\nreplace github.com/mapherez/nox-mcp => ${JSON.stringify(module.replaceAll('\\', '/'))}\n`);
  await writeFile(resolve(goConsumer, 'main.go'), `package main
import noxmcp "github.com/mapherez/nox-mcp/go"
func main() {
  if err := noxmcp.ValidateFrame("manifest", []byte(\x60{"schemaVersion":1,"protocolVersion":"2.0","tools":[]}\x60)); err != nil { panic(err) }
  if _, err := noxmcp.LoadToolManifest([]byte(\x60{"schemaVersion":1,"protocolVersion":"2.0","tools":[]}\x60)); err != nil { panic(err) }
  if !noxmcp.ValidateToolValue(map[string]any{"type":"string"}, "installed policy and meta-schema") { panic("schema validation failed") }
  if _, err := noxmcp.New(noxmcp.Options{AppID:"consumer",Name:"consumer",Version:"1"}); err != nil { panic(err) }
}
`);
  const goEnv = { ...process.env, GOTOOLCHAIN: 'local' };
  run('go', ['mod', 'tidy'], goConsumer, goEnv);
  run('go', ['run', '-mod=readonly', '.'], goConsumer, goEnv);

  // Test the actual Cargo package, outside this checkout, including its tests.
  const cargoManifest = await readFile(resolve(root, 'rust/Cargo.toml'), 'utf8');
  const version = cargoManifest.match(/^version = "([^"]+)"/m)?.[1];
  assert.ok(version);
  const packageTarget = resolve(temporary, 'package-target');
  run('cargo', ['package', '--allow-dirty', '--no-verify', '--locked', '--offline', '--manifest-path', 'rust/Cargo.toml'], root, { ...process.env, CARGO_TARGET_DIR: packageTarget });
  const unpacked = resolve(temporary, 'unpacked');
  await mkdir(unpacked);
  extractArchive(resolve(packageTarget, `package/nox-mcp-${version}.crate`), unpacked);
  const crate = resolve(unpacked, `nox-mcp-${version}`);
  run('cargo', ['test', '--locked', '--offline', '--manifest-path', resolve(crate, 'Cargo.toml')], root);
  const rustConsumer = resolve(temporary, 'rust-consumer');
  await mkdir(resolve(rustConsumer, 'src'), { recursive: true });
  await writeFile(resolve(rustConsumer, 'Cargo.toml'), `[package]\nname = "native-consumer"\nversion = "0.0.0"\nedition = "2021"\nrust-version = "1.88"\n[dependencies]\nnox-mcp = { path = ${JSON.stringify(crate.replaceAll('\\', '/'))} }\nrmcp = { version = "3.0", default-features = false, features = ["client"] }\nserde_json = "1"\ntokio = { version = "1", features = ["macros", "rt", "sync", "time"] }\ntokio-util = "0.7"\n`);
  // Deliberately no Cargo.lock: reproduce an application declaring rmcp="3.0".
  await cp(resolve(root, 'rust/tests'), resolve(rustConsumer, 'tests'), { recursive: true });
  await cp(resolve(root, 'rust/contracts'), resolve(rustConsumer, 'contracts'), { recursive: true });
  await writeFile(resolve(rustConsumer, 'src/main.rs'), `fn main() {
    assert!(nox_mcp::load_tools(r#"{"schemaVersion":1,"protocolVersion":"2.0","tools":[]}"#).is_ok());
    assert!(nox_mcp::load_manifest(r#"{"schemaVersion":1,"protocolVersion":"2.0","tools":[]}"#).is_ok());
    assert!(nox_mcp::parse_server_frame(br#"{"type":"authenticated"}"#, nox_mcp::MAX_PAYLOAD_BYTES).is_ok());
}
`);
  run('cargo', ['check', '--all-targets'], rustConsumer);
  run('cargo', ['test'], rustConsumer);
  run('cargo', ['run'], rustConsumer);
  console.log('Standalone Go module and packaged Rust dependency passed without root contracts or Node build hooks.');
} finally {
  assert.equal(dirname(temporary), resolve(tmpdir()));
  await rm(temporary, { recursive: true, force: true });
}
