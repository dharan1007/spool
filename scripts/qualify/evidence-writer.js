import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';

export class EvidenceWriter {
  constructor({ runDir }) {
    this.runDir = runDir;
    this.handles = new Map();
    this.failed = false;
  }

  async init() {
    await mkdir(this.runDir, { recursive: true });
  }

  _handle(name) {
    if (!this.handles.has(name)) {
      const path = join(this.runDir, name);
      const stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
      stream.on('error', () => { this.failed = true; });
      this.handles.set(name, { path, stream });
    }
    return this.handles.get(name).stream;
  }

  async writeJson(name, data) {
    const path = join(this.runDir, name);
    const json = JSON.stringify(data, null, 2);
    await writeFile(path, json, 'utf8');
    if (this.failed) throw new Error(`Evidence writer failed for ${name}`);
  }

  appendRaw(event) {
    if (this.failed) throw new Error('Evidence writer is in failed state');
    const stream = this._handle('raw.jsonl');
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      monotonicNs: String(process.hrtime.bigint()),
      ...event
    }) + '\n';
    const ok = stream.write(line);
    if (!ok) {
      // backpressure handled by stream buffering; we don't block here
    }
  }

  async close() {
    const promises = [];
    for (const { stream } of this.handles.values()) {
      promises.push(new Promise((resolve, reject) => {
        stream.end(err => err ? reject(err) : resolve());
      }));
    }
    await Promise.all(promises);
    this.handles.clear();
    if (this.failed) throw new Error('Evidence writer encountered a write error');
  }

  async writeChecksums() {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(this.runDir);
    const entries = [];
    for (const file of files.sort()) {
      if (file === 'sha256sums.txt') continue;
      const full = join(this.runDir, file);
      const hash = createHash('sha256');
      const data = await readFile(full);
      hash.update(data);
      entries.push(`${hash.digest('hex')}  ${file}`);
    }
    const sumsPath = join(this.runDir, 'sha256sums.txt');
    await writeFile(sumsPath, entries.join('\n') + '\n', 'utf8');
    return entries;
  }

  async verifyChecksums() {
    const { readFile } = await import('node:fs/promises');
    const sumsPath = join(this.runDir, 'sha256sums.txt');
    const content = await readFile(sumsPath, 'utf8');
    const lines = content.trim().split('\n');
    for (const line of lines) {
      const [hash, file] = line.split(/\s+/);
      const data = await readFile(join(this.runDir, file));
      const actual = createHash('sha256').update(data).digest('hex');
      if (actual !== hash) throw new Error(`Checksum mismatch for ${file}: expected ${hash}, got ${actual}`);
    }
    return true;
  }
}

export function sha256OfObject(obj) {
  return `sha256:${createHash('sha256').update(JSON.stringify(obj)).digest('hex')}`;
}
