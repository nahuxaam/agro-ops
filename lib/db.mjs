// Database: schema, date/money helpers, and the business operations shared by
// the API and the demo seeder. Money is stored in laari (MVR × 100, integers);
// quantities are REAL rounded to 3 decimals.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BOAT_LIST } from './boat-list.mjs';
import { CROP_LIST, splitCropName } from './crop-list.mjs';
import { FARMER_LIST } from './farmer-list.mjs';
import { GOVAN_FARMERS } from './govan-farmers.mjs';
import { DATA_DIR, DB_PATH } from './paths.mjs';

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('fruit','vegetable','herb','other')),
  unit TEXT NOT NULL CHECK (unit IN ('kg','piece','bunch','crate','box')),
  shelf_life_days INTEGER NOT NULL CHECK (shelf_life_days BETWEEN 1 AND 365),
  cost INTEGER NOT NULL CHECK (cost >= 0),
  price INTEGER NOT NULL CHECK (price > 0),
  active INTEGER NOT NULL DEFAULT 1,
  pos_on INTEGER NOT NULL DEFAULT 1,
  code TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE COLLATE NOCASE,
  supplier TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  arrived_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT ''
);
-- supplier holds the farmer (or importer) name. The farmer_* columns are a
-- snapshot taken at receipt, so a renewed agreement never rewrites old rows.
-- origin_lot_id is set on lots split off by a transfer: it points at the lot
-- that was received, and the split lot is not a receipt of its own.
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  shipment_id INTEGER REFERENCES shipments(id),
  supplier TEXT NOT NULL DEFAULT '',
  qty_received REAL NOT NULL CHECK (qty_received > 0),
  qty_left REAL NOT NULL CHECK (qty_left >= 0),
  unit_cost INTEGER NOT NULL CHECK (unit_cost >= 0),
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  bin_location TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  boat_note TEXT NOT NULL DEFAULT '',
  farmer_id_card TEXT NOT NULL DEFAULT '',
  farmer_island TEXT NOT NULL DEFAULT '',
  farmer_agreement TEXT NOT NULL DEFAULT '',
  origin_lot_id INTEGER REFERENCES lots(id)
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('resort','guesthouse','restaurant','retail','other')),
  island TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  credit_limit INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  terms_days INTEGER NOT NULL DEFAULT 14 CHECK (terms_days BETWEEN 0 AND 90),
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  created_at TEXT NOT NULL,
  delivery_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','paid','cancelled')),
  total INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  line_total INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  qty REAL NOT NULL CHECK (qty > 0)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'transfer',
  paid_at TEXT NOT NULL
);
-- Every stock change that is not a receipt or a sale. qty is the signed change
-- to lot_id; a transfer moves stock into to_lot_id, which gains -qty.
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  type TEXT NOT NULL CHECK (type IN ('damage','weight_loss','stem_weight','adjust','transfer')),
  qty REAL NOT NULL CHECK (qty != 0),
  to_lot_id INTEGER REFERENCES lots(id),
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','sales','operations')),
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  summary TEXT NOT NULL,
  details TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity, at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_lots_product ON lots (product_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_shipments_arrived ON shipments (arrived_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_delivery ON orders (delivery_date);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_allocs_item ON allocations (order_item_id);
CREATE INDEX IF NOT EXISTS idx_allocs_lot ON allocations (lot_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_moves_lot ON stock_moves (lot_id);
CREATE INDEX IF NOT EXISTS idx_moves_at ON stock_moves (at);
CREATE TABLE IF NOT EXISTS bins (
  name TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS transfer_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  moved_on TEXT NOT NULL,
  from_bin TEXT NOT NULL DEFAULT '',
  to_bin TEXT NOT NULL DEFAULT '',
  class_name TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  move_id INTEGER UNIQUE REFERENCES stock_moves(id),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transfer_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES transfer_notes(id),
  line_no INTEGER NOT NULL,
  lot_id INTEGER,
  item_code TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  from_bin TEXT NOT NULL DEFAULT '',
  qoh REAL NOT NULL,
  qty REAL NOT NULL,
  to_bin TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks (done, due_date);
CREATE TABLE IF NOT EXISTS farmers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '',
  id_card TEXT NOT NULL DEFAULT '',
  island TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT '',
  started_on TEXT NOT NULL DEFAULT '',
  ends_on TEXT NOT NULL DEFAULT '',
  crops TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_farmers_name ON farmers (name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS crops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  crop TEXT NOT NULL,
  variety TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crops_order ON crops (active, sort_order, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  slot TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  strokes TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  UNIQUE (doc, doc_id, slot)
);
CREATE TABLE IF NOT EXISTS boats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_boats_name_kind ON boats (name COLLATE NOCASE, kind COLLATE NOCASE);
`);

// Business identity shown on printed invoices and delivery notes.
// An empty biz_tin means "not GST-registered" — no GST line is printed.
export const DEFAULT_SETTINGS = {
  biz_name: 'agro-OPS',
  biz_address: '',
  biz_phone: '',
  biz_email: '',
  biz_tin: '',
  gst_rate: '8',
  invoice_note: '',
  invoice_terms: '',
  // '1' while the seeded admin still has the default password — the login
  // screen shows the first-run hint until it's changed. Not editable via
  // PATCH /api/settings (unknown keys are rejected there).
  default_admin: '0',
};
{
  const ins = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
}

// The supply-boat directory is loaded once. Later edits in Boats stay as saved.
{
  const seeded = db.prepare(`SELECT value FROM settings WHERE key = 'boats_seeded'`).get();
  if (!seeded) {
    const ins = db.prepare(
      `INSERT INTO boats (name, phone, kind, operator, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`
    );
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const b of BOAT_LIST) ins.run(b.name, b.phone || '', b.kind || '', b.operator || '', now);
      db.prepare(`INSERT INTO settings (key, value) VALUES ('boats_seeded', '1')`).run();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// The buying-contract list is loaded once. Later edits in Farmers stay as saved.
{
  const seeded = db.prepare(`SELECT value FROM settings WHERE key = 'farmers_seeded'`).get();
  if (!seeded) {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO farmers
         (contract_no, name, gender, id_card, island, phone, period, started_on, ends_on, crops, status, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    );
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const f of FARMER_LIST) {
        ins.run(
          f.contract_no, f.name, f.gender || '', f.id_card || '', f.island || '', f.phone || '',
          f.period || '', f.started_on || '', f.ends_on || '', f.crops || '', f.status || 'active', now,
        );
      }
      db.prepare(`INSERT INTO settings (key, value) VALUES ('farmers_seeded', '1')`).run();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// Land size came in with the Govan contract list. Older rows stay blank.
{
  const cols = db.prepare(`PRAGMA table_info(farmers)`).all();
  if (!cols.some(c => c.name === 'land_size')) {
    db.exec(`ALTER TABLE farmers ADD COLUMN land_size TEXT NOT NULL DEFAULT ''`);
  }
}

// The Govan list is loaded once. A person already on a later contract keeps it.
// Phone, gender, and crops already saved are left as they are.
{
  const seeded = db.prepare(`SELECT value FROM settings WHERE key = 'govan_farmers_imported'`).get();
  if (!seeded) {
    const editDistance = (a, b) => {
      const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
      for (let j = 0; j <= b.length; j++) m[0][j] = j;
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          m[i][j] = a[i - 1] === b[j - 1]
            ? m[i - 1][j - 1]
            : 1 + Math.min(m[i - 1][j], m[i][j - 1], m[i - 1][j - 1]);
        }
      }
      return m[a.length][b.length];
    };
    const foldName = s => s.toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^a-z]+/g, ' ')
      .trim()
      .replace(/\bdh/g, 'd')
      .replace(/th/g, 't')
      .replace(/sh/g, 's')
      .replace(/aa/g, 'a')
      .replace(/ee/g, 'i')
      .replace(/oo/g, 'u')
      .replace(/q/g, 'g')
      .replace(/(.)\1+/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    const nameAliases = s => {
      const out = new Set();
      const add = t => { const f = foldName(t); if (f) out.add(f); };
      add(s);
      for (const m of s.matchAll(/\(([^)]*)\)/g)) add(m[1]);
      for (const part of s.split('/')) add(part);
      return [...out];
    };
    const tokensClose = (x, y) => {
      const xt = x.split(' ');
      const yt = y.split(' ');
      if (xt.length !== yt.length) return false;
      return xt.every((t, i) => {
        const d = editDistance(t, yt[i]);
        const n = Math.max(t.length, yt[i].length);
        return d === 0 || (d <= 2 && d / n <= 0.3);
      });
    };
    const samePerson = (a, b) => {
      for (const x of nameAliases(a)) {
        for (const y of nameAliases(b)) {
          if (x === y || x.replace(/ /g, '') === y.replace(/ /g, '')) return true;
          if (tokensClose(x, y)) return true;
          const longer = x.length >= y.length ? x : y;
          const shorter = x.length >= y.length ? y : x;
          const longTokens = longer.split(' ');
          const shortTokens = shorter.split(' ');
          if (shortTokens.length < longTokens.length
            && longTokens.slice(0, shortTokens.length).join(' ') === shorter
            && shorter.replace(/ /g, '').length >= 6) return true;
          const tokenSet = new Set(longTokens);
          if (shortTokens.length && shortTokens.every(t => t.length >= 5 && tokenSet.has(t))) return true;
        }
      }
      return false;
    };
    const laterContract = (incoming, current) => incoming.ends_on > (current.ends_on || '')
      || (incoming.ends_on === (current.ends_on || '') && incoming.started_on > (current.started_on || ''));
    const existing = db.prepare(
      `SELECT id, contract_no, name, id_card, started_on, ends_on FROM farmers`
    ).all();
    const byId = new Map();
    for (const f of existing) {
      const id = (f.id_card || '').toUpperCase();
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(f);
    }
    const matchOf = g => {
      if (g.id_card) {
        const hits = (byId.get(g.id_card.toUpperCase()) || []).filter(f => samePerson(f.name, g.name));
        if (!hits.length) return null;
        hits.sort((a, b) => editDistance(foldName(a.name), foldName(g.name)) - editDistance(foldName(b.name), foldName(g.name)));
        return hits[0];
      }
      return existing.find(f => !f.id_card && samePerson(f.name, g.name)) || null;
    };
    const taken = db.prepare(`SELECT id FROM farmers WHERE contract_no = ? COLLATE NOCASE`);
    const claim = (contract, selfId, idCard) => {
      const row = taken.get(contract);
      if (!row || row.id === selfId) return contract;
      const alt = `${contract} · ${idCard || '2'}`.slice(0, 40);
      const other = taken.get(alt);
      if (!other || other.id === selfId) return alt;
      throw new Error(`Contract number already used: ${contract}`);
    };
    const update = db.prepare(
      `UPDATE farmers
       SET contract_no = ?, island = ?, land_size = ?, period = ?, started_on = ?, ends_on = ?, status = ?
       WHERE id = ?`
    );
    const insert = db.prepare(
      `INSERT INTO farmers
         (contract_no, name, gender, id_card, island, phone, land_size, period, started_on, ends_on, crops, status, active, created_at)
       VALUES (?, ?, '', ?, ?, '', ?, ?, ?, ?, '', ?, 1, ?)`
    );
    const today = localDateStr();
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;
    db.exec('BEGIN');
    try {
      for (const g of GOVAN_FARMERS) {
        const status = g.ends_on && g.ends_on < today ? 'inactive' : 'active';
        const hit = matchOf(g);
        if (hit) {
          if (!laterContract(g, hit)) continue;
          update.run(
            claim(g.contract_no, hit.id, g.id_card),
            g.island || '', g.land_size || '', g.period || '', g.started_on || '', g.ends_on || '',
            status, hit.id,
          );
          updated++;
          continue;
        }
        insert.run(
          claim(g.contract_no, null, g.id_card),
          g.name, g.id_card || '', g.island || '', g.land_size || '', g.period || '',
          g.started_on || '', g.ends_on || '', status, now,
        );
        added++;
      }
      db.prepare(`INSERT INTO settings (key, value) VALUES ('govan_farmers_imported', '1')`).run();
      logAction(null, 'farmers-imported', 'farmer', null, `Govan list: ${added} added, ${updated} updated to a later contract`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// The variety list is loaded once. Later edits in the Crops tab stay as saved.
{
  const seeded = db.prepare(`SELECT value FROM settings WHERE key = 'crops_seeded'`).get();
  if (!seeded) {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO crops (name, crop, variety, sort_order, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`
    );
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      CROP_LIST.forEach((name, i) => {
        const { crop, variety } = splitCropName(name);
        ins.run(name, crop, variety, i + 1, now);
      });
      db.prepare(`INSERT INTO settings (key, value) VALUES ('crops_seeded', '1')`).run();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare(`SELECT key, value FROM settings`).all()) {
    if (r.key in out) out[r.key] = r.value;
  }
  return out;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// Plain-text MVR for audit summaries ("MVR 1,236" / "MVR 97.50").
export function mvrText(laari) {
  const v = laari / 100;
  const whole = Math.abs(v % 1) < 0.005;
  return 'MVR ' + v.toLocaleString('en-US', whole
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Every state change lands here, written by the API handler that made it.
// user_name is snapshotted so history stays readable if users are renamed.
export function logAction(user, action, entity, entityId, summary, details = null) {
  db.prepare(
    `INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, summary, details, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user?.id ?? null,
    user?.name ?? 'system',
    action, entity, entityId,
    summary,
    details ? JSON.stringify(details) : null,
    new Date().toISOString(),
  );
}

// Migration: users.role originally allowed only admin|sales. SQLite can't
// alter a CHECK, so rebuild the table when the constraint predates the
// operations role. Order matters: create the NEW table under a temp name,
// copy, drop the old, rename the new into place — renaming the OLD table
// instead would make every referencing FK (sessions) follow the rename.
{
  const ddl = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get()?.sql ?? '';
  if (ddl && !ddl.includes('operations_hod') && !ddl.includes("'operations'")) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin','sales','operations')),
          pass_salt TEXT NOT NULL,
          pass_hash TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        INSERT INTO users_new SELECT * FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

// Operations HOD approves a boat price enquiry before a boat note can be written.
{
  const ddl = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get()?.sql ?? '';
  if (ddl && !ddl.includes('operations_hod')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin','sales','operations','operations_hod')),
          pass_salt TEXT NOT NULL,
          pass_hash TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
        INSERT INTO users_new SELECT * FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

// Repair: an earlier version of the migration above renamed the old table,
// which dragged the sessions FK along to "users_old". Rebuild sessions if it
// points at the dead name (sessions are disposable — users sign in again).
{
  const sessDdl = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`).get()?.sql ?? '';
  if (sessDdl.includes('users_old')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN');
    try {
      db.exec(`
        DROP TABLE sessions;
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
      `);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

// Lots gained a shipment after the first schema. CREATE TABLE IF NOT EXISTS
// will not add the column to a book that already exists.
{
  const cols = db.prepare(`PRAGMA table_info(lots)`).all();
  if (!cols.some(c => c.name === 'shipment_id')) {
    db.exec(`ALTER TABLE lots ADD COLUMN shipment_id INTEGER REFERENCES shipments(id)`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lots_shipment ON lots (shipment_id)`);
}

// Older receipts only stored a supplier and a date. Group those into one
// shipment per supplier per day so the Shipments tab can show them.
{
  const groups = db.prepare(
    `SELECT supplier, received_at FROM lots
     WHERE shipment_id IS NULL GROUP BY supplier, received_at`
  ).all();
  if (groups.length) {
    const find = db.prepare(`SELECT id FROM shipments WHERE reference = ? COLLATE NOCASE`);
    const ins = db.prepare(
      `INSERT INTO shipments (reference, supplier, origin, arrived_at, notes) VALUES (?, ?, '', ?, '')`
    );
    const upd = db.prepare(
      `UPDATE lots SET shipment_id = ?
       WHERE shipment_id IS NULL AND supplier = ? AND received_at = ?`
    );
    db.exec('BEGIN');
    try {
      for (const g of groups) {
        const supplier = g.supplier || '';
        const reference = supplier ? `${supplier} · ${g.received_at}` : `Arrival · ${g.received_at}`;
        let id = find.get(reference)?.id;
        if (!id) id = Number(ins.run(reference, supplier, g.received_at).lastInsertRowid);
        upd.run(id, supplier, g.received_at);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// The stock register gave products an item code and lots their receipt
// paperwork (farmer, bin, boat note, reference).
{
  const addColumn = (table, column, ddl) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  addColumn('products', 'code', `TEXT NOT NULL DEFAULT ''`);
  addColumn('products', 'pos_on', 'INTEGER NOT NULL DEFAULT 1');
  for (const column of ['bin_location', 'reference', 'boat_note', 'farmer_id_card', 'farmer_island', 'farmer_agreement']) {
    addColumn('lots', column, `TEXT NOT NULL DEFAULT ''`);
  }
  addColumn('lots', 'origin_lot_id', 'INTEGER REFERENCES lots(id)');
  addColumn('orders', 'channel', `TEXT NOT NULL DEFAULT 'wholesale'`);
  addColumn('orders', 'voided', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('payments', 'slip', `TEXT NOT NULL DEFAULT ''`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_code ON products (code COLLATE NOCASE) WHERE code != '';
    CREATE INDEX IF NOT EXISTS idx_lots_origin ON lots (origin_lot_id);
  `);

  // Books that predate the register: give existing products a code, and fill
  // farmer / bin / boat-note on lots that still have the empty defaults.
  const CODE_PREFIX = { fruit: 'FRU', vegetable: 'VEG', herb: 'HRB', other: 'OTH' };
  const FARMERS = {
    'Thoddoo Farmers Co-op': ['DEMO-ID', 'AA. Thoddoo', 'FA-2026-014'],
    'Kaashidhoo Growers': ['DEMO-ID', 'K. Kaashidhoo', 'FA-2026-022'],
    'Malé Local Market': ['DEMO-ID', 'K. Malé', ''],
    'Kochi Imports (IN)': ['', 'Kochi, India', 'IMP-2026-03'],
    'Colombo Fresh (LK)': ['', 'Colombo, Sri Lanka', 'IMP-2026-05'],
  };
  const perCategory = {};
  for (const p of db.prepare(`SELECT id, category, code FROM products ORDER BY id`).all()) {
    if (p.code) {
      const n = Number((p.code.match(/(\d+)$/) || [])[1]);
      if (n) perCategory[p.category] = Math.max(perCategory[p.category] ?? 0, n);
    }
  }
  const setCode = db.prepare(`UPDATE products SET code = ? WHERE id = ? AND code = ''`);
  for (const p of db.prepare(`SELECT id, category FROM products WHERE code = '' ORDER BY id`).all()) {
    perCategory[p.category] = (perCategory[p.category] ?? 0) + 1;
    setCode.run(`${CODE_PREFIX[p.category] ?? 'OTH'}-${String(perCategory[p.category]).padStart(3, '0')}`, p.id);
  }

  const perZone = { CR: 0, DS: 0 };
  const productBin = new Map();
  for (const p of db.prepare(`SELECT id, shelf_life_days FROM products ORDER BY id`).all()) {
    const zone = p.shelf_life_days <= 7 ? 'CR' : 'DS';
    productBin.set(p.id, `${zone}-${String(++perZone[zone]).padStart(2, '0')}`);
  }
  const suppliers = Object.keys(FARMERS);
  const setLot = db.prepare(
    `UPDATE lots SET bin_location = ?, boat_note = ?, farmer_id_card = ?, farmer_island = ?, farmer_agreement = ?
     WHERE id = ? AND bin_location = '' AND boat_note = '' AND farmer_id_card = '' AND farmer_island = '' AND farmer_agreement = ''`
  );
  for (const lot of db.prepare(
    `SELECT l.id, l.product_id, l.supplier, l.received_at, s.reference ship
     FROM lots l LEFT JOIN shipments s ON s.id = l.shipment_id
     WHERE l.bin_location = '' AND l.boat_note = '' AND l.farmer_id_card = '' AND l.farmer_island = ''`
  ).all()) {
    const [idCard, island, agreement] = FARMERS[lot.supplier] ?? ['', '', ''];
    const idx = suppliers.indexOf(lot.supplier);
    const d = lot.received_at;
    const boat = idx >= 0
      ? `BN-${d.slice(5, 7)}${d.slice(8, 10)}-${String(idx + 1).padStart(2, '0')}`
      : (lot.ship || '');
    setLot.run(productBin.get(lot.product_id) ?? '', boat, idCard, island, agreement, lot.id);
  }
}

// A boat note is the shipment. It is in transit until a GRN puts the goods
// into inventory. Older shipments were already receipts, so they stay received.
{
  const addColumn = (table, column, ddl) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  for (const column of [
    'loaded_at', 'boat_name', 'boat_phone', 'loaded_from', 'destination', 'island_code',
    'delivered_name', 'delivered_role', 'delivered_phone',
    'cargo_name', 'cargo_role', 'cargo_phone',
    'receiver_name', 'receiver_role', 'receiver_phone', 'grn_ref',
    'receipt_vendor', 'receipt_memo',
    'prepared_name', 'prepared_role',
    'checked_name', 'checked_role',
    'verified_name', 'verified_role',
  ]) addColumn('shipments', column, `TEXT NOT NULL DEFAULT ''`);
  addColumn('shipments', 'status', `TEXT NOT NULL DEFAULT 'received'`);
  addColumn('shipments', 'enquiry_rejected', 'INTEGER NOT NULL DEFAULT 0');
  for (const column of ['receipt_prepared_by', 'receipt_checked_by', 'receipt_verified_by']) {
    addColumn('shipments', column, 'INTEGER');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS shipment_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      line_no INTEGER NOT NULL,
      product_id INTEGER REFERENCES products(id),
      description TEXT NOT NULL DEFAULT '',
      packing TEXT NOT NULL DEFAULT '',
      qty REAL NOT NULL DEFAULT 0,
      destination TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_shipment_lines_ship ON shipment_lines (shipment_id);
  `);
  addColumn('shipment_lines', 'received_qty', 'REAL NOT NULL DEFAULT 0');
}

// A shipment now starts when produce is received from the farmer (harvest GRN),
// then a boat price enquiry, then approval, then the boat note.
{
  const addColumn = (table, column, ddl) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  for (const column of [
    'harvest_ref', 'farmer_name', 'farmer_code', 'farmer_phone', 'farmer_contract', 'farmer_island',
    'coord_name', 'coord_date', 'farmer_signed_name', 'farmer_signed_date',
    'regional_name', 'regional_date',
    'enquiry_ref', 'vessel_name', 'vessel_phone', 'vessel_date', 'enquiry_note',
    'approved_name', 'approved_at',
  ]) addColumn('shipments', column, `TEXT NOT NULL DEFAULT ''`);
  addColumn('shipments', 'approved_by', 'INTEGER');
  // A harvest GRN waits for someone in Operations other than whoever filled it
  // in or last corrected it. verify_state stays '' on shipments without one.
  // GRNs saved before this take whoever filled them in from the audit log.
  for (const column of ['verify_state', 'sent_back_note', 'sent_back_name', 'sent_back_at']) {
    addColumn('shipments', column, `TEXT NOT NULL DEFAULT ''`);
  }
  for (const column of ['harvest_by', 'harvest_fixed_by', 'verified_by']) addColumn('shipments', column, 'INTEGER');
  db.exec(`
    UPDATE shipments SET harvest_by = (
      SELECT user_id FROM audit_log
      WHERE action = 'harvest-grn-created' AND entity = 'shipment' AND entity_id = shipments.id
      ORDER BY id LIMIT 1
    )
    WHERE harvest_ref <> '' AND verify_state = '' AND harvest_by IS NULL;
    UPDATE shipments SET verify_state = CASE WHEN regional_name <> '' THEN 'verified' ELSE 'waiting' END
    WHERE harvest_ref <> '' AND verify_state = '';
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS harvest_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      line_no INTEGER NOT NULL,
      product_id INTEGER REFERENCES products(id),
      description TEXT NOT NULL DEFAULT '',
      grade TEXT NOT NULL DEFAULT '',
      harvest_kg REAL NOT NULL DEFAULT 0,
      damaged_kg REAL NOT NULL DEFAULT 0,
      undamaged_kg REAL NOT NULL DEFAULT 0,
      bunches INTEGER NOT NULL DEFAULT 0,
      hands INTEGER NOT NULL DEFAULT 0,
      harvested_at TEXT NOT NULL DEFAULT '',
      pack_count REAL NOT NULL DEFAULT 0,
      per_bag_kg REAL NOT NULL DEFAULT 0,
      remarks TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_harvest_lines_ship ON harvest_lines (shipment_id);
    CREATE TABLE IF NOT EXISTS harvest_grades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id INTEGER NOT NULL REFERENCES harvest_lines(id),
      grade_no INTEGER NOT NULL,
      grade TEXT NOT NULL DEFAULT '',
      kg REAL NOT NULL DEFAULT 0,
      pack_count REAL NOT NULL DEFAULT 0,
      per_bag_kg REAL NOT NULL DEFAULT 0,
      remarks TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_harvest_grades_line ON harvest_grades (line_id);
    CREATE TABLE IF NOT EXISTS enquiry_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      line_no INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      qty REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT '',
      rate INTEGER NOT NULL DEFAULT 0,
      line_total INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_enquiry_lines_ship ON enquiry_lines (shipment_id);
  `);
  // Each grade is bought at its own price, in laari per kg. Landing uses this
  // instead of the buying price set on the item.
  addColumn('harvest_grades', 'unit_cost', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('harvest_grades', 'bunches', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('harvest_grades', 'pack_unit', "TEXT NOT NULL DEFAULT ''");
  // Grades used to live on the harvest line itself, one per line. A line from
  // then becomes a crop with that single grade.
  db.exec(`
    INSERT INTO harvest_grades (line_id, grade_no, grade, kg, pack_count, per_bag_kg, remarks)
    SELECT hl.id, 1, hl.grade, hl.undamaged_kg, hl.pack_count, hl.per_bag_kg, hl.remarks
    FROM harvest_lines hl
    WHERE NOT EXISTS (SELECT 1 FROM harvest_grades hg WHERE hg.line_id = hl.id)
  `);
  // A boat (the shipment) can carry several harvest GRNs. Each GRN keeps its
  // farmer, grades, buying prices, and verification. The price enquiry, boat
  // note, and landing cost belong to the boat.
  db.exec(`
    CREATE TABLE IF NOT EXISTS harvest_grns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      harvest_ref TEXT NOT NULL DEFAULT '',
      farmer_name TEXT NOT NULL DEFAULT '',
      farmer_code TEXT NOT NULL DEFAULT '',
      farmer_phone TEXT NOT NULL DEFAULT '',
      farmer_contract TEXT NOT NULL DEFAULT '',
      farmer_island TEXT NOT NULL DEFAULT '',
      island_code TEXT NOT NULL DEFAULT '',
      coord_name TEXT NOT NULL DEFAULT '',
      coord_date TEXT NOT NULL DEFAULT '',
      farmer_signed_name TEXT NOT NULL DEFAULT '',
      farmer_signed_date TEXT NOT NULL DEFAULT '',
      regional_name TEXT NOT NULL DEFAULT '',
      regional_date TEXT NOT NULL DEFAULT '',
      verify_state TEXT NOT NULL DEFAULT '',
      sent_back_note TEXT NOT NULL DEFAULT '',
      sent_back_name TEXT NOT NULL DEFAULT '',
      sent_back_at TEXT NOT NULL DEFAULT '',
      harvest_by INTEGER,
      harvest_fixed_by INTEGER,
      verified_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_harvest_grns_ship ON harvest_grns (shipment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_harvest_grns_ref ON harvest_grns (harvest_ref COLLATE NOCASE) WHERE harvest_ref != '';
  `);
  addColumn('harvest_lines', 'harvest_grn_id', 'INTEGER REFERENCES harvest_grns(id)');
  addColumn('enquiry_lines', 'harvest_grade_id', 'INTEGER');
  db.exec(`
    INSERT INTO harvest_grns (
      shipment_id, harvest_ref, farmer_name, farmer_code, farmer_phone, farmer_contract, farmer_island,
      island_code, coord_name, coord_date, farmer_signed_name, farmer_signed_date,
      regional_name, regional_date, verify_state, sent_back_note, sent_back_name, sent_back_at,
      harvest_by, harvest_fixed_by, verified_by)
    SELECT id, harvest_ref, farmer_name, farmer_code, farmer_phone, farmer_contract, farmer_island,
      island_code, coord_name, coord_date, farmer_signed_name, farmer_signed_date,
      regional_name, regional_date, verify_state, sent_back_note, sent_back_name, sent_back_at,
      harvest_by, harvest_fixed_by, verified_by
    FROM shipments
    WHERE harvest_ref <> ''
      AND NOT EXISTS (SELECT 1 FROM harvest_grns g WHERE g.shipment_id = shipments.id);
    UPDATE harvest_lines SET harvest_grn_id = (
      SELECT id FROM harvest_grns WHERE shipment_id = harvest_lines.shipment_id ORDER BY id LIMIT 1
    )
    WHERE harvest_grn_id IS NULL;
    UPDATE signatures SET doc_id = (
      SELECT id FROM harvest_grns WHERE shipment_id = signatures.doc_id ORDER BY id LIMIT 1
    )
    WHERE doc = 'harvest-grn'
      AND NOT EXISTS (SELECT 1 FROM harvest_grns WHERE id = signatures.doc_id)
      AND EXISTS (SELECT 1 FROM harvest_grns WHERE shipment_id = signatures.doc_id);
  `);
  addColumn('shipments', 'boat_no', 'INTEGER');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_boat_no ON shipments (boat_no) WHERE boat_no IS NOT NULL;
    UPDATE shipments SET boat_no = (
      SELECT COUNT(*) FROM shipments s2
      WHERE s2.harvest_ref <> '' AND s2.status IN ('in_transit', 'received') AND s2.id <= shipments.id
    )
    WHERE harvest_ref <> '' AND boat_no IS NULL AND status IN ('in_transit', 'received');
  `);
  // A harvest GRN can exist before any boat. The boat starts when its boat note is written.
  const shipCol = table => db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.name === 'shipment_id');
  if (shipCol('harvest_grns')?.notnull || shipCol('harvest_lines')?.notnull) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
    db.exec(`
      CREATE TABLE harvest_grns_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shipment_id INTEGER REFERENCES shipments(id),
        harvest_ref TEXT NOT NULL DEFAULT '',
        farmer_name TEXT NOT NULL DEFAULT '',
        farmer_code TEXT NOT NULL DEFAULT '',
        farmer_phone TEXT NOT NULL DEFAULT '',
        farmer_contract TEXT NOT NULL DEFAULT '',
        farmer_island TEXT NOT NULL DEFAULT '',
        island_code TEXT NOT NULL DEFAULT '',
        coord_name TEXT NOT NULL DEFAULT '',
        coord_date TEXT NOT NULL DEFAULT '',
        farmer_signed_name TEXT NOT NULL DEFAULT '',
        farmer_signed_date TEXT NOT NULL DEFAULT '',
        regional_name TEXT NOT NULL DEFAULT '',
        regional_date TEXT NOT NULL DEFAULT '',
        verify_state TEXT NOT NULL DEFAULT '',
        sent_back_note TEXT NOT NULL DEFAULT '',
        sent_back_name TEXT NOT NULL DEFAULT '',
        sent_back_at TEXT NOT NULL DEFAULT '',
        harvest_by INTEGER,
        harvest_fixed_by INTEGER,
        verified_by INTEGER
      );
      INSERT INTO harvest_grns_new (
        id, shipment_id, harvest_ref, farmer_name, farmer_code, farmer_phone, farmer_contract, farmer_island,
        island_code, coord_name, coord_date, farmer_signed_name, farmer_signed_date,
        regional_name, regional_date, verify_state, sent_back_note, sent_back_name, sent_back_at,
        harvest_by, harvest_fixed_by, verified_by)
      SELECT id, shipment_id, harvest_ref, farmer_name, farmer_code, farmer_phone, farmer_contract, farmer_island,
        island_code, coord_name, coord_date, farmer_signed_name, farmer_signed_date,
        regional_name, regional_date, verify_state, sent_back_note, sent_back_name, sent_back_at,
        harvest_by, harvest_fixed_by, verified_by
      FROM harvest_grns;
      DROP TABLE harvest_grns;
      ALTER TABLE harvest_grns_new RENAME TO harvest_grns;
      CREATE INDEX IF NOT EXISTS idx_harvest_grns_ship ON harvest_grns (shipment_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_harvest_grns_ref ON harvest_grns (harvest_ref COLLATE NOCASE) WHERE harvest_ref != '';

      CREATE TABLE harvest_lines_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shipment_id INTEGER REFERENCES shipments(id),
        harvest_grn_id INTEGER REFERENCES harvest_grns(id),
        line_no INTEGER NOT NULL,
        product_id INTEGER REFERENCES products(id),
        description TEXT NOT NULL DEFAULT '',
        grade TEXT NOT NULL DEFAULT '',
        harvest_kg REAL NOT NULL DEFAULT 0,
        damaged_kg REAL NOT NULL DEFAULT 0,
        undamaged_kg REAL NOT NULL DEFAULT 0,
        bunches INTEGER NOT NULL DEFAULT 0,
        hands INTEGER NOT NULL DEFAULT 0,
        harvested_at TEXT NOT NULL DEFAULT '',
        pack_count REAL NOT NULL DEFAULT 0,
        per_bag_kg REAL NOT NULL DEFAULT 0,
        remarks TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO harvest_lines_new (
        id, shipment_id, harvest_grn_id, line_no, product_id, description, grade, harvest_kg, damaged_kg,
        undamaged_kg, bunches, hands, harvested_at, pack_count, per_bag_kg, remarks)
      SELECT id, shipment_id, harvest_grn_id, line_no, product_id, description, grade, harvest_kg, damaged_kg,
        undamaged_kg, bunches, hands, harvested_at, pack_count, per_bag_kg, remarks
      FROM harvest_lines;
      DROP TABLE harvest_lines;
      ALTER TABLE harvest_lines_new RENAME TO harvest_lines;
      CREATE INDEX IF NOT EXISTS idx_harvest_lines_ship ON harvest_lines (shipment_id);
    `);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  addColumn('shipments', 'ground_transport', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('shipments', 'labor_hire', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('shipments', 'landing_weight', 'REAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS landing_costs (
      shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      line_key TEXT NOT NULL,
      unit_cost INTEGER NOT NULL CHECK (unit_cost >= 0),
      PRIMARY KEY (shipment_id, line_key)
    );
    CREATE TABLE IF NOT EXISTS landing_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      kind TEXT NOT NULL CHECK (kind IN ('ground', 'other')),
      line_no INTEGER NOT NULL,
      description TEXT NOT NULL,
      basis TEXT NOT NULL DEFAULT 'trip' CHECK (basis IN ('trip', 'hour', 'each')),
      qty REAL NOT NULL CHECK (qty > 0),
      rate INTEGER NOT NULL CHECK (rate >= 0),
      line_total INTEGER NOT NULL CHECK (line_total >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_landing_charges_ship ON landing_charges (shipment_id);
    CREATE TABLE IF NOT EXISTS labor_hires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER REFERENCES shipments(id),
      reference TEXT NOT NULL,
      link_ref TEXT NOT NULL DEFAULT '',
      hired_on TEXT NOT NULL,
      boat_ref TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      asked_name TEXT NOT NULL DEFAULT '',
      asked_role TEXT NOT NULL DEFAULT '',
      asked_date TEXT NOT NULL DEFAULT '',
      approved_name TEXT NOT NULL DEFAULT '',
      approved_role TEXT NOT NULL DEFAULT '',
      approved_date TEXT NOT NULL DEFAULT '',
      worked_name TEXT NOT NULL DEFAULT '',
      worked_date TEXT NOT NULL DEFAULT '',
      checked_name TEXT NOT NULL DEFAULT '',
      checked_role TEXT NOT NULL DEFAULT '',
      checked_date TEXT NOT NULL DEFAULT '',
      paid_name TEXT NOT NULL DEFAULT '',
      paid_date TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_hires_ref ON labor_hires (reference COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS labor_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      labor_id INTEGER NOT NULL REFERENCES labor_hires(id),
      line_no INTEGER NOT NULL,
      description TEXT NOT NULL,
      qty REAL NOT NULL CHECK (qty > 0),
      rate INTEGER NOT NULL CHECK (rate >= 0),
      line_total INTEGER NOT NULL CHECK (line_total >= 0)
    );
  `);
}

// Labour hire used to belong to one shipment. It is its own document now,
// and the shipment link is optional.
{
  const pk = db.prepare(`PRAGMA table_info(labor_hires)`).all().find(c => c.pk === 1);
  if (pk && pk.name === 'shipment_id') {
    db.exec(`DROP TABLE labor_lines; DROP TABLE labor_hires;`);
    db.exec(`
      CREATE TABLE labor_hires (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shipment_id INTEGER REFERENCES shipments(id),
        reference TEXT NOT NULL,
        link_ref TEXT NOT NULL DEFAULT '',
        hired_on TEXT NOT NULL,
        boat_ref TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        asked_name TEXT NOT NULL DEFAULT '',
        asked_role TEXT NOT NULL DEFAULT '',
        asked_date TEXT NOT NULL DEFAULT '',
        approved_name TEXT NOT NULL DEFAULT '',
        approved_role TEXT NOT NULL DEFAULT '',
        approved_date TEXT NOT NULL DEFAULT '',
        worked_name TEXT NOT NULL DEFAULT '',
        worked_date TEXT NOT NULL DEFAULT '',
        checked_name TEXT NOT NULL DEFAULT '',
        checked_role TEXT NOT NULL DEFAULT '',
        checked_date TEXT NOT NULL DEFAULT '',
        paid_name TEXT NOT NULL DEFAULT '',
        paid_date TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX idx_labor_hires_ref ON labor_hires (reference COLLATE NOCASE);
      CREATE UNIQUE INDEX idx_labor_hires_ship ON labor_hires (shipment_id) WHERE shipment_id IS NOT NULL;
      CREATE TABLE labor_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        labor_id INTEGER NOT NULL REFERENCES labor_hires(id),
        line_no INTEGER NOT NULL,
        description TEXT NOT NULL,
        qty REAL NOT NULL CHECK (qty > 0),
        rate INTEGER NOT NULL CHECK (rate >= 0),
        line_total INTEGER NOT NULL CHECK (line_total >= 0)
      );
      CREATE INDEX idx_labor_lines_hire ON labor_lines (labor_id);
    `);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_hires_ship ON labor_hires (shipment_id) WHERE shipment_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_labor_lines_hire ON labor_lines (labor_id);
  `);
}

// Write-offs used to live in a `waste` table with a free-text reason. They are
// typed stock moves now; the old reason ("Expired", ...) is kept as the note.
if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'waste'`).get()) {
  db.exec('BEGIN');
  try {
    db.exec(`
      INSERT INTO stock_moves (lot_id, type, qty, note, at)
        SELECT lot_id, 'damage', -qty, reason, at FROM waste ORDER BY id;
      DROP TABLE waste;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// A till payment used to drop the sale back to "delivered", which showed as
// unpaid. Those sales are voided: stock goes back on the shelf, and they are
// not money owed.
{
  const stranded = db.prepare(
    `SELECT id, total FROM orders
     WHERE channel = 'pos' AND status = 'delivered' AND voided = 0
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id)`
  ).all();
  if (stranded.length) {
    db.exec('BEGIN');
    try {
      const mark = db.prepare(`UPDATE orders SET status = 'cancelled', voided = 1 WHERE id = ? AND status = 'delivered'`);
      for (const o of stranded) {
        returnOrderStock(o.id);
        mark.run(o.id);
        logAction(null, 'sale-voided', 'order', o.id,
          `Voided sale #${o.id} — ${mvrText(o.total)} (stock returned)`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export class AppError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Nest-safe: inner tx() calls become savepoints, so a route can wrap
// "mutation + audit log" atomically even when the mutation helper (e.g.
// createOrder) opens its own transaction.
let txDepth = 0;
export function tx(fn) {
  const sp = `sp${txDepth}`;
  db.exec(txDepth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    db.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    txDepth--;
    db.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

// ---- dates (local time, YYYY-MM-DD) ----

export function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const today = () => localDateStr();

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

// days from a to b (positive when b is later)
export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}

export function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00'));
}

export const round3 = n => Math.round(n * 1000) / 1000;

// Landing cost, in laari. Logistic charges are ground transport, the approved
// boat price, labour hire, and any other charge. Per kilogram that is the
// charges divided by the kilograms left to sell. Each crop's landing cost is
// what was paid for the kilograms received, restated over the kilograms left
// to sell, plus that shared moving cost. A mixed shipment does not collapse
// to one landing figure. Lines that are not kilograms stay out of the split.
export function landingFigures({ ground, labor, boat, other = 0, lines }) {
  const logistic = (ground || 0) + (labor || 0) + (boat || 0) + (other || 0);
  const kgLines = lines.filter(l => (l.unit || 'kg') === 'kg' && Number(l.kg) > 0);
  const kg = round3(kgLines.reduce((sum, l) => sum + Number(l.kg), 0));
  const logisticPerKg = kg > 0 ? Math.round(logistic / kg) : null;
  const priced = lines.map(l => {
    const sellable = Number(l.kg) || 0;
    const received = Number(l.received_kg ?? l.kg) || 0;
    const kgLine = (l.unit || 'kg') === 'kg' && sellable > 0 && logisticPerKg != null;
    const paidPer = kgLine ? Math.round(l.unit_cost * received / sellable) : null;
    return { ...l, landing_per_kg: kgLine ? paidPer + logisticPerKg : null };
  });
  const crops = new Set(kgLines.map(l => l.product_id || l.product));
  const one = crops.size === 1;
  let average = null;
  let landingPer = null;
  if (one && kg > 0) {
    const value = kgLines.reduce((sum, l) => sum + l.unit_cost * (Number(l.received_kg ?? l.kg) || 0), 0);
    average = Math.round(value / kg);
    landingPer = average + logisticPerKg;
  }
  return {
    logistic,
    kg,
    logistic_per_kg: logisticPerKg,
    average_unit_cost: one ? average : null,
    landing_per_kg: landingPer,
    one_crop: one ? 1 : 0,
    lines: priced,
  };
}

// Split a received weight across harvest grades in proportion to the
// undamaged kilograms. The last grade absorbs the rounding.
function shareKg(weights, total) {
  const n = round3(Number(total) || 0);
  if (!weights.length) return [];
  if (!(n > 0)) return weights.map(() => 0);
  const harvest = round3(weights.reduce((sum, w) => sum + (Number(w) || 0), 0));
  if (!(harvest > 0)) return weights.map((_, i) => (i === weights.length - 1 ? n : 0));
  let used = 0;
  return weights.map((w, i) => {
    if (i === weights.length - 1) return round3(Math.max(0, n - used));
    const part = round3((Number(w) || 0) * n / harvest);
    used = round3(used + part);
    return part;
  });
}

function keptCost(overrides, key, fallback) {
  return overrides.has(key) ? overrides.get(key) : fallback;
}

function harvestLandingLines(harvest, stock, received) {
  const groups = [];
  const index = new Map();
  for (const h of harvest) {
    const bucket = h.product_id ? `p:${h.product_id}` : `h:${h.id}`;
    if (!index.has(bucket)) {
      index.set(bucket, groups.length);
      groups.push([]);
    }
    groups[index.get(bucket)].push(h);
  }
  const lines = [];
  for (const rows of groups) {
    const productId = rows[0].product_id || null;
    const unit = rows[0].unit || 'kg';
    const held = productId ? stock.get(productId) : null;
    const weights = rows.map(h => round3(h.undamaged_kg));
    let receivedShares = weights;
    let sellShares = weights;
    if (received && unit === 'kg') {
      receivedShares = held ? shareKg(weights, held.received) : weights.map(() => 0);
      sellShares = held ? shareKg(weights, held.sellable) : weights.map(() => 0);
    }
    rows.forEach((h, i) => {
      lines.push({
        key: `g:${h.id}`,
        product_id: productId,
        product: h.product,
        grade: h.grade || '',
        kg: sellShares[i],
        received_kg: receivedShares[i],
        unit,
        // The price paid for this grade on the harvest GRN. Grades of one crop
        // are bought at different rates, so the item's set cost is not used.
        unit_cost: h.buy_price || 0,
        price: 0,
      });
    });
  }
  return lines;
}

function landingLines({ harvest = [], lotRows = [], boatLines = [], stock = new Map(), received = false, overrides = new Map() }) {
  if (harvest.length) {
    return {
      weightBasis: received ? 'received' : 'harvest',
      lines: harvestLandingLines(harvest, stock, received),
    };
  }
  if (lotRows.length) {
    return {
      weightBasis: 'received',
      lines: lotRows.map(r => {
        const held = stock.get(r.product_id);
        const receivedKg = held ? held.received : round3(r.received);
        const sellable = held ? held.sellable : receivedKg;
        const unit = r.unit || 'kg';
        const key = `p:${r.product_id}`;
        const fallback = receivedKg > 0 ? Math.round((held ? held.value : r.value) / receivedKg) : 0;
        return {
          key,
          product_id: r.product_id,
          product: r.product,
          grade: '',
          kg: sellable,
          received_kg: receivedKg,
          unit,
          unit_cost: keptCost(overrides, key, fallback),
          price: r.price || 0,
        };
      }),
    };
  }
  return {
    weightBasis: boatLines.length ? 'boat' : 'none',
    lines: boatLines.filter(b => b.qty > 0).map(b => {
      const key = `b:${b.id}`;
      return {
        key,
        product_id: b.product_id || null,
        product: b.product,
        grade: '',
        kg: round3(b.qty),
        received_kg: round3(b.qty),
        unit: b.unit,
        unit_cost: keptCost(overrides, key, b.cost || 0),
        price: b.price || 0,
      };
    }),
  };
}

function kgNote(basis, lines) {
  const kgLines = lines.filter(l => (l.unit || 'kg') === 'kg');
  const sellable = round3(kgLines.reduce((sum, l) => sum + Number(l.kg || 0), 0));
  const received = round3(kgLines.reduce((sum, l) => sum + Number(l.received_kg || 0), 0));
  const n = v => String(round3(v));
  const other = lines.some(l => (l.unit || 'kg') !== 'kg' && Number(l.kg) > 0);
  if (!(sellable > 0)) {
    if (received > 0.001) return `Nothing left to sell · ${n(received)} kg received was written off`;
    if (other) return 'No kilograms on this shipment. Lines in other units stay out of the per-kg cost.';
    return basis === 'received' ? 'Nothing left to sell on this shipment' : 'No kilograms recorded yet';
  }
  if (basis === 'harvest') return `${n(sellable)} kg on the harvest GRN`;
  if (basis === 'boat') return `${n(sellable)} kg on the boat note`;
  const off = round3(received - sellable);
  if (off > 0.001) return `${n(sellable)} kg left to sell · ${n(off)} kg written off from ${n(received)} kg received`;
  return `${n(sellable)} kg received`;
}

const LANDING_BOAT_STATUS = new Set(['approved', 'in_transit', 'received']);

function chargeParts(shipment, parts) {
  if (Array.isArray(parts.groundLines)) {
    let groundLines = parts.groundLines;
    let ground = groundLines.reduce((sum, l) => sum + l.line_total, 0);
    if (!groundLines.length && (shipment.ground_transport || 0) > 0) {
      ground = shipment.ground_transport;
      groundLines = [{ description: 'Pick-up', basis: 'trip', qty: 1, rate: ground, line_total: ground }];
    }
    const otherLines = parts.otherLines || [];
    return {
      ground,
      other: otherLines.reduce((sum, l) => sum + l.line_total, 0),
      groundLines,
      otherLines,
    };
  }
  return { ground: parts.ground || 0, other: parts.other || 0, groundLines: [], otherLines: [] };
}

function landingView(shipment, parts) {
  const received = (shipment.status || 'received') === 'received';
  const { lines, weightBasis } = landingLines({ ...parts, received });
  const charges = chargeParts(shipment, parts);
  const boat = LANDING_BOAT_STATUS.has(shipment.status || 'received') && parts.hasEnquiry
    ? (parts.boatFreight || 0) : 0;
  const labor = parts.laborTotal || 0;
  const figures = landingFigures({
    ground: charges.ground,
    labor,
    boat,
    other: charges.other,
    lines,
  });
  return {
    ground_lines: charges.groundLines,
    other_lines: charges.otherLines,
    ground_transport: charges.ground,
    other_charges: charges.other,
    labor_hire: labor,
    labor_ref: parts.laborRef || '',
    boat_freight: boat,
    boat_name: shipment.vessel_name || shipment.boat_name || '',
    has_enquiry: parts.hasEnquiry ? 1 : 0,
    weight_basis: weightBasis,
    weight_note: kgNote(weightBasis, lines),
    ...figures,
  };
}

const LANDING_HARVEST_SQL = `
  SELECT hl.shipment_id, hg.id, hg.grade, hg.kg AS undamaged_kg, hl.product_id,
         COALESCE(NULLIF(pr.name, ''), NULLIF(hl.description, ''), 'Crop') AS product,
         COALESCE(NULLIF(pr.unit, ''), 'kg') AS unit,
         COALESCE(hg.unit_cost, 0) AS buy_price
  FROM harvest_grades hg
  JOIN harvest_lines hl ON hl.id = hg.line_id
  LEFT JOIN products pr ON pr.id = hl.product_id`;
const LANDING_HARVEST_ORDER = 'ORDER BY hl.line_no, hl.id, hg.grade_no, hg.id';

const LANDING_LOT_SQL = `
  SELECT l.shipment_id, l.product_id, pr.name AS product, pr.unit, pr.price,
         SUM(l.qty_received) AS received, SUM(l.qty_received * l.unit_cost) AS value
  FROM lots l JOIN products pr ON pr.id = l.product_id
  WHERE (l.origin_lot_id IS NULL OR l.origin_lot_id = l.id) AND l.shipment_id IS NOT NULL`;

const LANDING_BOAT_SQL = `
  SELECT sl.shipment_id, sl.id, sl.product_id, sl.qty,
         COALESCE(NULLIF(pr.name, ''), NULLIF(sl.description, ''), 'Item') AS product,
         COALESCE(NULLIF(pr.unit, ''), 'kg') AS unit,
         COALESCE(pr.cost, 0) AS cost, COALESCE(pr.price, 0) AS price
  FROM shipment_lines sl
  LEFT JOIN products pr ON pr.id = sl.product_id`;

const LANDING_WRITEOFF_SQL = `
  SELECT l.shipment_id, l.product_id, COALESCE(SUM(m.qty), 0) AS qty
  FROM stock_moves m
  JOIN lots l ON l.id = m.lot_id
  WHERE l.shipment_id IS NOT NULL
    AND m.type IN ('damage', 'weight_loss', 'stem_weight')`;

function stockMapFor(lotRows, offByProduct) {
  const map = new Map();
  for (const r of lotRows) {
    const received = round3(Number(r.received) || 0);
    const off = offByProduct.get(r.product_id) || 0;
    map.set(r.product_id, {
      received,
      sellable: round3(Math.max(0, received + off)),
      value: Number(r.value) || 0,
    });
  }
  return map;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

// The crops on a harvest GRN, each with its grades in order.
function loadHarvestLines(whereSql, arg) {
  const lines = db.prepare(
    `SELECT hl.*, pr.name AS product, pr.unit, pr.code AS item_code,
            g.harvest_ref, g.farmer_name, g.farmer_island, g.island_code AS grn_island_code,
            g.verify_state, g.sent_back_note, g.sent_back_name, g.sent_back_at,
            g.regional_name, g.regional_date, g.harvest_by, g.harvest_fixed_by, g.verified_by,
            g.coord_name, g.coord_date, g.farmer_signed_name, g.farmer_signed_date,
            g.farmer_code, g.farmer_phone, g.farmer_contract
     FROM harvest_lines hl
     LEFT JOIN harvest_grns g ON g.id = hl.harvest_grn_id
     LEFT JOIN products pr ON pr.id = hl.product_id
     WHERE ${whereSql} ORDER BY g.id, hl.line_no, hl.id`
  ).all(arg);
  const grades = groupBy(db.prepare(
    `SELECT hg.* FROM harvest_grades hg JOIN harvest_lines hl ON hl.id = hg.line_id
     WHERE ${whereSql} ORDER BY hg.grade_no, hg.id`
  ).all(arg), 'line_id');
  return lines.map(l => ({ ...l, grades: grades.get(l.id) ?? [] }));
}

export function harvestLinesFor(shipmentId) {
  return loadHarvestLines('hl.shipment_id = ?', shipmentId);
}

export function harvestLinesByGrn(grnId) {
  return loadHarvestLines('hl.harvest_grn_id = ?', grnId);
}

export function shipmentLanding(shipmentId) {
  const shipment = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(shipmentId);
  if (!shipment) return null;
  const overrides = new Map(
    db.prepare(`SELECT line_key, unit_cost FROM landing_costs WHERE shipment_id = ?`)
      .all(shipmentId).map(r => [r.line_key, r.unit_cost]),
  );
  const charges = db.prepare(
    `SELECT * FROM landing_charges WHERE shipment_id = ? ORDER BY line_no, id`
  ).all(shipmentId);
  const lotRows = db.prepare(`${LANDING_LOT_SQL} AND l.shipment_id = ? GROUP BY l.product_id`).all(shipmentId);
  const offs = new Map(
    db.prepare(`${LANDING_WRITEOFF_SQL} AND l.shipment_id = ? GROUP BY l.shipment_id, l.product_id`)
      .all(shipmentId).map(r => [r.product_id, r.qty]),
  );
  return landingView(shipment, {
    harvest: db.prepare(`${LANDING_HARVEST_SQL} WHERE hl.shipment_id = ? ${LANDING_HARVEST_ORDER}`).all(shipmentId),
    lotRows,
    boatLines: db.prepare(`${LANDING_BOAT_SQL} WHERE sl.shipment_id = ? ORDER BY sl.line_no, sl.id`).all(shipmentId),
    stock: stockMapFor(lotRows, offs),
    overrides,
    groundLines: charges.filter(c => c.kind === 'ground'),
    otherLines: charges.filter(c => c.kind === 'other'),
    boatFreight: db.prepare(
      `SELECT COALESCE(SUM(line_total), 0) AS total FROM enquiry_lines WHERE shipment_id = ?`
    ).get(shipmentId).total,
    hasEnquiry: !!db.prepare(`SELECT 1 FROM enquiry_lines WHERE shipment_id = ? LIMIT 1`).get(shipmentId),
    ...laborHireParts(shipmentId),
  });
}

function laborHireParts(shipmentId) {
  const hire = db.prepare(
    `SELECT h.reference, COALESCE(SUM(l.line_total), 0) AS total
     FROM labor_hires h LEFT JOIN labor_lines l ON l.labor_id = h.id
     WHERE h.shipment_id = ? GROUP BY h.id`
  ).get(shipmentId);
  return { laborTotal: hire ? hire.total : 0, laborRef: hire?.reference || '' };
}

// One pass for the shipment list. The panel itself loads one shipment.
export function landingSummaries(shipments) {
  const out = new Map();
  if (!shipments.length) return out;
  const harvest = groupBy(db.prepare(`${LANDING_HARVEST_SQL} ${LANDING_HARVEST_ORDER}`).all(), 'shipment_id');
  const lots = groupBy(db.prepare(`${LANDING_LOT_SQL} GROUP BY l.shipment_id, l.product_id`).all(), 'shipment_id');
  const boats = groupBy(db.prepare(`${LANDING_BOAT_SQL} ORDER BY sl.line_no, sl.id`).all(), 'shipment_id');
  const writeoff = new Map();
  for (const r of db.prepare(`${LANDING_WRITEOFF_SQL} GROUP BY l.shipment_id, l.product_id`).all()) {
    if (!writeoff.has(r.shipment_id)) writeoff.set(r.shipment_id, new Map());
    writeoff.get(r.shipment_id).set(r.product_id, r.qty);
  }
  const enquiry = new Map();
  for (const r of db.prepare(
    `SELECT shipment_id, COALESCE(SUM(line_total), 0) AS total FROM enquiry_lines GROUP BY shipment_id`
  ).all()) enquiry.set(r.shipment_id, r.total);
  const overrides = new Map();
  for (const r of db.prepare(`SELECT shipment_id, line_key, unit_cost FROM landing_costs`).all()) {
    if (!overrides.has(r.shipment_id)) overrides.set(r.shipment_id, new Map());
    overrides.get(r.shipment_id).set(r.line_key, r.unit_cost);
  }
  const charges = new Map();
  for (const r of db.prepare(
    `SELECT shipment_id, kind, COALESCE(SUM(line_total), 0) AS total, COUNT(*) AS n
     FROM landing_charges GROUP BY shipment_id, kind`
  ).all()) {
    if (!charges.has(r.shipment_id)) charges.set(r.shipment_id, { ground: 0, other: 0, groundLines: 0 });
    const row = charges.get(r.shipment_id);
    if (r.kind === 'ground') { row.ground = r.total; row.groundLines = r.n; }
    else row.other = r.total;
  }
  const labor = new Map();
  for (const r of db.prepare(
    `SELECT h.shipment_id, h.reference, COALESCE(SUM(l.line_total), 0) AS total
     FROM labor_hires h LEFT JOIN labor_lines l ON l.labor_id = h.id
     WHERE h.shipment_id IS NOT NULL
     GROUP BY h.id`
  ).all()) labor.set(r.shipment_id, r);
  for (const shipment of shipments) {
    const hire = labor.get(shipment.id);
    const saved = charges.get(shipment.id) || { ground: 0, other: 0, groundLines: 0 };
    const lotRows = lots.get(shipment.id) ?? [];
    out.set(shipment.id, landingView(shipment, {
      harvest: harvest.get(shipment.id) ?? [],
      lotRows,
      boatLines: boats.get(shipment.id) ?? [],
      stock: stockMapFor(lotRows, writeoff.get(shipment.id) ?? new Map()),
      overrides: overrides.get(shipment.id) ?? new Map(),
      ground: saved.groundLines ? saved.ground : (shipment.ground_transport || 0),
      other: saved.other,
      boatFreight: enquiry.get(shipment.id) ?? 0,
      hasEnquiry: enquiry.has(shipment.id),
      laborTotal: hire ? hire.total : 0,
      laborRef: hire?.reference || '',
    }));
  }
  return out;
}

// A lot expiring on X is sellable through X. days_left 0 = last day.
export function lotStatus(daysLeft) {
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= 1) return 'critical';
  if (daysLeft <= 3) return 'soon';
  return 'fresh';
}

// ---- shared business operations ----

// These bins hold stock that has left the shelf. Harvest Damage and Harvest
// Weight Loss are already in the book; Harvest Stem Weight is added beside them.
export const LOSS_BINS = {
  damage: 'Harvest Damage',
  weight_loss: 'Harvest Weight Loss',
  stem_weight: 'Harvest Stem Weight',
};
const LOSS_BIN_LIST = Object.values(LOSS_BINS).map(n => `'${n.toLowerCase()}'`).join(', ');
export const lossBinSql = (column = 'bin_location') =>
  `lower(trim(${column})) NOT IN (${LOSS_BIN_LIST})`;
export const isLossBin = name =>
  Object.values(LOSS_BINS).some(n => n.toLowerCase() === String(name || '').trim().toLowerCase());

for (const name of Object.values(LOSS_BINS)) {
  db.prepare(`INSERT OR IGNORE INTO bins (name) VALUES (?)`).run(name);
}

// Sellable lots for a product as of a cutoff date, first-expiry-first.
// Quantity sitting in a damage, weight-loss, or stem-weight bin is not for sale.
export function availableLots(productId, cutoffDate) {
  return db.prepare(
    `SELECT id, qty_left FROM lots
     WHERE product_id = ? AND qty_left > 0 AND expires_at >= ?
       AND ${lossBinSql('bin_location')}
     ORDER BY expires_at, id`
  ).all(productId, cutoffDate);
}

export function availableQty(productId, cutoffDate) {
  return db.prepare(
    `SELECT COALESCE(SUM(qty_left), 0) AS q FROM lots
     WHERE product_id = ? AND qty_left > 0 AND expires_at >= ?
       AND ${lossBinSql('bin_location')}`
  ).get(productId, cutoffDate).q;
}

// Plans and applies a first-expiry-first draw of `qty` from a product's lots,
// returning the [{lot_id, qty}] plan. Must run inside a transaction. Throws
// INSUFFICIENT_STOCK when the shelf can't cover it.
export function consumeStock(productId, qty, cutoffDate) {
  const lots = availableLots(productId, cutoffDate);
  let need = qty;
  const plan = [];
  for (const lot of lots) {
    if (need <= 1e-6) break;
    const take = Math.min(lot.qty_left, need);
    plan.push({ lot_id: lot.id, qty: round3(take) });
    need -= take;
  }
  if (need > 1e-6) {
    throw new AppError(400, 'Not enough stock', {
      code: 'INSUFFICIENT_STOCK',
      product_id: productId,
      available: round3(qty - need),
    });
  }
  const dec = db.prepare(`UPDATE lots SET qty_left = ROUND(qty_left - ?, 3) WHERE id = ? AND qty_left >= ?`);
  for (const a of plan) {
    const res = dec.run(a.qty, a.lot_id, a.qty - 1e-6);
    if (res.changes !== 1) throw new AppError(409, 'Stock changed while saving — try again', { code: 'CONFLICT' });
  }
  return plan;
}

// Creates an order and consumes stock first-expiry-first. Goods must still be
// sellable on the delivery date, so that is the expiry cutoff.
// items: [{ product_id, qty, unit_price }] — validated by the caller.
export function createOrder({ customer_id, delivery_date, notes = '', items, created_at, status = 'pending', channel = 'wholesale' }) {
  return tx(() => {
    const ins = db.prepare(
      `INSERT INTO orders (customer_id, created_at, delivery_date, status, total, notes, channel)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).run(customer_id, created_at, delivery_date, status, notes, channel);
    const orderId = Number(ins.lastInsertRowid);

    const insItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?)`);
    const insAlloc = db.prepare(`INSERT INTO allocations (order_item_id, lot_id, qty) VALUES (?, ?, ?)`);

    let total = 0;
    for (const it of items) {
      const lineTotal = Math.round(it.qty * it.unit_price);
      const itemId = Number(insItem.run(orderId, it.product_id, round3(it.qty), it.unit_price, lineTotal).lastInsertRowid);
      for (const a of consumeStock(it.product_id, it.qty, delivery_date)) {
        insAlloc.run(itemId, a.lot_id, a.qty);
      }
      total += lineTotal;
    }
    db.prepare(`UPDATE orders SET total = ? WHERE id = ?`).run(total, orderId);
    return orderId;
  });
}

// Reuse a shipment when the reference already exists (any case). A new
// reference opens a shipment. Callers that must reject duplicates should
// check first — this is the "type a reference and join it" path.
export function findOrCreateShipment({ reference, supplier = '', origin = '', arrived_at, notes = '' }) {
  const existing = db.prepare(`SELECT * FROM shipments WHERE reference = ? COLLATE NOCASE`).get(reference);
  if (existing) return { shipment: existing, created: false };
  try {
    const id = Number(db.prepare(
      `INSERT INTO shipments (reference, supplier, origin, arrived_at, notes) VALUES (?, ?, ?, ?, ?)`
    ).run(reference, supplier, origin, arrived_at, notes).lastInsertRowid);
    return { shipment: db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(id), created: true };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      const again = db.prepare(`SELECT * FROM shipments WHERE reference = ? COLLATE NOCASE`).get(reference);
      if (again) return { shipment: again, created: false };
    }
    throw err;
  }
}

export function receiveLot({
  product_id, qty, unit_cost, supplier = '', received_at, expires_at, shipment_id = null,
  bin_location = '', reference = '', boat_note = '', farmer_id_card = '', farmer_island = '', farmer_agreement = '',
}) {
  const ins = db.prepare(
    `INSERT INTO lots (product_id, shipment_id, supplier, qty_received, qty_left, unit_cost, received_at, expires_at,
       bin_location, reference, boat_note, farmer_id_card, farmer_island, farmer_agreement)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(product_id, shipment_id, supplier, round3(qty), round3(qty), unit_cost, received_at, expires_at,
    bin_location, reference, boat_note, farmer_id_card, farmer_island, farmer_agreement);
  return Number(ins.lastInsertRowid);
}

// Document numbers: INV-0042 on invoices, GRN-0137 for a receipt with no
// reference typed in, and so on.
export const docNo = (prefix, id) => `${prefix}-${String(id).padStart(4, '0')}`;

function lotForMove(lotId, qty) {
  const lot = db.prepare(`SELECT * FROM lots WHERE id = ?`).get(lotId);
  if (!lot) throw new AppError(404, 'Lot not found');
  if (qty !== undefined && qty > lot.qty_left + 1e-6) {
    throw new AppError(400, `Only ${lot.qty_left} left in this lot`, { available: lot.qty_left });
  }
  return lot;
}

function insertMove({ lot_id, type, qty, to_lot_id = null, reference = '', note = '', at }) {
  return Number(db.prepare(
    `INSERT INTO stock_moves (lot_id, type, qty, to_lot_id, reference, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(lot_id, type, round3(qty), to_lot_id, reference, note, at).lastInsertRowid);
}

const takeFromLot = (lotId, qty) =>
  db.prepare(`UPDATE lots SET qty_left = ROUND(MAX(qty_left - ?, 0), 3) WHERE id = ?`).run(round3(qty), lotId);

function itnMemo(lot, note) {
  const place = lot.farmer_island || lot.supplier || '';
  const harvest = lot.boat_note
    ? `Harvest from ${place || 'the farmer'} - ${lot.boat_note}`
    : '';
  return [harvest, note].filter(Boolean).join('. ');
}

function nextItnReference(on) {
  const yy = String(on).slice(2, 4);
  const prefix = `ITN-${yy}-`;
  const nums = [];
  const take = sql => {
    for (const row of db.prepare(sql).all(`${prefix}%`)) {
      const match = String(row.reference).match(/^ITN-(\d{2})-(\d+)$/i);
      if (match && match[1] === yy) nums.push(Number(match[2]));
    }
  };
  take(`SELECT reference FROM transfer_notes WHERE reference LIKE ?`);
  take(`SELECT reference FROM lots WHERE reference LIKE ?`);
  take(`SELECT reference FROM stock_moves WHERE reference LIKE ?`);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}${String(n).padStart(3, '0')}`;
}

// One inventory transfer note for a move that already happened. The lines are
// the bins, the quantity on hand before the move, and the quantity moved.
function createTransferNote({ moveId, on, fromBin, toBin, kind, memo, line }) {
  const reference = nextItnReference(on);
  const id = Number(db.prepare(
    `INSERT INTO transfer_notes (reference, moved_on, from_bin, to_bin, class_name, memo, move_id, kind, created_at)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`
  ).run(reference, on, fromBin || '', toBin || '', memo || '', moveId, kind, new Date().toISOString()).lastInsertRowid);
  db.prepare(
    `INSERT INTO transfer_lines (note_id, line_no, lot_id, item_code, description, from_bin, qoh, qty, to_bin)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, line.lotId, line.code || '', line.description, line.fromBin || '', round3(line.qoh), round3(line.qty), line.toBin || '');
  db.prepare(`UPDATE stock_moves SET reference = ? WHERE id = ? AND reference = ''`).run(reference, moveId);
  return { id, reference };
}

function productOf(lot) {
  return db.prepare(`SELECT name, code FROM products WHERE id = ?`).get(lot.product_id);
}

// Damage, weight loss, stem weight: the quantity moves into that bin and is
// no longer on hand. The transfer note is written from the move.
export function writeOffLot(lotId, qty, { type = 'damage', reference = '', note = '', at }) {
  return tx(() => {
    const lot = lotForMove(lotId, qty);
    const qoh = lot.qty_left;
    const toBin = LOSS_BINS[type];
    if (!toBin) throw new AppError(400, 'Choose what happened to this stock');
    takeFromLot(lotId, qty);
    const newLotId = Number(db.prepare(
      `INSERT INTO lots (product_id, shipment_id, supplier, qty_received, qty_left, unit_cost, received_at, expires_at,
         bin_location, reference, boat_note, farmer_id_card, farmer_island, farmer_agreement, origin_lot_id)
       SELECT product_id, shipment_id, supplier, ?, 0, unit_cost, received_at, expires_at,
         ?, reference, boat_note, farmer_id_card, farmer_island, farmer_agreement, COALESCE(origin_lot_id, id)
       FROM lots WHERE id = ?`
    ).run(round3(qty), toBin, lotId).lastInsertRowid);
    const product = productOf(lot);
    const memo = [itnMemo(lot, note), reference].filter(Boolean).join('. ');
    const moveId = insertMove({ lot_id: lotId, type, qty: -qty, to_lot_id: newLotId, reference: '', note, at });
    const noteRow = createTransferNote({
      moveId, on: at, fromBin: lot.bin_location, toBin, kind: type, memo,
      line: {
        lotId, code: product.code, description: product.name,
        fromBin: lot.bin_location, qoh, qty, toBin,
      },
    });
    return { moveId, newLotId, ...noteRow };
  });
}

// Stock count: the lot becomes what is physically there, and the difference
// (either way) is recorded. Returns the signed difference.
export function adjustLot(lotId, counted, { reference = '', note = '', at }) {
  return tx(() => {
    const lot = lotForMove(lotId);
    const delta = round3(counted - lot.qty_left);
    if (Math.abs(delta) < 0.001) {
      throw new AppError(400, `The count matches the ${lot.qty_left} on record — nothing to adjust`);
    }
    db.prepare(`UPDATE lots SET qty_left = ? WHERE id = ?`).run(round3(counted), lotId);
    insertMove({ lot_id: lotId, type: 'adjust', qty: delta, reference, note, at });
    return delta;
  });
}

// Moving stock to another bin or warehouse splits it off into a new lot there,
// even when the whole lot moves: each lot keeps a single location, so the
// receipt and any earlier sales still show the bin they actually came from.
export function transferLot(lotId, qty, toBin, { reference = '', note = '', at }) {
  return tx(() => {
    const lot = lotForMove(lotId, qty);
    const qoh = lot.qty_left;
    takeFromLot(lotId, qty);
    // A normal bin keeps the quantity. The three loss bins take it off the shelf.
    const left = isLossBin(toBin) ? 0 : round3(qty);
    const newLotId = Number(db.prepare(
      `INSERT INTO lots (product_id, shipment_id, supplier, qty_received, qty_left, unit_cost, received_at, expires_at,
         bin_location, reference, boat_note, farmer_id_card, farmer_island, farmer_agreement, origin_lot_id)
       SELECT product_id, shipment_id, supplier, ?, ?, unit_cost, received_at, expires_at,
         ?, reference, boat_note, farmer_id_card, farmer_island, farmer_agreement, COALESCE(origin_lot_id, id)
       FROM lots WHERE id = ?`
    ).run(round3(qty), left, toBin, lotId).lastInsertRowid);
    const product = productOf(lot);
    const memo = [itnMemo(lot, note), reference].filter(Boolean).join('. ');
    const moveId = insertMove({ lot_id: lotId, type: 'transfer', qty: -qty, to_lot_id: newLotId, reference: '', note, at });
    const noteRow = createTransferNote({
      moveId, on: at, fromBin: lot.bin_location, toBin, kind: 'transfer', memo,
      line: {
        lotId, code: product.code, description: product.name,
        fromBin: lot.bin_location, qoh, qty, toBin,
      },
    });
    return { moveId, newLotId, ...noteRow };
  });
}

// Testing undo. The quantity returns to the lot it left, and the inventory
// transfer written for the move is deleted with it. A later movement or a
// sale of the destination has to be undone first, so this cannot rewrite history.
export function removeStockMove(moveId) {
  return tx(() => {
    const move = db.prepare(`SELECT * FROM stock_moves WHERE id = ?`).get(moveId);
    if (!move) throw new AppError(404, 'Movement not found');
    const lot = db.prepare(`SELECT * FROM lots WHERE id = ?`).get(move.lot_id);
    if (!lot) throw new AppError(404, 'Lot not found');
    const dest = move.to_lot_id
      ? db.prepare(`SELECT * FROM lots WHERE id = ?`).get(move.to_lot_id)
      : null;

    const later = db.prepare(
      `SELECT id FROM stock_moves
       WHERE id > ? AND (lot_id = ? OR to_lot_id = ? OR lot_id = ? OR to_lot_id = ?)
       LIMIT 1`
    ).get(move.id, lot.id, lot.id, dest?.id ?? 0, dest?.id ?? 0);
    if (later) throw new AppError(400, 'Undo the later movement on this lot first');

    if (dest) {
      const sold = db.prepare(`SELECT COUNT(*) AS n FROM allocations WHERE lot_id = ?`).get(dest.id).n;
      const children = db.prepare(`SELECT COUNT(*) AS n FROM lots WHERE origin_lot_id = ?`).get(dest.id).n;
      if (sold || children) {
        throw new AppError(400, 'This stock was used after it moved. Undo that first.');
      }
      const expectedLeft = isLossBin(dest.bin_location) ? 0 : round3(-move.qty);
      if (Math.abs(dest.qty_left - expectedLeft) > 0.001) {
        throw new AppError(400, 'The quantity changed after this movement. Undo that first.');
      }
    }

    const restored = round3(lot.qty_left - move.qty);
    if (restored < -0.0005) {
      throw new AppError(400, 'This stock was used after the movement. Undo that first.');
    }
    db.prepare(`UPDATE lots SET qty_left = ? WHERE id = ?`).run(restored, lot.id);

    const note = db.prepare(`SELECT id, reference FROM transfer_notes WHERE move_id = ?`).get(move.id);
    if (note) {
      db.prepare(`DELETE FROM transfer_lines WHERE note_id = ?`).run(note.id);
      db.prepare(`DELETE FROM transfer_notes WHERE id = ?`).run(note.id);
    }
    db.prepare(`DELETE FROM stock_moves WHERE id = ?`).run(move.id);
    if (dest) db.prepare(`DELETE FROM lots WHERE id = ?`).run(dest.id);

    return {
      type: move.type,
      reference: note?.reference || move.reference || '',
      lotId: lot.id,
      qty: round3(-move.qty),
    };
  });
}

// Put the kilograms from a sale back on the lots they came from, and drop the
// allocation rows so a later sale cannot count those kilograms twice.
export function returnOrderStock(orderId) {
  const allocs = db.prepare(
    `SELECT a.lot_id, a.qty FROM allocations a
     JOIN order_items oi ON oi.id = a.order_item_id WHERE oi.order_id = ?`
  ).all(orderId);
  const inc = db.prepare(`UPDATE lots SET qty_left = ROUND(qty_left + ?, 3) WHERE id = ?`);
  for (const a of allocs) inc.run(a.qty, a.lot_id);
  db.prepare(
    `DELETE FROM allocations WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`
  ).run(orderId);
}

// Admin removal of a shipment. The boat note, its lines, the lots it put into
// inventory (including stock later moved to another bin), write-offs of that
// stock, and sales that drew from it all go. A sale that also used other
// stock keeps the other lines. Returns slip filenames to delete after commit.
export function removeShipment(shipmentId) {
  const shipment = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(shipmentId);
  if (!shipment) throw new AppError(404, 'Shipment not found');

  const lotIds = db.prepare(
    `WITH RECURSIVE tree AS (
       SELECT id FROM lots WHERE shipment_id = ?
       UNION
       SELECT l.id FROM lots l JOIN tree t ON l.origin_lot_id = t.id
     )
     SELECT id FROM tree`
  ).all(shipmentId).map(r => r.id);

  const slips = [];
  let ordersRemoved = 0;
  let ordersChanged = 0;
  let kg = 0;

  if (lotIds.length) {
    const marks = lotIds.map(() => '?').join(',');
    kg = db.prepare(
      `SELECT COALESCE(ROUND(SUM(qty_left), 3), 0) AS q FROM lots WHERE id IN (${marks})`
    ).get(...lotIds).q;

    const allocs = db.prepare(
      `SELECT a.id, a.order_item_id, oi.order_id, oi.unit_price
       FROM allocations a JOIN order_items oi ON oi.id = a.order_item_id
       WHERE a.lot_id IN (${marks})`
    ).all(...lotIds);
    const itemIds = [...new Set(allocs.map(a => a.order_item_id))];
    const orderIds = [...new Set(allocs.map(a => a.order_id))];
    if (allocs.length) {
      db.prepare(`DELETE FROM allocations WHERE id IN (${allocs.map(() => '?').join(',')})`)
        .run(...allocs.map(a => a.id));
    }
    for (const itemId of itemIds) {
      const price = allocs.find(a => a.order_item_id === itemId).unit_price;
      const left = db.prepare(
        `SELECT COALESCE(SUM(qty), 0) AS q FROM allocations WHERE order_item_id = ?`
      ).get(itemId).q;
      if (left < 0.001) {
        db.prepare(`DELETE FROM allocations WHERE order_item_id = ?`).run(itemId);
        db.prepare(`DELETE FROM order_items WHERE id = ?`).run(itemId);
      } else {
        db.prepare(`UPDATE order_items SET qty = ?, line_total = ? WHERE id = ?`)
          .run(round3(left), Math.round(left * price), itemId);
      }
    }
    for (const orderId of orderIds) {
      const items = db.prepare(
        `SELECT COALESCE(SUM(line_total), 0) AS t, COUNT(*) AS n FROM order_items WHERE order_id = ?`
      ).get(orderId);
      if (items.n === 0) {
        const pays = db.prepare(`SELECT id, slip FROM payments WHERE order_id = ?`).all(orderId);
        for (const p of pays) {
          if (p.slip) slips.push(p.slip);
          db.prepare(`DELETE FROM audit_log WHERE entity = 'payment' AND entity_id = ?`).run(p.id);
        }
        if (pays.length) db.prepare(`DELETE FROM payments WHERE order_id = ?`).run(orderId);
        db.prepare(`DELETE FROM signatures WHERE doc IN ('invoice', 'delivery-note') AND doc_id = ?`).run(orderId);
        db.prepare(`DELETE FROM orders WHERE id = ?`).run(orderId);
        db.prepare(`DELETE FROM audit_log WHERE entity = 'order' AND entity_id = ?`).run(orderId);
        ordersRemoved++;
      } else {
        db.prepare(`UPDATE orders SET total = ? WHERE id = ?`).run(items.t, orderId);
        let extra = db.prepare(
          `SELECT COALESCE(SUM(amount), 0) AS p FROM payments WHERE order_id = ?`
        ).get(orderId).p - items.t;
        if (extra > 0) {
          const pays = db.prepare(
            `SELECT id, amount, slip FROM payments WHERE order_id = ? ORDER BY id DESC`
          ).all(orderId);
          for (const p of pays) {
            if (extra <= 0) break;
            if (p.amount <= extra) {
              if (p.slip) slips.push(p.slip);
              db.prepare(`DELETE FROM audit_log WHERE entity = 'payment' AND entity_id = ?`).run(p.id);
              db.prepare(`DELETE FROM payments WHERE id = ?`).run(p.id);
              extra -= p.amount;
            } else {
              db.prepare(`UPDATE payments SET amount = ? WHERE id = ?`).run(p.amount - extra, p.id);
              extra = 0;
            }
          }
        }
        const paid = db.prepare(
          `SELECT COALESCE(SUM(amount), 0) AS p FROM payments WHERE order_id = ?`
        ).get(orderId).p;
        const order = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(orderId);
        if (order.status !== 'cancelled' && order.status !== 'pending') {
          db.prepare(`UPDATE orders SET status = ? WHERE id = ?`)
            .run(paid >= items.t ? 'paid' : 'delivered', orderId);
        }
        ordersChanged++;
      }
    }

    db.prepare(`DELETE FROM allocations WHERE lot_id IN (${marks})`).run(...lotIds);
    db.prepare(
      `DELETE FROM stock_moves WHERE lot_id IN (${marks}) OR to_lot_id IN (${marks})`
    ).run(...lotIds, ...lotIds);

    let guard = 0;
    while (guard++ < 12) {
      const res = db.prepare(
        `DELETE FROM lots WHERE id IN (${marks})
           AND id NOT IN (SELECT origin_lot_id FROM lots WHERE origin_lot_id IS NOT NULL)`
      ).run(...lotIds);
      if (res.changes === 0) break;
    }
    const leftLots = db.prepare(`SELECT COUNT(*) AS c FROM lots WHERE id IN (${marks})`).get(...lotIds).c;
    if (leftLots) throw new AppError(400, 'This shipment is still tied to other stock records');
    db.prepare(`DELETE FROM audit_log WHERE entity = 'lot' AND entity_id IN (${marks})`).run(...lotIds);
  }

  db.prepare(`DELETE FROM shipment_lines WHERE shipment_id = ?`).run(shipmentId);
  db.prepare(`DELETE FROM signatures WHERE doc = 'harvest-grn' AND doc_id IN (SELECT id FROM harvest_grns WHERE shipment_id = ?)`).run(shipmentId);
  db.prepare(`DELETE FROM harvest_grades WHERE line_id IN (SELECT id FROM harvest_lines WHERE shipment_id = ?)`).run(shipmentId);
  db.prepare(`DELETE FROM harvest_lines WHERE shipment_id = ?`).run(shipmentId);
  db.prepare(`DELETE FROM harvest_grns WHERE shipment_id = ?`).run(shipmentId);
  db.prepare(`DELETE FROM enquiry_lines WHERE shipment_id = ?`).run(shipmentId);
  db.prepare(`UPDATE labor_hires SET shipment_id = NULL WHERE shipment_id = ?`).run(shipmentId);
  db.prepare(`DELETE FROM landing_costs WHERE shipment_id = ?`).run(shipmentId);
  db.prepare(`DELETE FROM landing_charges WHERE shipment_id = ?`).run(shipmentId);
  db.prepare(
    `DELETE FROM signatures WHERE doc IN ('harvest-grn', 'price-enquiry', 'boat-note', 'item-receipt') AND doc_id = ?`
  ).run(shipmentId);
  db.prepare(`DELETE FROM audit_log WHERE entity = 'shipment' AND entity_id = ?`).run(shipmentId);
  const gone = db.prepare(`DELETE FROM shipments WHERE id = ?`).run(shipmentId);
  if (gone.changes !== 1) throw new AppError(404, 'Shipment not found');

  return {
    reference: shipment.reference,
    grn_ref: shipment.grn_ref || '',
    had_stock: lotIds.length > 0,
    kg,
    orders_removed: ordersRemoved,
    orders_changed: ordersChanged,
    slips,
  };
}

export function paidTotal(orderId) {
  return db.prepare(`SELECT COALESCE(SUM(amount), 0) AS p FROM payments WHERE order_id = ?`).get(orderId).p;
}

// Unpaid value of delivered orders for one customer.
export function customerBalance(customerId) {
  return db.prepare(
    `SELECT COALESCE(SUM(o.total - (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.order_id = o.id)), 0) AS bal
     FROM orders o WHERE o.customer_id = ? AND o.status = 'delivered'`
  ).get(customerId).bal;
}

// Value of orders taken but not yet delivered — committed exposure that the
// credit check must count alongside the delivered-unpaid balance.
export function customerPendingTotal(customerId) {
  return db.prepare(
    `SELECT COALESCE(SUM(total), 0) AS t FROM orders WHERE customer_id = ? AND status = 'pending'`
  ).get(customerId).t;
}
