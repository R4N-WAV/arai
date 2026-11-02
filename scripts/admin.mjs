#!/usr/bin/env node
/**
 * Arai platform administration from the command line. This is the ONLY way
 * to create the first platform owner: it needs direct database access (your
 * Cloudflare credentials via wrangler), so there is no web backdoor.
 *
 *   node scripts/admin.mjs grant-owner <username> [--local]
 *   node scripts/admin.mjs grant-moderator <username> [--local]
 *   node scripts/admin.mjs revoke <username> [--local]
 *   node scripts/admin.mjs list [--local]
 *   node scripts/admin.mjs verify-audit [--local]
 *
 * Without --local it runs against the production D1 database (--remote).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'api');
const args = process.argv.slice(2);
const where = args.includes('--local') ? '--local' : '--remote';
const [cmd, username] = args.filter((a) => !a.startsWith('--'));

function sql(command) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'arai', where, '--json', '--command', command], { cwd: apiDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out)[0]?.results ?? [];
}
function requireName(name) {
  // Usernames are validated strictly before they go anywhere near SQL.
  if (!name || !/^[A-Za-z0-9_.]{3,30}$/.test(name)) {
    console.error('A valid username is required.');
    process.exit(2);
  }
  const rows = sql(`SELECT id FROM users WHERE username = '${name}' AND status = 'active'`);
  if (!rows.length) {
    console.error(`No active user @${name}.`);
    process.exit(1);
  }
  return rows[0].id;
}
const audit = (action, target) => {
  // Appended through the same hash chain the API uses (see apps/api/src/lib/audit.ts).
  const last = sql('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1')[0]?.hash ?? 'GENESIS';
  const at = Date.now();
  const details = JSON.stringify({ via: 'cli' });
  const hash = createHash('sha256').update(JSON.stringify([last, at, null, action, target, details])).digest('hex');
  sql(`INSERT INTO audit_log (at, actor_id, action, target, details_json, prev_hash, hash) VALUES (${at}, NULL, '${action}', '${target}', '${details}', '${last}', '${hash}')`);
};

switch (cmd) {
  case 'grant-owner':
  case 'grant-moderator': {
    const id = requireName(username);
    const role = cmd === 'grant-owner' ? 'owner' : 'moderator';
    if (role === 'owner' && sql("SELECT 1 FROM platform_roles WHERE role = 'owner'").length) {
      console.error('There is already a platform owner. Revoke them first.');
      process.exit(1);
    }
    sql(`INSERT INTO platform_roles (user_id, role, granted_by, granted_at) VALUES ('${id}', '${role}', 'cli', ${Date.now()}) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role`);
    audit(`admin.grant_${role}`, id);
    console.log(`@${username} is now platform ${role}. They find the dashboard under Settings → Administration.`);
    break;
  }
  case 'revoke': {
    const id = requireName(username);
    sql(`DELETE FROM platform_roles WHERE user_id = '${id}'`);
    audit('admin.revoke_role', id);
    console.log(`@${username} no longer has a platform role.`);
    break;
  }
  case 'list':
    for (const r of sql('SELECT u.username, r.role, r.granted_at FROM platform_roles r JOIN users u ON u.id = r.user_id ORDER BY r.role')) {
      console.log(`${r.role.padEnd(10)} @${r.username}  since ${new Date(r.granted_at).toISOString().slice(0, 10)}`);
    }
    break;
  case 'verify-audit': {
    let prev = 'GENESIS';
    const rows = sql('SELECT * FROM audit_log ORDER BY seq ASC');
    for (const r of rows) {
      const h = createHash('sha256').update(JSON.stringify([prev, r.at, r.actor_id, r.action, r.target, r.details_json])).digest('hex');
      if (r.prev_hash !== prev || h !== r.hash) {
        console.error(`Audit chain BROKEN at entry ${r.seq}.`);
        process.exit(1);
      }
      prev = r.hash;
    }
    console.log(`Audit chain intact (${rows.length} entries).`);
    break;
  }
  default:
    console.log('Usage: node scripts/admin.mjs grant-owner|grant-moderator|revoke <username> | list | verify-audit  [--local]');
    process.exit(cmd ? 2 : 0);
}
