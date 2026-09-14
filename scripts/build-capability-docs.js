import { readFile, writeFile } from 'node:fs/promises';
import { fail } from '../src/core/errors.js';

function evidenceList(entry) {
  const parts = [];
  for (const [key, value] of Object.entries(entry.evidence ?? {})) {
    if (Array.isArray(value) && value.length > 0) parts.push(`- ${key}: ${value.join(', ')}`);
    else if (typeof value === 'string' && value) parts.push(`- ${key}: ${value}`);
  }
  return parts.length ? parts.join('\n') : '- _no evidence claimed_';
}

export function renderCapabilityDocs(matrix) {
  if (!matrix || typeof matrix !== 'object' || !Array.isArray(matrix.capabilities)) {
    fail('INVALID_CAPABILITY_MATRIX', 'Capability matrix must contain capabilities');
  }
  const lines = [
    '# SPOOL Capability Matrix',
    '',
    `Release: ${matrix.release}`,
    `Production rule: ${matrix.productionRule}.`,
    ''
  ];
  for (const status of matrix.statuses) {
    const rows = matrix.capabilities.filter(item => item.status === status);
    lines.push(`## ${status} (${rows.length})`, '');
    for (const row of rows) {
      lines.push(`### \`${row.id}\` — ${row.label}`, '');
      if (row.assurance) lines.push(`Assurance: ${row.assurance}`, '');
      lines.push(evidenceList(row), '');
      lines.push(`_${row.notes}_`, '');
    }
  }
  lines.push('> Generated from capabilities/matrix.json. Do not edit by hand.', '');
  return `${lines.join('\n')}`;
}

export async function buildCapabilityDocs({ matrixPath = 'capabilities/matrix.json', outPath = 'docs/CAPABILITIES.md' } = {}) {
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  await writeFile(outPath, renderCapabilityDocs(matrix));
  return outPath;
}

async function main() {
  const out = await buildCapabilityDocs({});
  process.stdout.write(`capability docs written to ${out}\n`);
}

const invokedPath = process.argv[1] ? (await import('node:url')).pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) await main();
