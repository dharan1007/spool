// The only channel the renderer has to the privileged world. Every call goes
// through the context bridge exposed by preload.cjs and is validated again in
// the main process against contracts.js.
type Envelope = { ok: boolean; result?: unknown; error?: { code: string; message: string; severity: string; retryable: boolean; nextActions: string[] } };

export async function invoke(operation: string, payload: unknown = {}): Promise<Envelope> {
  const route = (globalThis as { spool?: { invoke: (op: string, p: unknown) => Promise<Envelope> } }).spool;
  if (!route?.invoke) {
    return { ok: false, error: { code: "BRIDGE_UNAVAILABLE", message: "IPC bridge is not available in this environment", severity: "internal", retryable: false, nextActions: [] } };
  }
  return await route.invoke(operation, payload);
}

export async function call<T>(operation: string, payload: unknown = {}): Promise<T> {
  const response = await invoke(operation, payload);
  if (!response.ok) throw buildError(response.error!);
  return response.result as T;
}

export function buildError(error: { code: string; message: string; severity: string; retryable: boolean; nextActions: string[] }) {
  return Object.assign(new Error(error.message), error);
}
