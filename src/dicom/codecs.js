// Lazy, once-only initialisation of the Emscripten codecs (CharLS for JPEG-LS, OpenJPEG for JPEG 2000).
//
// Browser/worker: the integrator must inject the wasm bytes BEFORE the first compressed series is built:
//   import charlsWasm   from '@cornerstonejs/codec-charls/dist/charlswasm_decode.wasm';     // esbuild loader: binary
//   import openjpegWasm from '@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.wasm'; // esbuild loader: binary
//   setWasmBinaries({ charls: charlsWasm, openjpeg: openjpegWasm });
// Node (tests): either inject the bytes the same way, or let Emscripten load the .wasm next to its glue file.

let wasm = { charls: null, openjpeg: null };
const ready = { charls: null, openjpeg: null };

export function setWasmBinaries({ charls, openjpeg } = {}) {
  if (charls) { wasm.charls = charls instanceof Uint8Array ? charls : new Uint8Array(charls); ready.charls = null; }
  if (openjpeg) { wasm.openjpeg = openjpeg instanceof Uint8Array ? openjpeg : new Uint8Array(openjpeg); ready.openjpeg = null; }
}

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node) &&
  typeof WorkerGlobalScope === 'undefined';

function makeOpts(bytes) {
  const opts = {
    // keep Emscripten quiet: never print to the console
    print: () => {}, printErr: () => {},
  };
  if (bytes) opts.wasmBinary = bytes;
  return opts;
}

async function init(name) {
  if (ready[name]) return ready[name];
  const bytes = wasm[name];
  if (!bytes && !isNode) {
    throw new Error(`The ${name === 'charls' ? 'JPEG-LS' : 'JPEG 2000'} decoder is not available (wasm not loaded).`);
  }
  ready[name] = (async () => {
    const mod = name === 'charls'
      ? await import('@cornerstonejs/codec-charls/decodewasmjs')
      : await import('@cornerstonejs/codec-openjpeg/decodewasmjs');
    const factory = mod.default || mod;
    return factory(makeOpts(bytes));
  })();
  try {
    return await ready[name];
  } catch (e) {
    ready[name] = null;
    throw new Error(`Could not initialise the ${name === 'charls' ? 'JPEG-LS' : 'JPEG 2000'} decoder.`);
  }
}

function copyOut(decoded, fi) {
  const bps = fi.bitsPerSample;
  const n = fi.width * fi.height * (fi.componentCount || 1);
  let pixels;
  if (bps <= 8) pixels = new Uint8Array(decoded.slice(0, n));
  else {
    const src = new Uint16Array(decoded.buffer, decoded.byteOffset, n);
    pixels = new Uint16Array(src);              // copy out of the wasm heap
  }
  return { pixels, width: fi.width, height: fi.height, bitsPerSample: bps, signed: !!fi.isSigned, components: fi.componentCount || 1 };
}

export async function decodeJpegLS(bytes) {
  const codec = await init('charls');
  const dec = new codec.JpegLSDecoder();
  try {
    dec.getEncodedBuffer(bytes.length).set(bytes);
    dec.decode();
    const fi = dec.getFrameInfo();
    return copyOut(dec.getDecodedBuffer(), fi);
  } finally {
    dec.delete();
  }
}

export async function decodeJ2K(bytes) {
  const codec = await init('openjpeg');
  const dec = new codec.J2KDecoder();
  try {
    dec.getEncodedBuffer(bytes.length).set(bytes);
    dec.decode();
    const fi = dec.getFrameInfo();
    return copyOut(dec.getDecodedBuffer(), fi);
  } finally {
    dec.delete();
  }
}
