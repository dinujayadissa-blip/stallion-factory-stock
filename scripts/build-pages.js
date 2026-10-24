// Assembles dist-pages/, the folder Cloudflare Pages publishes:  node scripts/build-pages.js [outDir]
//   public/*                  -> the top of the site (styles, scripts, fonts, logos, manifests, login.html...)
//   views/index.html          -> index.html   (the office app; the page gate in functions/_middleware.js decides who sees it)
//   views/floor.html          -> floor.html   (the worker app, same gate)
//   public/login.html         -> login.html   (needs no login)
//   functions/                -> functions/   (the pass-through to the Supabase function and the page gate)
//   three.js                  -> vendor/three/build and vendor/three/addons (the 3D factory view; the local server does the same)
//   _headers                  -> security headers and caching for the files
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
`;

export function build(outDir = path.join(root, 'dist-pages')) {
  const src = p => path.join(root, ...p.split('/'));
  const dst = p => path.join(outDir, ...p.split('/'));
  const copy = (from, to) => fs.cpSync(from, to, { recursive: true });

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  copy(src('public'), outDir);
  fs.copyFileSync(src('views/index.html'), dst('index.html'));
  fs.copyFileSync(src('views/floor.html'), dst('floor.html'));
  fs.copyFileSync(src('public/login.html'), dst('login.html'));
  copy(src('functions'), dst('functions'));

  const three = src('node_modules/three');
  if (!fs.existsSync(path.join(three, 'build', 'three.module.js'))) throw new Error('three.js is not installed: run npm install first');
  fs.mkdirSync(dst('vendor/three/build'), { recursive: true });
  for (const f of fs.readdirSync(path.join(three, 'build'))) if (/^three\.(module|core)(\.min)?\.js$/.test(f)) fs.copyFileSync(path.join(three, 'build', f), dst(`vendor/three/build/${f}`));
  copy(path.join(three, 'examples', 'jsm'), dst('vendor/three/addons'));

  fs.writeFileSync(dst('_headers'), HEADERS);
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = build(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  let files = 0, bytes = 0;
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } })(out);
  console.log(`Built ${out}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
}
