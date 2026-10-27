// Release gate CLI. The full gate decision logic lives in src/release/gate.js
// so the fail-closed signing rule can be qualified by tests deterministically;
// this wrapper only wires the real process-level step runner.
import { pathToFileURL } from 'node:url';
import { releaseGate } from '../src/release/gate.js';

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) releaseGate();
