// Main-process IPC surface. The renderer may only reach operations declared in
// contracts.js; the allow-list is the single gateway. Anything else is at
// best rejected as CONSOLE_VALIDATION_FAILED and logged to the activity trail.
import { ipcMain } from "electron";

export function registerIpc({ router, activity }) {
  const record = (category, code, detail = {}, severity = "info") => {
    try {
      activity({ category, code, detail, severity });
    } catch { /* activity must never break the IPC path */ }
  };

  ipcMain.handle("spool:command", async (_event, operation, payload) => {
    record("ipc", "IPC_OPERATION", { operation, unexpected: typeof payload }, "debug");
    return await router(operation, payload);
  });
  return { channel: "spool:command" };
}
