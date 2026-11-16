// Test helpers (Node only): file-system sources, wasm injection, fixture manifest.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setWasmBinaries } from '../../src/dicom/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../fixtures/dicom');
const require = createRequire(import.meta.url);

let wasmDone = false;
export function injectWasm() {
  if (wasmDone) return;
  setWasmBinaries({
    charls: fs.readFileSync(require.resolve('@cornerstonejs/codec-charls/decodewasm')),
    openjpeg: fs.readFileSync(require.resolve('@cornerstonejs/codec-openjpeg/decodewasm')),
  });
  wasmDone = true;
}

export function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

/** Browser-like sources for every file under `dir` (name = relative path incl. the folder itself). */
export function dirSources(dir, base = path.dirname(dir)) {
  return walk(dir).map((p) => ({
    name: path.relative(base, p),
    size: fs.statSync(p).size,
    read: async () => new Uint8Array(fs.readFileSync(p)),
  }));
}

export const manifest = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));

export function expected(name) {
  const b = fs.readFileSync(path.join(FIXTURES, manifest().expected[name]));
  return new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
}
