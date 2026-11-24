// JSON API. All money values cross the wire in laari (MVR × 100, integers);
// the UI formats them. Dates are local YYYY-MM-DD strings.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  AppError, addDays, adjustLot, availableQty, consumeStock, createOrder, customerBalance,
  customerPendingTotal, daysBetween, db, docNo, getSettings, harvestLinesFor, harvestLinesByGrn, isDateStr, localDateStr,
  logAction, lotStatus, mvrText, paidTotal, receiveLot, removeShipment, returnOrderStock, round3,
  setSetting, shipmentLanding, landingSummaries,
  transferLot, tx, writeOffLot, removeStockMove, LOSS_BINS, lossBinSql, isLossBin,
} from './db.mjs';
import { SLIPS_DIR } from './paths.mjs';
import { signTarget } from './print.mjs';
import { SIGN_FORMS, parseStrokes } from './signatures.mjs';
import {
  burnVerify, createSession, destroySession, destroyUserSessions, hashPassword, loginAllowed,
  recordLoginFailure, recordLoginSuccess, shouldLogThrottle, verifyPassword,
} from './auth.mjs';

// A handler can return this to also set/clear the session cookie.
export class ApiResult {
  constructor(body, { cookie } = {}) {
    this.body = body;
    this.cookie = cookie;
  }
}

// A slip photo or PDF, sent back as the file itself rather than JSON.
export class FileResult {
  constructor(buf, type, filename) {
    this.buf = buf;
    this.type = type;
    this.filename = filename;
  }
}

// Paths reachable without a session (the server enforces the gate).
export const PUBLIC_API = new Set(['POST /api/login', 'GET /api/me']);

const routes = [];
function route(method, path, handler) {
  const names = [];
  const rx = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '(\\d+)'; }) + '$');
  routes.push({ method, rx, names, handler });
}

export function handleApi(method, pathname, query, body, ctx = {}) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = Number(m[i + 1]); });
    return r.handler({ params, query, body: body ?? {}, user: ctx.user ?? null, ip: ctx.ip ?? '', token: ctx.token ?? '' });
  }
  throw new AppError(404, 'Not found');
}

function needAdmin(user) {
  if (user?.role !== 'admin') throw new AppError(403, 'Only an admin can do that');
}

// Sales sells received stock and sets the sell price. Operations receives it,
// writes it off, and keeps the item record. Admin can do both.
function needOperations(user) {
  if (user?.role !== 'operations' && user?.role !== 'operations_hod' && user?.role !== 'admin') {
    throw new AppError(403, 'Only operations (or admin) accounts can receive stock, write it off, or change item details');
  }
}
function needApprove(user) {
  if (user?.role !== 'operations_hod' && user?.role !== 'admin') {
    throw new AppError(403, 'Only an Operations HOD can approve a boat price enquiry');
  }
}

// The boat directory is edited by these accounts. Admin can still do it.
const BOAT_EDITORS = new Set(['nahuzaam', 'najah', 'ibbe']);
function needBoatEditor(user) {
  if (user?.role === 'admin') return;
  if (BOAT_EDITORS.has(String(user?.username || '').toLowerCase())) return;
  throw new AppError(403, 'Only Nahuzaam, Najah, or Ibbe can change the boat list');
}

// Which items show on the till. Admin can still do it; Dhaashin can too.
const POS_CATALOG = new Set(['dhaashin']);
function needPosCatalog(user) {
  if (user?.role === 'admin') return;
  if (POS_CATALOG.has(String(user?.username || '').toLowerCase())) return;
  throw new AppError(403, 'Only an admin or Dhaashin can change which items are on the till');
}

function needSalesDesk(user) {
  if (user?.role !== 'admin' && user?.role !== 'sales') {
    throw new AppError(403, 'Only sales (or admin) accounts can change orders, customers, and sell prices');
  }
}

// ---- validation helpers ----

function need(cond, msg, extra) {
  if (!cond) throw new AppError(400, msg, extra);
}

function str(v, name, { min = 1, max = 200, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return '';
    throw new AppError(400, `${name} is required`);
  }
  need(typeof v === 'string', `${name} must be text`);
  const t = v.trim();
  need(t.length >= min && t.length <= max, `${name} must be ${min}–${max} characters`);
  return t;
}

// Phone numbers are digits only. A number stored before that rule (the
// imported farmer list has a few with two numbers and a slash) is accepted
// unchanged, so the rest of that record can still be edited.
function phoneNo(v, name, { optional = false, kept = '' } = {}) {
  if (kept && v === kept) return kept;
  const t = str(v, name, { max: 15, optional });
  need(/^\d*$/.test(t), `${name} must be numbers only`);
  return t;
}

function posNum(v, name, max = 1e6) {
  const n = Number(v);
  need(Number.isFinite(n) && n > 0 && n <= max, `${name} must be a positive number`);
  return n;
}

// Quantities are stored at 3-decimal precision; anything that rounds to zero
// would violate the CHECK constraints downstream, so reject it here.
function qty3(v, name) {
  const q = round3(posNum(v, name, 100000));
  need(q >= 0.001, `${name} is below the smallest unit (0.001)`);
  return q;
}

function intIn(v, name, min, max) {
  const n = Number(v);
  need(Number.isInteger(n) && n >= min && n <= max, `${name} must be a whole number between ${min} and ${max}`);
  return n;
}

function dateStr(v, name, { optional = false } = {}) {
  if ((v === undefined || v === null || v === '') && optional) return null;
  need(isDateStr(v), `${name} must be a date (YYYY-MM-DD)`);
  return v;
}

const ROLES = ['admin', 'sales', 'operations', 'operations_hod'];
const CATEGORIES = ['fruit', 'vegetable', 'herb', 'other'];
const UNITS = ['kg', 'piece', 'bunch', 'crate', 'box'];
const CUSTOMER_TYPES = ['resort', 'guesthouse', 'restaurant', 'retail', 'other'];
const PAY_METHODS = ['transfer', 'cash', 'cheque', 'card'];

function getProduct(id) {
  const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(id);
  if (!p) throw new AppError(404, 'Product not found');
  return p;
}

function getCustomer(id) {
  const c = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
  if (!c) throw new AppError(404, 'Customer not found');
  return c;
}

// Retail sales have no account. One Walk-in customer holds every counter sale.
function walkInCustomer(user) {
  const existing = db.prepare(`SELECT id, active FROM customers WHERE name = 'Walk-in' COLLATE NOCASE`).get();
  if (existing) {
    if (!existing.active) db.prepare(`UPDATE customers SET active = 1 WHERE id = ?`).run(existing.id);
    return getCustomer(existing.id);
  }
  const id = Number(db.prepare(
    `INSERT INTO customers (name, type, island, contact, phone, credit_limit, terms_days, notes)
     VALUES ('Walk-in', 'retail', '', '', '', 0, 0, 'Retail counter. Till sales use this customer.')`
  ).run().lastInsertRowid);
  logAction(user, 'customer-created', 'customer', id, 'Added customer Walk-in (retail)');
  return getCustomer(id);
}

function getOrder(id) {
  const o = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
  if (!o) throw new AppError(404, 'Order not found');
  return o;
}

const SLIP_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };

function slipKind(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.length >= 5 && buf.slice(0, 5).toString() === '%PDF-') return 'pdf';
  return '';
}

function slipPath(name) {
  if (!/^[\w.-]+$/.test(name)) throw new AppError(404, 'Slip not found');
  const file = join(SLIPS_DIR, name);
  if (!file.startsWith(SLIPS_DIR + sep)) throw new AppError(404, 'Slip not found');
  return file;
}

function transferPayment(orderId) {
  return db.prepare(
    `SELECT * FROM payments WHERE order_id = ? AND method = 'transfer' ORDER BY id DESC LIMIT 1`
  ).get(orderId);
}

// ---- auth & account ----

const SESSION_COOKIE = 'baazaru_session';
const cookieFor = (token, { remember = true } = {}) => {
  if (!token) return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  const maxAge = remember ? `; Max-Age=${30 * 86400}` : '';
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${maxAge}`;
};

route('POST', '/api/login', ({ body, ip }) => {
  if (!loginAllowed(ip)) {
    if (shouldLogThrottle(ip)) {
      logAction(null, 'sign-in-throttled', 'auth', null, `Sign-in attempts throttled for ${ip}`);
    }
    throw new AppError(429, 'Too many attempts — wait a few minutes and try again');
  }
  const username = str(body.username, 'Username', { max: 40 }).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  need(password.length > 0 && password.length <= 200, 'Password is required');
  const u = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
  const ok = u && u.active
    ? verifyPassword(password, u.pass_salt, u.pass_hash)
    : (burnVerify(password), false); // constant cost — no timing oracle on usernames
  if (!ok) {
    recordLoginFailure(ip);
    logAction(null, 'sign-in-failed', 'auth', null, `Failed sign-in attempt for '${username}'`);
    throw new AppError(401, 'Wrong username or password');
  }
  recordLoginSuccess(ip);
  const token = createSession(u.id);
  const user = { id: u.id, username: u.username, name: u.name, role: u.role };
  logAction(user, 'signed-in', 'auth', u.id, `${u.name} signed in`);
  return new ApiResult({ user }, { cookie: cookieFor(token, { remember: body.remember === true }) });
});

route('POST', '/api/logout', ({ user, token }) => {
  destroySession(token);
  logAction(user, 'signed-out', 'auth', user?.id ?? null, `${user?.name ?? 'Someone'} signed out`);
  return new ApiResult({ ok: true }, { cookie: cookieFor(null) });
});

route('GET', '/api/me', ({ user }) => ({
  user,
  default_admin: getSettings().default_admin === '1',
}));

route('POST', '/api/account/password', ({ body, user }) => {
  const current = typeof body.current === 'string' ? body.current : '';
  const next = typeof body.next === 'string' ? body.next : '';
  need(next.length >= 6 && next.length <= 200, 'New password must be 6–200 characters');
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
  need(u && verifyPassword(current, u.pass_salt, u.pass_hash), 'Current password is wrong');
  const { salt, hash } = hashPassword(next);
  tx(() => {
    db.prepare(`UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?`).run(salt, hash, u.id);
    if (u.username === 'admin') setSetting('default_admin', '0');
    logAction(user, 'password-changed', 'user', u.id, `${user.name} changed their password`);
  });
  // The whole point of changing a password is locking out whoever else has the
  // old session — revoke everything, then hand this tab a fresh cookie.
  destroyUserSessions(u.id);
  const token = createSession(u.id);
  return new ApiResult({ ok: true }, { cookie: cookieFor(token) });
});

// ---- user management (admin) ----

route('GET', '/api/users', ({ user }) => {
  needAdmin(user);
  return db.prepare(
    `SELECT id, username, name, role, active, created_at FROM users ORDER BY active DESC, name`).all();
});

route('POST', '/api/users', ({ body, user }) => {
  needAdmin(user);
  const username = str(body.username, 'Username', { min: 2, max: 40 }).toLowerCase();
  need(/^[a-z0-9._-]+$/.test(username), 'Username can use letters, digits, dots, dashes');
  const name = str(body.name, 'Name', { min: 2, max: 80 });
  need(ROLES.includes(body.role), 'Role must be admin, sales, operations, or Operations HOD');
  const password = typeof body.password === 'string' ? body.password : '';
  need(password.length >= 6 && password.length <= 200, 'Password must be 6–200 characters');
  const { salt, hash } = hashPassword(password);
  try {
    const id = tx(() => {
      const ins = db.prepare(
        `INSERT INTO users (username, name, role, pass_salt, pass_hash, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      ).run(username, name, body.role, salt, hash, new Date().toISOString());
      const newId = Number(ins.lastInsertRowid);
      logAction(user, 'user-created', 'user', newId, `Added user ${name} (${username}, ${body.role})`);
      return newId;
    });
    return { id };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new AppError(400, 'That username is taken');
    throw e;
  }
});

route('PATCH', '/api/users/:id', ({ params, body, user }) => {
  needAdmin(user);
  const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(params.id);
  if (!target) throw new AppError(404, 'User not found');
  const fields = {};
  const changes = [];
  if (body.name !== undefined) {
    fields.name = str(body.name, 'Name', { min: 2, max: 80 });
    changes.push('name');
  }
  if (body.role !== undefined) {
    need(ROLES.includes(body.role), 'Role must be admin, sales, operations, or Operations HOD');
    need(target.id !== user.id || body.role === target.role, "You can't change your own role");
    fields.role = body.role;
    changes.push(`role → ${body.role}`);
  }
  if (body.active !== undefined) {
    need(!(target.id === user.id && !body.active), "You can't deactivate yourself");
    fields.active = body.active ? 1 : 0;
    changes.push(body.active ? 'reactivated' : 'deactivated');
  }
  // Never demote or deactivate the last active admin.
  const losesAdmin = (fields.role !== undefined && fields.role !== 'admin' && target.role === 'admin') || fields.active === 0;
  if (losesAdmin && target.role === 'admin') {
    const admins = db.prepare(`SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1`).get().n;
    need(admins > 1, 'That would leave no active admin');
  }
  if (body.password !== undefined) {
    need(typeof body.password === 'string' && body.password.length >= 6 && body.password.length <= 200,
      'Password must be 6–200 characters');
    const { salt, hash } = hashPassword(body.password);
    fields.pass_salt = salt;
    fields.pass_hash = hash;
    changes.push('password reset');
  }
  // Require a fresh password when reactivating the bootstrap administrator.
  if (fields.active === 1 && !target.active && target.username === 'admin'
      && !fields.pass_hash) {
    throw new AppError(400, 'Set a new password when reactivating the default admin account');
  }
  const keys = Object.keys(fields);
  need(keys.length > 0, 'Nothing to update');
  tx(() => {
    db.prepare(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => fields[k]), target.id);
    // The first-run hint must die with any change that retires the default
    // credentials: password reset, or the seeded account leaving service.
    if (target.username === 'admin' && (fields.pass_hash || fields.active === 0)) {
      setSetting('default_admin', '0');
    }
    logAction(user, 'user-updated', 'user', target.id, `Updated user ${target.name}: ${changes.join(', ')}`);
  });
  if (fields.active === 0 || fields.pass_salt) destroyUserSessions(target.id);
  return { ok: true };
});

// ---- action history ----

route('GET', '/api/history', ({ query }) => {
  const where = [];
  const params = [];
  const uid = Number(query.get('user_id'));
  if (uid) { where.push('user_id = ?'); params.push(uid); }
  const entity = query.get('entity');
  if (entity && /^[a-z]+$/.test(entity)) { where.push('entity = ?'); params.push(entity); }
  // Cursor: pass the last row id you have to page further back — the trail
  // stays reachable all the way to the first entry.
  const before = Number(query.get('before_id'));
  if (before) { where.push('id < ?'); params.push(before); }
  const limit = Math.min(Math.max(Number(query.get('limit')) || 200, 1), 500);
  const rows = db.prepare(
    `SELECT id, user_id, user_name, action, entity, entity_id, summary, at FROM audit_log
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC LIMIT ?`
  ).all(...params, limit);
  const actors = db.prepare(
    `SELECT DISTINCT user_id, user_name FROM audit_log WHERE user_id IS NOT NULL ORDER BY user_name`).all();
  return { rows, actors };
});

// On-hand stock for the dashboard charts. Value is laari at cost, rounded per
// lot the same way the inventory page totals a lot, then summed.
const STOCK_CATEGORIES = ['fruit', 'vegetable', 'herb', 'other'];

export function stockBreakdown(lots) {
  const catValue = new Map(STOCK_CATEGORIES.map(c => [c, 0]));
  const prod = new Map();
  let value = 0;
  for (const l of lots) {
    const line = Math.round(l.qty * l.unit_cost);
    value += line;
    catValue.set(l.category, (catValue.get(l.category) ?? 0) + line);
    const row = prod.get(l.name) ?? { name: l.name, unit: l.unit, qty: 0, value: 0 };
    row.qty = round3(row.qty + l.qty);
    row.value += line;
    prod.set(l.name, row);
  }
  const ranked = [...prod.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const head = ranked.slice(0, 6);
  const tail = ranked.slice(6);
  const by_product = head.map(p => ({ name: p.name, unit: p.unit, qty: p.qty, value: p.value }));
  if (tail.length) {
    by_product.push({
      name: 'Other',
      count: tail.length,
      value: tail.reduce((s, p) => s + p.value, 0),
    });
  }
  return {
    value,
    lots: lots.length,
    products: prod.size,
    by_category: STOCK_CATEGORIES
      .filter(c => catValue.get(c) > 0)
      .map(c => ({ category: c, value: catValue.get(c) })),
    by_product,
  };
}

// ---- dashboard ----

route('GET', '/api/dashboard', ({ query }) => {
  const t0 = localDateStr();
  const currentYear = Number(t0.slice(0, 4));
  const rawYear = query.get('year');
  let year = null;
  if (rawYear) {
    year = Number(rawYear);
    need(Number.isInteger(year) && year >= 2000 && year <= currentYear, 'Year is not valid');
  }
  // A chosen year is the whole calendar year, through today when it is still
  // this year. With no year, the desk stays on its short windows.
  const periodStart = year ? `${year}-01-01` : null;
  const periodEnd = year ? (year === currentYear ? t0 : `${year}-12-31`) : null;

  const yearSet = new Set([currentYear]);
  db.prepare(
    `SELECT DISTINCT substr(delivery_date, 1, 4) y FROM orders
     WHERE status != 'cancelled' AND delivery_date != ''
     UNION SELECT DISTINCT substr(received_at, 1, 4) FROM lots
     WHERE origin_lot_id IS NULL AND received_at != ''
     UNION SELECT DISTINCT substr(at, 1, 4) FROM stock_moves
     WHERE type IN ('damage', 'weight_loss', 'stem_weight') AND at != ''`
  ).all().forEach(r => {
    const y = Number(r.y);
    if (y >= 2000 && y <= currentYear) yearSet.add(y);
  });
  const years = [...yearSet].sort((a, b) => b - a);

  const salesFrom = periodStart ?? addDays(t0, -13);
  const salesTo = periodEnd ?? t0;
  const byDay = new Map();
  const revenue14 = [];
  if (!year) {
    db.prepare(
      `SELECT delivery_date d, SUM(total) v, COUNT(*) n FROM orders
       WHERE status != 'cancelled' AND delivery_date BETWEEN ? AND ?
       GROUP BY delivery_date`
    ).all(salesFrom, salesTo).forEach(r => byDay.set(r.d, r));
    for (let i = -13; i <= 0; i++) {
      const d = addDays(t0, i);
      revenue14.push({ date: d, value: byDay.get(d)?.v ?? 0 });
    }
  } else {
    const byMonth = new Map();
    db.prepare(
      `SELECT substr(delivery_date, 1, 7) m, SUM(total) v FROM orders
       WHERE status != 'cancelled' AND delivery_date BETWEEN ? AND ?
       GROUP BY m`
    ).all(salesFrom, salesTo).forEach(r => byMonth.set(r.m, r.v));
    const lastMonth = Number(salesTo.slice(5, 7));
    for (let m = 1; m <= lastMonth; m++) {
      const key = `${year}-${String(m).padStart(2, '0')}`;
      revenue14.push({ date: key, value: byMonth.get(key) ?? 0 });
    }
  }
  const todayRev = byDay.get(t0)?.v ?? 0;
  const yesterdayRev = byDay.get(addDays(t0, -1))?.v ?? 0;

  // Receivables: delivered but not fully paid.
  const delivered = db.prepare(
    `SELECT o.id, o.customer_id, o.total, o.delivery_date, c.name, c.phone, c.terms_days,
            (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.order_id = o.id) AS paid
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'delivered'`
  ).all();
  let outstanding = 0, overdueAmt = 0;
  const overdueList = [];
  for (const o of delivered) {
    const out = o.total - o.paid;
    if (out <= 0) continue;
    outstanding += out;
    const dueDate = addDays(o.delivery_date, o.terms_days);
    const over = daysBetween(dueDate, t0);
    if (over > 0) {
      overdueAmt += out;
      overdueList.push({
        order_id: o.id, customer_id: o.customer_id, customer: o.name, phone: o.phone,
        outstanding: out, days_over: over,
      });
    }
  }
  overdueList.sort((a, b) => b.days_over - a.days_over);

  // Stock expiring within 3 days, valued at sell price.
  const atRiskLots = db.prepare(
    `SELECT l.id lot_id, l.qty_left, l.expires_at, pr.name product, pr.unit, pr.price
     FROM lots l JOIN products pr ON pr.id = l.product_id
     WHERE l.qty_left > 0 AND l.expires_at >= ? AND l.expires_at <= ?
       AND ${lossBinSql('l.bin_location')}
     ORDER BY l.expires_at, l.id`
  ).all(t0, addDays(t0, 3));
  const atRiskValue = atRiskLots.reduce((s, l) => s + Math.round(l.qty_left * l.price), 0);

  // Waste: written-off cost vs stock sold at cost in the same window. Count
  // adjustments and transfers are not waste. The live desk uses 30 days; a
  // chosen year uses that year.
  const wasteFrom = periodStart ?? addDays(t0, -29);
  const wasteTo = periodEnd ?? t0;
  const wasteVal = db.prepare(
    `SELECT COALESCE(SUM(-m.qty * l.unit_cost), 0) v FROM stock_moves m JOIN lots l ON l.id = m.lot_id
     WHERE m.type IN ('damage', 'weight_loss', 'stem_weight') AND m.at >= ? AND m.at <= ?`
  ).get(wasteFrom, wasteTo).v;
  const cogs = db.prepare(
    `SELECT COALESCE(SUM(a.qty * l.unit_cost), 0) v
     FROM allocations a
     JOIN lots l ON l.id = a.lot_id
     JOIN order_items oi ON oi.id = a.order_item_id
     JOIN orders o ON o.id = oi.order_id
     WHERE o.status != 'cancelled' AND o.delivery_date BETWEEN ? AND ?`
  ).get(wasteFrom, wasteTo).v;
  const handled = wasteVal + cogs;

  // Receipts only. A transfer splits a lot and is not a new arrival.
  const arrivedFrom = periodStart ?? (t0.slice(0, 7) + '-01');
  const arrivedTo = periodEnd ?? t0;
  const arrivedLots = db.prepare(
    `SELECT qty_received, unit_cost FROM lots
     WHERE origin_lot_id IS NULL AND received_at >= ? AND received_at <= ?`
  ).all(arrivedFrom, arrivedTo);
  const arrivedValue = arrivedLots.reduce((s, l) => s + Math.round(l.qty_received * l.unit_cost), 0);

  const topFrom = periodStart ?? addDays(t0, -6);
  const topTo = periodEnd ?? t0;
  const topProducts7 = db.prepare(
    `SELECT pr.name, pr.unit, SUM(oi.line_total) value, SUM(oi.qty) qty
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products pr ON pr.id = oi.product_id
     WHERE o.status != 'cancelled' AND o.delivery_date BETWEEN ? AND ?
     GROUP BY oi.product_id ORDER BY value DESC LIMIT 7`
  ).all(topFrom, topTo);

  const deliveries = db.prepare(
    `SELECT o.id, o.delivery_date, o.total, c.name customer,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) items
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'pending' AND o.channel = 'wholesale' ORDER BY o.delivery_date, o.id LIMIT 8`
  ).all();

  const tasks = db.prepare(
    `SELECT t.id, t.title, t.due_date, t.done, c.name customer
     FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id
     WHERE t.done = 0 ORDER BY t.due_date, t.id LIMIT 8`
  ).all();

  return {
    today: {
      date: t0,
      revenue: todayRev,
      orders: byDay.get(t0)?.n ?? 0,
      delta_pct: yesterdayRev > 0 ? Math.round((todayRev - yesterdayRev) / yesterdayRev * 1000) / 10 : null,
    },
    receivables: { outstanding, overdue: overdueAmt, overdue_count: overdueList.length },
    at_risk: { value: atRiskValue, lots: atRiskLots.length },
    arrived_month: { value: arrivedValue, receipts: arrivedLots.length },
    waste30: {
      pct: handled > 0 ? Math.round(wasteVal / handled * 1000) / 10 : null,
      // qty is REAL so the sum can be fractional laari — money crossing the
      // API is always integral.
      value: Math.round(wasteVal),
    },
    year,
    years,
    revenue_grain: year ? 'month' : 'day',
    revenue14,
    top_products7: topProducts7,
    // A past year only counts lots received that year that are still on the
    // shelf. This year's shelf, and the live desk, stay the stock on hand now.
    stock: stockBreakdown((year && year < currentYear
      ? db.prepare(
        `SELECT pr.name AS name, pr.category AS category, pr.unit AS unit,
                l.qty_left AS qty, l.unit_cost AS unit_cost
         FROM lots l JOIN products pr ON pr.id = l.product_id
         WHERE l.qty_left > 0 AND l.received_at >= ? AND l.received_at <= ?
           AND ${lossBinSql('l.bin_location')}`
      ).all(periodStart, periodEnd)
      : db.prepare(
        `SELECT pr.name AS name, pr.category AS category, pr.unit AS unit,
                l.qty_left AS qty, l.unit_cost AS unit_cost
         FROM lots l JOIN products pr ON pr.id = l.product_id
         WHERE l.qty_left > 0 AND ${lossBinSql('l.bin_location')}`
      ).all()
    )),
    panel: {
      deliveries,
      expiring: atRiskLots.slice(0, 6).map(l => ({
        ...l, days_left: daysBetween(t0, l.expires_at),
        value: Math.round(l.qty_left * l.price),
      })),
      overdue: overdueList.slice(0, 6),
      tasks,
    },
  };
});

// ---- sell-first ----

route('GET', '/api/sell-first', () => {
  const t0 = localDateStr();
  const rows = db.prepare(
    `SELECT l.id lot_id, l.qty_left, l.expires_at, l.received_at, l.supplier,
            pr.id product_id, pr.name product, pr.unit, pr.price
     FROM lots l JOIN products pr ON pr.id = l.product_id
     WHERE l.qty_left > 0 AND l.expires_at >= ? AND l.expires_at <= ?
       AND ${lossBinSql('l.bin_location')}
     ORDER BY l.expires_at, l.id`
  ).all(t0, addDays(t0, 3));
  const buyers = db.prepare(
    `SELECT c.id, c.name, c.phone, ROUND(SUM(oi.qty), 1) qty
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN customers c ON c.id = o.customer_id
     WHERE oi.product_id = ? AND o.status != 'cancelled' AND o.delivery_date >= ?
     GROUP BY c.id ORDER BY SUM(oi.qty) DESC LIMIT 3`
  );
  return rows.map(r => {
    const daysLeft = daysBetween(t0, r.expires_at);
    const pct = daysLeft <= 1 ? 40 : 20;
    return {
      ...r,
      days_left: daysLeft,
      suggested_discount_pct: pct,
      suggested_price: Math.round(r.price * (100 - pct) / 100),
      value: Math.round(r.qty_left * r.price),
      buyers: buyers.all(r.product_id, addDays(t0, -59)),
    };
  });
});

// ---- products ----

// Days of cover, expiry-aware: consume `velocity` per day, first-expiry-first,
// counting a lot only on days it is still sellable. Plain stock/velocity would
// show a week of cover on stock that all expires tonight.
function coverDays(lots, velocity) {
  if (velocity <= 0) return null;
  const pool = lots.map(l => ({ qty: l.qty, daysLeft: l.daysLeft }));
  const CAP = 60;
  for (let day = 0; day < CAP; day++) {
    let need = velocity;
    for (const l of pool) {
      if (l.daysLeft < day || l.qty <= 0) continue;
      const take = Math.min(l.qty, need);
      l.qty -= take;
      need -= take;
      if (need <= 1e-9) break;
    }
    if (need > 1e-9) return Math.round((day + (velocity - need) / velocity) * 10) / 10;
  }
  return CAP;
}

// Removed products keep their row, and names are UNIQUE, so a clash may be
// with something no longer in Items.
function productNameTaken(name) {
  const hit = db.prepare(`SELECT active FROM products WHERE name = ?`).get(name);
  return new AppError(400, hit && !hit.active
    ? `${name} was removed from Items — tick “Show removed items” to restore it`
    : 'A product with that name already exists');
}

function productClash(err, name) {
  if (!String(err.message).includes('UNIQUE')) return err;
  return String(err.message).includes('products.code')
    ? new AppError(400, 'That item code is already used by another product')
    : productNameTaken(name);
}

// Item codes are optional, but two products can't share one.
function itemCode(v, exceptId = 0) {
  const code = str(v, 'Item code', { max: 20, optional: true });
  if (code) {
    const clash = db.prepare(`SELECT name FROM products WHERE code = ? COLLATE NOCASE AND id != ?`).get(code, exceptId);
    need(!clash, `Item code ${code} is already used by ${clash?.name}`);
  }
  return code;
}

function productHasHistory(id) {
  return db.prepare(
    `SELECT EXISTS (SELECT 1 FROM lots WHERE product_id = ?)
         OR EXISTS (SELECT 1 FROM order_items WHERE product_id = ?) AS used`
  ).get(id, id).used === 1;
}

route('GET', '/api/products', ({ query }) => {
  const t0 = localDateStr();
  const all = query.get('all') === '1';
  const sold = new Map();
  db.prepare(
    `SELECT oi.product_id pid, SUM(oi.qty) q FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status != 'cancelled' AND o.delivery_date BETWEEN ? AND ? GROUP BY oi.product_id`
  ).all(addDays(t0, -13), t0).forEach(r => sold.set(r.pid, r.q));
  const lotsByProduct = new Map();
  db.prepare(
    `SELECT product_id pid, qty_left, expires_at FROM lots
     WHERE qty_left > 0 AND expires_at >= ? AND ${lossBinSql('bin_location')} ORDER BY expires_at`
  ).all(t0).forEach(l => {
    if (!lotsByProduct.has(l.pid)) lotsByProduct.set(l.pid, []);
    lotsByProduct.get(l.pid).push({ qty: l.qty_left, daysLeft: daysBetween(t0, l.expires_at) });
  });

  const used = new Set(db.prepare(
    `SELECT product_id FROM lots UNION SELECT product_id FROM order_items`).all().map(r => r.product_id));

  return db.prepare(
    `SELECT * FROM products ${all ? '' : 'WHERE active = 1'} ORDER BY active DESC, name`
  ).all().map(p => {
    const lots = lotsByProduct.get(p.id) ?? [];
    const s = lots.reduce((sum, l) => sum + l.qty, 0);
    const q14 = sold.get(p.id) ?? 0;
    const velocity = q14 / 14;
    const cover = coverDays(lots, velocity);
    return {
      ...p,
      has_history: used.has(p.id),
      stock: round3(s),
      sold14: round3(q14),
      velocity: Math.round(velocity * 10) / 10,
      days_of_stock: cover,
      low_stock: cover !== null && cover < 2,
      margin_pct: p.price > 0 ? Math.round((p.price - p.cost) / p.price * 1000) / 10 : 0,
    };
  });
});

route('POST', '/api/products', ({ body, user }) => {
  needOperations(user);
  const name = str(body.name, 'Name', { min: 2, max: 80 });
  need(CATEGORIES.includes(body.category), 'Category is not valid');
  need(UNITS.includes(body.unit), 'Unit is not valid');
  const shelf = intIn(body.shelf_life_days, 'Shelf life', 1, 365);
  const cost = intIn(body.cost, 'Cost', 0, 1e9);
  const price = intIn(body.price, 'Price', 1, 1e9);
  const code = itemCode(body.code);
  if (body.receipt !== undefined && body.receipt !== null) {
    throw new AppError(400, 'Stock is added when the item receipt is written for a boat note.');
  }
  try {
    return tx(() => {
      const ins = db.prepare(
        `INSERT INTO products (name, category, unit, shelf_life_days, cost, price, code) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(name, body.category, body.unit, shelf, cost, price, code);
      const id = Number(ins.lastInsertRowid);
      logAction(user, 'product-created', 'product', id,
        `Added product ${name}${code ? ` (${code})` : ''} at ${mvrText(price)} / ${body.unit}`);
      return { id };
    });
  } catch (e) {
    throw productClash(e, name);
  }
});

route('PATCH', '/api/products/:id', ({ params, body, user }) => {
  const p = getProduct(params.id);
  const fields = {};
  if (body.name !== undefined) fields.name = str(body.name, 'Name', { min: 2, max: 80 });
  if (body.category !== undefined) { need(CATEGORIES.includes(body.category), 'Category is not valid'); fields.category = body.category; }
  if (body.unit !== undefined) { need(UNITS.includes(body.unit), 'Unit is not valid'); fields.unit = body.unit; }
  if (body.shelf_life_days !== undefined) fields.shelf_life_days = intIn(body.shelf_life_days, 'Shelf life', 1, 365);
  if (body.cost !== undefined) fields.cost = intIn(body.cost, 'Cost', 0, 1e9);
  if (body.price !== undefined) fields.price = intIn(body.price, 'Price', 1, 1e9);
  if (body.code !== undefined) fields.code = itemCode(body.code, p.id);
  if (body.active !== undefined) fields.active = body.active ? 1 : 0;
  if (body.pos_on !== undefined) fields.pos_on = body.pos_on ? 1 : 0;
  const keys = Object.keys(fields);
  need(keys.length > 0, 'Nothing to update');
  // Sell price and whether the item is on the list belong to sales. The item itself
  // (name, unit, buying cost, code) arrives with the GRN, so operations owns it.
  // pos_on is the till list, owned by admin and Dhaashin.
  const salesFields = ['price', 'active'];
  if (fields.pos_on !== undefined) needPosCatalog(user);
  const rest = keys.filter(k => k !== 'pos_on');
  if (rest.some(k => salesFields.includes(k))) needSalesDesk(user);
  if (rest.some(k => !salesFields.includes(k))) needOperations(user);
  // Lots and order lines store bare quantities, so they would silently
  // change meaning (12 kg → 12 boxes) if the unit moved under them.
  if (fields.unit !== undefined && fields.unit !== p.unit) {
    need(!productHasHistory(p.id), `${p.name} already has stock or orders in ${p.unit}, so its unit can't change`);
  }
  // Orders can't take a removed product, so anything left would be stranded.
  if (fields.active === 0 && p.active) {
    const left = db.prepare(
      `SELECT COALESCE(SUM(qty_left), 0) AS q FROM lots WHERE product_id = ? AND ${lossBinSql('bin_location')}`
    ).get(p.id).q;
    need(left < 0.001, `${p.name} still has ${round3(left)} ${p.unit} in stock — sell it or write it off in Inventory first`);
  }
  try {
    db.prepare(`UPDATE products SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => fields[k]), p.id);
  } catch (e) {
    throw productClash(e, fields.name);
  }
  // Money moves get old → new in the history line; the rest name the change.
  const changes = keys.map(k =>
    k === 'price' ? `price ${mvrText(p.price)} → ${mvrText(fields.price)}`
    : k === 'cost' ? `cost ${mvrText(p.cost)} → ${mvrText(fields.cost)}`
    : k === 'name' ? `renamed to ${fields.name}`
    : k === 'code' ? `item code ${p.code || 'none'} → ${fields.code || 'none'}`
    : k === 'active' ? (fields.active ? 'restored to Items' : 'removed from Items')
    : k === 'pos_on' ? (fields.pos_on ? 'shown on the till' : 'hidden from the till')
    : k === 'shelf_life_days' ? `shelf life ${p.shelf_life_days} → ${fields.shelf_life_days} days`
    : `${k} ${p[k]} → ${fields[k]}`).join(', ');
  logAction(user, 'product-updated', 'product', p.id, `Updated ${p.name}: ${changes}`);
  return { ok: true };
});

// One row per received lot. Stock split off by a transfer still counts as
// "in inventory" for the lot it came from.
function shipmentLots(shipmentId) {
  const t0 = localDateStr();
  const lots = db.prepare(
    `SELECT l.*, pr.name product, pr.code item_code, pr.unit
     FROM lots l JOIN products pr ON pr.id = l.product_id
     WHERE l.shipment_id = ?
     ORDER BY pr.name, l.id`
  ).all(shipmentId);
  const left = new Map();
  for (const l of lots) {
    const root = l.origin_lot_id ?? l.id;
    left.set(root, (left.get(root) ?? 0) + l.qty_left);
  }
  return lots.filter(l => l.origin_lot_id === null).map(l => {
    const dl = daysBetween(t0, l.expires_at);
    const qtyLeft = round3(left.get(l.id));
    return { ...l, qty_left: qtyLeft, days_left: dl, status: lotStatus(dl), value_cost: Math.round(qtyLeft * l.unit_cost) };
  });
}

// ---- inventory ----

route('GET', '/api/lots', ({ query }) => {
  const t0 = localDateStr();
  const all = query.get('all') === '1';
  const rows = db.prepare(
    `SELECT l.*, pr.name product, pr.code item_code, pr.unit, pr.price, s.reference shipment_reference
     FROM lots l JOIN products pr ON pr.id = l.product_id
     LEFT JOIN shipments s ON s.id = l.shipment_id
     ${all ? '' : `WHERE l.qty_left > 0 AND ${lossBinSql('l.bin_location')}`}
     ORDER BY l.expires_at, l.id`
  ).all();
  return rows.map(l => {
    const dl = daysBetween(t0, l.expires_at);
    return {
      ...l,
      receipt_ref: l.reference || docNo('GRN', l.origin_lot_id ?? l.id),
      days_left: dl,
      status: lotStatus(dl),
      value_cost: Math.round(l.qty_left * l.unit_cost),
    };
  });
});

route('POST', '/api/lots', () => {
  throw new AppError(400, 'Stock is added when the item receipt is written for a boat note.');
});

// Farmers seen on earlier receipts (latest details win) and the bins in use,
// for the receive form's suggestions.
route('GET', '/api/stock-lookups', () => {
  const farmers = new Map();
  for (const f of db.prepare(
    `SELECT supplier name, farmer_id_card id_card, farmer_island island, farmer_agreement agreement,
            received_at last_received
     FROM lots WHERE supplier != '' AND origin_lot_id IS NULL ORDER BY received_at, id`
  ).all()) {
    farmers.set(f.id_card || 'name:' + f.name.toLowerCase(), f);
  }
  const bins = db.prepare(
    `SELECT name b FROM bins
     UNION SELECT bin_location FROM lots WHERE bin_location != ''
     ORDER BY b COLLATE NOCASE`
  ).all().map(r => r.b);
  return {
    farmers: [...farmers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    bins,
    loss_bins: LOSS_BINS,
  };
});

const LOSS_TYPES = { damage: 'Damage', weight_loss: 'Weight Loss', stem_weight: 'Stem Weight' };
const DAMAGE_REASONS = [
  'Moisture & Mold',
  'Insect Infestations',
  'Rodents & Birds',
  'Respiration & Heat',
  'Rough Handling',
  'Puncture Wounds',
  'Lack of Cold Chain',
  'Substandard Storage',
  'Transportation Delays',
  'Sales Delay',
  'Lack of Sorting',
];

function moveNote(type, body) {
  if (type !== 'damage') return str(body.note, 'Note', { max: 120, optional: true });
  const reason = str(body.reason, 'Damage reason');
  need(DAMAGE_REASONS.includes(reason), 'Choose a damage reason from the list');
  const detail = str(body.note, 'Detail', { max: 80, optional: true });
  return detail ? `${reason} — ${detail}` : reason;
}

// Everything that changes a lot after it was received, apart from sales.
route('POST', '/api/lots/:id/moves', ({ params, body, user }) => {
  needOperations(user);
  const t0 = localDateStr();
  const lot = db.prepare(
    `SELECT l.*, pr.name product, pr.unit FROM lots l JOIN products pr ON pr.id = l.product_id WHERE l.id = ?`
  ).get(params.id);
  if (!lot) throw new AppError(404, 'Lot not found');
  const type = body.type;
  need(type in LOSS_TYPES || type === 'adjust' || type === 'transfer', 'Choose what happened to this stock');
  const at = dateStr(body.at, 'Date', { optional: true }) ?? t0;
  need(at <= t0, "The date can't be in the future");
  need(at >= lot.received_at, `This lot arrived on ${lot.received_at}, so the date can't be earlier`);
  const reference = str(body.reference, 'Reference', { max: 40, optional: true });
  const note = moveNote(type, body);
  const what = `${lot.product} (lot #${lot.id})`;
  const because = note ? ` — ${note}` : '';
  const room = q => need(q <= lot.qty_left + 1e-6, `Only ${lot.qty_left} ${lot.unit} left in this lot`);

  if (type in LOSS_TYPES) {
    const qty = qty3(body.qty, 'Quantity');
    room(qty);
    const moved = tx(() => {
      const result = writeOffLot(lot.id, qty, { type, reference, note, at });
      logAction(user, 'stock-written-off', 'lot', lot.id,
        `Moved ${qty} ${lot.unit} ${what} to ${LOSS_BINS[type]} as ${LOSS_TYPES[type]}${because}`);
      return result;
    });
    return { ok: true, id: moved.moveId, itn_id: moved.id, reference: moved.reference };
  }

  if (type === 'adjust') {
    const counted = Number(body.counted);
    need(body.counted !== '' && body.counted !== null && Number.isFinite(counted) && counted >= 0 && counted <= 100000,
      'Enter the quantity you counted');
    tx(() => {
      const delta = adjustLot(lot.id, round3(counted), { reference, note, at });
      logAction(user, 'stock-adjusted', 'lot', lot.id,
        `Adjusted ${what} from ${lot.qty_left} to ${round3(counted)} ${lot.unit} (${delta > 0 ? '+' : ''}${delta})${because}`);
    });
    return { ok: true };
  }

  const qty = qty3(body.qty, 'Quantity');
  room(qty);
  const toBin = str(body.to_bin, 'Destination bin', { max: 40 });
  need(toBin.toLowerCase() !== lot.bin_location.toLowerCase(), `This lot is already in ${toBin}`);
  need(!isLossBin(toBin), `${toBin} is off the shelf. Record it as damage, weight loss, or stem weight.`);
  const moved = tx(() => {
    const result = transferLot(lot.id, qty, toBin, { reference, note, at });
    logAction(user, 'stock-transferred', 'lot', lot.id,
      `Moved ${qty} ${lot.unit} ${what} from ${lot.bin_location || 'no bin'} to ${toBin} (now lot #${result.newLotId})${because}`);
    return result;
  });
  return { ok: true, lot_id: moved.newLotId, id: moved.moveId, itn_id: moved.id, reference: moved.reference };
});

route('DELETE', '/api/stock-moves/:id', ({ params, user }) => {
  needAdmin(user);
  const gone = tx(() => {
    const result = removeStockMove(params.id);
    const label = result.reference || result.type;
    logAction(user, 'stock-move-removed', 'lot', result.lotId, `Removed movement ${label}`);
    return result;
  });
  return { ok: true, reference: gone.reference };
});

// The stock register: one row per movement, oldest first, in the layout of
// the paper register. Quantities are signed (stock in is positive) and valued
// at the lot's buying price.
const MOVE_PREFIX = { damage: 'WO', weight_loss: 'WO', stem_weight: 'WO', adjust: 'ADJ', transfer: 'TRF' };
// Same-day rows run in the order a warehouse day does.
const MOVE_RANK = { receipt: 0, transfer: 1, sale: 2, loss: 3, adjust: 4 };

route('GET', '/api/stock-register', () => {
  const lots = new Map(db.prepare(
    `SELECT l.*, pr.name item, pr.code item_code, pr.unit FROM lots l JOIN products pr ON pr.id = l.product_id`
  ).all().map(l => [l.id, l]));
  const rows = [];
  const add = (lot, rank, seq, row) => rows.push({
    rank, seq,
    lot_id: lot.id,
    bin: lot.bin_location,
    farmer_name: lot.supplier,
    farmer_id_card: lot.farmer_id_card,
    farmer_island: lot.farmer_island,
    farmer_agreement: lot.farmer_agreement,
    item_code: lot.item_code,
    item: lot.item,
    unit: lot.unit,
    unit_cost: lot.unit_cost,
    boat_note: lot.boat_note,
    note: '',
    ...row,
    // Rounded on the magnitude so a transfer's out and in rows cancel exactly.
    value: Math.sign(row.qty) * Math.round(Math.abs(row.qty) * lot.unit_cost),
  });

  for (const lot of lots.values()) {
    if (lot.origin_lot_id !== null) continue;
    add(lot, MOVE_RANK.receipt, lot.id, {
      type: 'receipt', date: lot.received_at, qty: lot.qty_received,
      reference: lot.reference || docNo('GRN', lot.id),
    });
  }

  // Paid on the spot (cash terms, or settled by the delivery day) is a sales
  // receipt; anything sold on credit is an invoice.
  const orders = new Map(db.prepare(
    `SELECT o.id, o.delivery_date, o.status, o.total, c.terms_days,
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
             WHERE p.order_id = o.id AND p.paid_at <= o.delivery_date) AS paid_by_delivery
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status != 'cancelled'`
  ).all().map(o => [o.id, o]));
  for (const a of db.prepare(
    `SELECT a.id, a.lot_id, a.qty, oi.order_id FROM allocations a JOIN order_items oi ON oi.id = a.order_item_id`
  ).all()) {
    const o = orders.get(a.order_id);
    if (!o) continue;
    const onTheSpot = o.terms_days === 0 || (o.total > 0 && o.paid_by_delivery >= o.total);
    add(lots.get(a.lot_id), MOVE_RANK.sale, a.id, {
      type: onTheSpot ? 'sales_receipt' : 'invoice', date: o.delivery_date, qty: -a.qty,
      reference: docNo('INV', o.id), order_id: o.id, pending: o.status === 'pending',
    });
  }

  // Sales saved without drawing a lot never reached the loop above. A POS order
  // is a sales receipt; a wholesale order is an invoice. This does not change
  // what is on the shelf — there is still no lot to take it from.
  for (const line of db.prepare(
    `SELECT oi.id, oi.qty, oi.order_id,
            pr.name AS item, pr.code AS item_code, pr.unit, pr.cost AS unit_cost,
            o.delivery_date, o.status, o.notes, o.channel
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products pr ON pr.id = oi.product_id
     WHERE o.status != 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.order_item_id = oi.id)`
  ).all()) {
    const qty = -line.qty;
    rows.push({
      rank: MOVE_RANK.sale,
      seq: line.id,
      lot_id: null,
      bin: '',
      farmer_name: '',
      farmer_id_card: '',
      farmer_island: '',
      farmer_agreement: '',
      item_code: line.item_code,
      item: line.item,
      unit: line.unit,
      unit_cost: line.unit_cost,
      boat_note: '',
      note: '',
      type: line.channel === 'pos' ? 'sales_receipt' : 'invoice',
      date: line.delivery_date,
      qty,
      value: Math.sign(qty) * Math.round(Math.abs(qty) * line.unit_cost),
      reference: line.notes || docNo(line.channel === 'pos' ? 'SR' : 'INV', line.order_id),
      order_id: line.order_id,
      pending: line.status === 'pending',
    });
  }

  const itnByMove = new Map(
    db.prepare(`SELECT id, move_id FROM transfer_notes WHERE move_id IS NOT NULL`).all().map(r => [r.move_id, r.id]),
  );
  for (const m of db.prepare(`SELECT * FROM stock_moves`).all()) {
    const reference = m.reference || docNo(MOVE_PREFIX[m.type], m.id);
    const fromLot = lots.get(m.lot_id);
    const toLot = m.to_lot_id ? lots.get(m.to_lot_id) : null;
    const base = {
      type: m.type, date: m.at, reference, note: m.note, move_id: m.id,
      itn_id: itnByMove.get(m.id) || null,
      from_bin: fromLot?.bin_location || '',
      to_bin: toLot?.bin_location || '',
    };
    if (m.type === 'transfer') {
      add(lots.get(m.lot_id), MOVE_RANK.transfer, m.id * 2, { ...base, qty: m.qty });
      add(lots.get(m.to_lot_id), MOVE_RANK.transfer, m.id * 2 + 1, { ...base, qty: -m.qty });
    } else {
      add(lots.get(m.lot_id), m.type === 'adjust' ? MOVE_RANK.adjust : MOVE_RANK.loss, m.id, { ...base, qty: m.qty });
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.rank - b.rank || a.seq - b.seq);
  return rows.map(({ rank, seq, ...r }, i) => ({ serial: i + 1, ...r }));
});

// ---- shipments ----
// A boat note is the shipment. It stays in transit until the GRN. Older
// shipments were already receipts, so their status is received.

function qtyOrBlank(v, name) {
  if (v === undefined || v === null || v === '' || v === 0) return 0;
  return qty3(v, name);
}

function qtyZeroOk(v, name) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  need(Number.isFinite(n) && n >= 0 && n <= 100000, `${name} must be a number`);
  return round3(n);
}

function wholeOrZero(v, name) {
  if (v === undefined || v === null || v === '') return 0;
  return intIn(Number(v), name, 0, 100000);
}

function laariAmount(v, name) {
  const n = Number(v);
  need(Number.isInteger(n) && n >= 0 && n <= 1e12, `${name} must be a money amount`);
  return n;
}

// Packing is how many baskets, boxes, or bunches. Qty is the produce, and that is what
// the item receipt puts into inventory.
function suggestStockQty(line) {
  if (line.qty >= 0.001) return round3(line.qty);
  return 0;
}

function shipmentNoteLines(shipmentId) {
  return db.prepare(
    `SELECT sl.*, pr.name AS product, pr.unit, pr.code AS item_code
     FROM shipment_lines sl
     LEFT JOIN products pr ON pr.id = sl.product_id
     WHERE sl.shipment_id = ?
     ORDER BY sl.line_no, sl.id`
  ).all(shipmentId).map(l => ({ ...l, suggest_qty: suggestStockQty(l) }));
}

route('GET', '/api/shipments', () => {
  const shipments = db.prepare(`SELECT * FROM shipments ORDER BY arrived_at DESC, id DESC`).all();
  const lots = db.prepare(
    `SELECT shipment_id, pr.name product, qty_left, unit_cost, origin_lot_id
     FROM lots l JOIN products pr ON pr.id = l.product_id
     WHERE shipment_id IS NOT NULL`
  ).all();
  const byShip = new Map();
  for (const l of lots) {
    if (!byShip.has(l.shipment_id)) byShip.set(l.shipment_id, []);
    byShip.get(l.shipment_id).push(l);
  }
  const noteNames = new Map();
  const nameRows = db.prepare(
    `SELECT sl.shipment_id, COALESCE(NULLIF(pr.name, ''), sl.description) name
     FROM shipment_lines sl LEFT JOIN products pr ON pr.id = sl.product_id
     UNION ALL
     SELECT hl.shipment_id, COALESCE(NULLIF(pr.name, ''), hl.description) name
     FROM harvest_lines hl LEFT JOIN products pr ON pr.id = hl.product_id
     UNION ALL
     SELECT shipment_id, description name FROM enquiry_lines`
  ).all();
  for (const l of nameRows) {
    if (!l.name) continue;
    if (!noteNames.has(l.shipment_id)) noteNames.set(l.shipment_id, []);
    noteNames.get(l.shipment_id).push(l.name);
  }
  const enquiryTotal = new Map();
  for (const r of db.prepare(
    `SELECT shipment_id, COALESCE(SUM(line_total), 0) total FROM enquiry_lines GROUP BY shipment_id`
  ).all()) enquiryTotal.set(r.shipment_id, r.total);
  const harvestWhen = new Map();
  for (const r of db.prepare(
    `SELECT shipment_id, MIN(harvested_at) harvested_at FROM harvest_lines WHERE harvested_at != '' GROUP BY shipment_id`
  ).all()) harvestWhen.set(r.shipment_id, r.harvested_at);
  const grnsByShip = new Map();
  for (const g of db.prepare(
    `SELECT g.id, g.shipment_id, g.harvest_ref, g.farmer_name, g.farmer_island, g.island_code,
            g.verify_state, g.sent_back_note, g.sent_back_name, g.sent_back_at,
            g.regional_name, g.regional_date, g.harvest_by, g.harvest_fixed_by, g.verified_by
     FROM harvest_grns g ORDER BY g.id`
  ).all()) {
    if (!grnsByShip.has(g.shipment_id)) grnsByShip.set(g.shipment_id, []);
    grnsByShip.get(g.shipment_id).push({ ...g, crops: [] });
  }
  const grnById = new Map();
  for (const list of grnsByShip.values()) for (const g of list) grnById.set(g.id, g);
  for (const row of db.prepare(
    `SELECT hl.harvest_grn_id,
            COALESCE(NULLIF(pr.name, ''), NULLIF(hl.description, ''), 'Crop') name,
            hl.harvested_at
     FROM harvest_lines hl LEFT JOIN products pr ON pr.id = hl.product_id
     WHERE hl.harvest_grn_id IS NOT NULL`
  ).all()) {
    const g = grnById.get(row.harvest_grn_id);
    if (!g) continue;
    if (row.name && !g.crops.includes(row.name)) g.crops.push(row.name);
    if (row.harvested_at && (!g.harvested_at || row.harvested_at < g.harvested_at)) g.harvested_at = row.harvested_at;
  }
  const landing = landingSummaries(shipments);
  const laborHire = new Map();
  for (const r of db.prepare(
    `SELECT h.shipment_id, h.reference, h.hired_on,
       COALESCE((SELECT SUM(line_total) FROM labor_lines WHERE labor_id = h.id), 0) AS total,
       COALESCE((SELECT description FROM labor_lines WHERE labor_id = h.id ORDER BY line_no, id LIMIT 1), '') AS work
     FROM labor_hires h`
  ).all()) laborHire.set(r.shipment_id, r);
  return shipments.map(s => {
    const rows = byShip.get(s.id) ?? [];
    const noted = noteNames.get(s.id) ?? [];
    const products = [...new Set([...noted, ...rows.map(r => r.product)])];
    const stockValue = rows.reduce((sum, r) => sum + Math.round(r.qty_left * r.unit_cost), 0);
    return {
      ...s,
      status: s.status || 'received',
      product_count: products.length,
      lot_count: rows.filter(r => r.origin_lot_id === null).length,
      line_count: noted.length,
      products,
      stock_value: stockValue,
      enquiry_total: enquiryTotal.get(s.id) ?? 0,
      harvested_at: harvestWhen.get(s.id) || '',
      landing_per_kg: landing.get(s.id)?.landing_per_kg ?? null,
      landing_kg: landing.get(s.id)?.kg ?? null,
      logistic_per_kg: landing.get(s.id)?.logistic_per_kg ?? null,
      labor_ref: laborHire.get(s.id)?.reference || '',
      labor_on: laborHire.get(s.id)?.hired_on || '',
      labor_total: laborHire.get(s.id)?.total || 0,
      labor_work: laborHire.get(s.id)?.work || '',
      grns: grnsByShip.get(s.id) || [],
    };
  });
});

route('GET', '/api/shipments/:id', ({ params }) => {
  const shipment = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(params.id);
  if (!shipment) throw new AppError(404, 'Shipment not found');
  const lots = shipmentLots(shipment.id);
  const harvestLines = harvestLinesFor(shipment.id);
  const enquiryLines = db.prepare(
    `SELECT * FROM enquiry_lines WHERE shipment_id = ? ORDER BY line_no, id`
  ).all(shipment.id);
  return {
    shipment,
    lots,
    lines: shipmentNoteLines(shipment.id),
    harvest_lines: harvestLines,
    harvest_grns: db.prepare(`SELECT * FROM harvest_grns WHERE shipment_id = ? ORDER BY id`).all(shipment.id),
    enquiry_lines: enquiryLines,
    enquiry_total: enquiryLines.reduce((sum, l) => sum + l.line_total, 0),
    labor: laborBundle(shipment.id),
    stock_value: lots.reduce((sum, l) => sum + l.value_cost, 0),
    landing: shipmentLanding(shipment.id),
  };
});

function readLandingCharges(raw, { kind, label }) {
  if (raw == null) return [];
  need(Array.isArray(raw), `${label} lines are missing`);
  need(raw.length <= 12, `A shipment can hold 12 ${label.toLowerCase()} lines`);
  return raw.map((row, i) => {
    const n = i + 1;
    const description = str(row.description, `${label} on line ${n}`, { max: 80 });
    const qty = qty3(row.qty, `Qty on ${label.toLowerCase()} line ${n}`);
    const rate = laariAmount(row.rate, `Rate on ${label.toLowerCase()} line ${n}`);
    let basis = 'each';
    if (kind === 'ground') {
      need(row.basis === 'trip' || row.basis === 'hour', `Say whether line ${n} is trips or hours`);
      basis = row.basis;
    }
    return { description, basis, qty, rate, total: Math.round(qty * rate) };
  });
}

route('POST', '/api/shipments/:id/landing', ({ params, body, user }) => {
  needOperations(user);
  const shipment = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(params.id);
  if (!shipment) throw new AppError(404, 'Shipment not found');
  const status = shipment.status || 'received';
  if (status !== 'approved' && status !== 'in_transit' && status !== 'received') {
    throw new AppError(400, 'Landing cost starts once the price enquiry is approved');
  }
  const ground = readLandingCharges(body.ground, { kind: 'ground', label: 'Pick-up' });
  const other = readLandingCharges(body.other, { kind: 'other', label: 'Other charge' });
  const current = shipmentLanding(shipment.id);
  const allowed = new Set(current.lines.map(l => l.key));
  need(Array.isArray(body.lines), 'Add the crop prices');
  need(body.lines.length <= 40, 'A shipment can hold 40 crop prices');
  const lines = body.lines.map(raw => {
    const key = str(raw.key, 'Crop', { max: 40 });
    need(allowed.has(key), 'That crop is not on this shipment');
    return { key, unit_cost: laariAmount(raw.unit_cost, 'Buying price') };
  });
  const seen = new Set();
  for (const line of lines) {
    need(!seen.has(line.key), 'A crop price was sent twice');
    seen.add(line.key);
  }
  for (const key of allowed) need(seen.has(key), 'Enter the price paid for each crop');
  // A harvest grade's buying price is the one written on the GRN.
  const gradePrice = new Map(db.prepare(
    `SELECT hg.id, hg.unit_cost FROM harvest_grades hg
     JOIN harvest_lines hl ON hl.id = hg.line_id WHERE hl.shipment_id = ?`
  ).all(shipment.id).map(r => [`g:${r.id}`, r.unit_cost]));
  for (const line of lines) if (gradePrice.has(line.key)) line.unit_cost = gradePrice.get(line.key);
  const groundTotal = ground.reduce((sum, l) => sum + l.total, 0);
  tx(() => {
    db.prepare(`UPDATE shipments SET ground_transport = ?, landing_weight = NULL WHERE id = ?`)
      .run(groundTotal, shipment.id);
    db.prepare(`DELETE FROM landing_charges WHERE shipment_id = ?`).run(shipment.id);
    const insCharge = db.prepare(
      `INSERT INTO landing_charges (shipment_id, kind, line_no, description, basis, qty, rate, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ground.forEach((l, i) => insCharge.run(shipment.id, 'ground', i + 1, l.description, l.basis, l.qty, l.rate, l.total));
    other.forEach((l, i) => insCharge.run(shipment.id, 'other', i + 1, l.description, 'each', l.qty, l.rate, l.total));
    db.prepare(`DELETE FROM landing_costs WHERE shipment_id = ?`).run(shipment.id);
    const insCost = db.prepare(
      `INSERT INTO landing_costs (shipment_id, line_key, unit_cost) VALUES (?, ?, ?)`
    );
    for (const line of lines) insCost.run(shipment.id, line.key, line.unit_cost);
    const saved = shipmentLanding(shipment.id);
    const move = saved.logistic_per_kg == null ? 'no kilograms yet' : `${mvrText(saved.logistic_per_kg)} per kg to move`;
    const landed = saved.landing_per_kg == null ? '' : `, landing ${mvrText(saved.landing_per_kg)} per kg`;
    logAction(user, 'landing-cost-saved', 'shipment', shipment.id,
      `Landing cost for ${shipment.enquiry_ref || shipment.harvest_ref || shipment.reference}: ${move}${landed}`);
  });
  return shipmentLanding(shipment.id);
});

route('POST', '/api/shipments', ({ body, user }) => {
  needOperations(user);
  const reference = str(body.reference, 'Reference', { min: 2, max: 80 });
  const supplier = str(body.supplier, 'Supplier', { max: 80, optional: true });
  const origin = str(body.origin, 'Origin', { max: 80, optional: true });
  const arrived = dateStr(body.arrived_at, 'Arrival date');
  const notes = str(body.notes, 'Notes', { max: 200, optional: true });
  const existing = db.prepare(`SELECT id FROM shipments WHERE reference = ? COLLATE NOCASE`).get(reference);
  if (existing) throw new AppError(400, 'A shipment with that reference already exists');
  const id = tx(() => {
    const ins = db.prepare(
      `INSERT INTO shipments (reference, supplier, origin, arrived_at, notes) VALUES (?, ?, ?, ?, ?)`
    ).run(reference, supplier, origin, arrived, notes);
    const shipmentId = Number(ins.lastInsertRowid);
    logAction(user, 'shipment-created', 'shipment', shipmentId,
      `Opened shipment ${reference}${supplier ? ` from ${supplier}` : ''}, arrived ${arrived}`);
    return shipmentId;
  });
  return { id };
});

function refTaken(ref, exceptShipmentId = 0, exceptHireId = 0, exceptGrnId = 0) {
  return Boolean(db.prepare(
    `SELECT id FROM shipments WHERE id != ? AND (
       reference = ? COLLATE NOCASE OR harvest_ref = ? COLLATE NOCASE OR enquiry_ref = ? COLLATE NOCASE
       OR grn_ref = ? COLLATE NOCASE)`
  ).get(exceptShipmentId, ref, ref, ref, ref))
    || Boolean(db.prepare(
      `SELECT id FROM labor_hires WHERE id != ? AND reference = ? COLLATE NOCASE`
    ).get(exceptHireId, ref))
    || Boolean(db.prepare(
      `SELECT id FROM harvest_grns WHERE id != ? AND harvest_ref = ? COLLATE NOCASE`
    ).get(exceptGrnId, ref));
}

function laborLinesFor(hireId) {
  return db.prepare(
    `SELECT * FROM labor_lines WHERE labor_id = ? ORDER BY line_no, id`
  ).all(hireId);
}

function laborBundle(shipmentId) {
  const hire = db.prepare(`SELECT * FROM labor_hires WHERE shipment_id = ?`).get(shipmentId);
  if (!hire) return null;
  const lines = laborLinesFor(hire.id);
  return { ...hire, lines, total: lines.reduce((sum, l) => sum + l.line_total, 0) };
}

// The harvest GRN ref is copied into shipments.reference and never rewritten.
// A boat note number or an item-receipt number matches the same shipment once it exists.
function shipmentByNumber(raw) {
  const typed = str(raw, 'Shipment', { max: 80, optional: true });
  if (!typed) return null;
  const rows = db.prepare(
    `SELECT * FROM shipments WHERE reference = ? COLLATE NOCASE
       OR (harvest_ref != '' AND harvest_ref = ? COLLATE NOCASE)
       OR (enquiry_ref != '' AND enquiry_ref = ? COLLATE NOCASE)
       OR (grn_ref != '' AND grn_ref = ? COLLATE NOCASE)`
  ).all(typed, typed, typed, typed);
  if (!rows.length) throw new AppError(400, 'No shipment has that number');
  if (rows.length > 1) throw new AppError(400, 'That number matches more than one shipment');
  return rows[0];
}

function boatNoteLines(body) {
  need(Array.isArray(body.lines) && body.lines.length > 0, 'Add at least one line');
  need(body.lines.length <= 40, 'A boat note can hold 40 lines');
  const lines = body.lines.map((raw, i) => {
    const n = i + 1;
    const productId = raw.product_id ? intIn(raw.product_id, `Item on line ${n}`, 1, 1e9) : null;
    const product = productId ? getProduct(productId) : null;
    if (product) need(product.active, `${product.name} was removed from Items — restore it before loading it`);
    let description = str(raw.description, `Description on line ${n}`, { max: 120, optional: true });
    if (product && !description) description = product.name;
    need(description, `Line ${n} needs an item or a description`);
    const packing = str(raw.packing, `Baskets, boxes, or bunches on line ${n}`, { max: 40, optional: true });
    const qty = qtyOrBlank(raw.qty, `Qty on line ${n}`);
    if (productId) {
      need(packing, `Enter how many baskets, boxes, or bunches for line ${n}`);
      need(qty >= 0.001, `Enter the produce qty for line ${n}`);
    }
    const dest = str(raw.destination, `Destination on line ${n}`, { max: 80, optional: true });
    return { productId, description, packing, qty, dest };
  });
  need(lines.some(l => l.productId), 'Add at least one product. A reference line on its own does not load the boat.');
  return lines;
}

const GRADE_PACKS = ['box', 'sack', 'basket', 'bunch'];

function gradeTravelUnit(g) {
  if (GRADE_PACKS.includes(g.pack_unit)) return g.pack_unit;
  if (Number(g.bunches) > 0 && !(Number(g.pack_count) > 0)) return 'bunch';
  if (Number(g.pack_count) > 0) return 'box';
  return '';
}

// A grade travels as bunches, or in boxes, sacks, or baskets. Bunches are not packed into anything else.
function readGradePack(raw, grade, n) {
  let packUnit = GRADE_PACKS.includes(raw.pack_unit) ? raw.pack_unit : '';
  let packCount = qtyZeroOk(raw.pack_count, `How many for grade ${grade} on line ${n}`);
  let bunches = wholeOrZero(raw.bunches, `Bunches for grade ${grade} on line ${n}`);
  let perBag = qtyZeroOk(raw.per_bag_kg, `Amount in each bag for grade ${grade} on line ${n}`);
  if (!packUnit) packUnit = gradeTravelUnit({ pack_unit: '', bunches, pack_count: packCount });
  if (packUnit === 'bunch') {
    packCount = 0;
    perBag = 0;
  } else if (packUnit) {
    bunches = 0;
  }
  return { packUnit, packCount, perBag, bunches };
}

function gradeQuote(g) {
  const travel = gradeTravelUnit(g);
  if (travel === 'bunch' && g.bunches > 0) return { qty: g.bunches, unit: 'bunch' };
  if (travel && travel !== 'bunch' && g.pack_count > 0) return { qty: g.pack_count, unit: travel };
  return { qty: g.kg, unit: 'kg' };
}

// A crop's undamaged harvest is split into grades, each with its own weight
// and packing, and the grades add up to the undamaged amount. A line sent
// without a grades list is one grade holding all of it.
function harvestGrades(raw, n, undamaged) {
  const list = raw.grades === undefined
    ? [{ grade: raw.grade, kg: undamaged, pack_count: raw.pack_count, per_bag_kg: raw.per_bag_kg, remarks: raw.remarks, unit_cost: raw.unit_cost }]
    : raw.grades;
  need(Array.isArray(list) && list.length > 0, `Add a grade on line ${n}`);
  need(list.length <= 10, `Line ${n} can have up to 10 grades`);
  const seen = new Set();
  const grades = list.map((g, j) => {
    need(g && typeof g === 'object', `Grade ${j + 1} on line ${n} is not valid`);
    const grade = str(g.grade, `Grade name on line ${n}`, { max: 20 });
    need(!seen.has(grade.toLowerCase()), `Grade ${grade} is listed twice on line ${n}`);
    seen.add(grade.toLowerCase());
    return {
      id: g.id == null ? null : intIn(g.id, `Grade ${grade} on line ${n}`, 1, 1e12),
      grade,
      kg: qtyZeroOk(g.kg, `Kg for grade ${grade} on line ${n}`),
      ...readGradePack(g, grade, n),
      remarks: str(g.remarks, `Remarks for grade ${grade} on line ${n}`, { max: 120, optional: true }),
      unitCost: laariAmount(g.unit_cost, `Buying price for grade ${grade} on line ${n}`),
    };
  });
  const graded = round3(grades.reduce((sum, g) => sum + g.kg, 0));
  need(Math.abs(graded - undamaged) < 0.0005,
    `The grades on line ${n} add up to ${graded} kg. They need to match the undamaged amount, ${undamaged} kg.`);
  const empty = grades.length > 1 && grades.find(g => !(g.kg > 0));
  if (empty) throw new AppError(400, `Grade ${empty.grade} on line ${n} has no weight. Enter its kg or remove it.`);
  return grades;
}

// Harvest GRN numbers are written the way the paper book writes them,
// HRC/O-8/2026/018: the island code without its leading zero, the year, then the
// island's own running number, which carries on from one year into the next.
const harvestIsland = code => code.trim().toUpperCase().replace(/^([A-Z])-0*(?=\d)/, '$1-');
const harvestRefFor = (code, year, n) => `HRC/${harvestIsland(code)}/${year}/${String(n).padStart(3, '0')}`;

// The highest number used so far on each island, keyed by the island part of the ref.
// A GRN being corrected leaves its own number out.
function lastHarvestNumbers(exceptGrnId = 0) {
  const last = {};
  const rows = db.prepare(`SELECT harvest_ref FROM harvest_grns WHERE harvest_ref LIKE 'HRC/%' AND id != ?`).all(exceptGrnId);
  for (const { harvest_ref: ref } of rows) {
    const m = /^HRC\/([^/]+)\/\d{4}\/(\d+)$/i.exec(ref.trim());
    if (!m) continue;
    const island = harvestIsland(m[1]);
    last[island] = Math.max(last[island] || 0, Number(m[2]));
  }
  return last;
}

function nextBoatNo() {
  return db.prepare(`SELECT COALESCE(MAX(boat_no), 0) n FROM shipments`).get().n + 1;
}

function nextHarvestRef(islandCode, year, except = {}) {
  const exceptShipmentId = except.shipmentId || 0;
  const exceptGrnId = except.grnId || 0;
  need(islandCode, 'Choose the island so the GRN ref no can be made');
  need(!islandCode.includes('/'), 'The island code cannot contain /');
  let n = (lastHarvestNumbers(exceptGrnId)[harvestIsland(islandCode)] || 0) + 1;
  while (refTaken(harvestRefFor(islandCode, year, n), exceptShipmentId, 0, exceptGrnId)) n++;
  return harvestRefFor(islandCode, year, n);
}

// A boat note number is the same shape as a harvest GRN number, with BN in front:
// BN/O-8/2026/003. Each island keeps its own count, and it carries into the next year.
const boatRefFor = (code, year, n) => `BN/${harvestIsland(code)}/${year}/${String(n).padStart(3, '0')}`;

function lastBoatNumbers(exceptShipmentId = 0) {
  const last = {};
  const rows = db.prepare(`SELECT enquiry_ref FROM shipments WHERE enquiry_ref LIKE 'BN/%' AND id != ?`).all(exceptShipmentId);
  for (const { enquiry_ref: ref } of rows) {
    const m = /^BN\/([^/]+)\/\d{4}\/(\d+)$/i.exec(String(ref || '').trim());
    if (!m) continue;
    const island = harvestIsland(m[1]);
    last[island] = Math.max(last[island] || 0, Number(m[2]));
  }
  return last;
}

function nextBoatRef(islandCode, year, exceptShipmentId = 0) {
  need(islandCode, 'Choose the island so the BN ref no can be made');
  need(!islandCode.includes('/'), 'The island code cannot contain /');
  let n = (lastBoatNumbers(exceptShipmentId)[harvestIsland(islandCode)] || 0) + 1;
  while (refTaken(boatRefFor(islandCode, year, n), exceptShipmentId)) n++;
  return boatRefFor(islandCode, year, n);
}

function readEnquiryRef(body, islandCode, exceptShipmentId = 0) {
  if (body.enquiry_ref_auto === true) return nextBoatRef(islandCode, localDateStr().slice(0, 4), exceptShipmentId);
  return str(body.enquiry_ref, 'BN ref no', { min: 1, max: 40 });
}

route('GET', '/api/harvest-grns/next', ({ query, user }) => {
  needOperations(user);
  return { year: localDateStr().slice(0, 4), last: lastHarvestNumbers(Number(query.get('except')) || 0) };
});

route('GET', '/api/price-enquiries/next', ({ query, user }) => {
  needOperations(user);
  return { year: localDateStr().slice(0, 4), last: lastBoatNumbers(Number(query.get('except')) || 0) };
});

// What waits on this user: harvest GRNs they can verify, and their own that
// were sent back for correcting.
route('GET', '/api/harvest-grns/waiting', ({ user }) => {
  if (!['operations', 'operations_hod', 'admin'].includes(user.role)) return { verify: 0, correct: 0 };
  const { verify } = db.prepare(
    `SELECT COUNT(*) verify FROM harvest_grns WHERE verify_state = 'waiting'
       AND (? OR (COALESCE(harvest_by, 0) != ? AND COALESCE(harvest_fixed_by, 0) != ?))`
  ).get(user.role === 'admin' ? 1 : 0, user.id, user.id);
  const { correct } = db.prepare(
    `SELECT COUNT(*) correct FROM harvest_grns WHERE verify_state = 'sent_back'
       AND (harvest_by = ? OR harvest_fixed_by = ?)`
  ).get(user.id, user.id);
  return { verify, correct };
});

// The harvest GRN form, checked. A correction sends the same form, with the ids
// of the crops and grades it keeps.
function readHarvestGrn(body) {
  const farmerName = str(body.farmer_name, 'Farmer name', { max: 80 });
  const form = {
    farmerName,
    farmerCode: str(body.farmer_code, 'Farmer ID', { max: 40, optional: true }),
    farmerPhone: phoneNo(body.farmer_phone, 'Phone no'),
    farmerContract: str(body.farmer_contract, 'Farmer contract no', { max: 40, optional: true }),
    farmerIsland: str(body.farmer_island, 'Island', { max: 80 }),
    islandCode: str(body.island_code, 'Island code', { max: 20, optional: true }),
    coordName: str(body.coord_name, 'Receiver at harvesting point', { max: 80 }),
    coordDate: dateStr(body.coord_date, 'Receiver date', { optional: true }) || '',
    farmerSigned: str(body.farmer_signed_name, 'Farmer name on the signature', { max: 80, optional: true }) || farmerName,
    farmerSignedDate: dateStr(body.farmer_signed_date, 'Farmer date', { optional: true }) || '',
    year: localDateStr().slice(0, 4),
  };
  const t0 = localDateStr();
  need(Array.isArray(body.lines) && body.lines.length > 0, 'Add at least one crop');
  need(body.lines.length <= 20, 'A harvest GRN can hold 20 crops');
  form.lines = body.lines.map((raw, i) => {
    const n = i + 1;
    const productId = intIn(raw.product_id, `Crop on line ${n}`, 1, 1e9);
    const product = getProduct(productId);
    need(product.active, `${product.name} was removed from Items — restore it before receiving it`);
    const description = str(raw.description, `Crop name on line ${n}`, { max: 120, optional: true }) || product.name;
    const harvestKg = qty3(raw.harvest_kg, `Total harvest on line ${n}`);
    const damagedKg = qtyZeroOk(raw.damaged_kg, `Damaged amount on line ${n}`);
    need(damagedKg <= harvestKg + 1e-6, `Damaged amount on line ${n} cannot be more than the harvest`);
    const undamaged = round3(harvestKg - damagedKg);
    const harvestedAt = dateStr(raw.harvested_at, `Harvested date on line ${n}`);
    need(harvestedAt <= t0, `Harvested date on line ${n} cannot be in the future`);
    return {
      id: raw.id == null ? null : intIn(raw.id, `Crop on line ${n}`, 1, 1e12),
      productId, description, harvestKg, damagedKg, undamaged, harvestedAt,
      bunches: wholeOrZero(raw.bunches, `Bunches on line ${n}`),
      hands: wholeOrZero(raw.hands, `Hands on line ${n}`),
      grades: harvestGrades(raw, n, undamaged),
    };
  });
  form.harvestedAt = form.lines.map(l => l.harvestedAt).sort()[0];
  return form;
}

// Writes a GRN's crops and grades. Ones sent with an id are updated in place so
// the landing prices saved against their grades stay. A grade that is removed,
// or now sits under another crop or grade name, loses its landing price.
function writeHarvestLines(shipmentId, lines, oldLines = [], harvestGrnId = null) {
  const oldLineIds = new Set(oldLines.map(l => l.id));
  const oldGrades = new Map(oldLines.flatMap(l => l.grades.map(g => [g.id, { ...g, product_id: l.product_id }])));
  const keptLines = new Set();
  const keptGrades = new Set();
  for (const l of lines) {
    if (l.id != null) {
      need(oldLineIds.has(l.id) && !keptLines.has(l.id), 'A crop on this form is not on this harvest GRN. Open it again.');
      keptLines.add(l.id);
    }
    for (const g of l.grades) {
      if (g.id == null) continue;
      need(l.id != null && oldGrades.get(g.id)?.line_id === l.id && !keptGrades.has(g.id),
        'A grade on this form is not on that crop. Open the harvest GRN again.');
      keptGrades.add(g.id);
    }
  }
  const stale = [...oldGrades.keys()].filter(id => !keptGrades.has(id));
  for (const l of lines) {
    for (const g of l.grades) {
      const was = g.id == null ? null : oldGrades.get(g.id);
      if (was && (was.product_id !== l.productId || was.grade.toLowerCase() !== g.grade.toLowerCase())) stale.push(g.id);
    }
  }
  const delGrade = db.prepare(`DELETE FROM harvest_grades WHERE id = ?`);
  for (const id of oldGrades.keys()) if (!keptGrades.has(id)) delGrade.run(id);
  const delLine = db.prepare(`DELETE FROM harvest_lines WHERE id = ?`);
  for (const id of oldLineIds) if (!keptLines.has(id)) delLine.run(id);
  const delCost = db.prepare(`DELETE FROM landing_costs WHERE shipment_id = ? AND line_key = ?`);
  for (const id of stale) delCost.run(shipmentId, `g:${id}`);

  const insLine = db.prepare(
    `INSERT INTO harvest_lines (
       shipment_id, harvest_grn_id, line_no, product_id, description, harvest_kg, damaged_kg, undamaged_kg,
       bunches, hands, harvested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updLine = db.prepare(
    `UPDATE harvest_lines SET line_no = ?, product_id = ?, description = ?, harvest_kg = ?, damaged_kg = ?,
       undamaged_kg = ?, bunches = ?, hands = ?, harvested_at = ?
     WHERE id = ?`
  );
  const insGrade = db.prepare(
    `INSERT INTO harvest_grades (line_id, grade_no, grade, kg, pack_count, per_bag_kg, remarks, unit_cost, bunches, pack_unit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updGrade = db.prepare(
    `UPDATE harvest_grades SET grade_no = ?, grade = ?, kg = ?, pack_count = ?, per_bag_kg = ?, remarks = ?, unit_cost = ?, bunches = ?, pack_unit = ?
     WHERE id = ?`
  );
  lines.forEach((l, i) => {
    const values = [l.productId, l.description, l.harvestKg, l.damagedKg, l.undamaged, l.bunches, l.hands, l.harvestedAt];
    let lineId = l.id;
    if (lineId == null) lineId = Number(insLine.run(shipmentId, harvestGrnId, i + 1, ...values).lastInsertRowid);
    else updLine.run(i + 1, ...values, lineId);
    l.grades.forEach((g, j) => {
      if (g.id == null) insGrade.run(lineId, j + 1, g.grade, g.kg, g.packCount, g.perBag, g.remarks, g.unitCost, g.bunches, g.packUnit);
      else updGrade.run(j + 1, g.grade, g.kg, g.packCount, g.perBag, g.remarks, g.unitCost, g.bunches, g.packUnit, g.id);
    });
  });
}

// The workflow starts here: produce has been received from the farmer.
// It is not sellable inventory until the boat arrives and the item receipt is written.
// A GRN ref no left as the form made it is numbered here, as it is saved.
route('POST', '/api/harvest-grns', ({ body, user }) => {
  needOperations(user);
  const autoRef = body.harvest_ref_auto === true;
  let harvestRef = autoRef ? '' : str(body.harvest_ref, 'GRN ref no', { min: 1, max: 40 });
  const f = readHarvestGrn(body);
  if (autoRef) harvestRef = nextHarvestRef(f.islandCode, f.year);
  if (refTaken(harvestRef)) throw new AppError(400, 'A record with that GRN ref no already exists');
  let id;
  try {
    id = tx(() => {
      const grnId = Number(db.prepare(
        `INSERT INTO harvest_grns (
           shipment_id, harvest_ref, farmer_name, farmer_code, farmer_phone, farmer_contract, farmer_island,
           island_code, coord_name, coord_date, farmer_signed_name, farmer_signed_date, verify_state, harvest_by)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`
      ).run(
        harvestRef, f.farmerName, f.farmerCode, f.farmerPhone, f.farmerContract, f.farmerIsland,
        f.islandCode, f.coordName, f.coordDate, f.farmerSigned, f.farmerSignedDate, user.id,
      ).lastInsertRowid);
      writeHarvestLines(null, f.lines, [], grnId);
      logAction(user, 'harvest-grn-created', 'harvest-grn', grnId,
        `Harvest GRN ${harvestRef} received ${f.lines.length} crop${f.lines.length === 1 ? '' : 's'} from ${f.farmerName}, ${f.farmerIsland}`);
      return grnId;
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new AppError(400, 'A record with that GRN ref no already exists');
    throw err;
  }
  return { id, grn_id: id, ref: harvestRef };
});

function harvestGrnById(id) {
  const g = db.prepare(
    `SELECT g.*, s.status AS boat_status
     FROM harvest_grns g LEFT JOIN shipments s ON s.id = g.shipment_id WHERE g.id = ?`
  ).get(id);
  if (!g) throw new AppError(404, 'Harvest GRN not found');
  return g;
}

function harvestLinesForGrn(grnId) {
  return harvestLinesByGrn(grnId);
}

// One GRN on the boat keeps the boat's farmer and verification columns in step,
// which the older screens still read. A shared boat keeps its own departure.
function mirrorHarvestOntoBoat(shipmentId) {
  const grns = db.prepare(`SELECT * FROM harvest_grns WHERE shipment_id = ? ORDER BY id`).all(shipmentId);
  if (grns.length !== 1) return;
  const g = grns[0];
  db.prepare(
    `UPDATE shipments SET
       harvest_ref = ?, farmer_name = ?, farmer_code = ?, farmer_phone = ?, farmer_contract = ?,
       farmer_island = ?, coord_name = ?, coord_date = ?, farmer_signed_name = ?, farmer_signed_date = ?,
       regional_name = ?, regional_date = ?, verify_state = ?, sent_back_note = ?, sent_back_name = ?,
       sent_back_at = ?, harvest_by = ?, harvest_fixed_by = ?, verified_by = ?
     WHERE id = ?`
  ).run(
    g.harvest_ref, g.farmer_name, g.farmer_code, g.farmer_phone, g.farmer_contract,
    g.farmer_island, g.coord_name, g.coord_date, g.farmer_signed_name, g.farmer_signed_date,
    g.regional_name, g.regional_date, g.verify_state, g.sent_back_note, g.sent_back_name,
    g.sent_back_at, g.harvest_by, g.harvest_fixed_by, g.verified_by, shipmentId,
  );
}

// Anyone in Operations can check a harvest GRN, except whoever filled it in or
// last corrected it. Admin can check any.
function needHarvestChecker(user, s) {
  needOperations(user);
  if (user.role !== 'admin' && (s.harvest_by === user.id || s.harvest_fixed_by === user.id)) {
    throw new AppError(403, 'Someone else in Operations verifies a harvest GRN you filled in or corrected');
  }
  if (s.verify_state === 'verified') throw new AppError(400, 'This harvest GRN is already verified');
  if (s.verify_state === 'sent_back') throw new AppError(400, 'This harvest GRN was sent back and is waiting to be corrected');
}

function labelBoat(shipmentId) {
  const grns = db.prepare(
    `SELECT harvest_ref, farmer_name, farmer_island FROM harvest_grns WHERE shipment_id = ? ORDER BY id`
  ).all(shipmentId);
  if (grns.length === 1) {
    mirrorHarvestOntoBoat(shipmentId);
    return;
  }
  if (!grns.length) return;
  db.prepare(
    `UPDATE shipments SET harvest_ref = ?, farmer_name = ?, farmer_island = ? WHERE id = ?`
  ).run(
    grns.map(g => g.harvest_ref).join(', ').slice(0, 200),
    grns.map(g => g.farmer_name).filter(Boolean).join(' · ').slice(0, 80),
    [...new Set(grns.map(g => g.farmer_island).filter(Boolean))].join(', ').slice(0, 80),
    shipmentId,
  );
}

// An open enquiry keeps one line per crop. Grades and harvest GRNs are summed.
// A line typed by hand, with no grade, stays as it is. An approved enquiry is left alone.
function syncEnquiryFromGrades(shipmentId) {
  const ship = db.prepare(`SELECT status FROM shipments WHERE id = ?`).get(shipmentId);
  if (!ship || ship.status !== 'enquiry') return;
  const grades = db.prepare(
    `SELECT hg.id, hg.kg, hg.pack_count, hg.bunches, hg.pack_unit,
            COALESCE(NULLIF(pr.name, ''), NULLIF(hl.description, ''), 'Crop') AS product,
            COALESCE(g.farmer_name, '') AS farmer_name
     FROM harvest_grades hg
     JOIN harvest_lines hl ON hl.id = hg.line_id
     LEFT JOIN harvest_grns g ON g.id = hl.harvest_grn_id
     LEFT JOIN products pr ON pr.id = hl.product_id
     WHERE hl.shipment_id = ? AND hg.kg > 0
     ORDER BY hl.line_no, hg.grade_no, g.id`
  ).all(shipmentId);
  const crops = new Map();
  for (const g of grades) {
    const name = String(g.product || 'Crop').trim() || 'Crop';
    const key = name.toLowerCase();
    if (!crops.has(key)) crops.set(key, { name, farmers: new Set(), gradeIds: [], kg: 0, bunch: 0, box: 0, sack: 0, basket: 0 });
    const row = crops.get(key);
    if (g.farmer_name) row.farmers.add(g.farmer_name);
    row.gradeIds.push(g.id);
    row.kg = round3(row.kg + Number(g.kg));
    const quote = gradeQuote(g);
    if (quote.unit === 'bunch' || quote.unit === 'box' || quote.unit === 'sack' || quote.unit === 'basket') {
      row[quote.unit] += Number(quote.qty) || 0;
    }
  }
  const existing = db.prepare(
    `SELECT id, description, qty, unit, rate, harvest_grade_id FROM enquiry_lines WHERE shipment_id = ? ORDER BY line_no, id`
  ).all(shipmentId);
  const hands = existing.filter(l => !l.harvest_grade_id).map(l => l.id);
  db.prepare(`DELETE FROM enquiry_lines WHERE shipment_id = ? AND harvest_grade_id IS NOT NULL`).run(shipmentId);
  const ins = db.prepare(
    `INSERT INTO enquiry_lines (shipment_id, line_no, description, qty, unit, rate, line_total, harvest_grade_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const inserted = [];
  let n = 0;
  for (const crop of crops.values()) {
    const linked = existing.filter(l => l.harvest_grade_id && crop.gradeIds.includes(l.harvest_grade_id));
    const counts = { bunch: crop.bunch, box: crop.box, sack: crop.sack, basket: crop.basket, kg: crop.kg };
    const used = ['bunch', 'box', 'sack', 'basket'].filter(unit => counts[unit] > 0);
    const fallback = used.length === 1 ? used[0] : 'kg';
    const sameUnit = linked.length > 0 && linked.every(l => l.unit === linked[0].unit);
    const unit = sameUnit && counts[linked[0].unit] > 0 ? linked[0].unit : fallback;
    const sameRate = linked.length > 0 && linked.every(l => l.rate === linked[0].rate);
    const rate = sameRate ? linked[0].rate : (linked.find(l => l.rate)?.rate || 0);
    const farmer = crop.farmers.size === 1 ? [...crop.farmers][0] : '';
    const desc = `${farmer ? `${farmer} · ` : ''}${crop.name}`.slice(0, 160);
    const qty = counts[unit] || crop.kg;
    n += 1;
    inserted.push(Number(ins.run(shipmentId, n, desc, qty, unit, rate, Math.round(qty * rate), crop.gradeIds[0]).lastInsertRowid));
  }
  const renumber = db.prepare(`UPDATE enquiry_lines SET line_no = ? WHERE id = ?`);
  [...inserted, ...hands].forEach((id, i) => renumber.run(i + 1, id));
}

function boatIsOpen(status) {
  return status === 'harvested' || status === 'enquiry';
}

function dropEmptyBoat(sourceId, targetId) {
  const lots = db.prepare(`SELECT COUNT(*) n FROM lots WHERE shipment_id = ?`).get(sourceId).n;
  if (lots) throw new AppError(400, 'This boat already has stock, so its last harvest GRN stays on it');
  const notes = db.prepare(`SELECT COUNT(*) n FROM shipment_lines WHERE shipment_id = ?`).get(sourceId).n;
  if (notes) throw new AppError(400, 'This boat already has a boat note, so its last harvest GRN stays on it');
  const hire = db.prepare(`SELECT id FROM labor_hires WHERE shipment_id = ?`).get(sourceId);
  if (hire) {
    const other = db.prepare(`SELECT id FROM labor_hires WHERE shipment_id = ?`).get(targetId);
    if (other) throw new AppError(400, 'Both boats already have a labour hire, so this harvest GRN stays where it is');
    db.prepare(`UPDATE labor_hires SET shipment_id = ? WHERE id = ?`).run(targetId, hire.id);
    const total = db.prepare(`SELECT COALESCE(SUM(line_total), 0) t FROM labor_lines WHERE labor_id = ?`).get(hire.id).t;
    db.prepare(`UPDATE shipments SET labor_hire = ? WHERE id = ?`).run(total, targetId);
  }
  db.prepare(`DELETE FROM enquiry_lines WHERE shipment_id = ?`).run(sourceId);
  db.prepare(`DELETE FROM landing_costs WHERE shipment_id = ?`).run(sourceId);
  db.prepare(`DELETE FROM landing_charges WHERE shipment_id = ?`).run(sourceId);
  db.prepare(
    `DELETE FROM signatures WHERE doc IN ('price-enquiry', 'boat-note', 'item-receipt') AND doc_id = ?`
  ).run(sourceId);
  db.prepare(`DELETE FROM shipments WHERE id = ?`).run(sourceId);
}

route('POST', '/api/harvest-grns/:id/verify', ({ params, body, user }) => {
  const s = harvestGrnById(params.id);
  needHarvestChecker(user, s);
  tx(() => {
    const upd = db.prepare(
      `UPDATE harvest_grns SET verify_state = 'verified', verified_by = ?, regional_name = ?, regional_date = ?
       WHERE id = ? AND verify_state = 'waiting'`
    ).run(user.id, user.name, localDateStr(), s.id);
    if (upd.changes !== 1) throw new AppError(400, 'This harvest GRN is not waiting for verification');
    saveVerificationSignature('harvest-grn', s.id, 'regional', body.strokes, user);
    mirrorHarvestOntoBoat(s.shipment_id);
    logAction(user, 'harvest-grn-verified', 'shipment', s.shipment_id, `Verified harvest GRN ${s.harvest_ref}`);
  });
  return { id: s.id };
});

route('POST', '/api/harvest-grns/:id/send-back', ({ params, body, user }) => {
  const s = harvestGrnById(params.id);
  needHarvestChecker(user, s);
  const note = str(body.note, 'What needs correcting', { min: 2, max: 200 });
  tx(() => {
    const upd = db.prepare(
      `UPDATE harvest_grns SET verify_state = 'sent_back', sent_back_note = ?, sent_back_name = ?, sent_back_at = ?
       WHERE id = ? AND verify_state = 'waiting'`
    ).run(note, user.name, localDateStr(), s.id);
    if (upd.changes !== 1) throw new AppError(400, 'This harvest GRN is not waiting for verification');
    mirrorHarvestOntoBoat(s.shipment_id);
    logAction(user, 'harvest-grn-sent-back', 'shipment', s.shipment_id, `Sent back harvest GRN ${s.harvest_ref}: ${note}`);
  });
  return { id: s.id };
});

// A GRN that was sent back is corrected on the same form, then waits for
// verification again. The steps after it keep their own copies of the details,
// so only what still mirrors the GRN follows the correction.
route('POST', '/api/harvest-grns/:id/correct', ({ params, body, user }) => {
  needOperations(user);
  const s = harvestGrnById(params.id);
  need(s.verify_state === 'sent_back', 'Only a harvest GRN that was sent back can be corrected');
  const autoRef = body.harvest_ref_auto === true;
  let harvestRef = autoRef ? '' : str(body.harvest_ref, 'GRN ref no', { min: 1, max: 40 });
  const f = readHarvestGrn(body);
  if (autoRef) harvestRef = nextHarvestRef(f.islandCode, f.year, { shipmentId: s.shipment_id, grnId: s.id });
  const refChanged = harvestRef !== s.harvest_ref;
  if (refChanged) {
    need(s.boat_status !== 'received', 'The GRN ref no stays as it is once the item receipt is posted');
    if (refTaken(harvestRef, s.shipment_id, 0, s.id)) throw new AppError(400, 'A record with that GRN ref no already exists');
  }
  const alone = db.prepare(`SELECT COUNT(*) n FROM harvest_grns WHERE shipment_id = ?`).get(s.shipment_id).n === 1;
  try {
    tx(() => {
      const upd = db.prepare(
        `UPDATE harvest_grns SET
           harvest_ref = ?, farmer_name = ?, farmer_code = ?, farmer_phone = ?, farmer_contract = ?,
           farmer_island = ?, island_code = ?, coord_name = ?, coord_date = ?,
           farmer_signed_name = ?, farmer_signed_date = ?,
           verify_state = 'waiting', harvest_fixed_by = ?, regional_name = '', regional_date = ''
         WHERE id = ? AND verify_state = 'sent_back'`
      ).run(
        harvestRef, f.farmerName, f.farmerCode, f.farmerPhone, f.farmerContract,
        f.farmerIsland, f.islandCode, f.coordName, f.coordDate, f.farmerSigned, f.farmerSignedDate,
        user.id, s.id,
      );
      if (upd.changes !== 1) throw new AppError(400, 'Only a harvest GRN that was sent back can be corrected');
      if (alone && s.shipment_id) {
        db.prepare(
          `UPDATE shipments SET
             reference = CASE WHEN reference = ? THEN ? ELSE reference END,
             supplier = CASE WHEN supplier = ? THEN ? ELSE supplier END,
             origin = CASE WHEN origin = ? THEN ? ELSE origin END,
             loaded_from = CASE WHEN status = 'harvested' THEN ? ELSE loaded_from END,
             island_code = CASE WHEN status = 'harvested' THEN ? ELSE island_code END,
             arrived_at = CASE WHEN status = 'harvested' THEN ? ELSE arrived_at END
           WHERE id = ?`
        ).run(
          s.harvest_ref, harvestRef, s.farmer_name, f.farmerName, s.farmer_island, f.farmerIsland,
          f.farmerIsland, f.islandCode, f.harvestedAt, s.shipment_id,
        );
      }
      writeHarvestLines(s.shipment_id || null, f.lines, harvestLinesForGrn(s.id), s.id);
      if (s.shipment_id) {
        syncEnquiryFromGrades(s.shipment_id);
        labelBoat(s.shipment_id);
      }
      logAction(user, 'harvest-grn-corrected', 'harvest-grn', s.id,
        `Corrected harvest GRN ${harvestRef}${refChanged ? ` (was ${s.harvest_ref})` : ''} and sent it for verification again`);
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new AppError(400, 'A record with that GRN ref no already exists');
    throw err;
  }
  return { id: s.shipment_id, grn_id: s.id, ref: harvestRef };
});

// A harvest GRN stays on its own boat until it is put on another open one.
// Open means the price enquiry is not approved yet.
route('POST', '/api/harvest-grns/:id/boat', ({ params, body, user }) => {
  throw new AppError(400, 'A harvest GRN goes on a boat when the boat note is written for its price enquiry');
  needOperations(user);
  const g = harvestGrnById(params.id);
  const source = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(g.shipment_id);
  if (!boatIsOpen(source.status)) {
    throw new AppError(400, 'A harvest GRN can change boats until the price enquiry is approved');
  }
  const makeNew = body.own === true || body.shipment_id === 0 || body.shipment_id === '0';
  let target = null;
  if (!makeNew) {
    target = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(intIn(body.shipment_id, 'Boat', 1, 1e12));
    if (!target) throw new AppError(404, 'Boat not found');
    if (target.id === source.id) throw new AppError(400, 'This harvest GRN is already on that boat');
    if (!boatIsOpen(target.status)) throw new AppError(400, 'That boat is already approved, so nothing more can be loaded on it');
  } else if (db.prepare(`SELECT COUNT(*) n FROM harvest_grns WHERE shipment_id = ?`).get(source.id).n < 2) {
    throw new AppError(400, 'This harvest GRN is already on its own boat');
  }
  let targetId;
  tx(() => {
    if (makeNew) {
      if (source.reference.toLowerCase() === g.harvest_ref.toLowerCase()) {
        const other = db.prepare(
          `SELECT id, harvest_ref FROM harvest_grns WHERE shipment_id = ? AND id != ? ORDER BY id LIMIT 1`
        ).get(source.id, g.id);
        if (refTaken(other.harvest_ref, source.id, 0, other.id)) {
          throw new AppError(400, 'The boat reference is already in use, so this harvest GRN stays where it is');
        }
        db.prepare(`UPDATE shipments SET reference = ? WHERE id = ?`).run(other.harvest_ref, source.id);
      }
      if (refTaken(g.harvest_ref, 0, 0, g.id)) {
        throw new AppError(400, 'That GRN ref no is already a boat reference, so it stays on this boat');
      }
      targetId = Number(db.prepare(
        `INSERT INTO shipments (
           reference, supplier, origin, arrived_at, notes, status,
           harvest_ref, farmer_name, farmer_island, loaded_from, island_code, boat_no)
         VALUES (?, ?, ?, ?, '', 'harvested', ?, ?, ?, ?, ?, ?)`
      ).run(
        g.harvest_ref, g.farmer_name, g.farmer_island, localDateStr(),
        g.harvest_ref, g.farmer_name, g.farmer_island, g.farmer_island, g.island_code, nextBoatNo(),
      ).lastInsertRowid);
    } else {
      targetId = target.id;
    }
    db.prepare(`UPDATE harvest_grns SET shipment_id = ? WHERE id = ?`).run(targetId, g.id);
    db.prepare(`UPDATE harvest_lines SET shipment_id = ? WHERE harvest_grn_id = ?`).run(targetId, g.id);
    const left = db.prepare(`SELECT COUNT(*) n FROM harvest_grns WHERE shipment_id = ?`).get(source.id).n;
    if (left === 0) dropEmptyBoat(source.id, targetId);
    else labelBoat(source.id);
    labelBoat(targetId);
    if (left > 0) syncEnquiryFromGrades(source.id);
    if (!makeNew && target.status === 'enquiry') syncEnquiryFromGrades(targetId);
    logAction(user, 'harvest-grn-moved', 'shipment', targetId,
      `Harvest GRN ${g.harvest_ref} is now on boat ${targetId}`);
  });
  return { shipment_id: targetId };
});

function gradeOnGrn(gradeId) {
  return db.prepare(
    `SELECT g.id, g.shipment_id
     FROM harvest_grades hg
     JOIN harvest_lines hl ON hl.id = hg.line_id
     JOIN harvest_grns g ON g.id = hl.harvest_grn_id
     WHERE hg.id = ?`
  ).get(gradeId);
}

function attachGrns(shipmentId, grnIds) {
  const current = db.prepare(`SELECT id FROM harvest_grns WHERE shipment_id = ?`).all(shipmentId).map(r => r.id);
  for (const id of current) {
    if (grnIds.includes(id)) continue;
    db.prepare(`UPDATE harvest_grns SET shipment_id = NULL WHERE id = ?`).run(id);
    db.prepare(`UPDATE harvest_lines SET shipment_id = NULL WHERE harvest_grn_id = ?`).run(id);
  }
  for (const id of grnIds) {
    const row = db.prepare(`SELECT id, shipment_id FROM harvest_grns WHERE id = ?`).get(id);
    if (!row) throw new AppError(400, 'That harvest GRN is not on file');
    if (row.shipment_id && row.shipment_id !== shipmentId) {
      throw new AppError(400, 'That harvest GRN is already on another price enquiry');
    }
    db.prepare(`UPDATE harvest_grns SET shipment_id = ? WHERE id = ?`).run(shipmentId, id);
    db.prepare(`UPDATE harvest_lines SET shipment_id = ? WHERE harvest_grn_id = ?`).run(shipmentId, id);
  }
  labelBoat(shipmentId);
}

function readEnquiryLines(body, shipmentId, grnIds) {
  need(Array.isArray(body.lines) && body.lines.length > 0, 'Add at least one line');
  need(body.lines.length <= 40, 'A price enquiry can hold 40 lines');
  const allowed = new Set(grnIds);
  return body.lines.map((raw, i) => {
    const n = i + 1;
    const description = str(raw.description, `Description on line ${n}`, { max: 160 });
    const qty = qty3(raw.qty, `Qty on line ${n}`);
    const unit = str(raw.unit, `Units on line ${n}`, { max: 40, optional: true });
    const rate = laariAmount(raw.rate, `Rate on line ${n}`);
    let gradeId = null;
    if (raw.harvest_grade_id) {
      gradeId = intIn(raw.harvest_grade_id, `Grade on line ${n}`, 1, 1e12);
      const grade = gradeOnGrn(gradeId);
      const onThis = grade && (grade.shipment_id === shipmentId || (allowed.has(grade.id) && !grade.shipment_id));
      if (!onThis) throw new AppError(400, `Line ${n} is not a grade on this enquiry`);
    }
    return { description, qty, unit, rate, total: Math.round(qty * rate), gradeId };
  });
}

function grnIdList(body) {
  need(Array.isArray(body.grn_ids) && body.grn_ids.length > 0, 'Choose at least one harvest GRN');
  const ids = [...new Set(body.grn_ids.map(id => intIn(id, 'Harvest GRN', 1, 1e12)))];
  need(ids.length > 0, 'Choose at least one harvest GRN');
  return ids;
}

route('GET', '/api/harvest-grns', () => {
  const rows = db.prepare(
    `SELECT g.id, g.shipment_id, g.harvest_ref, g.farmer_name, g.farmer_island, g.island_code,
            g.verify_state, g.sent_back_note, g.sent_back_name, g.sent_back_at,
            g.regional_name, g.regional_date, g.harvest_by, g.harvest_fixed_by, g.verified_by,
            s.status AS shipment_status, s.boat_no, s.enquiry_ref
     FROM harvest_grns g
     LEFT JOIN shipments s ON s.id = g.shipment_id
     ORDER BY g.id DESC`
  ).all();
  return rows.map(g => {
    const lines = harvestLinesByGrn(g.id);
    const crops = [];
    for (const l of lines) if (l.product && !crops.includes(l.product)) crops.push(l.product);
    return { ...g, crops, harvested_at: lines.find(l => l.harvested_at)?.harvested_at || '', lines };
  });
});

route('GET', '/api/harvest-grns/:id', ({ params }) => {
  const g = harvestGrnById(params.id);
  if (!g) throw new AppError(404, 'Harvest GRN not found');
  const lines = harvestLinesByGrn(g.id);
  return { grn: g, lines };
});

// A harvest GRN can be removed while it is on its own, or while its price
// enquiry is still open. Once that enquiry is approved, the GRN stays.
route('DELETE', '/api/harvest-grns/:id', ({ params, user }) => {
  needOperations(user);
  const g = harvestGrnById(params.id);
  const ship = g.shipment_id
    ? db.prepare(`SELECT id, status, enquiry_ref FROM shipments WHERE id = ?`).get(g.shipment_id)
    : null;
  if (ship && ship.status !== 'enquiry') {
    throw new AppError(400, 'This harvest GRN stays once the price enquiry is approved');
  }
  const result = tx(() => {
    db.prepare(
      `DELETE FROM harvest_grades WHERE line_id IN (SELECT id FROM harvest_lines WHERE harvest_grn_id = ?)`
    ).run(g.id);
    db.prepare(`DELETE FROM harvest_lines WHERE harvest_grn_id = ?`).run(g.id);
    db.prepare(`DELETE FROM signatures WHERE doc = 'harvest-grn' AND doc_id = ?`).run(g.id);
    const gone = db.prepare(`DELETE FROM harvest_grns WHERE id = ?`).run(g.id);
    if (gone.changes !== 1) throw new AppError(404, 'Harvest GRN not found');
    let removedEnquiry = false;
    if (ship) {
      const left = db.prepare(`SELECT COUNT(*) n FROM harvest_grns WHERE shipment_id = ?`).get(ship.id).n;
      if (!left) {
        const lots = db.prepare(`SELECT COUNT(*) n FROM lots WHERE shipment_id = ?`).get(ship.id).n;
        const notes = db.prepare(`SELECT COUNT(*) n FROM shipment_lines WHERE shipment_id = ?`).get(ship.id).n;
        if (lots || notes) throw new AppError(400, 'This harvest GRN stays. The price enquiry already has a boat note.');
        db.prepare(`DELETE FROM enquiry_lines WHERE shipment_id = ?`).run(ship.id);
        db.prepare(`DELETE FROM landing_costs WHERE shipment_id = ?`).run(ship.id);
        db.prepare(`DELETE FROM landing_charges WHERE shipment_id = ?`).run(ship.id);
        db.prepare(`UPDATE labor_hires SET shipment_id = NULL WHERE shipment_id = ?`).run(ship.id);
        db.prepare(`UPDATE shipments SET labor_hire = 0 WHERE id = ?`).run(ship.id);
        db.prepare(`DELETE FROM signatures WHERE doc = 'price-enquiry' AND doc_id = ?`).run(ship.id);
        db.prepare(`DELETE FROM shipments WHERE id = ?`).run(ship.id);
        removedEnquiry = true;
      } else {
        labelBoat(ship.id);
        syncEnquiryFromGrades(ship.id);
      }
    }
    logAction(user, 'harvest-grn-removed', 'harvest-grn', g.id, `Removed harvest GRN ${g.harvest_ref}`);
    return { removed_enquiry: removedEnquiry };
  });
  return { ok: true, ref: g.harvest_ref, ...result };
});

function boatFields(body) {
  return {
    name: str(body.name, 'Boat name', { max: 80 }),
    phone: phoneNo(body.phone, 'Contact', { optional: true }),
    kind: str(body.kind, 'Type', { max: 40, optional: true }),
    operator: str(body.operator, 'Operator', { max: 80, optional: true }),
  };
}

function boatTaken(name, kind, exceptId = 0) {
  const row = db.prepare(
    `SELECT id FROM boats WHERE name = ? COLLATE NOCASE AND kind = ? COLLATE NOCASE AND id != ?`
  ).get(name, kind, exceptId);
  if (row) throw new AppError(400, 'That boat is already on the list');
}

route('GET', '/api/boats', ({ user }) => {
  needOperations(user);
  return db.prepare(
    `SELECT id, name, phone, kind, operator FROM boats WHERE active = 1 ORDER BY name COLLATE NOCASE, kind COLLATE NOCASE`
  ).all();
});

route('POST', '/api/boats', ({ body, user }) => {
  needBoatEditor(user);
  const b = boatFields(body);
  boatTaken(b.name, b.kind);
  const id = Number(db.prepare(
    `INSERT INTO boats (name, phone, kind, operator, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`
  ).run(b.name, b.phone, b.kind, b.operator, new Date().toISOString()).lastInsertRowid);
  logAction(user, 'boat-added', 'boat', id, `Added boat ${b.name}`);
  return { id, ...b };
});

route('PATCH', '/api/boats/:id', ({ params, body, user }) => {
  needBoatEditor(user);
  const existing = db.prepare(`SELECT id FROM boats WHERE id = ?`).get(params.id);
  if (!existing) throw new AppError(404, 'Boat not found');
  const b = boatFields(body);
  boatTaken(b.name, b.kind, params.id);
  db.prepare(`UPDATE boats SET name = ?, phone = ?, kind = ?, operator = ? WHERE id = ?`)
    .run(b.name, b.phone, b.kind, b.operator, params.id);
  logAction(user, 'boat-updated', 'boat', params.id, `Updated boat ${b.name}`);
  return { id: params.id, ...b };
});

route('DELETE', '/api/boats/:id', ({ params, user }) => {
  needBoatEditor(user);
  const existing = db.prepare(`SELECT id, name FROM boats WHERE id = ?`).get(params.id);
  if (!existing) throw new AppError(404, 'Boat not found');
  db.prepare(`DELETE FROM boats WHERE id = ?`).run(params.id);
  logAction(user, 'boat-removed', 'boat', params.id, `Removed boat ${existing.name}`);
  return { ok: true };
});

route('POST', '/api/price-enquiries', ({ body, user }) => {
  needOperations(user);
  const loadedFrom = str(body.loaded_from, 'Loaded from', { max: 80 });
  const destination = str(body.destination, 'Destination', { max: 80 });
  const islandCode = str(body.island_code, 'Island code', { max: 20, optional: true });
  const enquiryRef = readEnquiryRef(body, islandCode);
  const vesselName = str(body.vessel_name, 'Vessel name', { max: 80 });
  const vesselPhone = phoneNo(body.vessel_phone, 'Vessel contact', { optional: true });
  const vesselDate = dateStr(body.vessel_date, 'Vessel date', { optional: true }) || '';
  const grnIds = grnIdList(body);
  for (const id of grnIds) {
    const row = db.prepare(`SELECT id, shipment_id FROM harvest_grns WHERE id = ?`).get(id);
    if (!row) throw new AppError(400, 'That harvest GRN is not on file');
    if (row.shipment_id) throw new AppError(400, 'That harvest GRN is already on a price enquiry');
  }
  const lines = readEnquiryLines(body, 0, grnIds);
  if (refTaken(enquiryRef)) throw new AppError(400, 'A record with that BN ref no already exists');
  const id = tx(() => {
    const shipmentId = Number(db.prepare(
      `INSERT INTO shipments (
         reference, supplier, origin, arrived_at, notes, status, enquiry_ref,
         vessel_name, vessel_phone, vessel_date, loaded_from, destination, island_code)
       VALUES (?, '', '', ?, '', 'enquiry', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      enquiryRef, localDateStr(), enquiryRef,
      vesselName, vesselPhone, vesselDate, loadedFrom, destination, islandCode,
    ).lastInsertRowid);
    attachGrns(shipmentId, grnIds);
    const ins = db.prepare(
      `INSERT INTO enquiry_lines (shipment_id, line_no, description, qty, unit, rate, line_total, harvest_grade_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    lines.forEach((l, i) => ins.run(shipmentId, i + 1, l.description, l.qty, l.unit, l.rate, l.total, l.gradeId));
    const total = lines.reduce((sum, l) => sum + l.total, 0);
    logAction(user, 'price-enquiry-created', 'shipment', shipmentId,
      `Boat price enquiry ${enquiryRef} from ${loadedFrom} to ${destination}, ${mvrText(total)}`);
    return shipmentId;
  });
  return { id, ref: enquiryRef };
});

route('POST', '/api/shipments/:id/price-enquiry', ({ params, body, user }) => {
  needOperations(user);
  const shipment = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(params.id);
  if (!shipment) throw new AppError(404, 'Shipment not found');
  if (shipment.status !== 'harvested' && shipment.status !== 'enquiry') {
    throw new AppError(400, 'A price enquiry can be written until it is approved');
  }
  const loadedFrom = str(body.loaded_from, 'Loaded from', { max: 80 });
  const destination = str(body.destination, 'Destination', { max: 80 });
  const islandCode = str(body.island_code, 'Island code', { max: 20, optional: true });
  const enquiryRef = readEnquiryRef(body, islandCode, shipment.id);
  const vesselName = str(body.vessel_name, 'Vessel name', { max: 80 });
  const vesselPhone = phoneNo(body.vessel_phone, 'Vessel contact', { optional: true });
  const vesselDate = dateStr(body.vessel_date, 'Vessel date', { optional: true }) || '';
  const grnIds = Array.isArray(body.grn_ids)
    ? grnIdList(body)
    : db.prepare(`SELECT id FROM harvest_grns WHERE shipment_id = ?`).all(shipment.id).map(r => r.id);
  const lines = readEnquiryLines(body, shipment.id, grnIds);
  if (refTaken(enquiryRef, shipment.id)) throw new AppError(400, 'A record with that BN ref no already exists');
  tx(() => {
    const upd = db.prepare(
      `UPDATE shipments SET status = 'enquiry', enquiry_ref = ?, vessel_name = ?, vessel_phone = ?, vessel_date = ?,
         loaded_from = ?, destination = ?, island_code = ?, enquiry_rejected = 0, enquiry_note = ''
       WHERE id = ? AND status IN ('harvested', 'enquiry')`
    ).run(enquiryRef, vesselName, vesselPhone, vesselDate, loadedFrom, destination, islandCode, shipment.id);
    if (upd.changes !== 1) throw new AppError(400, 'A price enquiry can be written until it is approved');
    if (Array.isArray(body.grn_ids)) attachGrns(shipment.id, grnIds);
    db.prepare(`DELETE FROM enquiry_lines WHERE shipment_id = ?`).run(shipment.id);
    const ins = db.prepare(
      `INSERT INTO enquiry_lines (shipment_id, line_no, description, qty, unit, rate, line_total, harvest_grade_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    lines.forEach((l, i) => ins.run(shipment.id, i + 1, l.description, l.qty, l.unit, l.rate, l.total, l.gradeId));
    const total = lines.reduce((sum, l) => sum + l.total, 0);
    logAction(user, 'price-enquiry-created', 'shipment', shipment.id,
      `Boat price enquiry ${enquiryRef} from ${loadedFrom} to ${destination}, ${mvrText(total)}`);
  });
  return { id: shipment.id, ref: enquiryRef };
});

function readLaborHire(body, exceptHireId = 0) {
  const reference = str(body.reference, 'Reference', { min: 1, max: 40 });
  const hiredOn = dateStr(body.hired_on, 'Date');
  const note = str(body.note, 'Why', { max: 200, optional: true });
  const person = (prefix, label, { role = false, required = false } = {}) => ({
    name: str(body[`${prefix}_name`], `${label} name`, { max: 80, optional: !required }),
    role: role ? str(body[`${prefix}_role`], `${label} role`, { max: 40, optional: true }) : '',
    date: dateStr(body[`${prefix}_date`], `${label} date`, { optional: true }) || '',
  });
  const asked = person('asked', 'Asked for the hire', { role: true });
  const approved = person('approved', 'Approved the hire', { role: true });
  const worked = person('worked', 'Did the work');
  const checked = person('checked', 'Checked the work', { role: true });
  const paid = person('paid', 'Took the payment');
  need(Array.isArray(body.lines) && body.lines.length > 0, 'Add at least one line');
  need(body.lines.length <= 12, 'A labour hire form can hold 12 lines');
  const lines = body.lines.map((raw, i) => {
    const n = i + 1;
    const description = str(raw.description, `What was hired on line ${n}`, { max: 160 });
    const qty = qty3(raw.qty, `Qty on line ${n}`);
    const rate = laariAmount(raw.rate, `Rate on line ${n}`);
    return { description, qty, rate, total: Math.round(qty * rate) };
  });
  const shipment = shipmentByNumber(body.link_ref);
  if (refTaken(reference, shipment?.id || 0, exceptHireId)) {
    throw new AppError(400, 'A record with that reference already exists');
  }
  if (shipment) {
    const other = db.prepare(
      `SELECT reference FROM labor_hires WHERE shipment_id = ? AND id != ?`
    ).get(shipment.id, exceptHireId);
    if (other) throw new AppError(400, `That shipment is already on labour hire ${other.reference}`);
  }
  return {
    reference, hiredOn, note, asked, approved, worked, checked, paid, lines, shipment,
    total: lines.reduce((sum, l) => sum + l.total, 0),
  };
}

function writeLaborHire(hireId, form, user) {
  const previous = hireId ? db.prepare(`SELECT * FROM labor_hires WHERE id = ?`).get(hireId) : null;
  for (const prefix of ['asked', 'approved', 'checked']) {
    form[prefix] = previous
      ? { name: previous[prefix + '_name'], role: previous[prefix + '_role'], date: previous[prefix + '_date'] }
      : { name: '', role: '', date: '' };
  }
  if (!previous) form.asked = { name: user.name, role: receiptRole(user), date: localDateStr() };
  const shipment = form.shipment;
  const boatRef = shipment?.enquiry_ref || '';
  const linkRef = shipment?.reference || '';
  return tx(() => {
    let id = hireId;
    if (!id) {
      id = Number(db.prepare(
        `INSERT INTO labor_hires (
           shipment_id, reference, link_ref, hired_on, boat_ref, note,
           asked_name, asked_role, asked_date,
           approved_name, approved_role, approved_date,
           worked_name, worked_date,
           checked_name, checked_role, checked_date,
           paid_name, paid_date
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        shipment?.id || null, form.reference, linkRef, form.hiredOn, boatRef, form.note,
        form.asked.name, form.asked.role, form.asked.date,
        form.approved.name, form.approved.role, form.approved.date,
        form.worked.name, form.worked.date,
        form.checked.name, form.checked.role, form.checked.date,
        form.paid.name, form.paid.date,
      ).lastInsertRowid);
    } else {
      const upd = db.prepare(
        `UPDATE labor_hires SET
           shipment_id = ?, reference = ?, link_ref = ?, hired_on = ?, boat_ref = ?, note = ?,
           asked_name = ?, asked_role = ?, asked_date = ?,
           approved_name = ?, approved_role = ?, approved_date = ?,
           worked_name = ?, worked_date = ?,
           checked_name = ?, checked_role = ?, checked_date = ?,
           paid_name = ?, paid_date = ?
         WHERE id = ?`
      ).run(
        shipment?.id || null, form.reference, linkRef, form.hiredOn, boatRef, form.note,
        form.asked.name, form.asked.role, form.asked.date,
        form.approved.name, form.approved.role, form.approved.date,
        form.worked.name, form.worked.date,
        form.checked.name, form.checked.role, form.checked.date,
        form.paid.name, form.paid.date,
        id,
      );
      if (upd.changes !== 1) throw new AppError(404, 'Labour hire not found');
    }
    db.prepare(`DELETE FROM labor_lines WHERE labor_id = ?`).run(id);
    const ins = db.prepare(
      `INSERT INTO labor_lines (labor_id, line_no, description, qty, rate, line_total) VALUES (?, ?, ?, ?, ?, ?)`
    );
    form.lines.forEach((l, i) => ins.run(id, i + 1, l.description, l.qty, l.rate, l.total));
    if (previous?.shipment_id && previous.shipment_id !== shipment?.id) {
      db.prepare(`UPDATE shipments SET labor_hire = 0 WHERE id = ?`).run(previous.shipment_id);
    }
    if (shipment) db.prepare(`UPDATE shipments SET labor_hire = ? WHERE id = ?`).run(form.total, shipment.id);
    logAction(user, 'labor-hire-saved', 'labor-hire', id,
      `Labour hire ${form.reference}${linkRef ? ` for ${linkRef}` : ''}, ${mvrText(form.total)}`);
    return id;
  });
}

for (const action of ['approve', 'check']) {
  route('POST', '/api/labor-hires/:id/' + action, ({ params, user }) => {
    if (action === 'approve') needApprove(user);
    else needOperations(user);
    return tx(() => {
      const prefix = action === 'approve' ? 'approved' : 'checked';
      const result = db.prepare(
        `UPDATE labor_hires SET ${prefix}_name = ?, ${prefix}_role = ?, ${prefix}_date = ?
         WHERE id = ? AND ${prefix}_name = '' ${action === 'check' ? "AND approved_name <> ''" : ''}`
      ).run(user.name, receiptRole(user), localDateStr(), params.id);
      need(result.changes === 1, 'This labour hire is not waiting for this step');
      logAction(user, 'labor-hire-' + action, 'labor-hire', params.id, action === 'approve' ? 'Approved labour hire' : 'Checked labour hire');
      return { ok: true };
    });
  });
}

route('GET', '/api/labor-hires', () => {
  const hires = db.prepare(
    `SELECT h.*, s.status AS shipment_status, s.enquiry_ref AS shipment_bn
     FROM labor_hires h LEFT JOIN shipments s ON s.id = h.shipment_id
     ORDER BY h.hired_on DESC, h.id DESC`
  ).all();
  return hires.map(h => {
    const lines = laborLinesFor(h.id);
    return {
      ...h,
      lines,
      total: lines.reduce((sum, l) => sum + l.line_total, 0),
      work: lines[0]?.description || '',
    };
  });
});

route('POST', '/api/labor-hires', ({ body, user }) => {
  needOperations(user);
  const form = readLaborHire(body);
  const id = writeLaborHire(0, form, user);
  return { id, total: form.total };
});

route('POST', '/api/labor-hires/:id', ({ params, body, user }) => {
  needAdmin(user);
  const existing = db.prepare(`SELECT id FROM labor_hires WHERE id = ?`).get(params.id);
  if (!existing) throw new AppError(404, 'Labour hire not found');
  const form = readLaborHire(body, existing.id);
  const id = writeLaborHire(existing.id, form, user);
  return { id, total: form.total };
});

route('DELETE', '/api/labor-hires/:id', ({ params, user }) => {
  needAdmin(user);
  const hire = db.prepare(`SELECT * FROM labor_hires WHERE id = ?`).get(params.id);
  if (!hire) throw new AppError(404, 'Labour hire not found');
  tx(() => {
    db.prepare(`DELETE FROM labor_lines WHERE labor_id = ?`).run(hire.id);
    db.prepare(`DELETE FROM signatures WHERE doc = 'labor-hire' AND doc_id = ?`).run(hire.id);
    const gone = db.prepare(`DELETE FROM labor_hires WHERE id = ?`).run(hire.id);
    if (gone.changes !== 1) throw new AppError(404, 'Labour hire not found');
    if (hire.shipment_id) db.prepare(`UPDATE shipments SET labor_hire = 0 WHERE id = ?`).run(hire.shipment_id);
    logAction(user, 'labor-hire-removed', 'labor-hire', hire.id, `Removed labour hire ${hire.reference}`);
  });
  return { ok: true };
});

route('POST', '/api/shipments/:id/reject-enquiry', ({ params, body, user }) => {
  needApprove(user);
  const reason = str(body.reason, 'Rejection reason', { max: 200 });
  return tx(() => {
    const result = db.prepare(
      `UPDATE shipments SET enquiry_rejected = 1, enquiry_note = ?
       WHERE id = ? AND status = 'enquiry' AND enquiry_rejected = 0`
    ).run(reason, params.id);
    need(result.changes === 1, 'This price enquiry is not waiting for approval');
    logAction(user, 'price-enquiry-rejected', 'shipment', params.id, `Rejected price enquiry: ${reason}`);
    return { id: params.id };
  });
});

route('POST', '/api/shipments/:id/approve-enquiry', ({ params, body, user }) => {
  needApprove(user);
  const shipment = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(params.id);
  if (!shipment) throw new AppError(404, 'Shipment not found');
  if (shipment.status !== 'enquiry' || shipment.enquiry_rejected) throw new AppError(400, 'This price enquiry must be submitted for approval');
  const today = localDateStr();
  tx(() => {
    const upd = db.prepare(
      `UPDATE shipments SET status = 'approved', approved_by = ?, approved_name = ?, approved_at = ?, enquiry_note = ?
       WHERE id = ? AND status = 'enquiry'`
    ).run(user.id, user.name, today, '', shipment.id);
    if (upd.changes !== 1) throw new AppError(400, 'This price enquiry is not waiting for approval');
    saveVerificationSignature('price-enquiry', shipment.id, 'approved', body.strokes, user);
    logAction(user, 'price-enquiry-approved', 'shipment', shipment.id,
      `Approved boat price enquiry ${shipment.enquiry_ref}`);
  });
  return { id: shipment.id };
});

route('POST', '/api/shipments/:id/boat-note', ({ params, body, user }) => {
  needOperations(user);
  const shipment = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(params.id);
  if (!shipment) throw new AppError(404, 'Shipment not found');
  if (shipment.status !== 'approved') {
    throw new AppError(400, 'The boat price enquiry has to be approved before the boat note');
  }
  const boatName = str(body.boat_name, 'Boat name', { max: 80 });
  const boatPhone = phoneNo(body.boat_phone, 'Contact no', { optional: true });
  const islandCode = str(body.island_code, 'Island code', { max: 20, optional: true });
  const loadedFrom = str(body.loaded_from, 'Loaded from', { max: 80 });
  const destination = str(body.destination, 'Destination', { max: 80 });
  const loadedAt = dateStr(body.loaded_at, 'Loaded date');
  const t0 = localDateStr();
  need(loadedAt <= addDays(t0, 7), 'Loaded date cannot be more than a week ahead');
  const deliveredName = str(body.delivered_name, 'Delivered by', { max: 80 });
  const deliveredRole = str(body.delivered_role, 'Designation', { max: 80, optional: true });
  const deliveredPhone = phoneNo(body.delivered_phone, 'Contact no', { optional: true });
  const cargoName = str(body.cargo_name, 'Received by', { max: 80, optional: true });
  const cargoRole = str(body.cargo_role, 'Designation', { max: 80, optional: true });
  const cargoPhone = phoneNo(body.cargo_phone, 'Contact no', { optional: true });
  const lines = boatNoteLines(body);
  const boatNo = shipment.boat_no || nextBoatNo();
  tx(() => {
    const upd = db.prepare(
      `UPDATE shipments SET status = 'in_transit', arrived_at = ?, loaded_at = ?,
         boat_no = ?, boat_name = ?, boat_phone = ?, island_code = ?,
         loaded_from = ?, destination = ?,
         delivered_name = ?, delivered_role = ?, delivered_phone = ?,
         cargo_name = ?, cargo_role = ?, cargo_phone = ?
       WHERE id = ? AND status = 'approved'`
    ).run(
      loadedAt, loadedAt, boatNo,
      boatName, boatPhone, islandCode,
      loadedFrom, destination,
      deliveredName, deliveredRole, deliveredPhone,
      cargoName, cargoRole, cargoPhone,
      shipment.id,
    );
    if (upd.changes !== 1) throw new AppError(400, 'The boat price enquiry has to be approved before the boat note');
    const insLine = db.prepare(
      `INSERT INTO shipment_lines (shipment_id, line_no, product_id, description, packing, qty, destination)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    lines.forEach((l, i) => insLine.run(
      shipment.id, i + 1, l.productId, l.description, l.packing, l.qty, l.dest,
    ));
    logAction(user, 'boat-note-created', 'shipment', shipment.id,
      `Boat note ${shipment.enquiry_ref} loaded at ${shipment.loaded_from} for ${shipment.destination} on ${loadedAt}`);
  });
  return { id: shipment.id };
});

route('POST', '/api/boat-notes', () => {
  throw new AppError(400, 'A shipment starts with a harvest GRN.');
});

// The rate paid for a crop on this shipment, weighted by the kilograms of each
// grade. Grades with no buying price yet leave the item's set cost in place.
function harvestBuyRate(shipmentId, productId) {
  const rows = db.prepare(
    `SELECT hg.kg, hg.unit_cost
     FROM harvest_grades hg JOIN harvest_lines hl ON hl.id = hg.line_id
     WHERE hl.shipment_id = ? AND hl.product_id = ? AND hg.kg > 0`
  ).all(shipmentId, productId);
  if (!rows.length || rows.every(r => !(r.unit_cost > 0))) return null;
  const kg = rows.reduce((sum, r) => sum + r.kg, 0);
  if (!(kg > 0)) return null;
  return Math.round(rows.reduce((sum, r) => sum + r.kg * r.unit_cost, 0) / kg);
}

const receiptRole = user => ({
  operations: 'Operations', operations_hod: 'Operations HOD', admin: 'Admin',
})[user.role];

route('POST', '/api/shipments/:id/grn', ({ params, body, user }) => {
  needOperations(user);
  const shipment = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(params.id);
  if (!shipment) throw new AppError(404, 'Shipment not found');
  if (shipment.status !== 'in_transit') throw new AppError(400, 'This boat note is already received');
  const arrived = dateStr(body.arrived_at, 'Arrival date');
  const t0 = localDateStr();
  need(arrived <= t0, "The arrival date can't be in the future");
  need(!shipment.loaded_at || arrived >= shipment.loaded_at, 'Arrival cannot be before the loaded date');
  const bin = str(body.bin_location, 'Bin', { max: 40, optional: true });
  const vendor = str(body.vendor, 'Vendor', { max: 300, optional: true });
  const memo = str(body.memo, 'Memo', { max: 200, optional: true });
  need(Array.isArray(body.lines) && body.lines.length > 0, 'Enter the amount that arrived');
  const noteLines = db.prepare(`SELECT * FROM shipment_lines WHERE shipment_id = ?`).all(shipment.id);
  const byId = new Map(noteLines.map(l => [l.id, l]));
  const posted = [];
  const seen = new Set();
  for (const raw of body.lines) {
    const lineId = intIn(raw.id, 'Line', 1, 1e12);
    need(!seen.has(lineId), 'A line was sent twice');
    seen.add(lineId);
    const line = byId.get(lineId);
    need(line, 'That line is not on this boat note');
    need(line.product_id, 'A reference line does not enter inventory');
    posted.push({ line, qty: qty3(raw.qty, 'Amount into inventory') });
  }
  const receiptNo = `GRN-${String(shipment.id).padStart(8, '0')}`;
  tx(() => {
    const upd = db.prepare(
      `UPDATE shipments SET status = 'received', arrived_at = ?, grn_ref = ?,
         receipt_vendor = ?, receipt_memo = ?,
         prepared_name = ?, prepared_role = ?, receipt_prepared_by = ?,
         checked_name = '', checked_role = '', verified_name = '', verified_role = '',
         receipt_checked_by = NULL, receipt_verified_by = NULL
       WHERE id = ? AND status = 'in_transit'`
    ).run(
      arrived, receiptNo, vendor, memo,
      user.name, receiptRole(user), user.id,
      shipment.id,
    );
    if (upd.changes !== 1) throw new AppError(400, 'This boat note is already received');
    const setReceived = db.prepare(`UPDATE shipment_lines SET received_qty = ? WHERE id = ?`);
    for (const { line, qty } of posted) {
      const product = getProduct(line.product_id);
      need(product.active, `${product.name} was removed from Items — restore it before the item receipt`);
      setReceived.run(qty, line.id);
      const lotId = receiveLot({
        product_id: product.id,
        qty,
        unit_cost: harvestBuyRate(shipment.id, product.id) ?? product.cost,
        supplier: shipment.loaded_from || shipment.boat_name,
        received_at: arrived,
        expires_at: addDays(arrived, product.shelf_life_days),
        shipment_id: shipment.id,
        bin_location: bin,
        reference: receiptNo,
        boat_note: shipment.reference,
      });
      logAction(user, 'stock-received', 'lot', lotId,
        `Item receipt ${receiptNo} received ${qty} ${product.unit} ${product.name} from boat note ${shipment.reference} (lot #${lotId})`);
    }
    logAction(user, 'item-receipt-posted', 'shipment', shipment.id,
      `Item receipt ${receiptNo} posted for boat note ${shipment.reference}; ${posted.length} line${posted.length === 1 ? '' : 's'} into inventory`);
  });
  return { id: shipment.id, grn_ref: receiptNo };
});

route('POST', '/api/shipments/:id/grn/check', ({ params, user }) => {
  needOperations(user);
  const admin = user.role === 'admin';
  return tx(() => {
    const result = db.prepare(
      `UPDATE shipments SET receipt_checked_by = ?, checked_name = ?, checked_role = ?
       WHERE id = ? AND grn_ref <> '' AND receipt_prepared_by IS NOT NULL
         AND receipt_checked_by IS NULL AND (? OR receipt_prepared_by <> ?)`
    ).run(user.id, user.name, receiptRole(user), params.id, Number(admin), user.id);
    need(result.changes === 1, admin ? 'This receipt is not awaiting a check' : 'An unchecked receipt must be checked by someone other than its preparer');
    logAction(user, 'item-receipt-checked', 'shipment', params.id, 'Checked item receipt');
    return { ok: true };
  });
});

route('POST', '/api/shipments/:id/grn/verify', ({ params, body, user }) => {
  const admin = user.role === 'admin';
  if (!admin && user.role !== 'operations_hod') throw new AppError(403, 'Only an Operations HOD or Admin can verify an item receipt');
  return tx(() => {
    const result = db.prepare(
      `UPDATE shipments SET receipt_verified_by = ?, verified_name = ?, verified_role = ?
       WHERE id = ? AND grn_ref <> '' AND receipt_prepared_by IS NOT NULL
         AND receipt_checked_by IS NOT NULL AND receipt_verified_by IS NULL
         AND (? OR (receipt_prepared_by <> ? AND receipt_checked_by <> ?))`
    ).run(user.id, user.name, receiptRole(user), params.id, Number(admin), user.id, user.id);
    need(result.changes === 1, admin ? 'This receipt must be checked first and can only be verified once' : 'The receipt must be checked first and verified by an HOD who did not prepare or check it');
    saveVerificationSignature('item-receipt', params.id, 'verified', body.strokes, user);
    logAction(user, 'item-receipt-verified', 'shipment', params.id, 'Verified item receipt');
    return { ok: true };
  });
});

route('DELETE', '/api/shipments/:id', ({ params, user }) => {
  needAdmin(user);
  const removed = tx(() => {
    const result = removeShipment(params.id);
    const ref = result.grn_ref ? `${result.reference} (${result.grn_ref})` : result.reference;
    logAction(user, 'shipment-removed', 'shipment', params.id,
      `Removed shipment ${ref} and the stock it put into inventory`);
    return result;
  });
  for (const name of removed.slips) {
    try { unlinkSync(slipPath(name)); } catch { /* the file is already gone */ }
  }
  return {
    ok: true,
    reference: removed.reference,
    had_stock: removed.had_stock,
    orders_removed: removed.orders_removed,
    orders_changed: removed.orders_changed,
  };
});

// ---- signatures ----
// Whoever holds the device takes the signature, so anyone signed in can add
// one to an empty box. The log records who took it.


function verificationSlot(doc, slot) {
  return (doc === 'item-receipt' && slot === 'verified') || (doc === 'harvest-grn' && slot === 'regional')
    || (doc === 'price-enquiry' && slot === 'approved');
}

function saveVerificationSignature(doc, id, slot, raw, user) {
  const strokes = parseStrokes(raw);
  db.prepare('DELETE FROM signatures WHERE doc = ? AND doc_id = ? AND slot = ?').run(doc, id, slot);
  const result = db.prepare(
    `INSERT INTO signatures (doc, doc_id, slot, signer_name, strokes, signed_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(doc, id, slot, user.name, JSON.stringify(strokes), new Date().toISOString(), user.id);
  logAction(user, 'form-signed', 'signature', Number(result.lastInsertRowid), `Signed verification for ${doc} #${id}`);
}

route('POST', '/api/signatures', ({ body, user }) => {
  const doc = String(body.doc ?? '');
  const form = Object.hasOwn(SIGN_FORMS, doc) ? SIGN_FORMS[doc] : null;
  need(form, 'This form has no signature boxes');
  const slot = String(body.slot ?? '');
  if (verificationSlot(doc, slot)) throw new AppError(403, 'This signature is recorded during verification and is read-only');
  need(Object.hasOwn(form.slots, slot), 'That signature box is not on this form');
  const docId = Number(body.id);
  need(Number.isInteger(docId) && docId > 0, 'Form not found');
  const target = signTarget(doc, docId);
  const receipt = doc === 'item-receipt' ? db.prepare(
    `SELECT receipt_prepared_by, receipt_checked_by, receipt_verified_by,
            prepared_name, checked_name, verified_name FROM shipments WHERE id = ?`
  ).get(target.id) : null;
  const boundReceipt = receipt?.receipt_prepared_by != null;
  if (boundReceipt && receipt[`receipt_${slot}_by`] !== user.id) {
    throw new AppError(403, 'Only the person recorded for this step can sign this box');
  }
  const approval = doc === 'price-enquiry' && slot === 'approved'
    ? db.prepare('SELECT approved_by, approved_name FROM shipments WHERE id = ?').get(target.id) : null;
  if (approval && approval.approved_by !== user.id) {
    throw new AppError(403, 'Only the recorded approver can sign this approval');
  }
  const name = approval ? approval.approved_name
    : boundReceipt ? receipt[`${slot}_name`] : str(body.name, 'Name', { min: 2, max: 80 }).replace(/\s+/g, ' ');
  const strokes = parseStrokes(body.strokes);
  return tx(() => {
    const taken = db.prepare(
      `SELECT 1 FROM signatures WHERE doc = ? AND doc_id = ? AND slot = ?`
    ).get(doc, target.id, slot);
    need(!taken, 'Someone already signed this box. Open the form again to see it.');
    const r = db.prepare(
      `INSERT INTO signatures (doc, doc_id, slot, signer_name, strokes, signed_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(doc, target.id, slot, name, JSON.stringify(strokes), new Date().toISOString(), user.id);
    const id = Number(r.lastInsertRowid);
    logAction(user, 'form-signed', 'signature', id, `${name} signed ${form.name} ${target.ref} · ${form.slots[slot]}`);
    return { id };
  });
});

route('DELETE', '/api/signatures/:id', ({ params, user }) => {
  const sig = db.prepare(`SELECT * FROM signatures WHERE id = ?`).get(params.id);
  if (!sig) throw new AppError(404, 'This signature was already removed');
  if (verificationSlot(sig.doc, sig.slot)) throw new AppError(403, 'Verification signatures are read-only');
  if (user.role !== 'admin' && sig.user_id !== user.id) {
    throw new AppError(403, 'Only an admin or the person who took this signature can remove it');
  }
  const form = SIGN_FORMS[sig.doc];
  let ref = `#${sig.doc_id}`;
  try { ref = signTarget(sig.doc, sig.doc_id).ref; } catch { /* the form itself is gone */ }
  tx(() => {
    db.prepare(`DELETE FROM signatures WHERE id = ?`).run(sig.id);
    logAction(user, 'signature-removed', 'signature', sig.id,
      `Removed ${sig.signer_name}'s signature from ${form?.name ?? sig.doc} ${ref} · ${form?.slots[sig.slot] ?? sig.slot}`);
  });
  return { ok: true };
});

// ---- customers ----

route('GET', '/api/customers', () => {
  const t0 = localDateStr();
  const customers = db.prepare(`SELECT * FROM customers WHERE active = 1 ORDER BY name`).all();
  const delivered = db.prepare(
    `SELECT o.customer_id cid, o.total, o.delivery_date, c.terms_days,
            (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.order_id = o.id) paid
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'delivered'`
  ).all();
  const bal = new Map(), overdue = new Map();
  for (const o of delivered) {
    const out = o.total - o.paid;
    if (out <= 0) continue;
    bal.set(o.cid, (bal.get(o.cid) ?? 0) + out);
    if (addDays(o.delivery_date, o.terms_days) < t0) overdue.set(o.cid, true);
  }
  const last = new Map();
  db.prepare(
    `SELECT customer_id cid, MAX(delivery_date) d FROM orders WHERE status != 'cancelled' GROUP BY customer_id`
  ).all().forEach(r => last.set(r.cid, r.d));
  const pending = new Map();
  db.prepare(
    `SELECT customer_id cid, SUM(total) t FROM orders WHERE status = 'pending' GROUP BY customer_id`
  ).all().forEach(r => pending.set(r.cid, r.t));
  return customers.map(c => ({
    ...c,
    balance: bal.get(c.id) ?? 0,
    pending_total: pending.get(c.id) ?? 0,
    overdue: overdue.get(c.id) ?? false,
    last_order: last.get(c.id) ?? null,
  }));
});

route('GET', '/api/customers/:id', ({ params }) => {
  const t0 = localDateStr();
  const c = getCustomer(params.id);
  const unpaid = db.prepare(
    `SELECT o.id, o.delivery_date, o.total,
            (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.order_id = o.id) paid
     FROM orders o WHERE o.customer_id = ? AND o.status = 'delivered'
     ORDER BY o.delivery_date`
  ).all(c.id)
    .map(o => ({
      ...o,
      outstanding: o.total - o.paid,
      due_date: addDays(o.delivery_date, c.terms_days),
      days_over: Math.max(daysBetween(addDays(o.delivery_date, c.terms_days), t0), 0),
    }))
    .filter(o => o.outstanding > 0);
  const recent = db.prepare(
    `SELECT id, delivery_date, status, total FROM orders
     WHERE customer_id = ? ORDER BY delivery_date DESC, id DESC LIMIT 10`
  ).all(c.id);
  const topProducts = db.prepare(
    `SELECT pr.name, pr.unit, ROUND(SUM(oi.qty), 1) qty, SUM(oi.line_total) revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products pr ON pr.id = oi.product_id
     WHERE o.customer_id = ? AND o.status != 'cancelled' AND o.delivery_date >= ?
     GROUP BY oi.product_id ORDER BY revenue DESC LIMIT 5`
  ).all(c.id, addDays(t0, -89));
  const stats30 = db.prepare(
    `SELECT COALESCE(SUM(total), 0) revenue, COUNT(*) orders FROM orders
     WHERE customer_id = ? AND status != 'cancelled' AND delivery_date BETWEEN ? AND ?`
  ).get(c.id, addDays(t0, -29), t0);
  const tasks = db.prepare(
    `SELECT id, title, due_date FROM tasks WHERE customer_id = ? AND done = 0 ORDER BY due_date`
  ).all(c.id);
  return {
    customer: { ...c, balance: customerBalance(c.id) },
    unpaid, recent, top_products: topProducts, stats30, tasks,
  };
});

function customerFields(body, { partial = false } = {}) {
  const f = {};
  const has = k => body[k] !== undefined;
  if (!partial || has('name')) f.name = str(body.name, 'Name', { min: 2, max: 80 });
  if (!partial || has('type')) {
    need(CUSTOMER_TYPES.includes(body.type), 'Customer type is not valid');
    f.type = body.type;
  }
  if (has('island')) f.island = str(body.island, 'Island', { max: 60, optional: true });
  if (has('contact')) f.contact = str(body.contact, 'Contact', { max: 80, optional: true });
  if (has('phone')) f.phone = phoneNo(body.phone, 'Phone', { optional: true });
  if (!partial || has('credit_limit')) f.credit_limit = intIn(body.credit_limit ?? 0, 'Credit limit', 0, 1e10);
  if (!partial || has('terms_days')) f.terms_days = intIn(body.terms_days ?? 14, 'Payment terms', 0, 90);
  if (has('notes')) f.notes = str(body.notes, 'Notes', { max: 500, optional: true });
  return f;
}

route('POST', '/api/customers', ({ body, user }) => {
  needSalesDesk(user);
  const f = customerFields(body);
  try {
    const ins = db.prepare(
      `INSERT INTO customers (name, type, island, contact, phone, credit_limit, terms_days, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(f.name, f.type, f.island ?? '', f.contact ?? '', f.phone ?? '', f.credit_limit, f.terms_days, f.notes ?? '');
    const id = Number(ins.lastInsertRowid);
    logAction(user, 'customer-created', 'customer', id, `Added customer ${f.name} (${f.type})`);
    return { id };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new AppError(400, 'A customer with that name already exists');
    throw e;
  }
});

route('PATCH', '/api/customers/:id', ({ params, body, user }) => {
  needSalesDesk(user);
  const c = getCustomer(params.id);
  const f = customerFields(body, { partial: true });
  if (body.active !== undefined) f.active = body.active ? 1 : 0;
  const keys = Object.keys(f);
  need(keys.length > 0, 'Nothing to update');
  try {
    db.prepare(`UPDATE customers SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => f[k]), c.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new AppError(400, 'A customer with that name already exists');
    throw e;
  }
  const changes = keys.map(k =>
    k === 'credit_limit' ? `credit limit ${mvrText(c.credit_limit)} → ${mvrText(f.credit_limit)}`
    : k === 'terms_days' ? `terms ${c.terms_days}d → ${f.terms_days}d`
    : k === 'name' ? `renamed to ${f.name}`
    : k === 'active' ? (f.active ? 'unarchived' : 'archived')
    : k).join(', ');
  logAction(user, 'customer-updated', 'customer', c.id, `Updated ${c.name}: ${changes}`);
  return { ok: true };
});

// ---- crops ----

route('GET', '/api/crops', () => db.prepare(
  `SELECT id, name, crop, variety FROM crops WHERE active = 1 ORDER BY sort_order, name COLLATE NOCASE`
).all());

function cropFields(body) {
  const crop = str(body.crop, 'Crop', { min: 2, max: 60 });
  const varietyIn = typeof body.variety === 'string' && body.variety.trim() === '' ? '' : body.variety;
  const variety = str(varietyIn, 'Variety', { max: 60, optional: true });
  const name = variety ? `${crop} - ${variety}` : crop;
  need(name.length <= 80, 'That crop name is too long');
  // A farmer's crops are saved as names joined with commas.
  need(!name.includes(','), 'Crop names cannot include a comma');
  return { name, crop, variety };
}

route('POST', '/api/crops', ({ body, user }) => {
  needOperations(user);
  const c = cropFields(body);
  try {
    const sort = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) n FROM crops`).get().n ?? 0) + 1;
    const id = Number(db.prepare(
      `INSERT INTO crops (name, crop, variety, sort_order, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`
    ).run(c.name, c.crop, c.variety, sort, new Date().toISOString()).lastInsertRowid);
    logAction(user, 'crop-created', 'crop', id, `Added crop ${c.name}`);
    return { id };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new AppError(400, 'That crop is already on the list');
    throw e;
  }
});

route('PATCH', '/api/crops/:id', ({ params, body, user }) => {
  needOperations(user);
  const row = db.prepare(`SELECT * FROM crops WHERE id = ? AND active = 1`).get(params.id);
  if (!row) throw new AppError(404, 'Crop not found');
  const c = cropFields(body);
  try {
    db.prepare(`UPDATE crops SET name = ?, crop = ?, variety = ? WHERE id = ?`)
      .run(c.name, c.crop, c.variety, row.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new AppError(400, 'That crop is already on the list');
    throw e;
  }
  logAction(user, 'crop-updated', 'crop', row.id, `Updated crop ${row.name} to ${c.name}`);
  return { ok: true };
});

// ---- farmers ----

route('GET', '/api/farmers', () => db.prepare(
  `SELECT id, contract_no, name, gender, id_card, island, phone, land_size, period, started_on, ends_on, crops, status
   FROM farmers WHERE active = 1 ORDER BY contract_no COLLATE NOCASE, name COLLATE NOCASE`
).all());

route('GET', '/api/farmers/:id', ({ params }) => {
  const farmer = db.prepare(`SELECT * FROM farmers WHERE id = ? AND active = 1`).get(params.id);
  if (!farmer) throw new AppError(404, 'Farmer not found');
  return farmer;
});

function farmerFields(body, { partial = false, was = {} } = {}) {
  const f = {};
  const has = k => body[k] !== undefined;
  if (!partial || has('name')) f.name = str(body.name, 'Name', { min: 2, max: 80 });
  if (!partial || has('contract_no')) f.contract_no = str(body.contract_no, 'Contract number', { max: 40 });
  if (has('gender')) {
    const gender = str(body.gender, 'Gender', { optional: true });
    need(gender === '' || gender === 'M' || gender === 'F', 'Gender must be male or female');
    f.gender = gender;
  }
  if (has('id_card')) f.id_card = str(body.id_card, 'ID card', { max: 20, optional: true });
  if (has('island')) f.island = str(body.island, 'Island', { max: 80, optional: true });
  if (has('land_size')) f.land_size = str(body.land_size, 'Land size', { max: 24, optional: true });
  if (has('phone')) f.phone = phoneNo(body.phone, 'Phone', { optional: true, kept: was.phone });
  if (has('period')) f.period = str(body.period, 'Contract period', { max: 20, optional: true });
  if (has('crops')) f.crops = str(body.crops, 'Crops', { max: 2000, optional: true });
  if (has('started_on')) f.started_on = dateStr(body.started_on, 'Starting date', { optional: true }) ?? '';
  if (has('ends_on')) f.ends_on = dateStr(body.ends_on, 'End date', { optional: true }) ?? '';
  if (has('status')) {
    need(body.status === 'active' || body.status === 'inactive', 'Status is not valid');
    f.status = body.status;
  }
  if (f.started_on && f.ends_on && f.ends_on < f.started_on) {
    throw new AppError(400, 'The end date is before the starting date');
  }
  return f;
}

route('POST', '/api/farmers', ({ body, user }) => {
  needOperations(user);
  const f = farmerFields(body);
  if (!f.status) f.status = 'active';
  try {
    const id = Number(db.prepare(
      `INSERT INTO farmers
         (contract_no, name, gender, id_card, island, phone, land_size, period, started_on, ends_on, crops, status, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(
      f.contract_no, f.name, f.gender ?? '', f.id_card ?? '', f.island ?? '', f.phone ?? '', f.land_size ?? '',
      f.period ?? '', f.started_on ?? '', f.ends_on ?? '', f.crops ?? '', f.status, new Date().toISOString(),
    ).lastInsertRowid);
    logAction(user, 'farmer-created', 'farmer', id, `Added farmer ${f.name} (${f.contract_no})`);
    return { id };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new AppError(400, 'A farmer with that contract number already exists');
    throw e;
  }
});

route('PATCH', '/api/farmers/:id', ({ params, body, user }) => {
  needOperations(user);
  const farmer = db.prepare(`SELECT * FROM farmers WHERE id = ? AND active = 1`).get(params.id);
  if (!farmer) throw new AppError(404, 'Farmer not found');
  const f = farmerFields(body, { partial: true, was: farmer });
  const started = f.started_on ?? farmer.started_on;
  const ends = f.ends_on ?? farmer.ends_on;
  if (started && ends && ends < started) throw new AppError(400, 'The end date is before the starting date');
  const keys = Object.keys(f);
  need(keys.length > 0, 'Nothing to update');
  try {
    db.prepare(`UPDATE farmers SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => f[k]), farmer.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new AppError(400, 'A farmer with that contract number already exists');
    throw e;
  }
  logAction(user, 'farmer-updated', 'farmer', farmer.id, `Updated ${farmer.name}: ${keys.join(', ')}`);
  return { ok: true };
});

// ---- orders ----

route('GET', '/api/orders', ({ query }) => {
  const t0 = localDateStr();
  // Filters must run in SQL, before LIMIT — otherwise the oldest unpaid and
  // overdue invoices (which sort last) silently fall out of the window.
  const UNPAID_SQL =
    `o.status = 'delivered' AND o.total > (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.order_id = o.id)`;
  const status = query.get('status');
  const where = [];
  const params = [];
  if (status === 'unpaid') {
    where.push(UNPAID_SQL);
  } else if (status === 'overdue') {
    where.push(UNPAID_SQL);
    where.push(`date(o.delivery_date, '+' || c.terms_days || ' days') < ?`);
    params.push(t0);
  } else if (['pending', 'delivered', 'paid', 'cancelled'].includes(status)) {
    where.push(`o.status = ?`);
    params.push(status);
  }
  const cid = Number(query.get('customer_id'));
  if (cid) {
    where.push(`o.customer_id = ?`);
    params.push(cid);
  }
  const channel = query.get('channel') || 'wholesale';
  need(channel === 'wholesale' || channel === 'pos', 'Channel is not valid');
  where.push(`o.channel = ?`);
  params.push(channel);
  return db.prepare(
    `SELECT o.*, c.name customer, c.terms_days,
            (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.order_id = o.id) paid,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) item_count,
            (SELECT pr.name FROM order_items oi JOIN products pr ON pr.id = oi.product_id
             WHERE oi.order_id = o.id ORDER BY oi.line_total DESC LIMIT 1) top_item,
            (SELECT p.method FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) pay_method,
            (SELECT p.slip FROM payments p WHERE p.order_id = o.id AND p.method = 'transfer' AND p.slip != ''
             ORDER BY p.id DESC LIMIT 1) slip_file
     FROM orders o JOIN customers c ON c.id = o.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.delivery_date DESC, o.id DESC LIMIT 500`
  ).all(...params).map(o => {
    const due = addDays(o.delivery_date, o.terms_days);
    const out = o.status === 'delivered' ? o.total - o.paid : 0;
    const { slip_file, ...rest } = o;
    return { ...rest, has_slip: Boolean(slip_file), outstanding: out, due_date: due, overdue: out > 0 && due < t0 };
  });
});

route('GET', '/api/orders/:id', ({ params }) => {
  const o = getOrder(params.id);
  const customer = getCustomer(o.customer_id);
  const items = db.prepare(
    `SELECT oi.*, pr.name product, pr.unit FROM order_items oi
     JOIN products pr ON pr.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id`
  ).all(o.id).map(it => ({
    ...it,
    lots: db.prepare(
      `SELECT a.qty, l.id lot_id, l.received_at, l.expires_at, l.supplier
       FROM allocations a JOIN lots l ON l.id = a.lot_id WHERE a.order_item_id = ? ORDER BY l.expires_at`
    ).all(it.id),
  }));
  const payments = db.prepare(`SELECT * FROM payments WHERE order_id = ? ORDER BY paid_at, id`).all(o.id)
    .map(({ slip, ...p }) => ({ ...p, has_slip: Boolean(slip) }));
  return { order: o, customer, items, payments, paid: paidTotal(o.id) };
});

route('POST', '/api/orders/:id/slip', ({ params, body, user }) => {
  needSalesDesk(user);
  const o = getOrder(params.id);
  const payment = transferPayment(o.id);
  need(payment, 'A transfer slip belongs on a transfer payment');
  need(typeof body.data === 'string' && body.data, 'Choose a slip to upload');
  let buf;
  try { buf = Buffer.from(body.data, 'base64'); }
  catch { throw new AppError(400, 'That slip could not be read'); }
  const kind = slipKind(buf);
  need(kind, 'Use a JPEG, PNG, WebP, or PDF');
  need(buf.length <= 6_000_000, 'Slip must be under 6 MB');
  mkdirSync(SLIPS_DIR, { recursive: true });
  const name = `${o.id}-${randomBytes(8).toString('hex')}.${kind}`;
  writeFileSync(slipPath(name), buf);
  const previous = payment.slip;
  tx(() => {
    db.prepare(`UPDATE payments SET slip = ? WHERE id = ?`).run(name, payment.id);
    logAction(user, 'slip-saved', 'order', o.id,
      `Saved transfer slip on ${o.channel === 'pos' ? 'sale' : 'order'} #${o.id}`);
  });
  if (previous && previous !== name) {
    try { unlinkSync(slipPath(previous)); } catch { /* the old file is already gone */ }
  }
  return { ok: true };
});

route('GET', '/api/orders/:id/slip', ({ params }) => {
  const o = getOrder(params.id);
  const payment = transferPayment(o.id);
  if (!payment?.slip) throw new AppError(404, 'No transfer slip on this sale');
  const kind = payment.slip.split('.').pop();
  const type = SLIP_MIME[kind];
  if (!type) throw new AppError(404, 'No transfer slip on this sale');
  let buf;
  try { buf = readFileSync(slipPath(payment.slip)); }
  catch { throw new AppError(404, 'Slip file is missing'); }
  return new FileResult(buf, type, `transfer-slip-${o.id}.${kind}`);
});

route('POST', '/api/orders', ({ body, user }) => {
  needSalesDesk(user);
  const t0 = localDateStr();
  const channel = body.channel === undefined || body.channel === '' ? 'wholesale' : body.channel;
  need(channel === 'wholesale' || channel === 'pos', 'Channel is not valid');
  let customer = null;
  if (channel !== 'pos') {
    customer = getCustomer(intIn(body.customer_id, 'Customer', 1, 1e9));
    need(customer.active, 'Customer is archived');
  }
  const delivery = dateStr(body.delivery_date, 'Delivery date', { optional: true }) ?? t0;
  need(delivery >= addDays(t0, -7) && delivery <= addDays(t0, 14),
    'Delivery date must be within a week back or two weeks ahead');
  const notes = str(body.notes, 'Notes', { max: 300, optional: true });
  let payMethod = null;
  if (channel === 'pos') {
    need(body.payment_method === 'cash' || body.payment_method === 'transfer', 'Choose cash or transfer');
    payMethod = body.payment_method;
  } else {
    need(body.payment_method == null || body.payment_method === '', 'Wholesale orders are not paid at the till');
  }
  need(Array.isArray(body.items) && body.items.length > 0, 'Add at least one line');
  need(body.items.length <= 40, 'Too many lines on one order');

  const items = body.items.map(raw => {
    const p = getProduct(intIn(raw.product_id, 'Product', 1, 1e9));
    need(p.active, `${p.name} was removed from Items`);
    const qty = qty3(raw.qty, `Quantity for ${p.name}`);
    const unit_price = raw.unit_price === undefined || raw.unit_price === null || raw.unit_price === ''
      ? p.price
      : intIn(raw.unit_price, `Price for ${p.name}`, 0, 1e9);
    return { product_id: p.id, qty, unit_price, name: p.name };
  });

  // Availability pre-check for a friendly message (createOrder re-checks atomically).
  const wantByProduct = new Map();
  for (const it of items) wantByProduct.set(it.product_id, (wantByProduct.get(it.product_id) ?? 0) + it.qty);
  for (const [pid, want] of wantByProduct) {
    const avail = availableQty(pid, delivery);
    if (avail + 1e-6 < want) {
      const name = items.find(i => i.product_id === pid).name;
      throw new AppError(400, `Not enough ${name} — ${round3(avail)} available for that delivery date`, {
        code: 'INSUFFICIENT_STOCK', product_id: pid, available: round3(avail),
      });
    }
  }

  const total = items.reduce((s, it) => s + Math.round(it.qty * it.unit_price), 0);
  // A counter sale is paid before it is saved, so it is not credit exposure.
  if (channel !== 'pos' && customer.credit_limit > 0 && body.override !== true) {
    // Exposure counts pending orders too — they are committed stock that will
    // become receivables on delivery, not zero risk.
    const balance = customerBalance(customer.id);
    const pending = customerPendingTotal(customer.id);
    if (balance + pending + total > customer.credit_limit) {
      throw new AppError(409, `${customer.name} would exceed their credit limit`, {
        code: 'CREDIT_LIMIT', balance, pending_total: pending, exposure: balance + pending,
        credit_limit: customer.credit_limit, order_total: total,
      });
    }
  }

  const id = tx(() => {
    if (!customer) customer = walkInCustomer(user);
    const orderId = createOrder({
      customer_id: customer.id,
      delivery_date: delivery,
      notes,
      channel,
      status: channel === 'pos' ? 'paid' : 'pending',
      created_at: new Date().toISOString(),
      items: items.map(({ product_id, qty, unit_price }) => ({ product_id, qty, unit_price })),
    });
    if (channel === 'pos' && total > 0) {
      db.prepare(`INSERT INTO payments (order_id, amount, method, paid_at) VALUES (?, ?, ?, ?)`)
        .run(orderId, total, payMethod, t0);
    }
    logAction(user, 'order-created', 'order', orderId,
      `${channel === 'pos' ? `Recorded POS sale (${payMethod})` : 'Created order'} #${orderId} — ${customer.name}, ${items.length} line${items.length === 1 ? '' : 's'}, ${mvrText(total)}${body.override === true ? ' (credit limit overridden)' : ''}`);
    return orderId;
  });
  return { id };
});

route('POST', '/api/orders/:id/deliver', ({ params, user }) => {
  needSalesDesk(user);
  const o = getOrder(params.id);
  need(o.status === 'pending', `Order is ${o.status}, not pending`);
  // A zero-total (or pre-paid) order has nothing outstanding — going through
  // 'delivered' would strand it there, since /pay rejects zero amounts.
  const next = o.total - paidTotal(o.id) <= 0 ? 'paid' : 'delivered';
  tx(() => {
    db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).run(next, o.id);
    logAction(user, 'order-delivered', 'order', o.id,
      `Delivered order #${o.id} — ${getCustomer(o.customer_id).name}, ${mvrText(o.total)}`);
  });
  return { ok: true };
});

route('POST', '/api/orders/:id/cancel', ({ params, user }) => {
  needSalesDesk(user);
  const o = getOrder(params.id);
  // A counter sale is paid as it is rung up. Cancelling it still puts the
  // goods back; the payment row stays so the till record keeps cash or transfer.
  const posPaid = o.channel === 'pos' && o.status === 'paid';
  need(o.status === 'pending' || posPaid, 'Only pending orders can be cancelled');
  tx(() => {
    returnOrderStock(o.id);
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).run(o.id);
    logAction(user, 'order-cancelled', 'order', o.id,
      `Cancelled order #${o.id} — ${getCustomer(o.customer_id).name}, ${mvrText(o.total)} (stock returned)`);
  });
  return { ok: true };
});

route('POST', '/api/orders/:id/pay', ({ params, body, user }) => {
  needSalesDesk(user);
  const o = getOrder(params.id);
  need(o.status === 'delivered', o.status === 'paid' ? 'Order is already fully paid' : 'Deliver the order before recording payment');
  const amount = intIn(body.amount, 'Amount', 1, 1e10);
  let method = 'transfer';
  if (body.method !== undefined && body.method !== null && body.method !== '') {
    need(PAY_METHODS.includes(body.method), 'Payment method is not valid');
    method = body.method;
  }
  const outstanding = o.total - paidTotal(o.id);
  need(amount <= outstanding, `Only ${outstanding} laari is outstanding on this order`, { outstanding });
  let paymentId;
  tx(() => {
    const ins = db.prepare(`INSERT INTO payments (order_id, amount, method, paid_at) VALUES (?, ?, ?, ?)`)
      .run(o.id, amount, method, localDateStr());
    paymentId = Number(ins.lastInsertRowid);
    if (amount >= outstanding) db.prepare(`UPDATE orders SET status = 'paid' WHERE id = ?`).run(o.id);
    logAction(user, 'payment-recorded', 'payment', paymentId,
      `Recorded ${mvrText(amount)} ${method} payment on order #${o.id} — ${getCustomer(o.customer_id).name}${amount >= outstanding ? ' (paid in full)' : ''}`);
  });
  return { ok: true, remaining: outstanding - amount, payment_id: paymentId };
});

// ---- undo actions ----

// Deliver was a misclick: flip back to pending. Stock stays allocated (deliver
// never touched it), so this is safe only while nothing has been paid.
route('POST', '/api/orders/:id/undeliver', ({ params, user }) => {
  needSalesDesk(user);
  const o = getOrder(params.id);
  need(o.status === 'delivered' || o.status === 'paid', `Order is ${o.status} — nothing to undo`);
  need(paidTotal(o.id) === 0, 'This order has recorded payments — void them first');
  tx(() => {
    db.prepare(`UPDATE orders SET status = 'pending' WHERE id = ?`).run(o.id);
    logAction(user, 'order-undelivered', 'order', o.id,
      `Undid delivery of order #${o.id} — ${getCustomer(o.customer_id).name} (back to pending)`);
  });
  return { ok: true };
});

// Remove a recorded payment (wrong amount, wrong order). If the order was
// fully paid it drops back to delivered.
route('POST', '/api/payments/:id/void', ({ params, user }) => {
  needSalesDesk(user);
  const p = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(params.id);
  if (!p) throw new AppError(404, 'Payment not found');
  const o = getOrder(p.order_id);
  need(o.status !== 'cancelled', 'Order is cancelled');
  const otherPaid = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM payments WHERE order_id = ? AND id != ?`
  ).get(o.id, p.id).t;
  // A counter sale is paid as it is rung up. Voiding that payment voids the
  // sale: the goods go back, and it is not an unpaid invoice.
  const voidSale = o.channel === 'pos' && otherPaid <= 0;
  tx(() => {
    db.prepare(`DELETE FROM payments WHERE id = ?`).run(p.id);
    if (voidSale) {
      returnOrderStock(o.id);
      db.prepare(`UPDATE orders SET status = 'cancelled', voided = 1 WHERE id = ?`).run(o.id);
      logAction(user, 'sale-voided', 'order', o.id,
        `Voided sale #${o.id} — ${getCustomer(o.customer_id).name}, ${mvrText(o.total)} (stock returned)`);
    } else {
      if (o.status === 'paid') db.prepare(`UPDATE orders SET status = 'delivered' WHERE id = ?`).run(o.id);
      logAction(user, 'payment-voided', 'payment', p.id,
        `Voided ${mvrText(p.amount)} payment on order #${o.id} — ${getCustomer(o.customer_id).name}`);
    }
  });
  if (p.slip) {
    try { unlinkSync(slipPath(p.slip)); } catch { /* the file is already gone */ }
  }
  return { ok: true, amount: p.amount };
});

// Cancel was a mistake: put the order back by re-drawing its stock
// first-expiry-first. Fails cleanly if the returned goods were resold.
// Restore re-runs the same guards as order creation — it increases committed
// exposure exactly like a new order does.
route('POST', '/api/orders/:id/restore', ({ params, body, user }) => {
  needSalesDesk(user);
  const t0 = localDateStr();
  const o = getOrder(params.id);
  need(o.status === 'cancelled', 'Only cancelled orders can be restored');
  need(o.delivery_date >= addDays(t0, -7),
    'This order is too old to restore — create a fresh order instead');
  const customer = getCustomer(o.customer_id);
  need(customer.active, `${customer.name} is archived — unarchive them before restoring`);
  const items = db.prepare(
    `SELECT oi.*, pr.name, pr.active FROM order_items oi JOIN products pr ON pr.id = oi.product_id
     WHERE oi.order_id = ? ORDER BY oi.id`
  ).all(o.id);
  for (const it of items) {
    need(it.active, `${it.name} was removed from Items — restore it first`);
  }
  const covered = paidTotal(o.id) >= o.total;
  const restorePaid = o.channel === 'pos' && covered;
  if (!restorePaid && customer.credit_limit > 0 && body.override !== true) {
    const balance = customerBalance(customer.id);
    const pending = customerPendingTotal(customer.id);
    if (balance + pending + o.total > customer.credit_limit) {
      throw new AppError(409, `${customer.name} would exceed their credit limit`, {
        code: 'CREDIT_LIMIT', balance, pending_total: pending, exposure: balance + pending,
        credit_limit: customer.credit_limit, order_total: o.total,
      });
    }
  }
  // Goods must be sellable when the re-delivery actually happens — a stale
  // past delivery date as cutoff would FEFO-prefer already-expired lots.
  const cutoff = o.delivery_date > t0 ? o.delivery_date : t0;
  tx(() => {
    const insAlloc = db.prepare(`INSERT INTO allocations (order_item_id, lot_id, qty) VALUES (?, ?, ?)`);
    for (const it of items) {
      let plan;
      try {
        plan = consumeStock(it.product_id, it.qty, cutoff);
      } catch (err) {
        if (err instanceof AppError && err.extra?.code === 'INSUFFICIENT_STOCK') {
          throw new AppError(400,
            `Can't restore — only ${err.extra.available} of ${it.qty} ${it.name} is still on the shelf`,
            err.extra);
        }
        throw err;
      }
      for (const a of plan) insAlloc.run(it.id, a.lot_id, a.qty);
    }
    const next = restorePaid ? 'paid' : 'pending';
    db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).run(next, o.id);
    logAction(user, 'order-restored', 'order', o.id,
      `Restored cancelled ${o.channel === 'pos' ? 'sale' : 'order'} #${o.id} — ${customer.name}, ${mvrText(o.total)}${body.override === true ? ' (credit limit overridden)' : ''}`);
  });
  return { ok: true };
});

// ---- settings (business identity for printed documents) ----

route('GET', '/api/settings', () => getSettings());

route('PATCH', '/api/settings', ({ body, user }) => {
  needAdmin(user);
  // key → [human label, max length, may be empty]
  const TEXT_FIELDS = {
    biz_name: ['Business name', 120, false],
    biz_address: ['Address', 300, true],
    biz_phone: ['Phone', 15, true],
    biz_email: ['Email', 80, true],
    biz_tin: ['GST TIN', 40, true],
    invoice_note: ['Invoice note', 300, true],
    invoice_terms: ['Invoice terms', 1200, true],
  };
  for (const key of Object.keys(body)) {
    need(key in TEXT_FIELDS || key === 'gst_rate', `Unknown setting: ${key}`);
  }
  const updates = [];
  for (const [key, [label, max, mayBeEmpty]] of Object.entries(TEXT_FIELDS)) {
    if (body[key] === undefined) continue;
    need(typeof body[key] === 'string', `${label} must be text`);
    const v = body[key].trim();
    need(v.length <= max, `${label} must be at most ${max} characters`);
    need(mayBeEmpty || v.length > 0, `${label} is required`);
    need(key !== 'biz_phone' || /^\d*$/.test(v), `${label} must be numbers only`);
    updates.push([key, v]);
  }
  if (body.gst_rate !== undefined) {
    // Only a number or a non-empty numeric string — Number() would quietly
    // coerce '', arrays, and booleans into a "valid" rate.
    need(typeof body.gst_rate === 'number'
      || (typeof body.gst_rate === 'string' && body.gst_rate.trim() !== ''),
      'GST rate must be a number');
    const r = Math.round(Number(body.gst_rate) * 100) / 100;
    need(Number.isFinite(r) && r >= 0 && r <= 100, 'GST rate must be between 0 and 100');
    updates.push(['gst_rate', String(r)]);
  }
  need(updates.length > 0, 'Nothing to update');
  const before = getSettings();
  tx(() => {
    for (const [k, v] of updates) setSetting(k, v);
    logAction(user, 'settings-updated', 'settings', null,
      `Updated business details (${updates.map(([k, v]) =>
        k === 'gst_rate' && before.gst_rate !== v ? `gst_rate ${before.gst_rate}% → ${v}%` : k).join(', ')})`);
  });
  return getSettings();
});

// ---- tasks ----

route('GET', '/api/tasks', ({ query }) => {
  const openOnly = query.get('open') !== '0';
  return db.prepare(
    `SELECT t.*, c.name customer FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id
     ${openOnly ? 'WHERE t.done = 0' : ''} ORDER BY t.done, t.due_date, t.id LIMIT 100`
  ).all();
});

route('POST', '/api/tasks', ({ body, user }) => {
  needSalesDesk(user);
  const title = str(body.title, 'Title', { min: 2, max: 140 });
  const due = dateStr(body.due_date, 'Due date', { optional: true }) ?? localDateStr();
  let customerId = null;
  if (body.customer_id) customerId = getCustomer(intIn(body.customer_id, 'Customer', 1, 1e9)).id;
  const ins = db.prepare(
    `INSERT INTO tasks (customer_id, title, due_date, done, created_at) VALUES (?, ?, ?, 0, ?)`
  ).run(customerId, title, due, new Date().toISOString());
  const id = Number(ins.lastInsertRowid);
  logAction(user, 'task-created', 'task', id, `Added follow-up: ${title}`);
  return { id };
});

route('PATCH', '/api/tasks/:id', ({ params, body, user }) => {
  needSalesDesk(user);
  const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(params.id);
  if (!t) throw new AppError(404, 'Task not found');
  const fields = {};
  if (body.done !== undefined) fields.done = body.done ? 1 : 0;
  if (body.due_date !== undefined) fields.due_date = dateStr(body.due_date, 'Due date');
  if (body.title !== undefined) fields.title = str(body.title, 'Title', { min: 2, max: 140 });
  const keys = Object.keys(fields);
  need(keys.length > 0, 'Nothing to update');
  tx(() => {
    db.prepare(`UPDATE tasks SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => fields[k]), t.id);
    if (fields.done === 1 && !t.done) {
      logAction(user, 'task-done', 'task', t.id, `Completed follow-up: ${t.title}`);
    } else {
      const changes = [];
      if (fields.title !== undefined && fields.title !== t.title) changes.push(`retitled to "${fields.title}"`);
      if (fields.due_date !== undefined && fields.due_date !== t.due_date) changes.push(`due ${t.due_date} → ${fields.due_date}`);
      if (fields.done === 0 && t.done) changes.push('reopened');
      if (changes.length) {
        logAction(user, 'task-updated', 'task', t.id, `Updated follow-up "${t.title}": ${changes.join(', ')}`);
      }
    }
  });
  return { ok: true };
});
