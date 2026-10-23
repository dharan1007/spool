// Sandboxed preload. The renderer gets exactly one capability: invoking the
// validated IPC operations. No node integration, no arbitrary module loading,
// no event channels that a compromised renderer could abuse to push data.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spool", {
  invoke: async (operation, payload) => {
    if (typeof operation !== "string" || operation.length > 128) {
      return { ok: false, error: { code: "CONSOLE_VALIDATION_FAILED", message: "Invalid operation" } };
    }
    return await ipcRenderer.invoke("spool:command", operation, payload ?? {});
  }
});
