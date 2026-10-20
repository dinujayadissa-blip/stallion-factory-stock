// Fetch a picture from the internet for an item photo. The browser can't do this itself (most
// sites block other sites from reading their images), so the server fetches it and hands the
// bytes back; the browser then shrinks and saves it like any other photo.
//
// Safety: only http/https on the normal ports, only public internet addresses (never this PC or
// anything on the factory network), size and time limits, and the connection is made to the
// exact address we checked so a hostname can't be switched to a private one mid-request.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import os from 'node:os';
import { httpError } from './inventory.js';

const MAX_IMAGE = 15 * 1024 * 1024;
const MAX_HTML = 1024 * 1024; // only this much of a page is searched for its picture
const TIMEOUT_MS = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

// Addresses that are not the public internet. BlockList also catches IPv4 addresses written
// inside IPv6 (e.g. [::ffff:7f00:1] is 127.0.0.1), however they are spelled.
const BLOCK = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) BLOCK.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCK.addSubnet(a, p, 'ipv6');
// ::ffff:0:0:0/96 above is the IPv4-translated range and is blocked. Do NOT add ::ffff:0:0/96
// (IPv4-mapped): BlockList already applies the IPv4 rules to those, and that rule would match every
// IPv4 address and block all websites. Anything odd counts as private (fail closed).

// This PC's own networks. The ISP gives the factory public IPv6 addresses, so the router, cameras
// and this PC can look "public"; anything on a subnet this PC is on counts as the factory network.
// Read fresh each time because the ISP prefix can change.
function localNets() {
  const list = new net.BlockList();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const m = /\/(\d+)$/.exec(a.cidr || '');
      if (!m) continue;
      const fam = a.family === 'IPv6' || a.family === 6 ? 'ipv6' : 'ipv4';
      list.addSubnet(a.address.replace(/%.*$/, ''), Number(m[1]), fam);
    }
  }
  return list;
}
const isPrivate = ip => {
  try {
    if (!net.isIP(ip)) return true;
    const fam = net.isIPv4(ip) ? 'ipv4' : 'ipv6';
    return BLOCK.check(ip, fam) || localNets().check(ip, fam);
  } catch { return true; }
};

async function checkUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw httpError(400, "That doesn't look like a web link"); }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'Only http:// and https:// links work');
  if (url.port) throw httpError(400, 'Links with a port number are not allowed');
  if (url.username || url.password) throw httpError(400, 'Links with a login in them are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try { addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true }); }
  catch { throw httpError(400, `Couldn't find the website ${host}`); }
  if (!addrs.length || addrs.some(a => isPrivate(a.address))) throw httpError(400, "That link isn't on the public internet");
  return { url, addr: addrs[0] };
}

function request({ url, addr }, maxBytes) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,text/html;q=0.8,*/*;q=0.5' },
      // Connect to the address we already checked, whatever DNS says now.
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
      timeout: TIMEOUT_MS,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) });
      }
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); reject(httpError(400, 'That picture is too big (over 15 MB)')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(httpError(504, 'The website took too long to answer')));
    req.on('error', e => reject(e.status ? e : httpError(502, `Couldn't download from that website (${e.code || e.message})`)));
  });
}

async function fetchFollow(raw, maxBytes) {
  let target = await checkUrl(raw);
  for (let hops = 0; hops < 5; hops++) {
    const res = await request(target, maxBytes);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      target = await checkUrl(new URL(res.headers.location, target.url).href);
      continue;
    }
    if (res.status >= 400) throw httpError(400, `The website said no (error ${res.status}) — try another picture`);
    return { ...res, finalUrl: target.url };
  }
  throw httpError(400, 'That link redirects too many times');
}

// What kind of picture is it, judging by the first bytes?
function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(4, 12).toString('latin1').startsWith('ftypavif')) return 'image/avif';
  return null;
}

const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function attrsOf(tag) {
  const attrs = {};
  // (?<!...) so a long run of letters is tried once, not from every letter (that took minutes).
  for (const m of tag.matchAll(/(?<![\w:-])([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = decode(m[3] ?? m[4]);
  return attrs;
}
const abs = (u, base) => { try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const words = s => decode(s).toLowerCase().split(/[^a-z0-9/]+/).filter(w => w.length > 2);

// The main product picture of a web page, best guess first:
//   1. og:image / twitter:image (what shows when the link is shared)
//   2. schema.org product data ("image" in ld+json, itemprop="image")
//   3. the first <img> whose description matches the product name in the page title
// Tag patterns use [^<>]* (stop at the next '<') so a page full of unclosed tags can't make the
// search take hours.
function pagePicture(html, base) {
  for (const tag of html.match(/<(?:meta|link)\b[^<>]*>/gi) || []) {
    const a = attrsOf(tag);
    const key = (a.property || a.name || a.rel || a.itemprop || '').toLowerCase();
    if (['og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image_src', 'image'].includes(key)) {
      const u = abs(a.content || a.href, base);
      if (u) return u;
    }
  }
  const close = /<\/script>/gi;
  for (const m of html.matchAll(/<script\b[^<>]*>/gi)) {
    if (m.index < close.lastIndex || !m[0].toLowerCase().includes('ld+json')) continue;
    const start = m.index + m[0].length;
    close.lastIndex = start;
    const c = close.exec(html);
    if (!c) break;
    const end = c.index;
    let data;
    try { data = JSON.parse(html.slice(start, end)); } catch { continue; }
    const found = [];
    const walk = o => {
      if (!o || typeof o !== 'object' || found.length) return;
      if (o.image) {
        const img = Array.isArray(o.image) ? o.image[0] : o.image;
        const u = typeof img === 'string' ? img : img?.url || img?.contentUrl;
        if (u) found.push(u);
      }
      Object.values(o).forEach(walk);
    };
    walk(data);
    const u = found[0] && abs(found[0], base);
    if (u) return u;
  }
  const title = words((/<title[^<>]*>([^<]*)/i.exec(html) || [])[1]?.split(/\s[|–-]\s/)[0]);
  if (title.length) {
    const titleSet = new Set(title); // Set lookup keeps huge pages linear, not quadratic
    let best = null;
    for (const tag of html.match(/<img\b[^<>]*>/gi) || []) {
      const a = attrsOf(tag);
      if (/logo|icon|sprite|flag|avatar|badge/i.test(`${a.src} ${a.class} ${a.alt}`)) continue;
      const alt = words(a.alt);
      const score = alt.filter(w => titleSet.has(w)).length / title.length;
      if (score < 0.5) continue;
      // Largest candidate from srcset if there is one.
      const set = (a.srcset || '').split(',').map(s => s.trim().split(/\s+/)).filter(p => p[0])
        .map(([u, w]) => ({ u, w: parseInt(w, 10) || 0 })).sort((x, y) => y.w - x.w);
      const src = abs(set[0]?.u || a.src || a['data-src'], base);
      if (!src || /\.svg(\?|$)/i.test(src)) continue;
      if (!best || score > best.score) best = { score, src };
      if (score === 1) break;
    }
    if (best) return best.src;
  }
  return null;
}

export async function fetchWebImage(raw) {
  const res = await fetchFollow(raw, MAX_IMAGE);
  const type = String(res.headers['content-type'] || '').toLowerCase();
  const kind = sniff(res.body);
  if (kind) return { type: kind, body: res.body };
  if (type.includes('svg')) throw httpError(400, "That's a drawing (SVG), not a photo — pick a different picture");
  if (type.includes('html')) {
    const pic = pagePicture(res.body.subarray(0, MAX_HTML).toString('utf8'), res.finalUrl);
    if (!pic) throw httpError(400, "That page has no main picture. Right-click the photo you want and choose 'Copy image address', then paste that instead.");
    const img = await fetchFollow(pic, MAX_IMAGE);
    const k2 = sniff(img.body);
    if (!k2) throw httpError(400, "Couldn't get the picture from that page — right-click the photo and use 'Copy image address' instead");
    return { type: k2, body: img.body };
  }
  throw httpError(400, "That link isn't a picture");
}
