export class MemoryWorkspaceStore {
  constructor(initial = null) { this.value = initial ? structuredClone(initial) : null; }
  async load() { return this.value ? structuredClone(this.value) : null; }
  async save(value) { this.value = structuredClone(value); }
  async clear() { this.value = null; }
}
