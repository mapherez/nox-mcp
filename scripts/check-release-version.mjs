import { validateVersion } from './update-version.mjs';

try {
  const tag = process.argv[2];
  if (!tag?.startsWith('v')) throw new Error('Esperava uma tag vX.Y.Z.');
  const { version, files } = await validateVersion(process.cwd(), tag);
  if (tag !== `v${version}` || files.some(file => file.versions.some(value => value !== version))) {
    throw new Error(`A tag ${tag} nao corresponde a todas as versoes dos SDKs.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
