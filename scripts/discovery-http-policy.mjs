// Test policy only: never infer an expected status from the response under test.
function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`A resolved stable SDK version is required; received ${JSON.stringify(version)}`);
  }
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error(`Invalid SDK version: ${version}`);
  return parts;
}

function compare(left, right) {
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function status(value) {
  if (!Number.isInteger(value) || value < 100 || value > 599) throw new Error(`Invalid HTTP status in test policy: ${value}`);
  return value;
}

export function expectedHttpStatus(fixture, language, sdkVersion) {
  const base = status(fixture.httpStatus);
  const override = fixture.httpStatusBySDK?.[language];
  if (override === undefined) return base;
  if (typeof override === 'number') return status(override);
  if (!Array.isArray(override)) throw new Error(`Invalid HTTP policy for ${language}/${fixture.id}`);
  const version = versionParts(sdkVersion);
  const matches = override.filter(profile => {
    const minimum = versionParts(profile.minVersion), before = versionParts(profile.beforeVersion);
    if (compare(minimum, before) >= 0) throw new Error(`Invalid SDK version range for ${language}/${fixture.id}`);
    status(profile.status);
    return compare(version, minimum) >= 0 && compare(version, before) < 0;
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one HTTP policy for ${language}@${sdkVersion}/${fixture.id}; found ${matches.length}. Review the SDK mapping instead of falling back to HTTP ${base}.`);
  }
  return matches[0].status;
}
