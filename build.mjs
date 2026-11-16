// Build script: bundles the app + worker into ./dist (a fully static site).
//   node build.mjs            one-off production build
//   node build.mjs --serve    build, then serve ./dist on http://localhost:8080 and rebuild on change
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const serve = process.argv.includes('--serve');
const outdir = 'dist';

const common = {
  bundle: true,
  minify: !serve,
  sourcemap: serve ? 'inline' : false,
  target: ['chrome109', 'firefox115', 'safari16'],
  logLevel: 'info',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
};

// The worker bundle is inlined into app.js as a string and started from a Blob URL. That way the page needs
// no runtime fetches at all, and the worker inherits the page's Content-Security-Policy (connect-src 'none').
const inlineWorker = {
  name: 'inline-worker',
  setup(b) {
    b.onResolve({ filter: /^worker-source$/ }, () => ({ path: 'worker-source', namespace: 'inline-worker' }));
    b.onLoad({ filter: /.*/, namespace: 'inline-worker' }, async () => ({
      contents: await readFile(`${outdir}/worker.js`, 'utf8'),
      loader: 'text',
    }));
  },
};

const targets = [
  {
    ...common,
    entryPoints: ['src/worker/worker.js'],
    outfile: `${outdir}/worker.js`,
    format: 'iife',
    loader: { '.wasm': 'binary' },
    // Emscripten glue in the codec packages references Node built-ins behind runtime checks.
    external: ['fs', 'path', 'crypto', 'node:fs', 'node:path', 'node:crypto', 'module', 'node:module', 'url', 'node:url', 'worker_threads'],
    platform: 'browser',
  },
  { ...common, entryPoints: ['src/app/main.js'], outfile: `${outdir}/app.js`, format: 'iife', plugins: [inlineWorker] },
];

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  const hash = (f) => createHash('sha256').update(f).digest('hex').slice(0, 10);
  const [app, css] = await Promise.all([readFile(`${outdir}/app.js`), readFile('src/app/styles.css')]);
  await rm(`${outdir}/worker.js`, { force: true });
  await writeFile(`${outdir}/styles.css`, css);
  let html = await readFile('src/app/index.html', 'utf8');
  html = html
    .replaceAll('%APP_HASH%', hash(app))
    .replaceAll('%CSS_HASH%', hash(css));
  await writeFile(`${outdir}/index.html`, html);
  await writeFile(`${outdir}/.nojekyll`, '');
  if (existsSync('src/app/static')) await cp('src/app/static', outdir, { recursive: true });
}

async function buildAll() {
  for (const t of targets) await build(t);
  await copyStatic();
}

if (!serve) {
  await rm(outdir, { recursive: true, force: true });
  await buildAll();
} else {
  await rm(outdir, { recursive: true, force: true });
  await buildAll();
  let timer = null;
  watch('src', { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => buildAll().catch((e) => console.error(e.message)), 150);
  });
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.json': 'application/json',
  };
  const port = Number(process.env.PORT || 8080);
  createServer((req, res) => {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (p.endsWith('/') || p === '') p = join(p, 'index.html');
    const file = join(outdir, p);
    if (!file.startsWith(outdir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  }).listen(port, () => console.log(`serving ${outdir} on http://localhost:${port}`));
}
