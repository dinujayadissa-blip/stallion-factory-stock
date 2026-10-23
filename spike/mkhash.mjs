// One-off: prints a hash for 'spike-pass-1' in the SAME format as src/auth.js hashPassword()
// (scrypt$N$r$p$saltB64$hashB64, N=16384 r=8 p=1, 64-byte key). Throwaway password, safe to commit.
import crypto from 'node:crypto';
const salt = crypto.randomBytes(16);
const key = crypto.scryptSync('spike-pass-1'.normalize('NFC'), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
console.log(`scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`);
