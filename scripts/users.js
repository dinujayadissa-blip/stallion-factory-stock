// Logins from the command line — on the office PC itself (also while the app is running).
//
//   npm run users -- list
//   npm run users -- add <username> <role> [trade]      role: owner / office / stores / leadhand / worker
//   npm run users -- reset <username>                   new password (e.g. a forgotten owner password)
//   npm run users -- disable <username>                 turn a login off (logs it out everywhere)
//   npm run users -- enable <username>
//
// Passwords are typed at the prompt (not shown, never on the command line). Uses the same data folder
// as the app (DATA_DIR, or the "data" folder next to this one).
import readline from 'node:readline';
import * as auth from '../src/auth.js';
import { db } from '../src/db.js';

const [cmd, ...args] = process.argv.slice(2);
const TRADES = auth.TRADE_KEYS.join(' / ');
const ROLES = Object.keys(auth.ROLES).join(' / ');
const usage = () => console.log(`Logins:
  npm run users -- list
  npm run users -- add <username> <role> [trade]     role: ${ROLES}; a worker also needs a trade: ${TRADES}
  npm run users -- reset <username>                  choose a new password (logs them out everywhere)
  npm run users -- disable <username>                turn a login off
  npm run users -- enable <username>                 turn it back on`);

// ── asking on the terminal: passwords are not shown; also works with piped input (one answer per line) ──
const piped = !process.stdin.isTTY;
let lines = null;
async function pipedLine() {
  if (!lines) {
    lines = [];
    const rl = readline.createInterface({ input: process.stdin });
    for await (const l of rl) lines.push(l);
  }
  return lines.shift() ?? '';
}
async function ask(question) {
  if (piped) { process.stdout.write(question); const a = await pipedLine(); process.stdout.write('\n'); return a; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(question, res));
  rl.close();
  return a;
}
async function askHidden(question) {
  if (piped) { process.stdout.write(question); const a = await pipedLine(); process.stdout.write('\n'); return a; }
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise(resolve => {
    let pw = '';
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(pw);
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(1); } // Ctrl+C
        if (ch === '\u0008' || ch === '\u007f') { if (pw) { pw = pw.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        if (ch >= ' ') { pw += ch; process.stdout.write('*'); }
      }
    };
    stdin.on('data', onData);
  });
}
async function newPassword(username) {
  for (let tries = 0; tries < 3; tries++) {
    const a = await askHidden('New password (at least 8 characters): ');
    const bad = auth.passwordProblem(a, username);
    if (bad) { console.log(`  ${bad}`); continue; }
    const b = await askHidden('Same password again: ');
    if (a !== b) { console.log("  The two passwords aren't the same — try again."); continue; }
    return a;
  }
  throw new Error('No password set');
}
const yes = async q => /^y(es)?$/i.test((await ask(q)).trim());

function need(u, username) {
  if (!u) throw new Error(`No login called "${username}" — see: npm run users -- list`);
  return u;
}

async function main() {
  switch (cmd) {
    case 'list': {
      const users = auth.listUsers();
      if (!users.length) { console.log('No logins yet. Open the app on this PC (http://localhost:3000) to create the owner login, or: npm run users -- add <username> owner'); return; }
      const rows = users.map(u => [u.username, u.name, auth.ROLES[u.role]?.label || u.role, u.trade || '', u.active ? 'on' : 'OFF',
        u.last_login || 'never', u.must_change ? 'must choose a new password' : '']);
      const head = ['Username', 'Name', 'Role', 'Trade', 'Login', 'Last log in', ''];
      const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
      for (const r of [head, ...rows]) console.log(r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd());
      return;
    }
    case 'add': {
      const [username, role, trade = ''] = args;
      if (!username || !role) { usage(); process.exitCode = 1; return; }
      if (!auth.isRole(role)) throw new Error(`Role must be one of: ${ROLES}`);
      if (role === 'worker' && !auth.TRADE_KEYS.includes(trade)) throw new Error(`A worker needs a trade: ${TRADES}`);
      if (auth.findUser(username)) throw new Error(`The username "${username}" is already taken`);
      const name = (await ask(`Name shown in the app [${username}]: `)).trim() || username;
      const password = await newPassword(username);
      const mustChange = await yes('Must they choose their own password when they first log in? (y/N): ');
      const u = await auth.createUser({ username, name, role, trade, password, mustChange }, 'command line');
      console.log(`Login added: ${u.username} (${auth.ROLES[u.role].label}${u.trade ? `, ${u.trade}` : ''}).`);
      return;
    }
    case 'reset': {
      const [username] = args;
      if (!username) { usage(); process.exitCode = 1; return; }
      const u = need(auth.findUser(username), username);
      console.log(`New password for ${u.name} (${u.username}, ${auth.ROLES[u.role]?.label}).`);
      const password = await newPassword(u.username);
      const mustChange = await yes('Must they choose their own password at the next log in? (y/N): ');
      await auth.resetPassword(u.id, password, { mustChange });
      if (!u.active) auth.setActive(u.id, true);
      console.log(`Password changed for ${u.username}${u.active ? '' : ' (the login was off — it is on again)'}. They are logged out everywhere and log in with the new password.`);
      return;
    }
    case 'disable':
    case 'enable': {
      const [username] = args;
      if (!username) { usage(); process.exitCode = 1; return; }
      const u = need(auth.findUser(username), username);
      auth.setActive(u.id, cmd === 'enable');
      console.log(`${u.username}: login ${cmd === 'enable' ? 'turned on' : 'turned off (logged out everywhere)'}.`);
      return;
    }
    default:
      usage();
      if (cmd) process.exitCode = 1;
  }
}

try { await main(); }
catch (e) { console.error(`Stopped: ${e.message}`); process.exitCode = 1; }
finally { try { db.close(); } catch { /* closed */ } }
