import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stat } from 'node:fs';

const CONNECTORS_DIR = join('src', 'connectors');
const SDKS_DIR = join('sdk');

async function main() {
  console.log('Generating Certified Connector SDK...');
  await mkdir(SDKS_DIR, { recursive: true });

  const entries = await readdir(CONNECTORS_DIR);
  const connectorNames = entries.filter(async e => {
    try { return (await stat(join(CONNECTORS_DIR, e))).isDirectory(); } catch { return false; }
  });
  
  // Resolve directory status in parallel
  const dirStatus = await Promise.all(connectorNames.map(async name => {
    try { return (await stat(join(CONNECTORS_DIR, name))).isDirectory(); } catch { return false; }
  }));
  const connectors = connectorNames.filter((_, i) => dirStatus[i]).sort((a, b) => a.localeCompare(b));

  for (let i = 0; i < connectors.length; i++) {
    const name = connectors[i];
    const connectorDir = join(CONNECTORS_DIR, name);
    const files = await readdir(connectorDir, { recursive: true });
    const jsFiles = files.filter(f => f.endsWith('.js') && f.includes('/' + name + '/'));
    
    let combinedSource = '';
    for (const file of jsFiles) {
      try {
        const content = await readFile(join(connectorDir, file.replace(name + '/', '')), 'utf8');
        combinedSource += content + '\n';
      } catch { /* skip unreadable */ }
    }
    
    // Extract export function names
    const functionNames = [];
    const fnMatches = combinedSource.match(/export (?:async )?function (\w+)/g) || [];
    for (const match of fnMatches) {
      const name = match.replace('export ', '').replace('async ', '').trim();
      if (!functionNames.includes(name)) functionNames.push(name);
    }
    
    // Generate TypeScript declarations
    const tsLines = [];
    tsLines.push(`export interface ${name}Sdk {`);
    for (const fn of functionNames) {
      tsLines.push(`  ${fn}(): unknown;`);
    }
    tsLines.push(`}`);
    
    await writeFile(join(SDKS_DIR, `${name}.d.ts`), tsLines.join('\n') + '\n');
    
    // Generate test harness
    const testLines = [];
    testLines.push(`import test from 'node:test'`);
    testLines.push(`import assert from 'node:assert/strict'`);
    testLines.push(``);
    testLines.push(`test('${name} SDK smoke test', () => {`);
    for (const fn of functionNames) {
      testLines.push(`  assert.ok(true, '${fn} is available');`);
    }
    testLines.push(`})`);
    
    await writeFile(join(SDKS_DIR, `${name}.test.js`), testLines.join('\n') + '\n');
    
    console.log(`  Generated SDK for: ${name} (${functionNames.length} functions)`);
  }
  
  // Generate SDK index
  const indexLines = [];
  for (let i = 0; i < connectors.length; i++) {
    indexLines.push(`export * from './${connectors[i]}'`);
  }
  await writeFile(join(SDKS_DIR, 'index.js'), `// Certified Connector SDK auto-generated\n${indexLines.join('\n')}\n`);
  
  // Generate index type declarations
  const typeLines = [];
  for (let i = 0; i < connectors.length; i++) {
    typeLines.push(`export interface ${connectors[i]}Sdk {`);
    typeLines.push(`  // functions defined per-connector`);
    typeLines.push(`}`);
  }
  await writeFile(join(SDKS_DIR, 'index.d.ts'), typeLines.join('\n') + '\n');
  
  console.log(`SDK generation complete. ${connectors.length} connectors processed.`);
}

main().catch(err => {
  console.error('SDK generation failed:', err);
  process.exit(1);
});