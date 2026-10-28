import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fail } from '../core/errors.js';

// Optional connector drivers are deliberately outside the core dependency set
// (see docs/DEPENDENCY_RISK.md). The core artifact must stay installable and
// auditable without them, so every driver is imported on first use instead of
// at module load, and a missing driver is reported as an actionable SPOOL error
// instead of a raw ERR_MODULE_NOT_FOUND.
const loaded = new Map();

function installedMajor(packageName) {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const manifest = JSON.parse(readFileSync(requireFromHere.resolve(`${packageName}/package.json`), 'utf8'));
    const major = Number.parseInt(String(manifest.version).split('.')[0], 10);
    return Number.isSafeInteger(major) ? major : null;
  } catch {
    // A package that does not export its manifest keeps the shape check only.
    return null;
  }
}

export async function loadConnectorDriver({
  specifier,
  connector,
  packageName = specifier,
  installHint,
  supportedMajor = null,
  requiredExports = []
}) {
  if (loaded.has(specifier)) return loaded.get(specifier);

  const pending = (async () => {
    let namespace;
    try {
      namespace = await import(specifier);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
        fail(
          'CONNECTOR_DRIVER_UNAVAILABLE',
          `${connector} support requires the optional ${packageName} package, which is not installed in this release; ${installHint ?? `install ${packageName}`}`,
          { connector, package: packageName }
        );
      }
      fail(
        'CONNECTOR_DRIVER_LOAD_FAILED',
        `The optional ${packageName} package could not be loaded for ${connector} support`,
        { connector, package: packageName }
      );
    }

    const driver = namespace?.default ?? namespace;
    const missing = requiredExports.filter(name => driver?.[name] == null);
    if (missing.length) {
      fail(
        'CONNECTOR_DRIVER_INCOMPATIBLE',
        `${packageName} does not expose the API required by ${connector} support: ${missing.join(', ')}`,
        { connector, package: packageName, missing }
      );
    }
    if (supportedMajor != null) {
      const major = installedMajor(packageName);
      if (major != null && major !== supportedMajor) {
        fail(
          'CONNECTOR_DRIVER_INCOMPATIBLE',
          `${packageName} major ${major} is not supported by ${connector} support; install major ${supportedMajor}`,
          { connector, package: packageName, supportedMajor, installedMajor: major }
        );
      }
    }
    return driver;
  })();

  loaded.set(specifier, pending);
  try {
    return await pending;
  } catch (error) {
    loaded.delete(specifier);
    throw error;
  }
}
