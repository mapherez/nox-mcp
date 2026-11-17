import { execFileSync } from "node:child_process";

// Cargo parses the complete TOML, including multiline arrays and inline tables.
export function readRustDependencies(manifestPath) {
  const manifest = JSON.parse(
    execFileSync("cargo", ["read-manifest", "--manifest-path", manifestPath], { encoding: "utf8" }),
  );
  return manifest.dependencies
    .filter((dependency) => dependency.kind === null)
    .map((dependency) => {
      if (
        dependency.target ||
        dependency.rename ||
        dependency.optional ||
        dependency.registry ||
        dependency.source !== "registry+https://github.com/rust-lang/crates.io-index"
      )
        throw new Error(`Unsupported consumer dependency: ${dependency.name}`);
      const version = dependency.req.match(/^\^?(\d+(?:\.\d+){0,2})$/)?.[1];
      if (!version)
        throw new Error(`Unsupported consumer version: ${dependency.name} ${dependency.req}`);
      return {
        ...dependency,
        minimumVersion: version.split(".").concat(["0", "0"]).slice(0, 3).join("."),
      };
    });
}

export function rustConsumerManifest({
  source,
  sdk,
  rustVersion,
  dependencies,
  minimum = false,
  client = true,
  rmcpVersion = "3.0",
}) {
  let manifest = `[package]\nname = "independent-${source}"\nversion = "0.0.0"\nedition = "2021"\nrust-version = ${JSON.stringify(rustVersion)}\n[dependencies]\nnox-mcp = { ${sdk} }\n`;
  for (const dependency of dependencies) {
    const version =
      dependency.name === "rmcp"
        ? rmcpVersion
        : minimum
          ? `=${dependency.minimumVersion}`
          : dependency.req;
    const fields = [`version = ${JSON.stringify(version)}`];
    if (!dependency.uses_default_features) fields.push("default-features = false");
    const features =
      dependency.name === "rmcp" && client
        ? ["client", ...dependency.features]
        : dependency.features;
    if (features.length)
      fields.push(`features = [${features.map((feature) => JSON.stringify(feature)).join(", ")}]`);
    manifest += `${dependency.name} = { ${fields.join(", ")} }\n`;
  }
  return manifest + '[dev-dependencies]\naxum = "0.8"\n';
}
