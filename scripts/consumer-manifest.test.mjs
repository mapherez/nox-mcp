import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readRustDependencies, rustConsumerManifest } from "./consumer-manifest.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function manifestFile(t, contents) {
  const directory = mkdtempSync(join(tmpdir(), "nox-consumer-manifest-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "src/main.rs"), "fn main() {}\n");
  const file = join(directory, "Cargo.toml");
  writeFileSync(file, contents);
  return file;
}
function parse(file) {
  return JSON.parse(
    execFileSync("cargo", ["read-manifest", "--manifest-path", file], { encoding: "utf8" }),
  );
}

void test("Cargo dependencies survive multiline formatting, comments and CRLF", (t) => {
  const manifest = `[package]
name = "fixture"
version = "0.0.0"
edition = "2021"
[dependencies]
rmcp = { version = "3.5.0", default-features = false, features = [
  "server", # a comment inside the multiline array
  "transport-io",
] }
http = "1"
[dev-dependencies]
axum = "0.8"
`;
  const lf = readRustDependencies(manifestFile(t, manifest));
  assert.deepEqual(readRustDependencies(manifestFile(t, manifest.replaceAll("\n", "\r\n"))), lf);
  assert.deepEqual(
    lf.map(({ name }) => name),
    ["http", "rmcp"],
  );
  const rmcp = lf.find(({ name }) => name === "rmcp");
  assert.equal(rmcp.minimumVersion, "3.5.0");
  assert.equal(rmcp.uses_default_features, false);
  assert.deepEqual(rmcp.features, ["server", "transport-io"]);
  assert.equal(lf[0].minimumVersion, "1.0.0");
});

void test("Cargo accepts minimum/latest consumer manifests and preserves SDK feature requirements", (t) => {
  const dependencies = readRustDependencies(resolve(root, "rust/Cargo.toml"));
  for (const source of ["git", "path"])
    for (const minimum of [false, true])
      for (const client of [false, true]) {
        const sdk =
          source === "git"
            ? `git = "file:///unused-sdk", rev = "${"a".repeat(40)}"`
            : `path = ${JSON.stringify(resolve(root, "rust").replaceAll("\\", "/"))}`;
        const output = rustConsumerManifest({
          source,
          sdk,
          rustVersion: "1.88",
          dependencies,
          minimum,
          client,
        });
        const parsed = parse(manifestFile(t, output));
        for (const dependency of dependencies) {
          const actual = parsed.dependencies.find(({ name }) => name === dependency.name);
          assert.ok(actual, dependency.name);
          assert.equal(
            actual.req,
            dependency.name === "rmcp"
              ? "^3.0"
              : minimum
                ? `=${dependency.minimumVersion}`
                : dependency.req,
          );
          assert.equal(actual.uses_default_features, dependency.uses_default_features);
          assert.deepEqual(
            actual.features,
            dependency.name === "rmcp" && client
              ? ["client", ...dependency.features]
              : dependency.features,
          );
        }
      }
  const incompatible = rustConsumerManifest({
    source: "path",
    sdk: `path = ${JSON.stringify(resolve(root, "rust").replaceAll("\\", "/"))}`,
    rustVersion: "1.88",
    dependencies,
    rmcpVersion: "=3.2.0",
  });
  assert.equal(
    parse(manifestFile(t, incompatible)).dependencies.find(({ name }) => name === "rmcp").req,
    "=3.2.0",
  );
});
