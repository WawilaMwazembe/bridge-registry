'use strict';
// Bridge Register sync API.
//   GET  /api/lookups            dropdown values (cached on the tablet)
//   GET  /api/sync/pull?since=N  bridges changed after change-number N
//   POST /api/sync/push          tablet edits, with optimistic version check
// Also serves the tablet web app from ../app.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');

types.setTypeParser(1700, v => parseFloat(v)); // numeric -> number
types.setTypeParser(20, v => Number(v));       // bigint  -> number (server_seq)
types.setTypeParser(1082, v => v);             // date    -> 'YYYY-MM-DD', no timezone shift

const PORT = Number(process.env.PORT) || 3000;
const TOKEN_DAYS = Number(process.env.TOKEN_DAYS) || 60;
const PULL_LIMIT = 500;

// Columns a tablet may write. Everything else is set by the database.
const FIELDS = [
  'region_code', 'bridge_no', 'bridge_name', 'latitude', 'longitude', 'road_no', 'link_name',
  'chainage_km', 'structure_type', 'material', 'span_count', 'length_m', 'width_m', 'financier',
  'construction_year', 'design_life_years', 'construction_cost_tsh_mio', 'overall_condition',
  'record_status', 'remarks', 'last_inspected_on',
];
const RECORD_STATUSES = ['Active', 'New', 'Closed/Demolished', 'Duplicate'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class UserError extends Error {}

const pool = new Pool();
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'app')));

// ---------------------------------------------------------------- auth
async function auth(req, res, next) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not signed in' });
  const tokenHash = sha256(header.slice(7));
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.role, u.region_code
       FROM api_token t JOIN app_user u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.expires_at > now() AND u.active`,
    [tokenHash]);
  if (!rows.length) return res.status(401).json({ error: 'Session expired - please sign in again' });
  req.user = rows[0];
  req.tokenHash = tokenHash;
  next();
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Your account cannot do this' });

async function withUserTx(user, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(user.id)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

app.get('/api/ping', (req, res) => res.json({ ok: true }));

// Network totals for the home page (index.html), shown after sign-in.
app.get('/api/stats', auth, async (req, res) => {
  const { rows: [s] } = await pool.query(`
    SELECT count(*)                                              AS bridges,
           count(*) FILTER (WHERE verified_at IS NOT NULL)       AS verified,
           count(DISTINCT region_code)                           AS regions,
           count(DISTINCT road_no)                               AS roads,
           coalesce(round(sum(length_m)), 0)                     AS total_length_m,
           count(*) FILTER (WHERE overall_condition = 'Good')    AS good,
           count(*) FILTER (WHERE overall_condition = 'Fair')    AS fair,
           count(*) FILTER (WHERE overall_condition = 'Poor')    AS poor,
           count(*) FILTER (WHERE latitude IS NOT NULL)          AS with_gps,
           max(updated_at)                                       AS last_update
      FROM bridge
     WHERE NOT is_deleted AND record_status IN ('Active', 'New')`);
  res.set('Cache-Control', 'private, max-age=60').json(s);
});

app.post('/api/login', async (req, res) => {
  const { username, password, device } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Enter username and password' });
  const { rows } = await pool.query(
    `SELECT id, username, full_name, role, region_code FROM app_user
      WHERE username = lower($1) AND active AND password_hash = crypt($2, password_hash)`,
    [String(username).trim(), String(password)]);
  if (!rows.length) return res.status(401).json({ error: 'Wrong username or password' });
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO api_token (token_hash, user_id, device_label, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [sha256(token), rows[0].id, device ? String(device).slice(0, 100) : null, TOKEN_DAYS]);
  res.json({ token, user: rows[0] });
});

app.post('/api/logout', auth, async (req, res) => {
  await pool.query('DELETE FROM api_token WHERE token_hash = $1', [req.tokenHash]);
  res.json({ ok: true });
});

// ------------------------------------------------------------- lookups
app.get('/api/lookups', auth, async (req, res) => {
  const names = t => pool.query(`SELECT name FROM ${t} ORDER BY sort_order, name`).then(r => r.rows.map(x => x.name));
  const [regions, roads, structure_types, materials, financiers, conditions] = await Promise.all([
    pool.query('SELECT code, name FROM region ORDER BY name').then(r => r.rows),
    pool.query('SELECT road_no, road_name, road_class FROM road ORDER BY road_no').then(r => r.rows),
    names('structure_type'), names('material'), names('financier'), names('condition_rating'),
  ]);
  res.json({ regions, roads, structure_types, materials, financiers, conditions, record_statuses: RECORD_STATUSES });
});

// ---------------------------------------------------------------- pull
app.get('/api/sync/pull', auth, async (req, res) => {
  const since = Number(req.query.since) || 0;
  const params = [since, PULL_LIMIT];
  let regionFilter = '';
  if (req.user.region_code) {
    params.push(req.user.region_code);
    regionFilter = 'AND region_code = $3';
  }
  const { rows } = await pool.query(
    `SELECT * FROM bridge WHERE server_seq > $1 ${regionFilter} ORDER BY server_seq LIMIT $2`, params);
  res.json({
    bridges: rows,
    cursor: rows.length ? rows[rows.length - 1].server_seq : since,
    more: rows.length === PULL_LIMIT,
  });
});

// ---------------------------------------------------------------- push
function cleanData(data) {
  const out = {};
  for (const k of FIELDS) {
    let v = data?.[k];
    if (typeof v === 'string') {
      v = k === 'remarks' ? v.trim() : v.trim().replace(/\s+/g, ' ');
      if (v === '') v = null;
    }
    out[k] = v ?? null;
  }
  if (!RECORD_STATUSES.includes(out.record_status)) out.record_status = 'Active';
  return out;
}

async function applyChange(db, user, ch, device) {
  if (!UUID_RE.test(ch?.id || '')) throw new UserError('Invalid record id');
  const d = cleanData(ch.data);
  const deleted = !!ch.deleted;

  const { rows: [cur] } = await db.query('SELECT * FROM bridge WHERE id = $1 FOR UPDATE', [ch.id]);
  if (cur && cur.version !== Number(ch.base_version)) {
    // Same content already on the server (e.g. a retry after a lost response): nothing to do.
    const same = cur.is_deleted === deleted && FIELDS.every(k => String(cur[k] ?? '') === String(d[k] ?? ''));
    if (same) return { applied: { id: ch.id, version: cur.version, server_seq: cur.server_seq } };
    // Someone else changed it since this tablet last synced - let the user decide.
    return { conflict: { id: ch.id, server: cur } };
  }
  if (!cur && deleted) return { applied: { id: ch.id, purged: true } };
  if (user.region_code && (d.region_code !== user.region_code || (cur && cur.region_code !== user.region_code))) {
    throw new UserError(`You can only edit bridges in region ${user.region_code}`);
  }
  if (deleted && user.role !== 'admin') {
    throw new UserError('Only an administrator can delete a bridge - set the record status instead');
  }

  const cols = [...FIELDS, 'is_deleted', 'updated_on_device'];
  const vals = [...FIELDS.map(k => d[k]), deleted, device];
  let row;
  if (!cur) {
    ({ rows: [row] } = await db.query(
      `INSERT INTO bridge (id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(', ')})
       RETURNING version, server_seq`, [ch.id, ...vals]));
  } else {
    ({ rows: [row] } = await db.query(
      `UPDATE bridge SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
       WHERE id = $1 RETURNING version, server_seq`, [ch.id, ...vals]));
  }
  return { applied: { id: ch.id, version: row.version, server_seq: row.server_seq } };
}

function friendlyError(e) {
  if (e instanceof UserError) return e.message;
  switch (e.code) {
    case '23505': return e.constraint === 'bridge_no_uq' ? 'This bridge number already exists' : 'That value already exists';
    case '23503':
      if (/still referenced/.test(e.detail || '')) return 'It is still used by bridges or users - rename it instead of deleting';
      return `Unknown value - ${e.detail || 'not in the lookup list'}. Ask an administrator to add it.`;
    case '23514': return `Value out of allowed range (${e.constraint})`;
    case '23502': return `Missing required field: ${e.column}`;
    case '22P02':
    case '22003': return 'Invalid number in one of the fields';
    default:
      console.error(e);
      return 'Server could not save this record';
  }
}

app.post('/api/sync/push', auth, requireRole('inspector', 'admin'), async (req, res) => {
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
  const device = req.body?.device ? String(req.body.device).slice(0, 100) : null;
  const result = { applied: [], conflicts: [], rejected: [] };

  await withUserTx(req.user, async db => {
    for (const ch of changes) {
      // Savepoint per record: one bad record must not block the rest of the batch.
      await db.query('SAVEPOINT rec');
      try {
        const r = await applyChange(db, req.user, ch, device);
        if (r.conflict) result.conflicts.push(r.conflict);
        else result.applied.push(r.applied);
        await db.query('RELEASE SAVEPOINT rec');
      } catch (e) {
        await db.query('ROLLBACK TO SAVEPOINT rec');
        result.rejected.push({ id: ch?.id, error: friendlyError(e) });
      }
    }
  });
  res.json(result);
});

// ------------------------------------------------------ administration
// Lookup tables editable from the app's Admin screen. Renaming a key cascades
// to the bridges (ON UPDATE CASCADE), which bumps their version so tablets
// receive the new value on their next sync. Region codes are fixed because
// they are part of every bridge number.
const ADMIN_TABLES = {
  region:           { key: 'code',    cols: ['code', 'name'],                        order: 'name',             keyEditable: false },
  road:             { key: 'road_no', cols: ['road_no', 'road_name', 'road_class'],  order: 'road_no',          keyEditable: true },
  structure_type:   { key: 'name',    cols: ['name', 'sort_order'],                  order: 'sort_order, name', keyEditable: true },
  material:         { key: 'name',    cols: ['name', 'sort_order'],                  order: 'sort_order, name', keyEditable: true },
  financier:        { key: 'name',    cols: ['name', 'sort_order'],                  order: 'sort_order, name', keyEditable: true },
  condition_rating: { key: 'name',    cols: ['name', 'sort_order'],                  order: 'sort_order, name', keyEditable: true },
};
const ROLES = ['viewer', 'inspector', 'admin'];

function adminValue(col, v) {
  if (col === 'sort_order') return v === '' || v == null ? 100 : Number(v);
  if (typeof v !== 'string') return v ?? null;
  v = v.trim().replace(/\s+/g, ' ');
  if (col === 'code' || col === 'road_no') v = v.toUpperCase();
  return v === '' ? null : v;
}

async function adminWrite(req, res, fn) {
  try {
    res.json(await withUserTx(req.user, fn));
  } catch (e) {
    if (e instanceof UserError || /^2[23]/.test(e.code || '')) return res.status(400).json({ error: friendlyError(e) });
    if (e.code === '42501') return res.status(500).json({ error: 'Database permission missing - re-run db/03_grants.sql' });
    throw e;
  }
}

app.get('/api/admin/data', auth, requireRole('admin'), async (req, res) => {
  const tables = {};
  for (const [t, def] of Object.entries(ADMIN_TABLES)) {
    tables[t] = (await pool.query(`SELECT ${def.cols.join(', ')} FROM ${t} ORDER BY ${def.order}`)).rows;
  }
  const users = (await pool.query(
    `SELECT username, full_name, role, region_code, active FROM app_user ORDER BY active DESC, username`)).rows;
  res.json({ tables, users });
});

app.post('/api/admin/table/:table', auth, requireRole('admin'), (req, res) => {
  const def = ADMIN_TABLES[req.params.table];
  if (!def) return res.status(404).json({ error: 'Unknown table' });
  const { old_key: oldKey, row = {} } = req.body || {};
  const vals = def.cols.map(c => adminValue(c, row[c]));
  return adminWrite(req, res, async db => {
    if (vals.some((v, i) => v == null && def.cols[i] !== 'sort_order')) throw new UserError('Fill in all fields');
    if (oldKey != null) {
      if (!def.keyEditable && vals[def.cols.indexOf(def.key)] !== oldKey) throw new UserError('This code cannot be changed');
      const r = await db.query(
        `UPDATE ${req.params.table} SET ${def.cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}
         WHERE ${def.key} = $${def.cols.length + 1}`, [...vals, oldKey]);
      if (!r.rowCount) throw new UserError('Record not found - reload the page');
    } else {
      await db.query(`INSERT INTO ${req.params.table} (${def.cols.join(', ')})
                      VALUES (${def.cols.map((_, i) => '$' + (i + 1)).join(', ')})`, vals);
    }
    return { ok: true };
  });
});

app.delete('/api/admin/table/:table/:key', auth, requireRole('admin'), (req, res) => {
  const def = ADMIN_TABLES[req.params.table];
  if (!def) return res.status(404).json({ error: 'Unknown table' });
  return adminWrite(req, res, async db => {
    await db.query(`DELETE FROM ${req.params.table} WHERE ${def.key} = $1`, [req.params.key]);
    return { ok: true };
  });
});

app.post('/api/admin/users', auth, requireRole('admin'), (req, res) => {
  const { old_username: oldName, row = {} } = req.body || {};
  const username = String(row.username || '').trim().toLowerCase();
  const fullName = String(row.full_name || '').trim();
  const region = row.region_code || null;
  const active = row.active !== false;
  const password = row.password ? String(row.password) : '';
  return adminWrite(req, res, async db => {
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new UserError('Username: 3-40 letters, digits, dot, dash or underscore');
    if (!fullName) throw new UserError('Enter the full name');
    if (!ROLES.includes(row.role)) throw new UserError('Choose a role');
    if (password && password.length < 8) throw new UserError('Password must be at least 8 characters');
    if (oldName == null) {
      if (!password) throw new UserError('Set a password for the new user');
      await db.query('SELECT create_user($1, $2, $3, $4, $5)', [username, fullName, password, row.role, region]);
      return { ok: true };
    }
    if (oldName === req.user.username && (row.role !== 'admin' || !active)) {
      throw new UserError('You cannot remove your own admin access');
    }
    const r = await db.query(
      `UPDATE app_user SET username = $1, full_name = $2, role = $3, region_code = $4, active = $5
       WHERE username = $6 RETURNING id`, [username, fullName, row.role, region, active, oldName]);
    if (!r.rowCount) throw new UserError('User not found - reload the page');
    if (password) await db.query('SELECT set_password($1, $2)', [username, password]);
    // Disabled user or new password: sign them out on every tablet.
    if (!active || password) await db.query('DELETE FROM api_token WHERE user_id = $1', [r.rows[0].id]);
    return { ok: true };
  });
});

// ------------------------------------------------- checking & reporting
app.post('/api/bridges/:id/verify', auth, requireRole('admin'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  const row = await withUserTx(req.user, db => db.query(
    `UPDATE bridge SET verified_by = $2, verified_at = now()
      WHERE id = $1 AND NOT is_deleted RETURNING version`, [req.params.id, req.user.id]).then(r => r.rows[0]));
  if (!row) return res.status(404).json({ error: 'Bridge not found' });
  res.json({ ok: true });
});

app.get('/api/export.csv', auth, async (req, res) => {
  const { rows, fields } = await pool.query('SELECT * FROM v_bridge_list');
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [fields.map(f => esc(f.name)).join(',')]
    .concat(rows.map(r => fields.map(f => esc(r[f.name])).join(',')));
  res.type('text/csv')
    .set('Content-Disposition', 'attachment; filename="bridge-list.csv"')
    .send('﻿' + lines.join('\r\n')); // BOM so Excel reads UTF-8
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => console.log(`Bridge register running on http://localhost:${PORT}`));
