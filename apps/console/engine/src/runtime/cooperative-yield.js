export async function yieldBrowserTurn() {
  if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
  else await new Promise(resolve => globalThis.setTimeout(resolve, 0));
}
