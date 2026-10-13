// limpieza-api: datos compartidos del Calendario de Limpieza (Cloudflare Worker + D1).
// Cada marca es una fila propia (mes, celda), así dos personas marcando a la vez no se pisan.
// Acceso con el PIN del equipo (secreto TEAM_PIN) en la cabecera X-Team-Pin.
// Escrito sin comillas invertidas a propósito: se despliega incrustado en una llamada a la API.

var schemaReady = false;
var SCHEMA = [
  'CREATE TABLE IF NOT EXISTS months (k TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS cells (m TEXT NOT NULL, k TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (m, k))',
  'CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS fails (ip TEXT PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL)'
];
var BUMP = 'INSERT INTO config (k, data) VALUES (\'rev\', \'1\') ON CONFLICT(k) DO UPDATE SET data = CAST(CAST(data AS INTEGER) + 1 AS TEXT)';
var READ_REV = 'SELECT data FROM config WHERE k = \'rev\'';
var MONTH_KEY = /^\d{4}-\d{2}$/;
var CELL_KEY = /^[\w-]{1,12}\|(\d{1,2}|\d{4}-\d{2}-\d{2})$/;
var META_FIELDS = ['createdAt', 'updatedAt', 'closedAt', 'revised', 'workdays', 'weeks', 'tasks'];

async function ensure(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(function (q) { return db.prepare(q); }));
  schemaReady = true;
}
function corsHeaders(req, env) {
  var o = req.headers.get('Origin') || '';
  var allowed = String(env.ORIGENES || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var ok = o === 'null' || allowed.indexOf(o) >= 0 || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    'Access-Control-Allow-Origin': ok ? o : (allowed[0] || 'null'),
    'Access-Control-Allow-Methods': 'GET, PUT, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Team-Pin',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(obj, status, cors) {
  var h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  Object.keys(cors || {}).forEach(function (k) { h[k] = cors[k]; });
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}
function sameText(a, b) {
  a = String(a); b = String(b);
  var d = a.length ^ b.length;
  for (var i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function cleanCell(c) {
  if (!c || typeof c !== 'object' || ['done', 'flag', 'na'].indexOf(c.s) < 0) return null;
  var o = { s: c.s, by: String(c.by || '').slice(0, 4), at: String(c.at || '').slice(0, 40) };
  if (c.note) o.note = String(c.note).slice(0, 300);
  return o;
}
function cleanMeta(m) {
  var o = {};
  META_FIELDS.forEach(function (f) { if (m && m[f] !== undefined) o[f] = m[f]; });
  return o;
}
async function readBody(req) {
  var text = await req.text();
  if (text.length > 400000) throw { status: 413 };
  try { return JSON.parse(text); } catch (e) { throw { status: 400 }; }
}
async function bump(db, stmts) {
  var res = await db.batch(stmts.concat([db.prepare(BUMP), db.prepare(READ_REV)]));
  var last = res[res.length - 1];
  return Number(last.results && last.results[0] ? last.results[0].data : 0);
}
async function getRev(db) {
  var r = await db.prepare(READ_REV).first();
  return r ? Number(r.data) : 0;
}
async function getState(db) {
  var res = await db.batch([db.prepare(READ_REV), db.prepare('SELECT data FROM config WHERE k = \'template\''), db.prepare('SELECT k, data FROM months'), db.prepare('SELECT m, k, data FROM cells')]);
  var rev = res[0].results[0] ? Number(res[0].results[0].data) : 0;
  var template = res[1].results[0] ? JSON.parse(res[1].results[0].data) : null;
  var months = {};
  res[2].results.forEach(function (r) { var m = JSON.parse(r.data); m.cells = {}; months[r.k] = m; });
  res[3].results.forEach(function (r) { if (months[r.m]) months[r.m].cells[r.k] = JSON.parse(r.data); });
  return { rev: rev, template: template, months: months };
}
function cellStmts(db, key, cells) {
  var out = [];
  Object.keys(cells || {}).forEach(function (ck) {
    if (!CELL_KEY.test(ck)) return;
    var c = cleanCell(cells[ck]);
    if (c) out.push(db.prepare('INSERT INTO cells (m, k, data) VALUES (?1, ?2, ?3) ON CONFLICT(m, k) DO UPDATE SET data = excluded.data').bind(key, ck, JSON.stringify(c)));
    else out.push(db.prepare('DELETE FROM cells WHERE m = ?1 AND k = ?2').bind(key, ck));
  });
  return out;
}
async function tooManyFails(db, ip) {
  var r = await db.prepare('SELECT day, n FROM fails WHERE ip = ?1').bind(ip).first();
  var today = new Date().toISOString().slice(0, 10);
  return !!(r && r.day === today && r.n >= 30);
}
async function addFail(db, ip) {
  var today = new Date().toISOString().slice(0, 10);
  await db.prepare('INSERT INTO fails (ip, day, n) VALUES (?1, ?2, 1) ON CONFLICT(ip) DO UPDATE SET n = CASE WHEN day = ?2 THEN n + 1 ELSE 1 END, day = ?2').bind(ip, today).run();
}

export default {
  async fetch(req, env) {
    var cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    var url = new URL(req.url), path = url.pathname;
    if (path.indexOf('/api/') !== 0) return json({ ok: true, app: 'cleaning-schedule' }, 200, cors);
    try {
      var db = env.DB;
      await ensure(db);
      var ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      if (await tooManyFails(db, ip)) return json({ error: 'too_many_attempts' }, 429, cors);
      if (!env.TEAM_PIN || !sameText(req.headers.get('X-Team-Pin') || '', env.TEAM_PIN)) {
        await addFail(db, ip);
        await new Promise(function (r) { setTimeout(r, 500); });
        return json({ error: 'pin' }, 401, cors);
      }
      if (req.method === 'GET' && path === '/api/rev') return json({ rev: await getRev(db) }, 200, cors);
      if (req.method === 'GET' && path === '/api/state') return json(await getState(db), 200, cors);
      if (req.method === 'PUT' && path === '/api/template') {
        var t = await readBody(req);
        if (!t || !Array.isArray(t.tasks) || t.tasks.length > 300) return json({ error: 'bad_template' }, 400, cors);
        var rev1 = await bump(db, [db.prepare('INSERT INTO config (k, data) VALUES (\'template\', ?1) ON CONFLICT(k) DO UPDATE SET data = excluded.data').bind(JSON.stringify(t))]);
        return json({ rev: rev1 }, 200, cors);
      }
      var mm = path.match(/^\/api\/month\/(\d{4}-\d{2})$/);
      if (mm && (req.method === 'PUT' || req.method === 'PATCH')) {
        var key = mm[1], b = await readBody(req), stmts = [];
        if (!b || typeof b !== 'object') return json({ error: 'bad_body' }, 400, cors);
        if (req.method === 'PUT') {
          if (!Array.isArray(b.weeks) || !Array.isArray(b.tasks)) return json({ error: 'bad_month' }, 400, cors);
          var meta = JSON.stringify(cleanMeta(b));
          if (url.searchParams.get('mode') === 'create') stmts.push(db.prepare('INSERT OR IGNORE INTO months (k, data) VALUES (?1, ?2)').bind(key, meta));
          else stmts.push(db.prepare('INSERT INTO months (k, data) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET data = excluded.data').bind(key, meta));
          stmts = stmts.concat(cellStmts(db, key, b.cells));
        } else {
          var row = await db.prepare('SELECT data FROM months WHERE k = ?1').bind(key).first();
          if (!row) return json({ error: 'no_month' }, 404, cors);
          if (b.meta && typeof b.meta === 'object') {
            var cur = JSON.parse(row.data), add = cleanMeta(b.meta);
            Object.keys(add).forEach(function (f) { cur[f] = add[f]; });
            stmts.push(db.prepare('UPDATE months SET data = ?2 WHERE k = ?1').bind(key, JSON.stringify(cur)));
          }
          stmts = stmts.concat(cellStmts(db, key, b.cells));
        }
        if (stmts.length > 500) return json({ error: 'too_big' }, 413, cors);
        var rev2 = await bump(db, stmts);
        return json({ rev: rev2 }, 200, cors);
      }
      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      if (e && e.status) return json({ error: 'bad_request' }, e.status, cors);
      return json({ error: 'server', detail: String(e && e.message || e).slice(0, 200) }, 500, cors);
    }
  }
};
