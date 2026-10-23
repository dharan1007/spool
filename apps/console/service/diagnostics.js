import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cpus, totalmem, freemem } from "node:os";
import { consoleFail } from "./errors.js";

function redact(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/password|secret|token|key|credential|signing/i.test(k)) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object") {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createDiagnosticsService({ store }) {
  function get() {
    const info = {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpus: cpus().length,
      totalmem,
      freemem,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
    return redact(info);
  }

  async function exportBundle({ directory } = {}) {
    try {
      const dir = directory ?? join(process.cwd(), "diagnostics-export");
      await mkdir(dir, { recursive: true });
      const bundle = {
        format: "spool-console-diagnostics-v1",
        exportedAt: new Date().toISOString(),
        system: get(),
        settings: redact(store.allSettings ? store.allSettings() : {}),
        activity: redact(store.listActivity ? store.listActivity({ limit: 200 }) : [])
      };
      const path = join(dir, "diagnostics.json");
      await writeFile(path, JSON.stringify(bundle, null, 2) + "\n", "utf8");
      store.recordActivity ? store.recordActivity({ category: "diagnostics", code: "DIAGNOSTICS_EXPORTED", detail: { path }, severity: "info" }) : null;
      return { path, bytes: Buffer.byteLength(JSON.stringify(bundle)) };
    } catch (error) {
      if (error?.code) throw error;
      consoleFail("DIAGNOSTIC_EXPORT_FAILED", "Failed to export diagnostics bundle");
    }
  }

  return Object.freeze({ get, exportBundle });
}
