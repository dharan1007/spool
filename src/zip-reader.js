
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 10000;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

function findEocd(bytes, view) {
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (u32(view, offset) === EOCD) return offset;
  }
  throw new Error('Invalid XLSX ZIP archive: end-of-central-directory record is missing.');
}

function safePath(name) {
  const normalized = String(name || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) throw new Error('Invalid XLSX ZIP entry name.');
  const parts = normalized.split('/');
  if (parts.some(part => part === '..')) throw new Error('Unsafe XLSX ZIP entry path.');
  return parts.filter(part => part && part !== '.').join('/');
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crcTable();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser does not provide the native decompression required for XLSX import.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzipZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 22) throw new Error('Invalid XLSX ZIP archive.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, view);
  const disk = u16(view, eocd + 4);
  const centralDisk = u16(view, eocd + 6);
  const entriesOnDisk = u16(view, eocd + 8);
  const entriesTotal = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);

  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entriesTotal) {
    throw new Error('Multi-disk XLSX ZIP archives are not supported.');
  }
  if (entriesTotal === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 XLSX workbooks are outside the Browser Studio import boundary.');
  }
  if (entriesTotal > MAX_ENTRIES) throw new Error('XLSX contains too many archive entries.');
  if (centralOffset + centralSize > bytes.byteLength) throw new Error('Invalid XLSX ZIP central directory bounds.');

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries = Object.create(null);
  let expanded = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entriesTotal; index += 1) {
    if (cursor + 46 > bytes.byteLength || u32(view, cursor) !== CENTRAL) {
      throw new Error('Invalid XLSX ZIP central directory entry.');
    }
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const expectedCrc = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > bytes.byteLength) throw new Error('Invalid XLSX ZIP entry bounds.');
    const name = safePath(decoder.decode(bytes.subarray(nameStart, nameEnd)));
    cursor = nameEnd + extraLength + commentLength;

    if (!name || name.endsWith('/')) continue;
    if ((flags & 0x1) !== 0) throw new Error('Encrypted XLSX workbooks are not supported.');
    if (method !== 0 && method !== 8) throw new Error('XLSX ZIP entry uses an unsupported compression method.');
    if (uncompressedSize > MAX_EXPANDED_BYTES || expanded + uncompressedSize > MAX_EXPANDED_BYTES) {
      throw new Error('XLSX expands beyond the 256 MiB browser safety ceiling.');
    }
    if (localOffset + 30 > bytes.byteLength || u32(view, localOffset) !== LOCAL) {
      throw new Error('Invalid XLSX ZIP local file header.');
    }
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) throw new Error('Invalid XLSX ZIP compressed-data bounds.');

    const compressed = bytes.subarray(dataStart, dataEnd);
    const output = method === 0 ? new Uint8Array(compressed) : await inflateRaw(compressed);
    if (output.byteLength !== uncompressedSize) throw new Error('XLSX ZIP entry size check failed.');
    if (crc32(output) !== expectedCrc) throw new Error('XLSX ZIP entry integrity check failed.');
    expanded += output.byteLength;
    entries[name] = output;
  }

  return entries;
}
