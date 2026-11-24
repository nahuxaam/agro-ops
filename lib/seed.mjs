// Demo data: ~4 weeks of realistic history for a Malé fruit & veg wholesaler.
// Deterministic (seeded PRNG) so a reset regenerates the same book.
// Runs only when the database is empty; set BAAZARU_NO_DEMO=1 to start blank.
import {
  db, tx, addDays, availableQty, createOrder, findOrCreateShipment, localDateStr, receiveLot, round3, writeOffLot,
} from './db.mjs';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260807);
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const chance = p => rnd() < p;

// name, category, unit, shelf days, cost MVR, price MVR, est. daily demand, popularity, supplier
const PRODUCTS = [
  ['Tomato', 'vegetable', 'kg', 6, 28, 45, 35, 3, 'Kochi Imports (IN)'],
  ['Cucumber', 'vegetable', 'kg', 6, 18, 30, 25, 3, 'Thoddoo Farmers Co-op'],
  ['Lettuce', 'vegetable', 'kg', 3, 55, 90, 12, 2, 'Colombo Fresh (LK)'],
  ['Banana (Dhonkeyo)', 'fruit', 'kg', 4, 20, 35, 40, 3, 'Kaashidhoo Growers'],
  ['Papaya', 'fruit', 'kg', 4, 22, 38, 20, 2, 'Thoddoo Farmers Co-op'],
  ['Watermelon (Thoddoo)', 'fruit', 'kg', 7, 12, 22, 60, 3, 'Thoddoo Farmers Co-op'],
  ['Mango', 'fruit', 'kg', 5, 45, 75, 25, 2, 'Kochi Imports (IN)'],
  ['Lime', 'fruit', 'kg', 10, 35, 60, 8, 2, 'Colombo Fresh (LK)'],
  ['Onion', 'vegetable', 'kg', 21, 12, 20, 50, 3, 'Kochi Imports (IN)'],
  ['Potato', 'vegetable', 'kg', 30, 10, 18, 45, 3, 'Kochi Imports (IN)'],
  ['Carrot', 'vegetable', 'kg', 14, 16, 28, 15, 2, 'Kochi Imports (IN)'],
  ['Capsicum', 'vegetable', 'kg', 7, 40, 65, 10, 2, 'Colombo Fresh (LK)'],
  ['Githeyo Mirus (chili)', 'vegetable', 'kg', 5, 180, 280, 4, 1.5, 'Malé Local Market'],
  ['Curry Leaves (Hikandhi faiy)', 'herb', 'bunch', 3, 5, 10, 20, 1.5, 'Kaashidhoo Growers'],
  ['Coconut (Kaashi)', 'fruit', 'piece', 30, 8, 15, 80, 3, 'Kaashidhoo Growers'],
  ['Pumpkin (Barabo)', 'vegetable', 'kg', 20, 15, 26, 12, 1, 'Thoddoo Farmers Co-op'],
  ['Eggplant', 'vegetable', 'kg', 7, 20, 34, 10, 1.5, 'Malé Local Market'],
  ['Cabbage', 'vegetable', 'kg', 10, 14, 24, 18, 2, 'Colombo Fresh (LK)'],
];

// Receipt paperwork per supplier: ID card, island, agreement no. Importers
// have no ID card; their agreement is the import contract.
const FARMERS = {
  'Thoddoo Farmers Co-op': ['DEMO-ID', 'AA. Thoddoo', 'FA-2026-014'],
  'Kaashidhoo Growers': ['DEMO-ID', 'K. Kaashidhoo', 'FA-2026-022'],
  'Malé Local Market': ['DEMO-ID', 'K. Malé', ''],
  'Kochi Imports (IN)': ['', 'Kochi, India', 'IMP-2026-03'],
  'Colombo Fresh (LK)': ['', 'Colombo, Sri Lanka', 'IMP-2026-05'],
};
const CODE_PREFIX = { fruit: 'FRU', vegetable: 'VEG', herb: 'HRB', other: 'OTH' };

// name, type, island, contact, phone, credit MVR, terms, order chance/day, order size multiplier
const CUSTOMERS = [
  ['Demo Customer 1', 'resort', '', 'Demo Contact 1', '', 150000, 30, 0.38, 3.2],
  ['Demo Customer 2', 'resort', '', 'Demo Contact 2', '', 120000, 30, 0.33, 2.8],
  ['Demo Customer 3', 'resort', '', 'Demo Contact 3', '', 100000, 30, 0.30, 2.4],
  ['Demo Customer 4', 'guesthouse', '', 'Demo Contact 4', '', 25000, 14, 0.30, 1.0],
  ['Demo Customer 5', 'guesthouse', '', 'Demo Contact 5', '', 20000, 14, 0.28, 0.9],
  ['Demo Customer 6', 'guesthouse', '', 'Demo Contact 6', '', 15000, 14, 0.22, 0.7],
  ['Demo Customer 7', 'restaurant', '', 'Demo Contact 7', '', 12000, 7, 0.45, 0.6],
  ['Demo Customer 8', 'restaurant', '', 'Demo Contact 8', '', 10000, 7, 0.40, 0.55],
  ['Demo Customer 9', 'restaurant', '', 'Demo Contact 9', '', 12000, 7, 0.40, 0.65],
  ['Demo Customer 10', 'retail', '', 'Demo Contact 10', '', 30000, 14, 0.35, 1.6],
  ['Demo Customer 11', 'retail', '', 'Demo Contact 11', '', 20000, 14, 0.30, 1.3],
];

const restockDays = shelf => (shelf <= 4 ? 2 : shelf <= 7 ? 3 : shelf <= 14 ? 5 : 8);

function roundQty(q, unit, down = false) {
  if (unit === 'kg') {
    const r = down ? Math.floor(q * 2) / 2 : Math.round(q * 2) / 2;
    return round3(r);
  }
  return Math.max(down ? Math.floor(q) : Math.round(q), 0);
}

// Set when the demo book has been cleared for real use. A later restart must
// not refill an empty database; --reset deletes the file and demo can return.
function realBook() {
  return db.prepare(`SELECT value FROM settings WHERE key = 'no_demo'`).get()?.value === '1';
}

export function maybeSeed() {
  if (process.env.BAAZARU_NO_DEMO === '1' || realBook()) return false;
  if (db.prepare(`SELECT COUNT(*) AS n FROM products`).get().n > 0) return false;
  seedDemo();
  return true;
}

function seedDemo() {
  const t0 = localDateStr();

  const products = [];
  const customers = [];
  tx(() => {
    const insP = db.prepare(
      `INSERT INTO products (name, category, unit, shelf_life_days, cost, price, code) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const perCategory = {};
    const perZone = { CR: 0, DS: 0 };
    for (const [name, cat, unit, shelf, cost, price, daily, weight, supplier] of PRODUCTS) {
      perCategory[cat] = (perCategory[cat] ?? 0) + 1;
      const code = `${CODE_PREFIX[cat]}-${String(perCategory[cat]).padStart(3, '0')}`;
      // Short-life produce goes in the cold room, the rest in the dry store.
      const zone = shelf <= 7 ? 'CR' : 'DS';
      const bin = `${zone}-${String(++perZone[zone]).padStart(2, '0')}`;
      const id = Number(insP.run(name, cat, unit, shelf, cost * 100, price * 100, code).lastInsertRowid);
      products.push({ id, name, unit, shelf, cost: cost * 100, price: price * 100, daily, weight, supplier, bin });
    }
    const insC = db.prepare(
      `INSERT INTO customers (name, type, island, contact, phone, credit_limit, terms_days) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const [name, type, island, contact, phone, credit, terms, freq, mult] of CUSTOMERS) {
      const id = Number(insC.run(name, type, island, contact, phone, credit * 100, terms).lastInsertRowid);
      customers.push({ id, name, type, terms, freq, mult });
    }
  });

  for (let off = -28; off <= 0; off++) {
    const d = addDays(t0, off);
    writeOffExpired(d, t0);
    restock(products, d);
    genOrders(products, customers, d, t0);
  }

  // A couple of confirmed orders for tomorrow so the deliveries panel has depth
  // (created today, delivered tomorrow — created_at must never be in the future).
  for (const cust of [customers[0], customers[9]]) {
    makeOrder(products, cust, t0, addDays(t0, 1), t0);
  }

  settlePayments(customers, t0);
  seedTasks(customers, t0);
}

// Start-of-day housekeeping: write off stock that expired before this day.
// Freshly expired lots occasionally linger un-written-off (as they do in real
// warehouses) so the inventory page has something to clean up.
function writeOffExpired(d, t0) {
  const rows = db.prepare(
    `SELECT id, qty_left, expires_at FROM lots WHERE qty_left > 0 AND expires_at < ?`).all(d);
  for (const lot of rows) {
    const stale = addDays(lot.expires_at, 2) < d;
    if (stale || chance(0.85)) writeOffLot(lot.id, lot.qty_left, { type: 'damage', note: 'Expired', at: d });
  }
}

function restock(products, d) {
  const suppliers = Object.keys(FARMERS);
  const shipments = new Map();
  const shipmentFor = supplier => {
    if (!shipments.has(supplier)) {
      const reference = `${supplier} · ${d}`;
      const boatNote = `BN-${d.slice(5, 7)}${d.slice(8, 10)}-${String(suppliers.indexOf(supplier) + 1).padStart(2, '0')}`;
      shipments.set(supplier, {
        id: findOrCreateShipment({
          reference, supplier, origin: FARMERS[supplier][1], arrived_at: d, notes: '',
        }).shipment.id,
        boatNote,
      });
    }
    return shipments.get(supplier);
  };
  for (const p of products) {
    // Actual sell-through is well below the headline daily estimate: each
    // product lands on roughly a quarter of the day's order lines.
    const demand = p.daily * 0.3;
    const avail = availableQty(p.id, d);
    if (avail >= demand * 2) continue;
    const qty = roundQty(demand * restockDays(p.shelf) * (1.0 + rnd() * 0.4), p.unit);
    if (qty <= 0) continue;
    let life = p.shelf + (chance(0.3) ? (chance(0.5) ? 1 : -1) : 0);
    life = Math.max(life, 1);
    const shipment = shipmentFor(p.supplier);
    const [idCard, island, agreement] = FARMERS[p.supplier];
    const lotId = receiveLot({
      product_id: p.id,
      qty,
      unit_cost: Math.round(p.cost * (0.9 + rnd() * 0.2)),
      supplier: p.supplier,
      received_at: d,
      expires_at: addDays(d, life),
      shipment_id: shipment.id,
      bin_location: p.bin,
      boat_note: shipment.boatNote,
      farmer_id_card: idCard,
      farmer_island: island,
      farmer_agreement: agreement,
    });
    // Banana bunches are weighed with the stalk on; the stalks come off here.
    if (p.name.startsWith('Banana')) {
      const stems = roundQty(qty * (0.05 + rnd() * 0.04), p.unit);
      if (stems > 0) writeOffLot(lotId, stems, { type: 'stem_weight', note: 'Stalks trimmed at receiving', at: d });
    }
  }
}

function sampleProducts(products, n) {
  const pool = [...products];
  const picked = [];
  while (picked.length < n && pool.length) {
    const totalW = pool.reduce((s, p) => s + p.weight, 0);
    let r = rnd() * totalW;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].weight;
      if (r <= 0) { idx = i; break; }
    }
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

function makeOrder(products, cust, created, delivery, t0) {
  const items = [];
  for (const p of sampleProducts(products, rint(3, 7))) {
    const want = p.daily * 0.18 * cust.mult * (0.6 + rnd());
    const avail = availableQty(p.id, delivery);
    const qty = roundQty(Math.min(want, avail), p.unit, true);
    if (qty <= 0) continue;
    items.push({ product_id: p.id, qty, unit_price: p.price });
  }
  if (!items.length) return null;
  const hh = String(rint(6, 16)).padStart(2, '0');
  const mm = String(rint(0, 59)).padStart(2, '0');
  const status = delivery < t0 ? 'delivered' : 'pending';
  try {
    return createOrder({
      customer_id: cust.id,
      delivery_date: delivery,
      created_at: `${created}T${hh}:${mm}:00`,
      status,
      items,
    });
  } catch {
    return null; // clamped quantities make this rare; skip rather than fail the seed
  }
}

function genOrders(products, customers, d, t0) {
  for (const cust of customers) {
    if (!chance(cust.freq)) continue;
    const nextDay = cust.type === 'resort' && chance(0.5);
    const delivery = nextDay ? addDays(d, 1) : d;
    const orderId = makeOrder(products, cust, d, delivery, t0);
    // Some of today's runs are already delivered by mid-morning.
    if (orderId && d === t0 && delivery === t0 && chance(0.55)) {
      db.prepare(`UPDATE orders SET status = 'delivered' WHERE id = ?`).run(orderId);
    }
  }
}

function settlePayments(customers, t0) {
  const byId = new Map(customers.map(c => [c.id, c]));
  const lagFor = type =>
    type === 'restaurant' ? rint(2, 12)
    : type === 'retail' ? rint(4, 18)
    : type === 'guesthouse' ? rint(7, 20)
    : rint(20, 40); // resorts pay slowly
  const orders = db.prepare(
    `SELECT id, customer_id, delivery_date, total FROM orders WHERE status = 'delivered' AND delivery_date < ?`).all(t0);
  const insPay = db.prepare(`INSERT INTO payments (order_id, amount, method, paid_at) VALUES (?, ?, ?, ?)`);
  const markPaid = db.prepare(`UPDATE orders SET status = 'paid' WHERE id = ?`);
  for (const o of orders) {
    if (o.total <= 0) continue;
    const cust = byId.get(o.customer_id);
    const payDate = addDays(o.delivery_date, lagFor(cust.type));
    if (payDate <= t0) {
      insPay.run(o.id, o.total, chance(0.75) ? 'transfer' : 'cash', payDate);
      markPaid.run(o.id);
    } else if (cust.type === 'retail' && addDays(o.delivery_date, 10) <= t0 && chance(0.3)) {
      insPay.run(o.id, Math.round(o.total / 2), 'transfer', addDays(o.delivery_date, 5));
    }
  }
}

function seedTasks(customers, t0) {
  const ins = db.prepare(
    `INSERT INTO tasks (customer_id, title, due_date, done, created_at) VALUES (?, ?, ?, ?, ?)`);
  ins.run(customers[6].id, 'Collect cheque — overdue invoices', t0, 0, `${t0}T08:00:00`);
  ins.run(customers[0].id, 'Confirm weekend produce list with the kitchen', addDays(t0, 1), 0, `${t0}T08:00:00`);
  ins.run(customers[1].id, 'Ask Chef Marco about mango pre-orders for peak season', addDays(t0, 1), 0, `${t0}T08:05:00`);
  ins.run(null, 'Intro visit — new guesthouse opening on Dhiffushi', addDays(t0, 2), 0, `${t0}T08:10:00`);
  ins.run(null, 'Renegotiate watermelon rate with Thoddoo co-op', addDays(t0, 3), 0, `${t0}T08:15:00`);
  ins.run(customers[9].id, 'Send July statement', addDays(t0, -1), 1, `${addDays(t0, -2)}T09:00:00`);
}
