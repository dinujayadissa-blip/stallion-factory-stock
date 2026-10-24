// Assembles dist-pages/, the folder Cloudflare Pages publishes:  node scripts/build-pages.js [outDir]
//   public/*                  -> the top of the site (styles, scripts, fonts, logos, manifests, login.html...)
//   views/index.html          -> index.html   (the office app; the page gate in functions/_middleware.js decides who sees it)
//   views/floor.html          -> floor.html   (the worker app, same gate)
//   public/login.html         -> login.html   (already part of public/; needs no login)
//   three.js                  -> vendor/three/build and vendor/three/addons (the 3D factory view; the local server does the same)
//   _headers, _routes.json    -> security headers and caching; and which addresses run a Function (see ROUTES)
// functions/ is NOT copied: wrangler compiles ./functions of the folder it runs in, and scripts/deploy-pages.ps1 runs
// from the repo root, so the root functions/ is what gets deployed.
// views/ itself is never copied, so index.html / floor.html exist only at the top, behind the gate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  X-Frame-Options: SAMEORIGIN
/vendor/three/*
  Cache-Control: public, max-age=604800
/fonts/*
  Cache-Control: public, max-age=2592000
/assets/brand/*
  Cache-Control: public, max-age=2592000
`;

// Only the pages and the pass-through run a Function; every other file is served straight from the assets, so the
// free plan's 100k Function requests a day are not spent on no-op next() calls. The page gate's odd-address
// handling (/%69ndex.html...) is a convenience: the pages hold no data, every data call needs a login.
const ROUTES = { version: 1, include: ['/', '/index.html', '/floor', '/floor.html', '/login', '/login.html', '/api/*', '/photos/*'], exclude: [] };

export function build(outDir = path.join(root, 'dist-pages')) {
  const src = p => path.join(root, ...p.split('/'));
  const dst = p => path.join(outDir, ...p.split('/'));
  const copy = (from, to) => fs.cpSync(from, to, { recursive: true });

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  copy(src('public'), outDir);
  fs.copyFileSync(src('views/index.html'), dst('index.html'));
  fs.copyFileSync(src('views/floor.html'), dst('floor.html'));

  const three = src('node_modules/three');
  if (!fs.existsSync(path.join(three, 'build', 'three.module.js'))) throw new Error('three.js is not installed: run npm install first');
  fs.mkdirSync(dst('vendor/three/build'), { recursive: true });
  for (const f of fs.readdirSync(path.join(three, 'build'))) if (/^three\.(module|core)(\.min)?\.js$/.test(f)) fs.copyFileSync(path.join(three, 'build', f), dst(`vendor/three/build/${f}`));
  copy(path.join(three, 'examples', 'jsm'), dst('vendor/three/addons'));

  fs.writeFileSync(dst('_headers'), HEADERS);
  fs.writeFileSync(dst('_routes.json'), JSON.stringify(ROUTES, null, 2) + '\n');
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = build(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  let files = 0, bytes = 0;
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } })(out);
  console.log(`Built ${out}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
}
