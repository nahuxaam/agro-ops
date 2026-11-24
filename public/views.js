import { verifyWithSignature } from './sign.js';
// Page renderers and modals.
import {
  $, $$, addDaysStr, api, busyClick, closeAllModals, confirmModal, daysLeftLabel, esc, fmtDate,
  fmtQty, lotBadge, money, moneyShort, openModal, orderBadge, parseMoney, relDay, toast,
  todayStr, typeChip,
} from './helpers.js';
import { bindIslandPair, codeValue, islandValue } from './islands.js';
import { cropPicker } from './crop-picker.js';
import { posMark } from './pos-marks.js';
import {
  barChartH, chartCard, chartTableHtml, donutChart, lineChart, wireChartCards,
} from './charts.js';

let refresh = () => {};
export function setRefresh(fn) { refresh = fn; }

// Current user, for role-aware rendering. The server enforces every rule —
// this only hides controls that would 403.
let me = null;
export function setCurrentUser(u) { me = u; }
const canSell = () => me?.role === 'admin' || me?.role === 'sales';
const canOps = () => me?.role === 'operations' || me?.role === 'operations_hod' || me?.role === 'admin';
const canApprove = () => me?.role === 'operations_hod' || me?.role === 'admin';
const isAdmin = () => me?.role === 'admin';
const BOAT_EDITORS = new Set(['nahuzaam', 'najah', 'ibbe']);
const canEditBoats = () => isAdmin() || BOAT_EDITORS.has(String(me?.username || '').toLowerCase());
const POS_CATALOG = new Set(['dhaashin']);
const canPosCatalog = () => isAdmin() || POS_CATALOG.has(String(me?.username || '').toLowerCase());
const ROLE_LABEL = {
  admin: 'Admin',
  sales: 'Sales',
  operations: 'Operations',
  operations_hod: 'Operations HOD',
};
const roleLabel = role => ROLE_LABEL[role] || role;
const ROLE_ORDER = ['sales', 'operations', 'operations_hod', 'admin'];

// ---- undo actions (used by toasts and the order modal) ----
// Toast action fns rethrow on failure so the toast re-arms and Undo can be
// retried; they close open modals first because the undo changes the data
// those modals were rendered from.

const undeliverAction = id => ({
  label: 'Undo',
  fn: async () => {
    try {
      await api(`/api/orders/${id}/undeliver`, { method: 'POST' });
      closeAllModals();
      toast(`Order #${id} is pending again`);
      refresh();
    } catch (err) { toast(err.message, 'err'); throw err; }
  },
});

// Restore mirrors order creation's credit check, so it can 409 with
// CREDIT_LIMIT — offer the same deliberate override.
async function doRestore(id) {
  const attempt = override => api(`/api/orders/${id}/restore`, { body: override ? { override: true } : {} });
  try {
    await attempt(false);
  } catch (err) {
    if (err.data?.code === 'CREDIT_LIMIT') {
      const d = err.data;
      const ok = await confirmModal(
        `Restoring this order puts the customer at ${money(d.exposure + d.order_total)} committed (unpaid + pending) against a ${money(d.credit_limit)} limit. Restore anyway?`,
        { title: 'Over credit limit', confirmLabel: 'Restore anyway' });
      if (!ok) return false;
      await attempt(true);
    } else {
      throw err;
    }
  }
  closeAllModals();
  toast(`Order #${id} restored`);
  refresh();
  return true;
}

const restoreAction = id => ({
  label: 'Undo',
  fn: async () => {
    try { await doRestore(id); }
    catch (err) { toast(err.message, 'err'); throw err; }
  },
});

const voidPaymentAction = paymentId => ({
  label: 'Undo',
  fn: async () => {
    try {
      await api(`/api/payments/${paymentId}/void`, { method: 'POST' });
      closeAllModals();
      toast('Payment removed');
      refresh();
    } catch (err) { toast(err.message, 'err'); throw err; }
  },
});

// ---- small building blocks ----

function tile({ label, value, sub = '', right = '' }) {
  return `<div class="card tile">
    <div class="tile-label">${label}</div>
    <div class="tile-row"><div class="tile-value">${value}</div>${right}</div>
    <div class="tile-sub">${sub}</div>
  </div>`;
}

function panelCard(title, extra, listHtml) {
  return `<div class="card">
    <div class="card-head"><div class="card-title">${title}</div>${extra}</div>
    ${listHtml}
  </div>`;
}

function coverPhrase(days, stock) {
  if (stock < 0.001) return 'Out of stock';
  const n = Number(days);
  const shown = Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
  return `${shown} ${n === 1 ? 'day' : 'days'} of cover`;
}

function reorderCard(reorder) {
  const items = reorder?.items ?? [];
  const total = reorder?.total ?? items.length;
  const count = total
    ? `<span class="reorder-count" aria-label="${total} ${total === 1 ? 'product' : 'products'}">${total}</span>`
    : '';
  const rows = items.map((r, i) => {
    const pct = r.need > 0 ? Math.max(0, Math.min(100, Math.round(r.stock / r.need * 100))) : 0;
    const level = r.out ? 'Out' : 'Low';
    const badge = r.out ? 'b-crit' : 'b-warn';
    return `<li class="reorder-row">
      <span class="reorder-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7">
          <path d="M4.5 8.2 12 4.5l7.5 3.7L12 12 4.5 8.2Z"/><path d="M4.5 8.2V16L12 19.5 19.5 16V8.2"/><path d="M12 12v7.5"/>
        </svg>
      </span>
      <div class="reorder-id">
        <b>${esc(r.name)}</b>
        <span class="reorder-sub">${coverPhrase(r.days_of_stock, r.stock)} · sells ${fmtQty(r.velocity, r.unit)} a day</span>
      </div>
      <div class="reorder-side">
        <span class="reorder-qty">${fmtQty(r.stock, '')} / ${fmtQty(r.need, r.unit)}</span>
        <div class="reorder-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(r.name)}, on hand against 2 days of sales">
          <div class="reorder-fill" style="width:${pct}%"></div>
        </div>
        <span class="badge ${badge}">${level}</span>
      </div>
    </li>`;
  }).join('');
  const more = total > items.length
    ? `<p class="reorder-more"><a class="tile-link" href="#/products">${total - items.length} more in Items</a></p>`
    : '';
  const body = items.length
    ? `<ul class="reorder-list">${rows}</ul>${more}`
    : `<p class="reorder-empty">Nothing is running low. A product shows here when less than 2 days of sales are left on the shelf.</p>`;
  return `<section class="card reorder" aria-labelledby="reorder-title">
    <div class="card-head">
      <h2 class="card-title reorder-title" id="reorder-title">Reorder now ${count}</h2>
      <span class="reorder-rule">Under 2 days of cover</span>
    </div>
    ${body}
  </section>`;
}

const emptyLi = msg => `<li class="empty">${msg}</li>`;

const STOCK_CAT = {
  fruit: ['Fruit', 'var(--chart-1)'],
  vegetable: ['Vegetables', 'var(--chart-2)'],
  herb: ['Herbs', 'var(--chart-3)'],
  other: ['Other', 'var(--chart-4)'],
};
const shareOf = (part, total) => {
  if (!(total > 0)) return '—';
  const p = part / total * 100;
  if (p > 0 && p < 0.5) return '<1%';
  return Math.round(p) + '%';
};

// ---- dashboard ----

// null is the live desk (this month, last 30 days, last 14 days). A year
// switches arrivals, write-offs, and sales to that year's totals.
let dashboardYear = null;

async function renderDashboard(view) {
  const dashPath = dashboardYear ? `/api/dashboard?year=${dashboardYear}` : '/api/dashboard';
  const [d, products] = await Promise.all([api(dashPath), api('/api/products')]);
  const year = d.year || null;
  const years = Array.isArray(d.years) ? d.years : [];
  const byMonth = d.revenue_grain === 'month';
  const past = year != null && year < Number(todayStr().slice(0, 4));
  const low = products
    .filter(p => p.active && p.low_stock)
    .map(p => ({ ...p, need: Math.round(p.velocity * 2 * 1000) / 1000, out: p.stock < 0.001 }))
    .sort((a, b) => a.days_of_stock - b.days_of_stock || a.name.localeCompare(b.name));
  const reorder = { total: low.length, items: low.slice(0, 6) };

  const salesTotal = d.revenue14.reduce((s, p) => s + p.value, 0);
  const shortMonth = ym => (MONTH_NAMES[Number(String(ym).slice(5, 7)) - 1] || '').slice(0, 3) || ym;
  const salesPoints = d.revenue14.map(p => ({
    label: byMonth ? shortMonth(p.date) : fmtDate(p.date),
    value: p.value,
    tip: byMonth ? `${shortMonth(p.date)} ${p.date.slice(0, 4)}` : fmtDate(p.date),
  }));
  const salesChart = chartCard({
    title: 'Sales',
    sub: byMonth ? `${year} · ${money(salesTotal)}` : 'last 14 days · MVR',
    render: (h, t) => lineChart(h, t, { points: salesPoints, yFmt: moneyShort }),
    tableHtml: chartTableHtml(
      [byMonth ? 'Month' : 'Day', 'Sales'],
      d.revenue14.map(p => [byMonth ? `${shortMonth(p.date)} ${p.date.slice(0, 4)}` : fmtDate(p.date), money(p.value)]),
    ),
  });
  const topChart = chartCard({
    title: 'Top products',
    sub: byMonth ? `${year} · revenue, MVR` : 'last 7 days · revenue, MVR',
    render: (h, t) => barChartH(h, t, {
      rows: d.top_products7.map(p => ({
        label: p.name, value: p.value,
        tip: `${fmtQty(p.qty, p.unit)} · ${money(p.value)}`,
      })),
      vFmt: moneyShort,
    }),
    tableHtml: chartTableHtml(['Product', 'Qty', 'Revenue'],
      d.top_products7.map(p => [esc(p.name), fmtQty(p.qty, p.unit), money(p.value)])),
  });

  const stock = d.stock ?? { value: 0, by_product: [], by_category: [] };
  const stockEmpty = past ? `Nothing left from ${year}.` : 'No stock on hand yet.';
  const stockChart = chartCard({
    title: 'On hand', sub: 'at cost · MVR',
    render: (h, t) => barChartH(h, t, {
      rows: stock.by_product.map(p => ({
        label: p.name, value: p.value,
        tip: p.count
          ? `${p.count} other product${p.count === 1 ? '' : 's'} · ${money(p.value)}`
          : `${fmtQty(p.qty, p.unit)} · ${money(p.value)}`,
      })),
      vFmt: moneyShort,
      empty: stockEmpty,
    }),
    tableHtml: stock.by_product.length
      ? chartTableHtml(['Product', 'On hand', 'Value'], stock.by_product.map(p => [
        esc(p.name),
        p.count ? `${p.count} product${p.count === 1 ? '' : 's'}` : fmtQty(p.qty, p.unit),
        money(p.value),
      ]))
      : `<p class="loading">${stockEmpty}</p>`,
  });
  const categoryChart = chartCard({
    title: 'By category', sub: 'share of stock, at cost',
    render: (h, t) => donutChart(h, t, {
      slices: stock.by_category.map(c => {
        const [label, color] = STOCK_CAT[c.category] ?? [c.category, 'var(--chart-4)'];
        return {
          label, color, value: c.value, display: moneyShort(c.value),
          tip: `${money(c.value)} · ${shareOf(c.value, stock.value)}`,
        };
      }),
      center: moneyShort(stock.value),
      centerSub: 'MVR',
      empty: stock.by_product.length ? 'Stock on hand has no cost yet.' : stockEmpty,
    }),
    tableHtml: stock.by_category.length
      ? chartTableHtml(['Category', 'Value', 'Share'], stock.by_category.map(c => [
        esc((STOCK_CAT[c.category] ?? [c.category])[0]),
        money(c.value),
        esc(shareOf(c.value, stock.value)),
      ]))
      : `<p class="loading">${stockEmpty}</p>`,
  });

  const arrived = d.arrived_month ?? { value: 0, receipts: 0 };
  const yearPick = `<div class="year-pick">
      <select data-year-pick aria-label="Year">
        <option value=""${!year ? ' selected' : ''}>Now</option>
        ${years.map(y => `<option value="${y}"${year === y ? ' selected' : ''}>${y}</option>`).join('')}
      </select>
    </div>`;
  view.innerHTML = `
    ${yearPick}
    <div class="grid-tiles">
      ${tile({
        label: past ? `On hand from ${year}` : 'Stock on hand', value: money(stock.value),
        sub: past
          ? (stock.products ? 'still on the shelf · at cost' : 'nothing left from that year')
          : stock.products
            ? `${stock.products} item${stock.products === 1 ? '' : 's'} · at cost`
            : 'nothing on hand',
      })}
      ${tile({
        label: year ? `Arrived in ${year}` : 'Arrived this month', value: money(arrived.value),
        sub: arrived.receipts
          ? `${arrived.receipts} receipt${arrived.receipts === 1 ? '' : 's'} · at cost`
          : 'nothing received',
      })}
      ${tile({
        label: 'Expiring', value: money(past ? 0 : d.at_risk.value),
        sub: past
          ? (stock.products ? 'what is left is on the shelf today' : `nothing from ${year} is still on the shelf`)
          : d.at_risk.lots
            ? `${d.at_risk.lots} lot${d.at_risk.lots === 1 ? '' : 's'} within 3 days · <a class="tile-link" href="#/sell-first">sell first →</a>`
            : 'nothing within 3 days',
      })}
      ${tile({
        label: year ? `Written off in ${year}` : 'Written off', value: money(d.waste30.value),
        sub: d.waste30.pct === null
          ? (year ? `nothing written off in ${year}` : 'nothing written off in 30 days')
          : `${d.waste30.pct.toFixed(1)}% of stock handled · ${year || 'last 30 days'}`,
      })}
    </div>
    ${past && !stock.products ? '' : `<div class="grid-charts">${stockChart}${categoryChart}</div>`}
    ${past ? '' : reorderCard(reorder)}
    <div class="grid-charts">${salesChart}${topChart}</div>
    <div class="grid-panel">
      ${panelCard('Deliveries due', '', `<ul class="plist">
        ${d.panel.deliveries.length ? d.panel.deliveries.map(o => `
          <li><div class="grow"><b>${esc(o.customer)}</b>
              <span class="sub">#${o.id} · ${o.items} line${o.items === 1 ? '' : 's'} · ${relDay(o.delivery_date)}</span></div>
            <span class="val">${money(o.total)}</span>
            ${canSell() ? `<button class="btn btn-sm" data-deliver="${o.id}">Deliver</button>` : ''}</li>`).join('')
        : emptyLi('No pending deliveries.')}
      </ul>`)}
      ${past
        ? panelCard('Expiring stock', '', `<ul class="plist">${emptyLi(stock.products ? 'What is left is on the shelf today.' : `Nothing left from ${year}.`)}</ul>`)
        : panelCard('Expiring stock', '<a class="tile-link" href="#/sell-first">all →</a>', `<ul class="plist">
        ${d.panel.expiring.length ? d.panel.expiring.map(l => `
          <li><div class="grow"><b>${esc(l.product)}</b>
              <span class="sub">${fmtQty(l.qty_left, l.unit)} · ${daysLeftLabel(l.days_left).toLowerCase()}</span></div>
            <span class="val">${money(l.value)}</span></li>`).join('')
        : emptyLi('Nothing close to expiry.')}
      </ul>`)}
      ${panelCard('Overdue invoices', '', `<ul class="plist">
        ${d.panel.overdue.length ? d.panel.overdue.map(o => `
          <li><div class="grow"><b>${esc(o.customer)}</b>
              <span class="sub">#${o.order_id} · ${o.days_over} day${o.days_over === 1 ? '' : 's'} over · ${esc(o.phone)}</span></div>
            <span class="val">${money(o.outstanding)}</span>
            <button class="btn btn-sm" data-order="${o.order_id}">View</button></li>`).join('')
        : emptyLi('Nothing overdue. 🎉')}
      </ul>`)}
      ${panelCard('Follow-ups', canSell() ? '<button class="btn btn-sm" data-new-task>+ Add</button>' : '', `<ul class="plist">
        ${d.panel.tasks.length ? d.panel.tasks.map(t => `
          <li><input type="checkbox" class="task-check" data-task="${t.id}" aria-label="Done" ${canSell() ? '' : 'disabled'}>
            <div class="grow">${esc(t.title)}
              <span class="sub">${t.customer ? esc(t.customer) + ' · ' : ''}due ${relDay(t.due_date)}</span></div></li>`).join('')
        : emptyLi('No open follow-ups.')}
      </ul>`)}
    </div>`;
  wireChartCards(view);

  view.addEventListener('click', async e => {
    const del = e.target.closest('[data-deliver]');
    if (del) {
      const id = +del.dataset.deliver;
      del.disabled = true;
      try {
        await api(`/api/orders/${id}/deliver`, { method: 'POST' });
        toast(`Order #${id} delivered`, 'ok', { action: undeliverAction(id) });
        refresh();
      } catch (err) { toast(err.message, 'err'); del.disabled = false; }
      return;
    }
    const ord = e.target.closest('[data-order]');
    if (ord) return orderDetailModal(+ord.dataset.order);
    if (e.target.closest('[data-new-task]')) return taskModal();
  });
  view.addEventListener('change', async e => {
    const yearPick = e.target.closest('[data-year-pick]');
    if (yearPick) {
      const next = yearPick.value ? Number(yearPick.value) : null;
      if (next !== dashboardYear) { dashboardYear = next; refresh(); }
      return;
    }
    const cb = e.target.closest('[data-task]');
    if (cb && cb.checked) {
      try { await api(`/api/tasks/${cb.dataset.task}`, { method: 'PATCH', body: { done: true } }); toast('Done'); refresh(); }
      catch (err) { toast(err.message, 'err'); cb.checked = false; }
    }
  });
}

// ---- sell first ----

async function renderSellFirst(view) {
  const rows = await api('/api/sell-first');
  if (!rows.length) {
    view.innerHTML = `<div class="card card-pad"><p class="muted">Nothing is close to expiry — the shelf is fresh. 🌿</p></div>`;
    return;
  }
  view.innerHTML = `<div class="card tbl-wrap"><table class="tbl">
    <thead><tr>
      <th>Product</th><th>Expires</th><th class="num">Qty left</th><th class="num">At stake</th>
      <th>Offer at</th><th>Likely buyers</th><th></th>
    </tr></thead>
    <tbody>${rows.map(r => `
      <tr>
        <td><b>${esc(r.product)}</b><span class="sub">lot #${r.lot_id} · ${esc(r.supplier)}</span></td>
        <td>${lotBadge(r.days_left <= 1 ? 'critical' : 'soon', r.days_left)}<span class="sub">${fmtDate(r.expires_at)}</span></td>
        <td class="num">${fmtQty(r.qty_left, r.unit)}</td>
        <td class="num">${money(r.value)}</td>
        <td><b>${money(r.suggested_price)}</b> <span class="chip">−${r.suggested_discount_pct}%</span>
          <span class="sub strike">${money(r.price)} / ${esc(r.unit)}</span></td>
        <td>${r.buyers.length ? r.buyers.map(b => canSell()
          ? `<button class="chip chip-btn" data-offer data-cust="${b.id}" data-name="${esc(b.name)}"
              data-product="${esc(r.product)}" data-price="${r.suggested_price}"
              title="Bought ${b.qty} ${esc(r.unit)} in 60 days · ${esc(b.phone)}">${esc(b.name)}</button>`
          : `<span class="chip" title="Bought ${b.qty} ${esc(r.unit)} in 60 days · ${esc(b.phone)}">${esc(b.name)}</span>`).join(' ')
          : '<span class="muted">no history</span>'}</td>
        <td class="actions">${canSell() ? `<button class="btn btn-sm" data-offer data-product="${esc(r.product)}" data-price="${r.suggested_price}">Follow-up</button>` : ''}</td>
      </tr>`).join('')}
    </tbody></table></div>
    <p class="hint" style="margin-top:10px">Suggested markdowns: 20% inside 3 days, 40% on the last two days — selling below list still beats writing it off.</p>`;

  view.addEventListener('click', e => {
    const b = e.target.closest('[data-offer]');
    if (!b) return;
    const name = b.dataset.name;
    taskModal({
      title: `Offer ${b.dataset.product} at ${money(+b.dataset.price)}${name ? ' — call ' + name : ''}`,
      customerId: b.dataset.cust ? +b.dataset.cust : null,
    });
  });
}

const payLabel = m => ({ cash: 'Cash', transfer: 'Transfer', cheque: 'Cheque', card: 'Card' }[m] || m || '');

function pickSlipFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.click();
  });
}

async function uploadSlip(orderId, file) {
  if (file.size > 6_000_000) throw new Error('Slip must be under 6 MB');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
  if (!data) throw new Error('Could not read that file');
  await api(`/api/orders/${orderId}/slip`, { body: { type: file.type, data } });
}

async function orderDetailModal(id) {
  let d;
  try { d = await api('/api/orders/' + id); } catch (err) { return toast(err.message, 'err'); }
  const { order: o, customer: c, items, payments } = d;
  const outstanding = o.total - d.paid;
  const overdue = o.status === 'delivered' && outstanding > 0 && addDaysStr(o.delivery_date, c.terms_days) < todayStr();

  const m = openModal({
    title: `${o.channel === 'pos' ? 'Sale' : 'Bill'} #${o.id} — ${c.name}`,
    wide: true,
    body: `
      <p class="muted mb">${orderBadge({ ...o, overdue })} &nbsp;delivery ${fmtDate(o.delivery_date)} · terms ${c.terms_days} days${o.notes ? ` · “${esc(o.notes)}”` : ''}</p>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
        <tbody>${items.map(it => `
          <tr><td>${esc(it.product)}<span class="sub">${it.lots.map(l => `lot #${l.lot_id} · exp ${fmtDate(l.expires_at)}`).join(' · ')}</span></td>
            <td class="num">${fmtQty(it.qty, it.unit)}</td>
            <td class="num">${money(it.unit_price)}</td>
            <td class="num">${money(it.line_total)}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="order-total">
        ${d.paid > 0 ? `<span>Paid ${money(d.paid)} ·</span>` : ''}
        ${o.status === 'delivered' ? `<span>Outstanding</span><b>${money(outstanding)}</b>` : `<span>Total</span><b>${money(o.total)}</b>`}
      </div>
      ${payments.length ? `<p class="hint">Payments: ${payments.map(p =>
        `${money(p.amount)} ${esc(payLabel(p.method))} on ${fmtDate(p.paid_at)}
         ${p.method === 'transfer' ? (p.has_slip
           ? `<a class="btn btn-sm" href="/api/orders/${o.id}/slip" target="_blank" rel="noopener">View slip</a>`
           : (canSell() ? `<button type="button" class="btn btn-sm" data-slip-upload>Upload slip</button>` : '')) : ''}
         ${canSell() ? `<button class="btn btn-sm btn-ghost btn-danger" data-void="${p.id}" data-amount="${p.amount}">Void</button>` : ''}`).join(' · ')}</p>` : ''}`,
    footer: `
      ${o.status !== 'cancelled' ? `<a class="btn" href="/print/delivery-note/${o.id}" target="_blank" rel="noopener">Delivery note</a>` : ''}
      ${o.status === 'pending' ? `<a class="btn" href="/print/invoice/${o.id}" target="_blank" rel="noopener">Pro forma invoice</a>` : ''}
      ${o.status === 'delivered' || o.status === 'paid' ? `<a class="btn" href="/print/invoice/${o.id}" target="_blank" rel="noopener">Invoice</a>` : ''}
      ${canSell() ? `
        ${(o.status === 'delivered' || o.status === 'paid') && d.paid === 0
          ? `<button class="btn" data-undeliver>Undo delivery</button>` : ''}
        ${o.status === 'cancelled' && !o.voided ? `<button class="btn btn-primary" data-restore>Restore order</button>` : ''}
        ${o.status === 'pending' ? `<button class="btn btn-danger" data-cancel>Cancel order</button>
          <button class="btn btn-primary" data-deliver>Mark delivered</button>` : ''}
        ${o.channel === 'pos' && o.status === 'paid' ? `<button class="btn btn-danger" data-cancel>Cancel sale</button>` : ''}
        ${o.status === 'delivered' ? `<button class="btn btn-primary" data-pay>Record payment</button>` : ''}` : ''}
      <button class="btn" data-close>Close</button>`,
  });

  const slipBtn = $('[data-slip-upload]', m.modal);
  if (slipBtn) slipBtn.addEventListener('click', async () => {
    const file = await pickSlipFile();
    if (!file) return;
    slipBtn.disabled = true;
    try {
      await uploadSlip(o.id, file);
      toast('Transfer slip saved');
      slipBtn.replaceWith(Object.assign(document.createElement('a'), {
        className: 'btn btn-sm', href: `/api/orders/${o.id}/slip`, target: '_blank', rel: 'noopener', textContent: 'View slip',
      }));
    } catch (err) { toast(err.message, 'err'); slipBtn.disabled = false; }
  });
  const deliverBtn = $('[data-deliver]', m.modal);
  if (deliverBtn) busyClick(deliverBtn, async () => {
    try {
      await api(`/api/orders/${o.id}/deliver`, { method: 'POST' });
      toast(`Order #${o.id} delivered`, 'ok', { action: undeliverAction(o.id) });
      m.close(); refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
  const cancelBtn = $('[data-cancel]', m.modal);
  if (cancelBtn) busyClick(cancelBtn, async () => {
    const sale = o.channel === 'pos';
    const ok = await confirmModal(
      sale ? 'Cancel this sale and return the stock to the shelf?' : 'Cancel this order and return the stock to the shelf?',
      { confirmLabel: sale ? 'Cancel sale' : 'Cancel order', danger: true });
    if (!ok) return;
    try {
      await api(`/api/orders/${o.id}/cancel`, { method: 'POST' });
      toast(`${sale ? 'Sale' : 'Order'} #${o.id} cancelled`, 'ok', { action: restoreAction(o.id) });
      m.close(); refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
  const undeliverBtn = $('[data-undeliver]', m.modal);
  if (undeliverBtn) busyClick(undeliverBtn, async () => {
    try {
      await api(`/api/orders/${o.id}/undeliver`, { method: 'POST' });
      toast(`Order #${o.id} is pending again`);
      m.close(); refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
  const restoreBtn = $('[data-restore]', m.modal);
  if (restoreBtn) busyClick(restoreBtn, async () => {
    try { await doRestore(o.id); } // closes this modal itself on success
    catch (err) { toast(err.message, 'err'); }
  });
  m.modal.addEventListener('click', async e => {
    const voidBtn = e.target.closest('[data-void]');
    if (!voidBtn || voidBtn.disabled) return;
    voidBtn.disabled = true; // before the confirm — a double-click must not re-enter
    const sale = o.channel === 'pos';
    const ok = await confirmModal(
      sale ? 'Void this sale and return the stock to the shelf?' : `Remove this payment of ${money(+voidBtn.dataset.amount)}?`,
      { confirmLabel: sale ? 'Void sale' : 'Void payment', danger: true });
    if (!ok) { voidBtn.disabled = false; return; }
    try {
      await api(`/api/payments/${voidBtn.dataset.void}/void`, { method: 'POST' });
      toast(sale ? `Sale #${o.id} voided` : 'Payment removed');
      m.close(); refresh();
    } catch (err) { toast(err.message, 'err'); voidBtn.disabled = false; }
  });
  $('[data-pay]', m.modal)?.addEventListener('click', () => {
    m.close();
    paymentModal({ orderId: o.id, customerName: c.name, outstanding });
  });
}

function paymentModal({ orderId, customerName, outstanding }) {
  const m = openModal({
    title: 'Record payment',
    body: `
      <p class="muted mb">Order #${orderId} — ${esc(customerName)} · outstanding <b>${money(outstanding)}</b></p>
      <div class="form-grid">
        <div class="field"><label>Amount (MVR)</label>
          <input name="amount" type="number" step="0.01" min="0.01" value="${(outstanding / 100).toFixed(2)}"></div>
        <div class="field"><label>Method</label>
          <select name="method"><option value="transfer">Bank transfer</option><option value="cash">Cash</option>
            <option value="cheque">Cheque</option><option value="card">Card</option></select></div>
      </div>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>Save payment</button>`,
  });
  busyClick($('[data-save]', m.modal), async () => {
    const amount = parseMoney($('[name=amount]', m.modal).value);
    if (!Number.isFinite(amount) || amount <= 0) return toast('Enter a valid amount', 'err');
    if (amount > outstanding) return toast(`Only ${money(outstanding)} is outstanding`, 'err');
    try {
      const r = await api(`/api/orders/${orderId}/pay`, { body: { amount, method: $('[name=method]', m.modal).value } });
      toast(r.remaining > 0 ? `Payment saved — ${money(r.remaining)} still due` : 'Paid in full',
        'ok', { action: voidPaymentAction(r.payment_id) });
      m.close(); refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---- inventory ----

const MOVE_TYPES = [
  ['receipt', 'Item Receipt', 'good'],
  ['sales_receipt', 'Sales Receipt', 'blue'],
  ['invoice', 'Invoice', 'blue'],
  ['damage', 'Damage', 'serious'],
  ['weight_loss', 'Weight Loss', 'serious'],
  ['stem_weight', 'Stem Weight', 'serious'],
  ['adjust', 'Inventory Adjust', 'warn'],
  ['transfer', 'Inter Warehouse Transfer', ''],
];
const MOVE = Object.fromEntries(MOVE_TYPES.map(([key, label, kind]) => [key, { label, kind }]));

const moveBadge = (type, note) => {
  const m = MOVE[type] ?? { label: type, kind: '' };
  return `<span class="badge${m.kind ? ' b-' + m.kind : ''}"${note ? ` title="${esc(note)}"` : ''}>${esc(m.label)}</span>`;
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const monthLabel = ym => `${MONTH_NAMES[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const regMonth = d => MONTH_NAMES[+String(d).slice(5, 7) - 1] || '';
// The register keeps every year, so the date always shows it. Month is only the month.
const regDate = d => {
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return '';
  return `${day} ${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;
};

// Four weeks in every month, so the number says which part of that month it was.
// 1–7 is week 1, 8–14 week 2, 15–21 week 3, and the 22nd through month end is week 4.
function weekNo(d) {
  const day = +String(d).slice(8, 10);
  if (day <= 7) return 1;
  if (day <= 14) return 2;
  if (day <= 21) return 3;
  return 4;
}

const dash = '<span class="muted">—</span>';
const cell = s => (s ? esc(s) : dash);
const subLine = (...bits) => {
  const text = bits.filter(Boolean).map(esc).join(' · ');
  return text ? `<span class="sub">${text}</span>` : '';
};
const decimal2 = laari => (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedMoney = laari => (laari < 0 ? '−' : '') + decimal2(Math.abs(laari));
// Stock counts need the gram-level figure that fmtQty rounds away.
const exactQty = (q, unit) => `${(+q).toLocaleString('en-US', { maximumFractionDigits: 3 })} ${unit}`;
const signedQty = (q, unit) => (q < 0 ? '−' : q > 0 ? '+' : '') + esc(exactQty(Math.abs(q), unit));

let invView = 'register';
let invBin = '';
let invShowAll = false;
let invQuery = '';
const reg = { query: '', type: '', year: '', month: '', limit: 200 };
const LOSS_BIN_NAMES = new Set(['harvest damage', 'harvest weight loss', 'harvest stem weight']);

function shelfBins(lots) {
  const map = new Map();
  for (const l of lots) {
    const name = String(l.bin_location || '').trim();
    if (!name || LOSS_BIN_NAMES.has(name.toLowerCase())) continue;
    const key = name.toLowerCase();
    const row = map.get(key) || { name, n: 0 };
    row.n += 1;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function renderInventory(view) {
  const lots = await api('/api/lots' + (invShowAll ? '?all=1' : ''));
  const live = lots.filter(l => l.qty_left > 0);
  const stockValue = live.filter(l => l.status !== 'expired').reduce((s, l) => s + l.value_cost, 0);
  const atRisk = live.filter(l => l.status === 'soon' || l.status === 'critical');
  const expired = live.filter(l => l.status === 'expired');
  const bins = shelfBins(lots);
  if (invBin && !bins.some(b => b.name.toLowerCase() === invBin.toLowerCase())) invBin = '';
  if (invView === 'bins' && !invBin) invView = 'onhand';

  view.innerHTML = `
    <div class="grid-tiles">
      ${tile({ label: 'Stock on hand, at cost', value: money(stockValue), sub: `${live.length} live lot${live.length === 1 ? '' : 's'}` })}
      ${tile({ label: 'Expiring ≤ 3 days', value: String(atRisk.length), sub: `<a class="tile-link" href="#/sell-first">sell-first list →</a>` })}
      ${tile({ label: 'Expired on shelf', value: String(expired.length), sub: expired.length ? 'record them as Damage under On hand' : 'all clean' })}
    </div>
    <div class="filter-tabs" role="tablist" aria-label="Inventory view">
      ${[['register', 'Stock register'], ['onhand', 'On hand']].map(([k, label]) =>
        `<button class="filter-tab${k === invView ? ' active' : ''}" data-view="${k}" role="tab" aria-selected="${k === invView}">${label}</button>`).join('')}
      <label class="filter-tab bin-pick${invView === 'bins' ? ' active' : ''}">
        <select data-inv-bin aria-label="Bins">
          <option value="" ${invBin ? '' : 'selected'} disabled hidden>Bins</option>
          ${bins.length
            ? bins.map(b => `<option value="${esc(b.name)}" ${b.name === invBin ? 'selected' : ''}>${esc(b.name)} · ${b.n}</option>`).join('')
            : '<option value="" disabled>No bins with stock</option>'}
        </select>
      </label>
    </div>
    <div data-inv-body></div>`;

  const body = $('[data-inv-body]', view);
  const binPick = $('[data-inv-bin]', view);
  let register = null;
  let loading = null;
  const syncTabs = () => {
    $$('[data-view]', view).forEach(t => {
      const on = t.dataset.view === invView;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    binPick.closest('.bin-pick').classList.toggle('active', invView === 'bins');
    if (invView !== 'bins') binPick.value = '';
  };
  const show = async () => {
    if (invView === 'onhand' || invView === 'bins') return paintOnHand(body, lots, invView === 'bins' ? invBin : '');
    if (!register) {
      body.innerHTML = '<div class="loading">Loading the register…</div>';
      try {
        register = await (loading ??= api('/api/stock-register'));
      } catch (err) {
        loading = null;
        if (invView === 'register') body.innerHTML = `<div class="card error-box">${esc(err.message)}</div>`;
        return;
      }
      if (invView !== 'register' || !body.isConnected) return;
    }
    paintRegister(body, register);
  };
  view.addEventListener('click', e => {
    const tab = e.target.closest('[data-view]');
    if (!tab || tab.dataset.view === invView) return;
    invView = tab.dataset.view;
    invBin = '';
    syncTabs();
    show();
  });
  view.addEventListener('change', e => {
    if (e.target !== binPick) return;
    invBin = binPick.value;
    invView = invBin ? 'bins' : 'onhand';
    syncTabs();
    show();
  });
  await show();
}

// Same columns, in the same order, as the paper register.
const REGISTER_COLUMNS = ['#', 'Bin Location', 'Reference Num', 'Date', 'Month', 'Week', 'Farmer Name',
  'Farmer ID Card', 'Farmer Island', 'Farmer Agreement No', 'Item Code', 'Item Description', 'Type',
  'Buying Price (MVR)', 'Received Qty', 'Received Qty Value', 'Boat Note Reference'];
const REGISTER_NUMERIC = new Set(['#', 'Week', 'Buying Price (MVR)', 'Received Qty', 'Received Qty Value']);

function paintRegister(body, rows) {
  const years = [...new Set(rows.map(r => r.date.slice(0, 4)))].filter(Boolean).sort().reverse();
  if (reg.year && !years.includes(reg.year)) reg.year = '';
  const months = [...new Set(rows.map(r => r.date.slice(0, 7)))]
    .filter(ym => !reg.year || ym.startsWith(reg.year))
    .sort().reverse();
  if (reg.month && !months.includes(reg.month)) reg.month = '';
  const monthName = ym => MONTH_NAMES[+ym.slice(5, 7) - 1] || ym;
  body.innerHTML = `
    <div class="filter-row">
      <input type="search" data-reg-q value="${esc(reg.query)}" aria-label="Search the stock register"
        placeholder="Search farmer, item, ref, boat note…">
      <select data-reg-type aria-label="Movement type">
        <option value="">All types</option>
        ${MOVE_TYPES.map(([k, label]) => `<option value="${k}" ${k === reg.type ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <select data-reg-year aria-label="Year">
        <option value="">All years</option>
        ${years.map(y => `<option value="${y}" ${y === reg.year ? 'selected' : ''}>${y}</option>`).join('')}
      </select>
      <select data-reg-month aria-label="Month">
        <option value="">All months</option>
        ${months.map(ym => `<option value="${ym}" ${ym === reg.month ? 'selected' : ''}>${reg.year ? monthName(ym) : monthLabel(ym)}</option>`).join('')}
      </select>
      <button class="btn push-right" type="button" data-reg-export>Export CSV</button>
    </div>
    <div class="card reg-card">
      <div class="reg-wrap">
        <table class="tbl reg">
          <thead><tr>${REGISTER_COLUMNS.map(c => `<th${REGISTER_NUMERIC.has(c) ? ' class="num"' : ''}>${c}</th>`).join('')}</tr></thead>
          <tbody data-reg-rows></tbody>
          <tfoot data-reg-total></tfoot>
        </table>
      </div>
      <div data-reg-more></div>
    </div>`;

  const newestFirst = [...rows].reverse();
  const haystack = new Map(rows.map(r => [r, [
    r.reference, r.bin, r.farmer_name, r.farmer_id_card, r.farmer_island, r.farmer_agreement,
    r.item_code, r.item, r.boat_note, r.note, MOVE[r.type]?.label,
  ].join(' ').toLowerCase()]));
  const filtered = () => {
    const terms = reg.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return newestFirst.filter(r => (!reg.type || r.type === reg.type)
      && (!reg.year || r.date.startsWith(reg.year))
      && (!reg.month || r.date.startsWith(reg.month))
      && terms.every(t => haystack.get(r).includes(t)));
  };
  const paint = () => {
    const shown = filtered();
    const page = shown.slice(0, reg.limit);
    $('[data-reg-rows]', body).innerHTML = page.length ? page.map(registerRowHtml).join('')
      : `<tr><td colspan="${REGISTER_COLUMNS.length}" class="empty">${rows.length
        ? 'No movements match these filters. <button type="button" class="linkish" data-reg-clear>Clear filters</button>'
        : 'No stock movements yet. A boat note and an item receipt add stock.'}</td></tr>`;
    $('[data-reg-total]', body).innerHTML = shown.length ? registerTotalHtml(shown, rows.length) : '';
    $('[data-reg-more]', body).innerHTML = shown.length > page.length
      ? `<div class="reg-more"><button class="btn btn-sm" type="button" data-reg-all>Show all ${shown.length.toLocaleString('en-US')} movements</button></div>`
      : '';
  };

  // Both inventory views paint into the same container, so they assign its
  // handlers rather than adding listeners that would stack up.
  body.oninput = e => {
    if (!e.target.matches('[data-reg-q]')) return;
    reg.query = e.target.value;
    reg.limit = 200;
    paint();
  };
  body.onchange = e => {
    if (e.target.matches('[data-reg-type]')) reg.type = e.target.value;
    else if (e.target.matches('[data-reg-year]')) {
      reg.year = e.target.value;
      if (reg.month && reg.year && !reg.month.startsWith(reg.year)) reg.month = '';
      reg.limit = 200;
      paintRegister(body, rows);
      return;
    } else if (e.target.matches('[data-reg-month]')) reg.month = e.target.value;
    else return;
    reg.limit = 200;
    paint();
  };
  body.onclick = e => {
    if (e.target.closest('[data-reg-all]')) { reg.limit = Infinity; paint(); return; }
    if (e.target.closest('[data-reg-clear]')) {
      Object.assign(reg, { query: '', type: '', year: '', month: '', limit: 200 });
      paintRegister(body, rows);
      return;
    }
    if (e.target.closest('[data-reg-export]')) { exportRegister(filtered()); return; }
    const order = e.target.closest('[data-order]');
    if (order) { orderDetailModal(+order.dataset.order); return; }
    const move = e.target.closest('[data-move]');
    if (move) {
      const same = r => String(r.move_id) === move.dataset.move;
      const row = rows.find(r => same(r) && r.qty < 0) || rows.find(same);
      if (row) movementDetailModal(row);
    }
  };
  paint();
}

function movementForms(r) {
  const forms = [];
  if (r.itn_id) forms.push([`/print/transfer/${r.itn_id}`, 'Print inventory transfer']);
  if (r.type === 'damage' && r.move_id) forms.push([`/print/disposal/${r.move_id}`, 'Print disposal note']);
  if (r.type === 'weight_loss' && r.move_id) forms.push([`/print/weight-loss/${r.move_id}`, 'Print weight loss note']);
  if (r.type === 'stem_weight' && r.move_id) forms.push([`/print/stem-weight/${r.move_id}`, 'Print stem weight note']);
  return forms;
}

function movementDetailModal(r) {
  const forms = movementForms(r);
  const where = r.type === 'adjust'
    ? (r.from_bin ? `<p class="mb">${esc(r.from_bin)}</p>` : '')
    : (r.from_bin || r.to_bin)
      ? `<p class="mb">${esc(r.from_bin || '—')} → ${esc(r.to_bin || '—')}</p>` : '';
  const lossPaper = {
    damage: ['Harvest Damage', 'disposal note'],
    weight_loss: ['Harvest Weight Loss', 'weight loss note'],
    stem_weight: ['Harvest Stem Weight', 'stem weight note'],
  }[r.type];
  const papers = r.type === 'adjust'
    ? 'The lot was set to a counted quantity. The difference is this row.'
    : lossPaper
      ? (r.itn_id
        ? `The inventory transfer records the move into ${lossPaper[0]}. The ${lossPaper[1]} is the write-off.`
        : `This write-off has a ${lossPaper[1]}.`)
      : 'This quantity stays on hand in the bin it moved to.';
  const undoText = r.type === 'adjust'
    ? 'Remove this count? The lot goes back to the quantity it had before.'
    : r.type === 'transfer'
      ? `Remove this move? ${exactQty(Math.abs(r.qty), r.unit)} goes back to ${r.from_bin || 'the original bin'}, and the inventory transfer note is removed.`
      : 'Remove this write-off? The quantity goes back on hand, and its notes are removed.';
  const m = openModal({
    title: r.reference || (MOVE[r.type]?.label ?? 'Movement'),
    body: `
      <p class="mb">${moveBadge(r.type, r.note)}${r.date ? ` · ${esc(regDate(r.date))}` : ''}</p>
      ${r.item ? `<p class="mb"><b>${esc(r.item)}</b>${r.item_code ? ` <span class="muted">${esc(r.item_code)}</span>` : ''}</p>` : ''}
      ${where}
      ${r.qty != null && r.unit ? `<p class="mb">${signedQty(r.qty, r.unit)}</p>` : ''}
      ${r.note ? `<p class="hint mb">${esc(r.note)}</p>` : ''}
      <p class="hint">${papers}</p>`,
    footer: `${isAdmin() && r.move_id ? '<button class="btn btn-danger labor-remove" type="button" data-undo-move>Remove</button>' : ''}
      ${forms.map(([href, label]) => `<a class="btn" href="${href}" target="_blank" rel="noopener">${label}</a>`).join('')}
      <button class="btn" data-close>Close</button>`,
  });
  const undo = $('[data-undo-move]', m.modal);
  if (undo) busyClick(undo, async () => {
    const ok = await confirmModal(undoText, { title: 'Remove movement', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      await api(`/api/stock-moves/${r.move_id}`, { method: 'DELETE' });
      m.close();
      toast('Movement removed');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function movementFromSave(lot, type, body, res, lossBins) {
  if (!res.itn_id && type !== 'damage' && type !== 'weight_loss' && type !== 'stem_weight') return null;
  const note = type === 'damage'
    ? [body.reason, body.note].filter(Boolean).join(' — ')
    : (body.note || '');
  return {
    type,
    reference: res.reference,
    itn_id: res.itn_id,
    move_id: res.id,
    date: body.at || todayStr(),
    item: lot.product,
    item_code: lot.item_code,
    from_bin: lot.bin_location,
    to_bin: type === 'transfer' ? body.to_bin : (lossBins?.[type] || ''),
    qty: body.qty ? -Number(body.qty) : null,
    unit: lot.unit,
    note,
  };
}

function regRef(r) {
  const label = esc(r.reference);
  if (r.order_id) return `<button type="button" class="linkish" data-order="${r.order_id}">${label}</button>`;
  if (r.move_id) return `<button type="button" class="linkish" data-move="${r.move_id}">${label}</button>`;
  return label;
}

async function binMoveModal(lot) {
  let bins, lossBins;
  try { ({ bins, loss_bins: lossBins } = await api('/api/stock-lookups')); }
  catch (err) { return toast(err.message, 'err'); }
  const lossNames = new Set(Object.values(lossBins || {}).map(b => String(b).toLowerCase()));
  const choices = bins.filter(b => b.toLowerCase() !== String(lot.bin_location || '').toLowerCase() && !lossNames.has(b.toLowerCase()));
  const step = lot.unit === 'kg' ? 'any' : '1';
  const m = openModal({
    title: `Move ${lot.product}`,
    body: `
      <p class="muted mb">${esc(exactQty(lot.qty_left, lot.unit))} on hand${lot.bin_location ? ` in ${esc(lot.bin_location)}` : ''}. This stays on hand in the bin it moves to, and an inventory transfer note is written.</p>
      <div class="form-grid">
        <div class="field"><label>Quantity (${esc(lot.unit)})</label>
          <input name="qty" type="number" min="0" max="${lot.qty_left}" step="${step}" value="${lot.qty_left}"></div>
        <div class="field"><label>To bin</label>
          <input name="to_bin" list="bin-move-bins" maxlength="40" autocomplete="off" placeholder="H.Funvilu"></div>
        <div class="field"><label>Date</label>
          <input name="at" type="date" value="${todayStr()}" min="${lot.received_at}" max="${todayStr()}"></div>
        <div class="field"><label>Note <span class="muted">(optional)</span></label>
          <input name="note" maxlength="120"></div>
      </div>
      <datalist id="bin-move-bins">${choices.map(b => `<option value="${esc(b)}">`).join('')}</datalist>`,
    footer: `<button class="btn" data-close type="button">Cancel</button>
      <button class="btn btn-primary" data-save type="button">Move stock</button>`,
  });
  busyClick($('[data-save]', m.modal), async () => {
    const qty = Number.parseFloat($('[name=qty]', m.modal).value);
    const toBin = $('[name=to_bin]', m.modal).value.trim();
    const note = $('[name=note]', m.modal).value.trim();
    const at = $('[name=at]', m.modal).value;
    if (!(qty > 0)) return toast('Enter a quantity', 'err');
    if (qty > lot.qty_left + 1e-6) return toast(`Only ${exactQty(lot.qty_left, lot.unit)} left in this lot`, 'err');
    if (!toBin) return toast('Enter the bin it is moving to', 'err');
    if (lossNames.has(toBin.toLowerCase())) return toast(`${toBin} is off the shelf. Use Update for damage, weight loss, or stem weight.`, 'err');
    if (toBin.toLowerCase() === String(lot.bin_location || '').toLowerCase()) return toast(`This lot is already in ${toBin}`, 'err');
    const body = { type: 'transfer', qty, to_bin: toBin, note, at: at || undefined };
    try {
      const res = await api(`/api/lots/${lot.id}/moves`, { body });
      const sheet = movementFromSave(lot, 'transfer', body, res, lossBins);
      m.close();
      toast(`Moved to ${toBin}${res.reference ? ` · ${res.reference}` : ''}`, 'ok',
        sheet ? { action: { label: 'Forms', fn: () => movementDetailModal(sheet) } } : undefined);
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function registerRowHtml(r) {
  return `<tr>
    <td class="num muted">${r.serial}</td>
    <td>${cell(r.bin)}</td>
    <td>${regRef(r)}</td>
    <td>${regDate(r.date)}</td>
    <td>${regMonth(r.date)}</td>
    <td class="num">${weekNo(r.date)}</td>
    <td>${cell(r.farmer_name)}</td>
    <td>${cell(r.farmer_id_card)}</td>
    <td>${cell(r.farmer_island)}</td>
    <td>${cell(r.farmer_agreement)}</td>
    <td>${cell(r.item_code)}</td>
    <td><b>${esc(r.item)}</b></td>
    <td>${moveBadge(r.type, r.note)}${r.pending ? ' <span class="muted">not delivered</span>' : ''}${
      r.note && r.type === 'damage' ? `<span class="sub">${esc(r.note)}</span>` : ''}</td>
    <td class="num">${decimal2(r.unit_cost)}</td>
    <td class="num">${signedQty(r.qty, r.unit)}</td>
    <td class="num">${signedMoney(r.value)}</td>
    <td>${cell(r.boat_note)}</td>
  </tr>`;
}

// Quantities only add up when every row is in the same unit.
function registerTotalHtml(shown, total) {
  const units = new Set(shown.map(r => r.unit));
  const qty = units.size === 1 ? shown.reduce((s, r) => s + r.qty, 0) : null;
  const value = shown.reduce((s, r) => s + r.value, 0);
  return `<tr>
    <td colspan="14">${shown.length.toLocaleString('en-US')} movement${shown.length === 1 ? '' : 's'}${
      shown.length < total ? ` <span class="muted">of ${total.toLocaleString('en-US')}</span>` : ''}</td>
    <td class="num">${qty === null ? '<span class="muted" title="Mixed units">—</span>' : signedQty(qty, [...units][0])}</td>
    <td class="num">${signedMoney(value)}</td>
    <td></td>
  </tr>`;
}

// Oldest first, like the paper register. Text that opens with = + - @ would
// run as a formula in Excel, so it gets a leading apostrophe.
function exportRegister(rows) {
  const csvCell = v => {
    let s = String(v ?? '');
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [[...REGISTER_COLUMNS, 'Unit', 'Note'], ...[...rows].reverse().map(r => [
    r.serial, r.bin, r.reference, r.date, regMonth(r.date), weekNo(r.date),
    r.farmer_name, r.farmer_id_card, r.farmer_island, r.farmer_agreement, r.item_code, r.item,
    MOVE[r.type]?.label ?? r.type, r.unit_cost / 100, r.qty, r.value / 100, r.boat_note, r.unit, r.note,
  ])].map(cols => cols.map(csvCell).join(','));
  const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `stock-register-${todayStr()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${rows.length.toLocaleString('en-US')} movement${rows.length === 1 ? '' : 's'}`);
}

function paintOnHand(body, lots, bin = '') {
  const pool = bin
    ? lots.filter(l => String(l.bin_location || '').toLowerCase() === bin.toLowerCase())
    : lots;
  body.innerHTML = `
    <div class="filter-row">
      <input type="search" data-inv-q value="${esc(invQuery)}" aria-label="${bin ? `Search lots in ${bin}` : 'Search lots on hand'}"
        placeholder="${bin ? 'Search item, farmer, boat note' : 'Search bin, item, farmer, boat note'}">
      <label class="hint check-label"><input type="checkbox" class="task-check" data-show-all ${invShowAll ? 'checked' : ''}>
        Include finished lots</label>
    </div>
    ${bin ? `<p class="hint mb">${esc(bin)} · ${pool.length} lot${pool.length === 1 ? '' : 's'}</p>` : ''}
    <div class="card tbl-wrap"><table class="tbl">
      <thead><tr><th>Bin</th><th>Item</th><th>Farmer</th><th>Received</th><th>Boat note</th><th>Expires</th>
        <th class="num">Qty left</th><th class="num">Value at cost</th><th class="actions"></th></tr></thead>
      <tbody data-inv-rows></tbody></table></div>`;

  const byId = new Map(lots.map(l => [l.id, l]));
  const haystack = new Map(lots.map(l => [l, [
    l.bin_location, l.product, l.item_code, l.supplier, l.farmer_island, l.farmer_id_card, l.farmer_agreement,
    l.boat_note, l.receipt_ref, l.shipment_reference, `#${l.id}`,
  ].join(' ').toLowerCase()]));
  const paint = () => {
    const terms = invQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = pool.filter(l => terms.every(t => haystack.get(l).includes(t)));
    $('[data-inv-rows]', body).innerHTML = shown.length ? shown.map(onHandRowHtml).join('')
      : `<tr><td colspan="9" class="empty">${pool.length
        ? 'No lots match.'
        : bin ? `Nothing in ${esc(bin)}.`
        : 'Nothing on hand. A boat note and an item receipt add stock.'}</td></tr>`;
  };

  body.oninput = e => {
    if (!e.target.matches('[data-inv-q]')) return;
    invQuery = e.target.value;
    paint();
  };
  body.onchange = e => {
    if (e.target.matches('[data-show-all]')) { invShowAll = e.target.checked; refresh(); }
  };
  body.onclick = e => {
    const ship = e.target.closest('[data-shipment]');
    if (ship) { shipmentDetailModal(+ship.dataset.shipment); return; }
    const moveBin = e.target.closest('[data-move-bin]');
    if (moveBin) { binMoveModal(byId.get(+moveBin.dataset.moveBin)); return; }
    const upd = e.target.closest('[data-update]');
    if (upd) stockUpdateModal(byId.get(+upd.dataset.update));
  };
  paint();
}

function onHandRowHtml(l) {
  const shipment = l.shipment_id
    ? `<button type="button" class="linkish" data-shipment="${l.shipment_id}">${esc(l.shipment_reference)}</button>` : '';
  const boatNote = !l.boat_note ? shipment || dash
    : esc(l.boat_note) + (shipment && l.shipment_reference !== l.boat_note ? `<span class="sub">${shipment}</span>` : '');
  return `<tr>
    <td class="nowrap">${l.bin_location ? `<b>${esc(l.bin_location)}</b>` : dash}</td>
    <td><b>${esc(l.product)}</b>${subLine(l.item_code, `lot #${l.id}`, l.origin_lot_id ? `received as #${l.origin_lot_id}` : '')}</td>
    <td>${cell(l.supplier)}${subLine(l.farmer_island, l.farmer_id_card)}</td>
    <td class="nowrap">${fmtDate(l.received_at)}${subLine(l.receipt_ref)}</td>
    <td>${boatNote}</td>
    <td class="nowrap">${lotBadge(l.status, l.days_left)}<span class="sub">${fmtDate(l.expires_at)}</span></td>
    <td class="num">${fmtQty(l.qty_left, l.unit)}<span class="sub">of ${fmtQty(l.qty_received, l.unit)}</span></td>
    <td class="num">${money(l.value_cost)}<span class="sub">@ ${money(l.unit_cost)} / ${esc(l.unit)}</span></td>
    <td class="actions">${canOps() && l.qty_left > 0
      ? `<button class="btn btn-sm" type="button" data-move-bin="${l.id}">Move</button>
         <button class="btn btn-sm" type="button" data-update="${l.id}">Update</button>` : ''}</td>
  </tr>`;
}

const UPDATE_TYPES = [
  ['damage', 'Damage', 'Moves the quantity to Harvest Damage and takes it off what is on hand. An inventory transfer note and a disposal note are written.'],
  ['weight_loss', 'Weight loss', 'Moves the quantity to Harvest Weight Loss and takes it off what is on hand. An inventory transfer note and a weight loss note are written.'],
  ['stem_weight', 'Stem weight', 'Moves the quantity to Harvest Stem Weight and takes it off what is on hand. An inventory transfer note and a stem weight note are written.'],
  ['adjust', 'Inventory adjust', 'Set the lot to what you counted on the shelf. The difference is recorded.'],
];
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

async function stockUpdateModal(lot) {
  let lossBins;
  try { ({ loss_bins: lossBins } = await api('/api/stock-lookups')); }
  catch (err) { return toast(err.message, 'err'); }
  const t0 = todayStr();
  const step = lot.unit === 'kg' ? 'any' : '1';
  const unit = esc(lot.unit);
  const m = openModal({
    title: `Update stock — ${lot.product}`,
    body: `
      <p class="muted mb">Lot #${lot.id} · ${esc(exactQty(lot.qty_left, lot.unit))} on hand${
        lot.bin_location ? ` in ${esc(lot.bin_location)}` : ''} · bought at ${money(lot.unit_cost)} / ${unit}</p>
      <div class="field">
        <span class="field-label" id="move-type-label">What happened?</span>
        <div class="seg" role="radiogroup" aria-labelledby="move-type-label">
          ${UPDATE_TYPES.map(([k, label], i) =>
            `<label><input type="radio" name="type" value="${k}" ${i === 0 ? 'checked' : ''}><span>${label}</span></label>`).join('')}
        </div>
        <p class="hint" data-type-hint></p>
      </div>
      <div class="form-grid" data-fields></div>
      <div class="form-grid">
        <div class="field"><label>Date</label>
          <input name="at" type="date" value="${t0}" min="${lot.received_at}" max="${t0}"></div>
        <div class="field"><label>Reference <span class="muted">(optional)</span></label>
          <input name="reference" maxlength="40" placeholder="Numbered automatically"></div>
      </div>
      <div class="field" data-note-row><label>Note <span class="muted">(optional)</span></label>
        <input name="note" maxlength="120"></div>`,
    footer: `<button class="btn" data-close type="button">Cancel</button>
      <button class="btn btn-primary" data-save type="button">Write off</button>`,
  });

  const f = name => $(`[name=${name}]`, m.modal);
  const fields = $('[data-fields]', m.modal);
  const save = $('[data-save]', m.modal);
  const type = () => $('[name=type]:checked', m.modal).value;
  const showFields = () => {
    const t = type();
    $('[data-type-hint]', m.modal).textContent = UPDATE_TYPES.find(u => u[0] === t)[2];
    if (t === 'adjust') {
      fields.innerHTML = `
        <div class="field"><label>Counted (${unit})</label>
          <input name="counted" type="number" min="0" step="${step}" value="${lot.qty_left}"></div>
        <div class="field"><span class="field-label">Difference</span><div class="calc" data-calc>No change</div></div>`;
      save.textContent = 'Save count';
      f('counted').addEventListener('input', () => {
        const c = Number.parseFloat(f('counted').value);
        const d = Math.round((c - lot.qty_left) * 1000) / 1000;
        $('[data-calc]', m.modal).textContent = !Number.isFinite(c) || c < 0 ? '—'
          : d === 0 ? 'No change' : `${d > 0 ? '+' : '−'}${exactQty(Math.abs(d), lot.unit)} · ${money(Math.round(Math.abs(d) * lot.unit_cost))}`;
      });
    } else {
      const dest = lossBins?.[t] || '';
      const reasonFields = t === 'damage' ? `
        <div class="field"><label>Damage reason</label>
          <select name="reason">
            <option value="">Choose why…</option>
            ${DAMAGE_REASONS.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}
          </select></div>
        <div class="field"><label>Detail <span class="muted">(optional)</span></label>
          <input name="detail" maxlength="80" placeholder="Which crates, where it sat…"></div>` : '';
      fields.innerHTML = `
        <div class="field"><label>Quantity (${unit}, up to ${lot.qty_left})</label>
          <input name="qty" type="number" min="0" max="${lot.qty_left}" step="${step}" placeholder="0"></div>
        <div class="field"><span class="field-label">Value at cost</span><div class="calc" data-calc>—</div></div>
        ${reasonFields}
        <p class="hint" style="grid-column: 1 / -1">Goes to ${esc(dest)}. It will not stay on hand.</p>`;
      save.textContent = 'Move off the shelf';
      f('qty').addEventListener('input', () => {
        const q = Number.parseFloat(f('qty').value);
        $('[data-calc]', m.modal).textContent = q > 0 ? money(Math.round(q * lot.unit_cost)) : '—';
      });
    }
    const noteRow = $('[data-note-row]', m.modal);
    if (noteRow) noteRow.hidden = t === 'damage';
  };
  m.modal.addEventListener('change', e => { if (e.target.name === 'type') showFields(); });
  showFields();

  busyClick(save, async () => {
    const t = type();
    const body = { type: t, at: f('at').value || undefined, reference: f('reference').value.trim() };
    if (t === 'damage') {
      body.reason = f('reason').value;
      if (!body.reason) return toast('Choose a damage reason', 'err');
      body.note = f('detail').value.trim();
    } else {
      body.note = f('note').value.trim();
    }
    if (t === 'adjust') {
      const raw = f('counted').value.trim();
      if (raw === '' || !(Number(raw) >= 0)) return toast('Enter the quantity you counted', 'err');
      body.counted = Number(raw);
    } else {
      const qty = Number.parseFloat(f('qty').value);
      if (!(qty > 0)) return toast('Enter a quantity', 'err');
      if (qty > lot.qty_left + 1e-6) return toast(`Only ${exactQty(lot.qty_left, lot.unit)} left in this lot`, 'err');
      body.qty = qty;
    }
    try {
      const res = await api(`/api/lots/${lot.id}/moves`, { body });
      const sheet = movementFromSave(lot, t, body, res, lossBins);
      toast(t === 'adjust' ? 'Count saved'
        : t === 'damage' ? `Moved to Harvest Damage — ${body.reason}`
        : `Moved to ${lossBins?.[t] || MOVE[t].label}`,
        'ok', sheet ? { action: { label: 'Forms', fn: () => movementDetailModal(sheet) } } : undefined);
      m.close(); refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---- customers ----

async function renderCustomers(view) {
  const rows = await api('/api/customers');
  view.innerHTML = `<div class="card tbl-wrap"><table class="tbl">
    <thead><tr><th>Customer</th><th>Type</th><th>Island</th><th>Contact</th>
      <th class="num">Terms</th><th class="num">Credit limit</th><th class="num">Balance</th><th>Last order</th><th class="actions"></th></tr></thead>
    <tbody>${rows.length ? rows.map(c => `
      <tr class="row-click" data-open="${c.id}">
        <td><b>${esc(c.name)}</b></td>
        <td>${typeChip(c.type)}</td>
        <td>${esc(c.island) || '—'}</td>
        <td>${esc(c.contact) || '—'}<span class="sub">${esc(c.phone)}</span></td>
        <td class="num">${c.terms_days}d</td>
        <td class="num">${c.credit_limit ? money(c.credit_limit) : '—'}</td>
        <td class="num">${c.balance ? `<b>${money(c.balance)}</b>` : '—'}
          ${c.overdue ? '<span class="sub"><span class="badge b-crit">Overdue</span></span>' : ''}</td>
        <td>${c.last_order ? relDay(c.last_order) : '<span class="muted">never</span>'}</td>
        <td class="actions">${canSell() ? `<button class="btn btn-sm" data-bill="${c.id}">Bill</button>` : ''}</td>
      </tr>`).join('')
      : `<tr><td colspan="9" class="empty">No customers yet.</td></tr>`}
    </tbody></table></div>`;

  view.addEventListener('click', e => {
    const bill = e.target.closest('[data-bill]');
    if (bill) { e.stopPropagation(); return openTill(+bill.dataset.bill); }
    const row = e.target.closest('[data-open]');
    if (row) customerDetailModal(+row.dataset.open);
  });
}

async function customerDetailModal(id) {
  let d;
  try { d = await api('/api/customers/' + id); } catch (err) { return toast(err.message, 'err'); }
  const c = d.customer;

  const m = openModal({
    title: c.name,
    wide: true,
    body: `
      <p class="muted mb">${typeChip(c.type)} ${esc(c.island)} · ${esc(c.contact)} · ${esc(c.phone)}
        · terms ${c.terms_days} days · limit ${c.credit_limit ? money(c.credit_limit) : 'none'}</p>
      <div class="grid-tiles" style="margin-bottom:8px">
        ${tile({ label: 'Unpaid balance', value: money(c.balance), sub: `${d.unpaid.length} open invoice${d.unpaid.length === 1 ? '' : 's'}` })}
        ${tile({ label: 'Last 30 days', value: money(d.stats30.revenue), sub: `${d.stats30.orders} order${d.stats30.orders === 1 ? '' : 's'}` })}
      </div>
      ${d.unpaid.length ? `
        <div class="card-title mb">Open invoices</div>
        <div class="tbl-wrap mb"><table class="tbl">
          <tbody>${d.unpaid.map(o => `
            <tr><td>#${o.id}<span class="sub">delivered ${fmtDate(o.delivery_date)}</span></td>
              <td>${o.days_over > 0 ? `<span class="badge b-crit">${o.days_over}d overdue</span>` : `<span class="sub">due ${fmtDate(o.due_date)}</span>`}</td>
              <td class="num"><b>${money(o.outstanding)}</b></td>
              <td class="actions">${canSell() ? `<button class="btn btn-sm" data-pay="${o.id}" data-out="${o.outstanding}">Payment</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>` : ''}
      <div class="detail-cols">
        <div>
          <div class="card-title mb">Usually buys <small>90 days</small></div>
          ${d.top_products.length ? `<ul class="plist">${d.top_products.map(p => `
            <li><div class="grow">${esc(p.name)}</div><span class="val">${fmtQty(p.qty, p.unit)}</span></li>`).join('')}</ul>`
            : '<p class="hint">No purchase history yet.</p>'}
        </div>
        <div>
          <div class="card-title mb">Follow-ups ${canSell() ? '<button class="btn btn-sm" data-new-task style="margin-left:6px">+ Add</button>' : ''}</div>
          ${d.tasks.length ? `<ul class="plist">${d.tasks.map(t => `
            <li><div class="grow">${esc(t.title)}<span class="sub">due ${relDay(t.due_date)}</span></div></li>`).join('')}</ul>`
            : '<p class="hint">Nothing open.</p>'}
        </div>
      </div>`,
    footer: `${canSell() ? '<button class="btn" data-edit>Edit</button>' : ''}
      <button class="btn" data-close>Close</button>
      ${canSell() ? '<button class="btn btn-primary" data-bill>Bill</button>' : ''}`,
  });

  m.modal.addEventListener('click', e => {
    const pay = e.target.closest('[data-pay]');
    if (pay) { m.close(); return paymentModal({ orderId: +pay.dataset.pay, customerName: c.name, outstanding: +pay.dataset.out }); }
    if (e.target.closest('[data-new-task]')) { m.close(); return taskModal({ customerId: c.id }); }
    if (e.target.closest('[data-edit]')) { m.close(); return customerFormModal(c); }
    if (e.target.closest('[data-bill]')) { m.close(); return openTill(c.id); }
  });
}

function customerFormModal(existing) {
  const c = existing ?? {};
  const m = openModal({
    title: existing ? `Edit — ${c.name}` : 'New customer',
    body: `
      <div class="form-grid">
        <div class="field"><label>Name</label><input name="name" value="${esc(c.name ?? '')}" maxlength="80"></div>
        <div class="field"><label>Type</label>
          <select name="type">${['resort', 'guesthouse', 'restaurant', 'retail', 'other'].map(t =>
            `<option value="${t}" ${c.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>Island / area</label><input name="island" value="${esc(c.island ?? '')}" maxlength="60" placeholder="K. Male"></div>
        <div class="field"><label>Island code</label><input name="island_code" maxlength="20" placeholder="T-10"></div>
        <div class="field"><label>Contact person</label><input name="contact" value="${esc(c.contact ?? '')}" maxlength="80"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(c.phone ?? '')}" inputmode="numeric" data-phone></div>
        <div class="field"><label>Payment terms (days)</label><input name="terms" type="number" min="0" max="90" value="${c.terms_days ?? 14}"></div>
        <div class="field"><label>Credit limit (MVR, 0 = none)</label><input name="credit" type="number" min="0" step="100" value="${(c.credit_limit ?? 0) / 100}"></div>
      </div>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>${existing ? 'Save changes' : 'Add customer'}</button>`,
  });
  bindIslandPair($('[name=island]', m.modal), $('[name=island_code]', m.modal));
  busyClick($('[data-save]', m.modal), async () => {
    const termsRaw = $('[name=terms]', m.modal).value.trim();
    const body = {
      name: $('[name=name]', m.modal).value.trim(),
      type: $('[name=type]', m.modal).value,
      island: islandValue($('[name=island]', m.modal).value),
      contact: $('[name=contact]', m.modal).value.trim(),
      phone: $('[name=phone]', m.modal).value.trim(),
      terms_days: Number(termsRaw),
      credit_limit: parseMoney($('[name=credit]', m.modal).value || '0'),
    };
    if (!body.name) return toast('Enter a name', 'err');
    // Number('') is 0 — a cleared field must not silently become 0-day terms.
    if (termsRaw === '' || !Number.isInteger(body.terms_days) || body.terms_days < 0 || body.terms_days > 90) {
      return toast('Enter payment terms between 0 and 90 days', 'err');
    }
    if (!Number.isFinite(body.credit_limit) || body.credit_limit < 0) return toast('Enter a valid credit limit', 'err');
    try {
      if (existing) await api(`/api/customers/${c.id}`, { method: 'PATCH', body });
      else await api('/api/customers', { body });
      toast(existing ? 'Saved' : 'Customer added'); m.close(); refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---- farmers ----

let farmerTab = 'farmers';
let farmerQuery = '';
let farmerState = '';
let cropQuery = '';

const farmerGender = g => g === 'F' ? 'Female' : g === 'M' ? 'Male' : '';
const farmerStateOf = f => f.status === 'inactive' ? 'inactive' : 'active';

function farmerLand(v) {
  if (!v) return '—';
  if (!/^\d+(\.\d+)?$/.test(v)) return esc(v);
  const [whole, frac] = v.split('.');
  const n = Number(whole).toLocaleString('en-US');
  return frac ? `${n}.${frac}` : n;
}

function farmerStatus(status) {
  return status === 'inactive'
    ? '<span class="badge">Inactive</span>'
    : '<span class="badge b-good">Active</span>';
}

function syncFarmerChrome() {
  const actions = document.getElementById('page-actions');
  const sub = document.getElementById('page-sub');
  if (sub) {
    sub.textContent = farmerTab === 'crops'
      ? 'Varieties grown under the buying contracts'
      : 'Buying contracts, the island, and the crops on each contract';
  }
  if (!actions) return;
  actions.textContent = '';
  if (!canOps()) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-primary';
  if (farmerTab === 'crops') {
    b.textContent = 'New crop';
    b.addEventListener('click', () => cropFormModal());
  } else {
    b.textContent = 'New farmer';
    b.addEventListener('click', () => farmerFormModal());
  }
  actions.append(b);
}

async function renderFarmers(view) {
  syncFarmerChrome();
  view.innerHTML = `
    <div class="filter-tabs" role="tablist" aria-label="Farmers">
      <button type="button" class="filter-tab${farmerTab === 'farmers' ? ' active' : ''}" data-farmer-tab="farmers" role="tab" aria-selected="${farmerTab === 'farmers'}">Farmers</button>
      <button type="button" class="filter-tab${farmerTab === 'crops' ? ' active' : ''}" data-farmer-tab="crops" role="tab" aria-selected="${farmerTab === 'crops'}">Crops</button>
    </div>
    <div data-farmer-body></div>`;
  const show = () => (farmerTab === 'crops' ? paintCrops(view) : paintFarmers(view));
  view.addEventListener('click', e => {
    const tab = e.target.closest('[data-farmer-tab]');
    if (!tab || tab.dataset.farmerTab === farmerTab) return;
    farmerTab = tab.dataset.farmerTab;
    $$('[data-farmer-tab]', view).forEach(t => {
      const on = t.dataset.farmerTab === farmerTab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    syncFarmerChrome();
    show();
  });
  await show();
}

let farmerPaint = 0;

function freshFarmerBody(view) {
  const old = $('[data-farmer-body]', view);
  const next = old.cloneNode(false);
  old.replaceWith(next);
  return next;
}

async function paintFarmers(view) {
  const gen = ++farmerPaint;
  const body = freshFarmerBody(view);
  body.innerHTML = '<div class="loading">Loading…</div>';
  const rows = await api('/api/farmers');
  if (gen !== farmerPaint || farmerTab !== 'farmers' || !body.isConnected) return;
  const byId = new Map(rows.map(f => [f.id, f]));
  const stateCount = s => rows.filter(f => farmerStateOf(f) === s).length;
  body.innerHTML = `
    <div class="filter-row">
      <input type="search" data-farmer-q value="${esc(farmerQuery)}" aria-label="Search farmers"
        placeholder="Search name, ID, island, crop, contract">
      <select data-farmer-state aria-label="Contract status">
        <option value="">All farmers · ${rows.length}</option>
        <option value="active" ${farmerState === 'active' ? 'selected' : ''}>Active · ${stateCount('active')}</option>
        <option value="inactive" ${farmerState === 'inactive' ? 'selected' : ''}>Inactive · ${stateCount('inactive')}</option>
      </select>
    </div>
    <div class="card tbl-wrap"><table class="tbl">
      <thead><tr><th>Farmer</th><th>ID card</th><th>Island</th><th>Land</th><th>Phone</th>
        <th>Crops</th><th>Contract</th><th>Ends</th><th>Status</th></tr></thead>
      <tbody data-farmer-rows></tbody>
    </table></div>`;
  const shown = () => {
    const needle = farmerQuery.trim().toLowerCase();
    return rows.filter(f => (!farmerState || farmerStateOf(f) === farmerState)
      && (!needle || [f.name, f.id_card, f.island, f.phone, f.land_size, f.crops, f.contract_no, f.period]
        .join(' ').toLowerCase().includes(needle)));
  };
  const paint = () => {
    const list = shown();
    $('[data-farmer-rows]', body).innerHTML = list.length ? list.map(f => `
      <tr class="row-click" data-open="${f.id}">
        <td><b>${esc(f.name)}</b>${farmerGender(f.gender) ? `<span class="sub">${farmerGender(f.gender)}</span>` : ''}</td>
        <td>${esc(f.id_card) || '—'}</td>
        <td>${esc(f.island) || '—'}</td>
        <td class="nowrap">${farmerLand(f.land_size)}</td>
        <td>${esc(f.phone) || '—'}</td>
        <td class="wrap">${esc(f.crops) || '—'}</td>
        <td class="nowrap">${esc(f.contract_no) || '—'}${f.period ? `<span class="sub">${esc(f.period)}</span>` : ''}</td>
        <td class="nowrap">${f.ends_on ? fmtDate(f.ends_on) : '—'}</td>
        <td>${farmerStatus(f.status)}</td>
      </tr>`).join('')
      : `<tr><td colspan="9" class="empty">${rows.length ? 'No farmers match.' : 'No farmers yet.'}</td></tr>`;
  };
  body.addEventListener('input', e => {
    if (!e.target.matches('[data-farmer-q]')) return;
    farmerQuery = e.target.value;
    paint();
  });
  body.addEventListener('change', e => {
    if (!e.target.matches('[data-farmer-state]')) return;
    farmerState = e.target.value;
    paint();
  });
  body.addEventListener('click', e => {
    const row = e.target.closest('[data-open]');
    if (row) farmerDetailModal(byId.get(+row.dataset.open));
  });
  paint();
}

async function paintCrops(view) {
  const gen = ++farmerPaint;
  const body = freshFarmerBody(view);
  body.innerHTML = '<div class="loading">Loading…</div>';
  const rows = await api('/api/crops');
  if (gen !== farmerPaint || farmerTab !== 'crops' || !body.isConnected) return;
  const byId = new Map(rows.map(c => [c.id, c]));
  body.innerHTML = `
    <div class="crop-find">
      <input type="search" data-crop-q value="${esc(cropQuery)}" aria-label="Search crops"
        placeholder="Search a crop or a variety">
      <p class="crop-meta" data-crop-meta></p>
    </div>
    <div class="crop-sheet" data-crop-sheet></div>`;
  const groups = () => {
    const needle = cropQuery.trim().toLowerCase();
    const family = new Set(rows.filter(c => c.crop.toLowerCase().includes(needle)).map(c => c.crop));
    const hit = c => !needle || family.has(c.crop)
      || c.variety.toLowerCase().includes(needle)
      || c.name.toLowerCase().includes(needle);
    const out = [];
    for (const c of rows) {
      if (!hit(c)) continue;
      const last = out.at(-1);
      if (!last || last.crop !== c.crop) out.push({ crop: c.crop, rows: [c] });
      else last.rows.push(c);
    }
    return out;
  };
  const variety = c => {
    const label = esc(c.variety || c.crop);
    return canOps()
      ? `<button type="button" class="crop-var" data-crop="${c.id}">${label}</button>`
      : `<span class="crop-var">${label}</span>`;
  };
  const paint = () => {
    const list = groups();
    const shown = list.reduce((n, g) => n + g.rows.length, 0);
    $('[data-crop-meta]', body).textContent = cropQuery.trim()
      ? `${shown} of ${rows.length}`
      : `${rows.length} crops`;
    const sheet = $('[data-crop-sheet]', body);
    sheet.innerHTML = list.length ? list.map(g => {
      const only = g.rows.length === 1 && !g.rows[0].variety ? g.rows[0] : null;
      if (only) {
        return canOps()
          ? `<button type="button" class="crop-solo" data-crop="${only.id}">${esc(only.crop)}</button>`
          : `<div class="crop-solo">${esc(only.crop)}</div>`;
      }
      return `<section class="crop-block crop-family">
        <h2>${esc(g.crop)}</h2>
        <div class="crop-vars">${g.rows.map(variety).join('')}</div>
      </section>`;
    }).join('') : `<div class="crop-empty">${rows.length ? 'Nothing matches that.' : 'No crops yet.'}</div>`;
  };
  body.addEventListener('input', e => {
    if (!e.target.matches('[data-crop-q]')) return;
    cropQuery = e.target.value;
    paint();
  });
  body.addEventListener('click', e => {
    if (!canOps()) return;
    const row = e.target.closest('[data-crop]');
    if (row) cropFormModal(byId.get(+row.dataset.crop));
  });
  paint();
}

function cropFormModal(existing) {
  const c = existing ?? {};
  const m = openModal({
    title: existing ? `Edit — ${c.name}` : 'New crop',
    body: `
      <div class="form-grid">
        <div class="field"><label>Crop</label><input name="crop" value="${esc(c.crop ?? '')}" maxlength="60" placeholder="Watermelon"></div>
        <div class="field"><label>Variety</label><input name="variety" value="${esc(c.variety ?? '')}" maxlength="60" placeholder="Diana"></div>
      </div>
      <p class="hint">Leave variety blank for a crop with no named variety.</p>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>${existing ? 'Save changes' : 'Add crop'}</button>`,
  });
  busyClick($('[data-save]', m.modal), async () => {
    const body = {
      crop: $('[name=crop]', m.modal).value.trim(),
      variety: $('[name=variety]', m.modal).value.trim(),
    };
    if (body.crop.length < 2) return toast('Enter the crop', 'err');
    try {
      if (existing) await api(`/api/crops/${c.id}`, { method: 'PATCH', body });
      else await api('/api/crops', { body });
      toast(existing ? 'Saved' : 'Crop added');
      m.close();
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function farmerDetailModal(f) {
  if (!f) return;
  const m = openModal({
    title: f.name,
    body: `
      <p class="muted mb">${farmerStatus(f.status)}${farmerGender(f.gender) ? ` · ${farmerGender(f.gender)}` : ''}
        ${f.id_card ? ` · ${esc(f.id_card)}` : ''}${f.island ? ` · ${esc(f.island)}` : ''}${f.phone ? ` · ${esc(f.phone)}` : ''}</p>
      <dl class="fact-grid">
        <div><dt>Contract</dt><dd>${esc(f.contract_no || '—')}</dd></div>
        <div><dt>Period</dt><dd>${esc(f.period || '—')}</dd></div>
        <div><dt>Starts</dt><dd>${f.started_on ? fmtDate(f.started_on) : '—'}</dd></div>
        <div><dt>Ends</dt><dd>${f.ends_on ? fmtDate(f.ends_on) : '—'}</dd></div>
        <div><dt>Land</dt><dd>${farmerLand(f.land_size)}</dd></div>
      </dl>
      <div class="card-title mb">Crops</div>
      <p>${esc(f.crops) || '<span class="hint">No crops listed.</span>'}</p>`,
    footer: `${canOps() ? '<button class="btn" data-edit>Edit</button>' : ''}
      <button class="btn" data-close>Close</button>`,
  });
  const edit = $('[data-edit]', m.modal);
  if (edit) edit.addEventListener('click', () => { m.close(); farmerFormModal(f); });
}

function farmerFormModal(existing) {
  const f = existing ?? {};
  const m = openModal({
    title: existing ? `Edit — ${f.name}` : 'New farmer',
    body: `
      <div class="form-grid">
        <div class="field"><label>Name</label><input name="name" value="${esc(f.name ?? '')}" maxlength="80"></div>
        <div class="field"><label>Gender</label>
          <select name="gender">
            <option value="">—</option>
            <option value="M" ${f.gender === 'M' ? 'selected' : ''}>Male</option>
            <option value="F" ${f.gender === 'F' ? 'selected' : ''}>Female</option>
          </select></div>
        <div class="field"><label>ID card</label><input name="id_card" value="${esc(f.id_card ?? '')}" maxlength="20" placeholder="DEMO-ID"></div>
        <div class="field"><label>Island</label><input name="island" value="${esc(f.island ?? '')}" maxlength="80" placeholder="K. Kaashidhoo"></div>
        <div class="field"><label>Land size</label><input name="land_size" value="${esc(f.land_size ?? '')}" maxlength="24" inputmode="decimal"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(f.phone ?? '')}" inputmode="numeric" data-phone></div>
        <div class="field"><label>Contract number</label><input name="contract_no" value="${esc(f.contract_no ?? '')}" maxlength="40" placeholder="B-2026-002"></div>
        <div class="field"><label>Period</label><input name="period" value="${esc(f.period ?? '')}" maxlength="20" placeholder="2 Years"></div>
        <div class="field"><label>Status</label>
          <select name="status">
            <option value="active" ${f.status !== 'inactive' ? 'selected' : ''}>Active</option>
            <option value="inactive" ${f.status === 'inactive' ? 'selected' : ''}>Inactive</option>
          </select></div>
        <div class="field"><label>Starting date</label><input name="started_on" type="date" value="${esc(f.started_on ?? '')}"></div>
        <div class="field"><label>End date</label><input name="ends_on" type="date" value="${esc(f.ends_on ?? '')}"></div>
        <div class="field" style="grid-column: 1 / -1"><span class="field-label" id="farmer-crops-label">Crops</span><div data-crop-pick></div></div>
      </div>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>${existing ? 'Save changes' : 'Add farmer'}</button>`,
  });
  bindIslandPair($('[name=island]', m.modal));
  const cropPick = cropPicker($('[data-crop-pick]', m.modal), {
    saved: f.crops ?? '',
    labelId: 'farmer-crops-label',
    load: () => api('/api/crops'),
  });
  busyClick($('[data-save]', m.modal), async () => {
    const field = name => $(`[name=${name}]`, m.modal).value.trim();
    const body = {
      name: field('name'),
      gender: $('[name=gender]', m.modal).value,
      id_card: field('id_card'),
      island: islandValue(field('island')),
      land_size: field('land_size'),
      phone: field('phone'),
      contract_no: field('contract_no'),
      period: field('period'),
      status: $('[name=status]', m.modal).value,
      started_on: field('started_on'),
      ends_on: field('ends_on'),
      crops: cropPick.value(),
    };
    if (body.name.length < 2) return toast('Enter the farmer name', 'err');
    if (!body.contract_no) return toast('Enter the contract number', 'err');
    try {
      if (existing) await api(`/api/farmers/${f.id}`, { method: 'PATCH', body });
      else await api('/api/farmers', { body });
      toast(existing ? 'Saved' : 'Farmer added');
      m.close();
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---- items ----

let prodShowRemoved = false;

const productBackAction = p => ({
  label: 'Undo',
  fn: async () => {
    try {
      await api(`/api/products/${p.id}`, { method: 'PATCH', body: { active: true } });
      closeAllModals();
      toast(`${p.name} is back in Items`);
      refresh();
    } catch (err) { toast(err.message, 'err'); throw err; }
  },
});

async function removeProduct(p) {
  const ok = await confirmModal(
    `Remove ${p.name}? It can't be added to new orders or received as stock. Past orders and history keep it, and you can bring it back under “Show removed items”.`,
    { title: 'Remove item', confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  try {
    await api(`/api/products/${p.id}`, { method: 'PATCH', body: { active: false } });
    toast(`${p.name} removed`, 'ok', { action: productBackAction(p) });
    refresh();
  } catch (err) { toast(err.message, 'err'); }
}

async function restoreProduct(p, btn) {
  btn.disabled = true;
  try {
    await api(`/api/products/${p.id}`, { method: 'PATCH', body: { active: true } });
    toast(`${p.name} is back in Items`);
    refresh();
  } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
}

async function renderProducts(view) {
  const rows = await api('/api/products' + (prodShowRemoved ? '?all=1' : ''));
  const byId = new Map(rows.map(p => [p.id, p]));
  view.innerHTML = `
    <div class="filter-row">
      <label class="hint" style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" class="task-check" data-show-removed ${prodShowRemoved ? 'checked' : ''}> Show removed items</label>
    </div>
    <div class="card tbl-wrap"><table class="tbl">
    <thead><tr><th>Item</th><th>Category</th><th class="num">Shelf life</th>
      <th class="num">Cost</th><th class="num">Sell price</th><th class="num">Margin</th>
      <th class="num">Stock</th><th class="num">Sales / day</th><th>Cover</th><th class="actions"></th></tr></thead>
    <tbody>${rows.length ? rows.map(p => p.active ? `
      <tr>
        <td><b>${esc(p.name)}</b><span class="sub">${p.code ? `${esc(p.code)} · ` : ''}per ${esc(p.unit)}</span></td>
        <td>${typeChip(p.category)}</td>
        <td class="num">${p.shelf_life_days}d</td>
        <td class="num">${canOps()
          ? `<span class="inline-edit" data-id="${p.id}" data-field="cost" data-value="${p.cost}" role="button" tabindex="0">${money(p.cost)}</span>`
          : money(p.cost)}</td>
        <td class="num">${canSell()
          ? `<span class="inline-edit" data-id="${p.id}" data-field="price" data-value="${p.price}" role="button" tabindex="0">${money(p.price)}</span>`
          : money(p.price)}</td>
        <td class="num">${p.margin_pct.toFixed(0)}%</td>
        <td class="num">${fmtQty(p.stock, p.unit)}</td>
        <td class="num">${p.velocity ? fmtQty(p.velocity, p.unit) : '—'}</td>
        <td>${p.days_of_stock === null ? '<span class="muted">—</span>'
          : p.low_stock ? `<span class="badge b-serious">${p.days_of_stock}d — reorder</span>`
          : `<span class="badge b-good">${p.days_of_stock}d</span>`}</td>
        <td class="actions">${canOps() ? `<button class="btn btn-sm" data-edit="${p.id}">Edit</button>` : ''}
          ${canSell() ? `<button class="btn btn-sm btn-danger" data-remove="${p.id}">Remove</button>` : ''}</td>
      </tr>` : `
      <tr class="row-removed">
        <td><b>${esc(p.name)}</b> <span class="badge">Removed</span><span class="sub">${p.code ? `${esc(p.code)} · ` : ''}per ${esc(p.unit)}</span></td>
        <td>${typeChip(p.category)}</td>
        <td class="num">${p.shelf_life_days}d</td>
        <td class="num">${money(p.cost)}</td>
        <td class="num">${money(p.price)}</td>
        <td class="num">${p.margin_pct.toFixed(0)}%</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td><span class="muted">—</span></td>
        <td class="actions">${canSell() ? `<button class="btn btn-sm" data-restore="${p.id}">Restore</button>` : ''}</td>
      </tr>`).join('')
      : `<tr><td colspan="10" class="empty">No items yet.</td></tr>`}
    </tbody></table></div>`;

  view.addEventListener('change', e => {
    if (e.target.closest('[data-show-removed]')) { prodShowRemoved = e.target.checked; refresh(); }
  });

  const startEdit = span => {
    if (span.querySelector('input')) return;
    const { id, field } = span.dataset;
    const cur = +span.dataset.value;
    const input = document.createElement('input');
    input.className = 'inline-input';
    input.type = 'number';
    input.step = '0.01';
    input.min = '0';
    input.value = (cur / 100).toFixed(2);
    span.textContent = '';
    span.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async save => {
      if (done) return;
      done = true;
      if (save) {
        const v = parseMoney(input.value);
        if (!Number.isFinite(v) || v < 0 || (field === 'price' && v === 0)) {
          toast('Enter a valid amount', 'err');
        } else if (v !== cur) {
          try { await api(`/api/products/${id}`, { method: 'PATCH', body: { [field]: v } }); toast('Item updated'); }
          catch (err) { toast(err.message, 'err'); }
        }
      }
      refresh();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  };
  view.addEventListener('click', e => {
    const edit = e.target.closest('[data-edit]');
    if (edit) return productFormModal(byId.get(+edit.dataset.edit));
    const rm = e.target.closest('[data-remove]');
    if (rm) return removeProduct(byId.get(+rm.dataset.remove));
    const back = e.target.closest('[data-restore]');
    if (back) return restoreProduct(byId.get(+back.dataset.restore), back);
    const span = e.target.closest('.inline-edit');
    if (span) startEdit(span);
  });
  view.addEventListener('keydown', e => {
    const span = e.target.closest('.inline-edit');
    if (span && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); startEdit(span); }
  });
}

async function productFormModal(existing) {
  const p = existing ?? {};
  const unitLocked = Boolean(existing?.has_history);
  const opt = (value, current) => `<option value="${value}" ${value === current ? 'selected' : ''}>${value}</option>`;
  const m = openModal({
    title: existing ? `Edit — ${p.name}` : 'New item',
    body: `
      <div class="form-grid form-grid-name">
        <div class="field"><label>Name</label><input name="name" maxlength="80" placeholder="e.g. Passion fruit" value="${esc(p.name ?? '')}"></div>
        <div class="field"><label>Item code <span class="muted">(optional)</span></label>
          <input name="code" maxlength="20" autocomplete="off" placeholder="e.g. FRU-014" value="${esc(p.code ?? '')}"></div>
      </div>
      <div class="form-grid-3">
        <div class="field"><label>Category</label>
          <select name="category">${['fruit', 'vegetable', 'herb', 'other'].map(c => opt(c, p.category)).join('')}</select></div>
        <div class="field"><label>Unit</label>
          <select name="unit" ${unitLocked ? 'disabled' : ''}>${['kg', 'piece', 'bunch', 'crate', 'box'].map(u => opt(u, p.unit)).join('')}</select></div>
        <div class="field"><label>Shelf life (days)</label><input name="shelf" type="number" min="1" max="365" value="${p.shelf_life_days ?? 5}"></div>
      </div>
      ${unitLocked ? `<p class="hint mb">The unit can't change because ${esc(p.name)} already has stock or orders in ${esc(p.unit)}.</p>` : ''}
      <div class="form-grid">
        <div class="field"><label>Buying cost (MVR)</label><input name="cost" type="number" min="0" step="0.01" placeholder="0.00"
          value="${existing ? (p.cost / 100).toFixed(2) : ''}"></div>
        ${!existing || canSell() ? `<div class="field"><label>${existing ? 'Sell price (MVR)' : 'Starting sell price (MVR)'}</label>
          <input name="price" type="number" min="0.01" step="0.01" placeholder="0.00"
            value="${existing ? (p.price / 100).toFixed(2) : ''}"></div>` : ''}
      </div>
      ${existing ? '' : '<p class="hint mb">Sales changes the sell price after this. Operations keeps the buying cost. Stock arrives on an item receipt.</p>'}`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>${existing ? 'Save changes' : 'Add item'}</button>`,
  });
  const f = name => $(`[name=${name}]`, m.modal);
  busyClick($('[data-save]', m.modal), async () => {
    const cost = parseMoney(f('cost').value);
    if (!Number.isFinite(cost) || cost < 0) return toast('Enter a valid buying cost', 'err');
    const priceInput = f('price');
    const price = priceInput ? parseMoney(priceInput.value) : null;
    if (priceInput && (!Number.isFinite(price) || price <= 0)) return toast('Enter a valid sell price', 'err');
    const body = {
      name: f('name').value.trim(),
      code: f('code').value.trim(),
      category: f('category').value,
      unit: f('unit').value,
      shelf_life_days: Number(f('shelf').value),
      cost,
    };
    if (priceInput) body.price = price;
    if (existing) {
      const changed = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== p[k]));
      if (!Object.keys(changed).length) return m.close();
      try {
        await api(`/api/products/${p.id}`, { method: 'PATCH', body: changed });
        toast(`${body.name} updated`); m.close(); refresh();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    try {
      await api('/api/products', { body });
      toast('Product added');
      m.close(); refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---- business details (printed on invoices / delivery notes) ----

export async function businessModal() {
  if ($('#modal-root .modal[aria-label="Business details"]')) return;
  let s;
  try { s = await api('/api/settings'); } catch (err) { return toast(err.message, 'err'); }
  const m = openModal({
    title: 'Business details',
    body: `
      <p class="hint mb">Printed in the header of invoices and delivery notes.</p>
      <div class="field"><label>Business name</label>
        <input name="biz_name" value="${esc(s.biz_name)}" maxlength="120"></div>
      <div class="field"><label>Address</label>
        <textarea name="biz_address" rows="2" maxlength="300">${esc(s.biz_address)}</textarea></div>
      <div class="form-grid">
        <div class="field"><label>Phone</label><input name="biz_phone" value="${esc(s.biz_phone)}" inputmode="numeric" data-phone></div>
        <div class="field"><label>Email</label><input name="biz_email" value="${esc(s.biz_email)}" maxlength="80"></div>
        <div class="field"><label>GST TIN <span class="muted">(blank = no GST line)</span></label>
          <input name="biz_tin" value="${esc(s.biz_tin)}" maxlength="40"></div>
        <div class="field"><label>GST rate % <span class="muted">(prices treated as inclusive)</span></label>
          <input name="gst_rate" type="number" min="0" max="100" step="0.1" value="${esc(s.gst_rate)}"></div>
      </div>
      <div class="field"><label>Invoice note <span class="muted">(optional line under the terms)</span></label>
        <input name="invoice_note" value="${esc(s.invoice_note)}" maxlength="300"></div>
      <div class="field"><label>Invoice terms <span class="muted">(one term per line)</span></label>
        <textarea name="invoice_terms" rows="5" maxlength="1200">${esc(s.invoice_terms || '')}</textarea></div>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>Save</button>`,
  });
  busyClick($('[data-save]', m.modal), async () => {
    const val = name => $(`[name=${name}]`, m.modal).value.trim();
    if (!val('biz_name')) return toast('Enter the business name', 'err');
    const rateEl = $('[name=gst_rate]', m.modal);
    // A cleared or non-numeric field must not silently become rate 0.
    if (rateEl.validity.badInput || rateEl.value.trim() === '') {
      return toast('Enter a GST rate between 0 and 100 (0 = no GST)', 'err');
    }
    const rate = Number(rateEl.value.trim());
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return toast('GST rate must be 0–100', 'err');
    try {
      await api('/api/settings', { method: 'PATCH', body: {
        biz_name: val('biz_name'),
        biz_address: val('biz_address'),
        biz_phone: val('biz_phone'),
        biz_email: val('biz_email'),
        biz_tin: val('biz_tin'),
        gst_rate: rate,
        invoice_note: val('invoice_note'),
        invoice_terms: val('invoice_terms'),
      } });
      toast('Business details saved');
      m.close();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---- tasks ----

async function taskModal({ title = '', customerId = null } = {}) {
  let customers = [];
  try { customers = await api('/api/customers'); } catch { /* optional */ }
  const m = openModal({
    title: 'New follow-up',
    body: `
      <div class="field"><label>What needs doing?</label>
        <input name="title" maxlength="140" value="${esc(title)}" placeholder="e.g. Call the chef about tomorrow's list"></div>
      <div class="form-grid">
        <div class="field"><label>Customer <span class="muted">(optional)</span></label>
          <select name="customer"><option value="">—</option>
            ${customers.map(c => `<option value="${c.id}" ${c.id === customerId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label>Due</label><input name="due" type="date" value="${todayStr()}"></div>
      </div>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>Add follow-up</button>`,
  });
  busyClick($('[data-save]', m.modal), async () => {
    const t = $('[name=title]', m.modal).value.trim();
    if (t.length < 2) return toast('Describe the follow-up', 'err');
    try {
      await api('/api/tasks', { body: {
        title: t,
        customer_id: +$('[name=customer]', m.modal).value || null,
        due_date: $('[name=due]', m.modal).value,
      } });
      toast('Follow-up added'); m.close(); refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---- action history ----

let histUser = '';
let histEntity = '';
const ENTITIES = ['order', 'payment', 'lot', 'shipment', 'product', 'customer', 'task', 'settings', 'user', 'auth', 'signature'];

function histWhen(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${relDay(day)} ${hh}:${mm}`;
}

async function renderHistory(view) {
  const q = new URLSearchParams();
  if (histUser) q.set('user_id', histUser);
  if (histEntity) q.set('entity', histEntity);
  const d = await api('/api/history' + (q.size ? `?${q}` : ''));
  view.innerHTML = `
    <div class="filter-row">
      <select data-f-user aria-label="Filter by user">
        <option value="">Everyone</option>
        ${d.actors.map(a => `<option value="${a.user_id}" ${String(a.user_id) === histUser ? 'selected' : ''}>${esc(a.user_name)}</option>`).join('')}
      </select>
      <select data-f-entity aria-label="Filter by area">
        <option value="">All areas</option>
        ${ENTITIES.map(e => `<option value="${e}" ${e === histEntity ? 'selected' : ''}>${e}</option>`).join('')}
      </select>
    </div>
    <div class="card tbl-wrap"><table class="tbl">
      <thead><tr><th>When</th><th>Who</th><th>What</th><th>Area</th></tr></thead>
      <tbody data-hist-rows>${d.rows.length ? d.rows.map(histRowHtml).join('')
        : `<tr><td colspan="4" class="empty">${histUser || histEntity
            ? 'No entries match these filters.'
            : 'Nothing logged yet — actions land here as the team works.'}</td></tr>`}
      </tbody></table></div>
    ${d.rows.length >= 200 ? '<div style="margin-top:10px"><button class="btn" data-older>Show older</button></div>' : ''}`;

  view.addEventListener('change', e => {
    if (e.target.closest('[data-f-user]')) { histUser = e.target.value; refresh(); }
    if (e.target.closest('[data-f-entity]')) { histEntity = e.target.value; refresh(); }
  });
  view.addEventListener('click', async e => {
    const older = e.target.closest('[data-older]');
    if (!older || older.disabled) return;
    older.disabled = true;
    const tbody = $('[data-hist-rows]', view);
    const lastId = tbody.lastElementChild?.dataset.id;
    try {
      const q2 = new URLSearchParams();
      if (histUser) q2.set('user_id', histUser);
      if (histEntity) q2.set('entity', histEntity);
      q2.set('before_id', lastId);
      const more = await api(`/api/history?${q2}`);
      tbody.insertAdjacentHTML('beforeend', more.rows.map(histRowHtml).join(''));
      if (more.rows.length < 200) older.remove(); // reached the first entry
      else older.disabled = false;
    } catch (err) { toast(err.message, 'err'); older.disabled = false; }
  });
}

function histRowHtml(r) {
  return `<tr data-id="${r.id}">
    <td class="hist-time">${histWhen(r.at)}</td>
    <td class="hist-user">${esc(r.user_name)}</td>
    <td>${esc(r.summary)}</td>
    <td><span class="chip hist-entity">${esc(r.entity)}</span></td>
  </tr>`;
}

// ---- account & user management ----

export function accountModal(user) {
  const m = openModal({
    title: `Account — ${user.name}`,
    body: `
      <p class="hint mb">Signed in as <b>${esc(user.username)}</b> (${esc(roleLabel(user.role))}). ${
        user.role === 'sales' ? 'You take orders, keep customers, and set sell prices.'
        : user.role === 'operations' ? 'You receive stock, record damage, and keep boat notes and item details.'
        : user.role === 'operations_hod' ? 'You approve boat price enquiries, and you can receive stock, record damage, and keep boat notes.'
        : 'You can do everything, including users and business details.'}</p>
      <div class="field"><label>Current password</label><input name="current" type="password" autocomplete="current-password"></div>
      <div class="form-grid">
        <div class="field"><label>New password</label><input name="next" type="password" autocomplete="new-password"></div>
        <div class="field"><label>Repeat new password</label><input name="next2" type="password" autocomplete="new-password"></div>
      </div>
      <p class="hint">At least 6 characters.</p>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>Change password</button>`,
  });
  busyClick($('[data-save]', m.modal), async () => {
    const v = n => $(`[name=${n}]`, m.modal).value;
    if (v('next').length < 6) return toast('New password must be at least 6 characters', 'err');
    if (v('next') !== v('next2')) return toast("New passwords don't match", 'err');
    try {
      await api('/api/account/password', { body: { current: v('current'), next: v('next') } });
      toast('Password changed');
      m.close();
    } catch (err) { toast(err.message, 'err'); }
  });
}

export async function usersModal(currentUser) {
  let users;
  try { users = await api('/api/users'); } catch (err) { return toast(err.message, 'err'); }
  const m = openModal({
    title: 'Users',
    wide: true,
    body: `
      <div class="tbl-wrap mb"><table class="tbl">
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th class="actions"></th></tr></thead>
        <tbody>${users.map(u => `
          <tr>
            <td><b>${esc(u.name)}</b>${u.id === currentUser.id ? ' <span class="muted">(you)</span>' : ''}</td>
            <td>${esc(u.username)}</td>
            <td>${u.id === currentUser.id
              ? typeChip(roleLabel(u.role))
              : `<select class="role-pick" data-role="${u.id}" data-was="${esc(u.role)}" data-name="${esc(u.name)}"
                  aria-label="Role for ${esc(u.name)}">
                  ${ROLE_ORDER.map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}
                </select>`}</td>
            <td>${u.active ? '<span class="badge b-good">Active</span>' : '<span class="badge">Deactivated</span>'}</td>
            <td class="actions">
              ${u.id === currentUser.id
                ? '<span class="muted">change yours under Account</span>'
                : `<button class="btn btn-sm" data-reset="${u.id}" data-name="${esc(u.name)}">Reset password</button>
                   <button class="btn btn-sm${u.active ? ' btn-danger' : ''}" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Deactivate' : 'Reactivate'}</button>`}
            </td>
          </tr>`).join('')}
        </tbody></table></div>
      <p class="hint mb">A new role applies straight away. The person may need to refresh to see their new menus.</p>
      <div class="card-title mb">Add user</div>
      <div class="form-grid-3">
        <div class="field"><label>Name</label><input name="nu-name" maxlength="80"></div>
        <div class="field"><label>Username</label><input name="nu-username" maxlength="40" autocomplete="off"></div>
        <div class="field"><label>Role</label>
          <select name="nu-role">
            <option value="sales">Sales — orders, customers, sell prices</option>
            <option value="operations">Operations — receipts, stock, damage</option>
            <option value="operations_hod">Operations HOD — approves boat price enquiries</option>
            <option value="admin">Admin — everything</option>
          </select></div>
      </div>
      <div class="field"><label>Starting password <span class="muted">(they can change it later)</span></label>
        <input name="nu-pass" maxlength="80" autocomplete="off"></div>`,
    footer: `<button class="btn" data-close>Close</button>
      <button class="btn btn-primary" data-add>Add user</button>`,
  });
  $('[name=nu-name]', m.modal).focus();

  const reopen = () => { m.close(); usersModal(currentUser); };
  m.modal.addEventListener('click', async e => {
    const reset = e.target.closest('[data-reset]');
    if (reset && !reset.disabled) {
      reset.disabled = true;
      const pw = prompt(`New password for ${reset.dataset.name} (min 6 characters):`);
      if (pw === null) { reset.disabled = false; return; }
      try {
        await api(`/api/users/${reset.dataset.reset}`, { method: 'PATCH', body: { password: pw } });
        toast('Password reset');
        reset.disabled = false;
      } catch (err) { toast(err.message, 'err'); reset.disabled = false; }
      return;
    }
    const tog = e.target.closest('[data-toggle]');
    if (tog && !tog.disabled) {
      tog.disabled = true;
      const activating = tog.dataset.active !== '1';
      try {
        await api(`/api/users/${tog.dataset.toggle}`, { method: 'PATCH', body: { active: activating } });
        toast('Saved');
        // Update the row in place — a full reopen would wipe a half-typed
        // "Add user" form below.
        tog.dataset.active = activating ? '1' : '0';
        tog.textContent = activating ? 'Deactivate' : 'Reactivate';
        tog.classList.toggle('btn-danger', activating);
        const statusCell = tog.closest('tr').children[3];
        statusCell.innerHTML = activating
          ? '<span class="badge b-good">Active</span>'
          : '<span class="badge">Deactivated</span>';
        tog.disabled = false;
      } catch (err) { toast(err.message, 'err'); tog.disabled = false; }
    }
  });
  m.modal.addEventListener('change', async e => {
    const pick = e.target.closest('[data-role]');
    if (!pick) return;
    const was = pick.dataset.was;
    const role = pick.value;
    if (role === was) return;
    const name = pick.dataset.name;
    if (role === 'admin' || was === 'admin') {
      const ok = await confirmModal(role === 'admin'
        ? `${name} will be able to do everything, including managing users and roles.`
        : `${name} will move to ${roleLabel(role)} and lose admin access.`, {
        title: role === 'admin' ? 'Make this user an admin?' : 'Remove admin access?',
        confirmLabel: `Make ${roleLabel(role)}`,
      });
      if (!ok) { pick.value = was; return; }
    }
    pick.disabled = true;
    try {
      await api(`/api/users/${pick.dataset.role}`, { method: 'PATCH', body: { role } });
      pick.dataset.was = role;
      toast(`${name} is now ${roleLabel(role)}`);
    } catch (err) {
      pick.value = was;
      toast(err.message, 'err');
    } finally {
      pick.disabled = false;
    }
  });
  busyClick($('[data-add]', m.modal), async () => {
    const v = n => $(`[name=${n}]`, m.modal).value.trim();
    try {
      await api('/api/users', { body: {
        name: v('nu-name'), username: v('nu-username'),
        role: $('[name=nu-role]', m.modal).value, password: $('[name=nu-pass]', m.modal).value,
      } });
      toast('User added');
      reopen();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---- shipments ----

function shipmentProductPreview(names) {
  if (!names.length) return '<span class="muted">Nothing received yet</span>';
  const shown = names.slice(0, 3).map(esc).join(', ');
  const more = names.length > 3 ? ` +${names.length - 3}` : '';
  return shown + more;
}

function shipmentLotsHtml(lots) {
  if (!lots.length) {
    return '<p class="hint">Nothing from this shipment has been received into inventory yet.</p>';
  }
  return `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Product</th><th>Farmer</th><th>Boat note</th><th class="num">Received</th>
      <th class="num">Still in inventory</th><th>Expires</th><th>Lot</th></tr></thead>
    <tbody>${lots.map(l => `
      <tr>
        <td><b>${esc(l.product)}</b>${subLine(l.item_code, `per ${l.unit}`)}</td>
        <td>${cell(l.supplier)}${subLine(l.farmer_island, l.farmer_id_card)}</td>
        <td>${cell(l.boat_note)}</td>
        <td class="num">${fmtQty(l.qty_received, l.unit)}</td>
        <td class="num">${fmtQty(l.qty_left, l.unit)}</td>
        <td>${lotBadge(l.status, l.days_left)}<span class="sub">${fmtDate(l.expires_at)}</span></td>
        <td>#${l.id}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

let shipmentQuery = '';
let shipTab = '';

const plainNum = q => {
  const n = Number(q);
  if (!Number.isFinite(n) || n === 0) return '';
  return String(Math.round(n * 1000) / 1000);
};

function boatNumber(s) {
  return s.boat_no ? `Boat ${s.boat_no}` : '';
}

function shipmentLabel(s) {
  const num = boatNumber(s);
  const name = (s.boat_name || '').trim();
  // The name is whatever was written on the boat note. Before that note, the boat is its number.
  if (num && name && (s.status === 'in_transit' || s.status === 'received')) return `${num} · ${name}`;
  if (num) return num;
  return s.enquiry_ref || s.harvest_ref || s.reference;
}

function harvestRefLine(s) {
  const refs = (s.grns || []).map(g => g.harvest_ref).filter(Boolean);
  if (refs.length) return refs.join(' · ');
  return s.harvest_ref || '';
}

function shipmentStage(s) {
  if (s.status === 'harvested') return 'harvest';
  if (s.status === 'enquiry' || s.status === 'approved') return 'enquiry';
  if (s.status === 'in_transit') return 'transit';
  return 'received';
}

const SHIP_STEPS = [
  { key: 'harvested', name: 'Harvest GRN' },
  { key: 'enquiry', name: 'Price enquiry' },
  { key: 'approved', name: 'Approved' },
  { key: 'in_transit', name: 'In transit' },
  { key: 'received', name: 'Received' },
];

const SHIP_STEP_ICONS = [
  '<svg class="step-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3.5h6V6H9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="6" y="5" width="12" height="15.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 11h6M9 14.5h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  '<svg class="step-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5V5h7.2L20 13.3l-6.7 6.7L4.5 12.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="8.6" cy="8.6" r="1.15" fill="currentColor"/></svg>',
  '<svg class="step-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.4 12.2 11 14.7 15.7 9.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  '<svg class="step-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16h18l-1.7 3.1a1.6 1.6 0 0 1-1.4.8H6.1a1.6 1.6 0 0 1-1.4-.8L3 16z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 16V9.2h5.2L16.5 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10.4 9.2V6h2.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  '<svg class="step-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.6 12 4l8 6.6V20a1 1 0 0 1-1 1h-5.2v-6.2H10.2V21H5a1 1 0 0 1-1-1v-9.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
];

function shipmentStepIndex(s) {
  const i = SHIP_STEPS.findIndex(step => step.key === (s.status || 'received'));
  return i < 0 ? SHIP_STEPS.length - 1 : i;
}

function shipmentTrackHtml(s) {
  const step = shipmentStepIndex(s);
  const state = SHIP_STEPS[step].name;
  const items = SHIP_STEPS.map((st, i) => {
    const on = i <= step ? ' is-on' : '';
    const current = i === step ? ' aria-current="step"' : '';
    return `<li class="${on.trim()}"${current}><span class="dot">${SHIP_STEP_ICONS[i]}</span><span class="step-name">${st.name}</span></li>`;
  }).join('');
  return `<ol class="ship-steps" style="--step:${step}" aria-label="${esc(state)}, step ${step + 1} of ${SHIP_STEPS.length}">${items}</ol>`;
}

function shipmentTrackCard(s) {
  const state = SHIP_STEPS[shipmentStepIndex(s)].name;
  const from = s.loaded_from || s.farmer_island || s.origin || '';
  const to = s.destination || '';
  const route = from && to
    ? `<div class="track-route"><span>${esc(from)}</span><b aria-hidden="true">→</b><span>${esc(to)}</span></div>`
    : (from || to ? `<div class="track-route"><span>${esc(from || to)}</span></div>` : '');
  const when = (s.status === 'harvested' ? s.harvested_at : '') || s.loaded_at || s.arrived_at || s.harvested_at || '';
  return `<article class="track-card" data-open="${s.id}" data-q="${esc(shipmentSearchText(s))}" tabindex="0">
    <div class="track-head">
      <div class="track-id">
        <div class="track-ref">${esc(shipmentLabel(s))}</div>
        ${route}
      </div>
      <div class="track-side">
        <b>${esc(state)}</b>
        <span>${when ? fmtDate(when) : ''}</span>
      </div>
    </div>
    ${shipmentTrackHtml(s)}
  </article>`;
}

function shipmentSearchText(s) {
  return [
    s.reference, s.harvest_ref, s.enquiry_ref, s.labor_ref, s.labor_work, s.supplier, s.origin, s.farmer_name, s.farmer_island,
    boatNumber(s),
    s.boat_name, s.vessel_name, s.loaded_from, s.destination, s.island_code, s.grn_ref, ...(s.products ?? []),
    ...(s.grns ?? []).flatMap(g => [g.harvest_ref, g.farmer_name, g.farmer_island, ...(g.crops ?? [])]),
  ].join(' ').toLowerCase();
}

function shipmentMatches(s, q) {
  return shipmentSearchText(s).includes(q);
}

function boatLinesHtml(lines) {
  return `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>#</th><th>Item</th><th>Baskets / boxes / bunches</th><th class="num">Qty</th><th>Destination</th></tr></thead>
    <tbody>${lines.map(l => `
      <tr>
        <td>${l.line_no}</td>
        <td><b>${esc(l.description || l.product || '')}</b>${l.product_id ? '' : '<span class="sub">Reference only</span>'}</td>
        <td>${cell(l.packing)}</td>
        <td class="num">${plainNum(l.qty) ? `${plainNum(l.qty)}${l.unit ? ' ' + esc(l.unit) : ''}` : dash}</td>
        <td>${cell(l.destination)}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

async function renderShipments(view) {
  const [rows, hires, catalog] = await Promise.all([
    api('/api/shipments'),
    api('/api/labor-hires'),
    api('/api/harvest-grns').catch(() => []),
  ]);
  const count = stage => rows.filter(s => shipmentStage(s) === stage).length;
  const boats = rows.filter(s => s.status === 'in_transit');
  const receiptReview = rows.filter(s => s.grn_ref && s.receipt_prepared_by != null && s.receipt_verified_by == null);
  const harvestList = catalog.filter(g => !g.boat_no).map(g => ({ g }));
  const toVerify = catalog
    .filter(g => g.verify_state === 'waiting' || g.verify_state === 'sent_back')
    .map(g => ({ g }));
  const grnMatches = (entry, q) => [
    entry.g.harvest_ref, entry.g.farmer_name, entry.g.farmer_island, entry.g.sent_back_note, entry.g.enquiry_ref,
    ...(entry.g.crops || []),
  ].join(' ').toLowerCase().includes(q);
  const looseHires = hires.filter(h => !h.shipment_id);
  const grnOpen = g => (g.shipment_id ? `data-open="${g.shipment_id}"` : `data-grn="${g.id}"`);
  const grnPlace = g => (g.boat_no ? `Boat ${g.boat_no}` : (g.enquiry_ref || '—'));
  if (shipTab === 'transit') shipTab = 'all';
  if (shipTab === 'landing') shipTab = '';
  if (!shipTab) {
    shipTab = harvestList.length ? 'harvest'
      : boats.length ? 'all'
      : ['enquiry', 'received'].find(stage => count(stage) > 0) || 'received';
  }
  const tabLabel = (id, label) => {
    const n = id === 'all' ? boats.length : id === 'labor' ? looseHires.length : id === 'verify' ? toVerify.length
      : id === 'harvest' ? harvestList.length : id === 'receipt-review' ? receiptReview.length : count(id);
    return `<button class="filter-tab${shipTab === id ? ' active' : ''}" data-tab="${id}" role="tab" aria-selected="${shipTab === id}">${label}${n ? ` · ${n}` : ''}</button>`;
  };
  view.innerHTML = `
    <div class="filter-tabs" role="tablist" aria-label="Shipments">
      ${tabLabel('all', 'Boats')}
      ${tabLabel('harvest', 'Harvest')}
      ${tabLabel('verify', 'To verify')}
      ${tabLabel('enquiry', 'Price enquiry')}
      ${tabLabel('received', 'Received')}
      ${canOps() ? tabLabel('receipt-review', 'Receipt review') : ''}
      ${tabLabel('labor', 'Labour hire')}
    </div>
    <div class="filter-row">
      <input data-ship-filter placeholder="Filter by boat, ref, island, or product" value="${esc(shipmentQuery)}" aria-label="Filter shipments">
    </div>
    <div data-ship-body></div>`;

  const paint = () => {
    const q = shipmentQuery.trim().toLowerCase();
    const pool = shipTab === 'all' ? boats
      : shipTab === 'labor' ? hires
      : shipTab === 'verify' ? toVerify
      : shipTab === 'harvest' ? harvestList
      : shipTab === 'receipt-review' ? receiptReview
      : rows.filter(s => shipmentStage(s) === shipTab);
    const shown = q
      ? pool.filter(s => (shipTab === 'harvest' || shipTab === 'verify' ? grnMatches(s, q) : shipmentMatches(s, q)))
      : pool;
    const body = $('[data-ship-body]', view);
    const empty = (cols, none, nomatch) => `<tr><td colspan="${cols}" class="empty">${pool.length ? nomatch : none}</td></tr>`;
    if (shipTab === 'all') {
      let list = $('[data-ship-list]', body);
      if (!list) {
        body.innerHTML = boats.length
          ? `<div class="ship-track-list" data-ship-list>${boats.map(shipmentTrackCard).join('')}</div>
             <div class="card track-empty" data-ship-none hidden>No boats match.</div>`
          : `<div class="card track-empty">No boat yet. A boat starts when its boat note is written.</div>`;
        list = $('[data-ship-list]', body);
      }
      let n = 0;
      if (list) {
        for (const card of $$('.track-card', list)) {
          const match = !q || (card.dataset.q || '').includes(q);
          card.hidden = !match;
          if (match) n += 1;
        }
      }
      const none = $('[data-ship-none]', body);
      if (none) none.hidden = n !== 0;
      return;
    }
    if (shipTab === 'harvest') {
      body.innerHTML = `<div class="card tbl-wrap"><table class="tbl">
        <thead><tr><th>On</th><th>Harvest GRN</th><th>Farmer</th><th>Island</th><th>Harvested</th><th>Crop</th><th>Verified</th></tr></thead>
        <tbody>${shown.length ? shown.map(({ g }) => `
          <tr class="row-click" ${grnOpen(g)}>
            <td><b>${esc(grnPlace(g))}</b></td>
            <td><b>${esc(g.harvest_ref)}</b></td>
            <td>${esc(g.farmer_name) || '—'}</td>
            <td>${esc(g.farmer_island) || '—'}</td>
            <td>${g.harvested_at ? fmtDate(g.harvested_at) : '—'}</td>
            <td>${shipmentProductPreview(g.crops ?? [])}</td>
            <td>${verifyBadge(g)}</td>
          </tr>`).join('') : empty(7, 'Nothing received from a farmer yet. A harvest GRN stays here until a boat note is written.', 'No harvest GRNs match.')}
        </tbody></table></div>`;
      return;
    }
    if (shipTab === 'verify') {
      body.innerHTML = `<div class="card tbl-wrap"><table class="tbl">
        <thead><tr><th>On</th><th>Harvest GRN</th><th>Farmer</th><th>Island</th><th>Harvested</th><th>Verification</th></tr></thead>
        <tbody>${shown.length ? shown.map(({ g }) => `
          <tr class="row-click" ${grnOpen(g)}>
            <td><b>${esc(grnPlace(g))}</b></td>
            <td><b>${esc(g.harvest_ref)}</b>${g.enquiry_ref ? `<span class="sub">${esc(g.enquiry_ref)}</span>` : ''}</td>
            <td>${esc(g.farmer_name) || '—'}</td>
            <td>${esc(g.farmer_island) || '—'}</td>
            <td>${g.harvested_at ? fmtDate(g.harvested_at) : '—'}</td>
            <td>${verifyBadge(g)}${g.verify_state === 'sent_back' ? `<span class="sub">${esc(g.sent_back_note)}</span>` : ''}</td>
          </tr>`).join('') : empty(6, 'Nothing is waiting to be verified.', 'No harvest GRNs match.')}
        </tbody></table></div>`;
      return;
    }
    if (shipTab === 'enquiry') {
      body.innerHTML = `
        ${canOps() ? '<div class="labor-toolbar"><button class="btn btn-primary" type="button" data-enquiry-new>New price enquiry</button></div>' : ''}
        <div class="card tbl-wrap"><table class="tbl">
        <thead><tr><th>BN ref</th><th>Route</th><th>Vessel</th><th class="num">Total</th><th>Approval</th></tr></thead>
        <tbody>${shown.length ? shown.map(s => `
          <tr class="row-click" data-open="${s.id}">
            <td><b>${esc(s.enquiry_ref || shipmentLabel(s))}</b>${s.enquiry_ref && shipmentLabel(s) !== s.enquiry_ref ? `<span class="sub">${esc(shipmentLabel(s))}</span>` : ''}</td>
            <td>${esc(s.loaded_from) || '—'} → ${esc(s.destination) || '—'}</td>
            <td>${esc(s.vessel_name) || '—'}</td>
            <td class="num">${s.enquiry_total ? money(s.enquiry_total) : '—'}</td>
            <td>${s.status === 'approved' ? '<span class="badge b-good">Approved</span>' : s.enquiry_rejected ? '<span class="badge b-serious">Rejected · correction needed</span>' : '<span class="badge b-warn">Awaiting approval</span>'}</td>
          </tr>`).join('') : empty(5, 'No price enquiry yet. Gather the harvest GRNs that travel together, then write the enquiry.', 'No price enquiries match.')}
        </tbody></table></div>`;
      return;
    }
    if (shipTab === 'labor') {
      const laborText = h => [h.reference, h.note, h.work, h.asked_name].join(' ').toLowerCase();
      const shownHires = q ? looseHires.filter(h => laborText(h).includes(q)) : looseHires;
      body.innerHTML = `
        ${canOps() ? '<div class="labor-toolbar"><button class="btn btn-primary" type="button" data-labor-new>New labour hire</button></div>' : ''}
        <div class="card tbl-wrap"><table class="tbl">
        <thead><tr><th>Reference</th><th>Date</th><th>What was hired</th><th class="num">Total</th></tr></thead>
        <tbody>${shownHires.length ? shownHires.map(h => `
          <tr class="row-click" data-hire="${h.id}" tabindex="0">
            <td><b>${esc(h.reference)}</b></td>
            <td>${fmtDate(h.hired_on)}</td>
            <td>${esc(h.work) || '—'}</td>
            <td class="num">${money2(h.total)}</td>
          </tr>`).join('') : `<tr><td colspan="4" class="empty">${looseHires.length ? 'No labour hire forms match.' : 'Labour hire here is not for a shipment. A hire for a shipment is added on that shipment.'}</td></tr>`}
        </tbody></table></div>`;
      return;
    }
    body.innerHTML = `<div class="card tbl-wrap"><table class="tbl">
      <thead><tr><th>Shipment</th><th>Supplier</th><th>Origin</th><th>Arrived</th>
        <th>Into inventory</th><th class="num">On hand, at cost</th></tr></thead>
      <tbody>${shown.length ? shown.map(s => `
        <tr class="row-click" data-open="${s.id}">
          <td><b>${esc(shipmentLabel(s))}</b><span class="sub">${s.grn_ref ? esc(s.grn_ref) : `${s.lot_count} lot${s.lot_count === 1 ? '' : 's'}`}</span>
            ${s.receipt_prepared_by != null ? `<span class="sub">${receiptReviewStatus(s)}</span>` : ''}</td>
          <td>${esc(s.farmer_name || s.supplier) || '—'}</td>
          <td>${esc(s.loaded_from || s.origin) || '—'}</td>
          <td>${fmtDate(s.arrived_at)}</td>
          <td>${shipmentProductPreview(s.products ?? [])}</td>
          <td class="num">${s.stock_value ? money(s.stock_value) : '—'}</td>
        </tr>`).join('') : empty(6, shipTab === 'receipt-review' ? 'No receipts are waiting for review.' : 'Nothing received yet.', 'No shipments match.')}
      </tbody></table></div>`;
  };
  paint();
  $('[data-ship-filter]', view).addEventListener('input', e => {
    shipmentQuery = e.target.value;
    paint();
  });
  view.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      shipTab = tab.dataset.tab;
      $$('[data-tab]', view).forEach(b => {
        const on = b.dataset.tab === shipTab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      paint();
      return;
    }
    if (e.target.closest('[data-labor-new]')) { laborHireModal(null); return; }
    if (e.target.closest('[data-enquiry-new]')) { priceEnquiryModal(null); return; }
    const hireRow = e.target.closest('[data-hire]');
    if (hireRow) {
      const hire = hires.find(h => h.id === +hireRow.dataset.hire);
      if (hire) laborHireModal(hire);
      return;
    }
    const grnRow = e.target.closest('[data-grn]');
    if (grnRow) { harvestGrnDetail(+grnRow.dataset.grn); return; }
    const row = e.target.closest('[data-open]');
    if (row) shipmentDetailModal(+row.dataset.open);
  });
  view.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const hireRow = e.target.closest('[data-hire]');
    if (hireRow) {
      e.preventDefault();
      const hire = hires.find(h => h.id === +hireRow.dataset.hire);
      if (hire) laborHireModal(hire);
      return;
    }
    const grnRow = e.target.closest('[data-grn]');
    if (grnRow) {
      e.preventDefault();
      harvestGrnDetail(+grnRow.dataset.grn);
      return;
    }
    const row = e.target.closest('[data-open]');
    if (!row) return;
    e.preventDefault();
    shipmentDetailModal(+row.dataset.open);
  });
}

function harvestLinesHtml(lines) {
  if (!lines.length) return '';
  return `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Crop</th><th>Grades</th><th class="num">Harvest</th><th class="num">Damaged</th><th class="num">Undamaged</th><th>Harvested</th></tr></thead>
    <tbody>${lines.map(l => `
      <tr>
        <td><b>${esc(l.description || l.product || '')}</b></td>
        <td>${(l.grades || []).map(g => {
          const asBunch = g.pack_unit === 'bunch' || (!g.pack_unit && g.bunches > 0 && !(g.pack_count > 0));
          const packUnit = asBunch ? 'bunch' : (g.pack_unit === 'sack' ? 'sack' : g.pack_unit === 'basket' ? 'basket' : 'box');
          const packN = asBunch ? g.bunches : g.pack_count;
          const pack = packN ? `${plainNum(packN)} ${Number(packN) === 1 ? packUnit : packUnit + (packUnit === 'box' ? 'es' : 's')}` : '';
          return `<span class="hv-grade-read"><b>${esc(g.grade)}</b><span>${plainNum(g.kg) || '0'} kg${pack ? ` · ${pack}` : ''}</span><span class="hv-grade-price">${money2(g.unit_cost)}</span></span>`;
        }).join('')}</td>
        <td class="num">${plainNum(l.harvest_kg)} kg</td>
        <td class="num">${plainNum(l.damaged_kg) || '0'} kg</td>
        <td class="num">${plainNum(l.undamaged_kg) || '0'} kg</td>
        <td>${l.harvested_at ? fmtDate(l.harvested_at) : '—'}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

function enquiryLinesHtml(lines, total) {
  if (!lines.length) return '';
  return `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th class="num">Qty</th><th>Units</th><th>Description</th><th class="num">Rate</th><th class="num">Total</th></tr></thead>
    <tbody>${lines.map(l => `
      <tr>
        <td class="num">${plainNum(l.qty)}</td>
        <td>${cell(l.unit)}</td>
        <td>${esc(l.description)}</td>
        <td class="num">${money(l.rate)}</td>
        <td class="num">${money(l.line_total)}</td>
      </tr>`).join('')}
      <tr><td colspan="4"></td><td class="num"><b>${money(total)}</b></td></tr>
    </tbody></table></div>`;
}

function laborLinesHtml(lines, total) {
  if (!lines.length) return '';
  return `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>What was hired</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
    <tbody>${lines.map(l => `
      <tr>
        <td>${esc(l.description)}</td>
        <td class="num">${plainNum(l.qty)}</td>
        <td class="num">${money2(l.rate)}</td>
        <td class="num">${money2(l.line_total)}</td>
      </tr>`).join('')}
      <tr><td colspan="3"></td><td class="num"><b>${money2(total)}</b></td></tr>
    </tbody></table></div>`;
}

function money2(laari) {
  if (laari == null || !Number.isFinite(Number(laari))) return '—';
  return 'MVR ' + (Number(laari) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Same rounding as landingFigures in lib/db.mjs. Charges divided by the
// kilograms left to sell, then added to the price paid for what arrived.
function paintLanding(root) {
  const sheet = $('[data-landing]', root);
  if (!sheet) return;
  const editable = sheet.dataset.editable === '1';
  let ground = Number(sheet.dataset.landGround || 0);
  let other = Number(sheet.dataset.landOther || 0);
  let bad = false;
  if (editable) {
    ground = 0;
    other = 0;
    for (const tr of $$('[data-land-line]', root)) {
      const amt = landChargeAmount(tr);
      if (amt == null) bad = true;
      else if (tr.dataset.kind === 'other') other += amt;
      else ground += amt;
    }
  }
  const logistic = ground + other + Number(sheet.dataset.landBoat || 0) + Number(sheet.dataset.landLabor || 0);
  const logisticEl = $('[data-land-logistic]', root);
  if (logisticEl) logisticEl.textContent = money2(logistic);
  const crops = $$('[data-land-crop]', root).map(el => {
    const input = $('[data-land-cost]', el);
    let unit_cost = Number(el.dataset.cost || 0);
    if (input) {
      const read = readCropMoney(input);
      if (read == null) bad = true;
      else unit_cost = read;
    }
    return {
      el,
      unit_cost,
      kg: Number(el.dataset.kg || 0),
      received: Number(el.dataset.received || 0),
      unit: el.dataset.unit || 'kg',
    };
  });
  if (bad) return;
  const kgLines = crops.filter(c => c.unit === 'kg' && c.kg > 0);
  const kg = Math.round(kgLines.reduce((sum, c) => sum + c.kg, 0) * 1000) / 1000;
  const per = kg > 0 ? Math.round(logistic / kg) : null;
  const perEl = $('[data-land-perkg]', root);
  if (perEl) perEl.textContent = per == null ? '—' : `${money2(per)} / kg`;
  let value = 0;
  for (const c of crops) {
    const out = $('[data-land-result]', c.el);
    let landing = null;
    if (c.unit === 'kg' && c.kg > 0 && per != null) {
      landing = Math.round(c.unit_cost * c.received / c.kg) + per;
      value += c.unit_cost * c.received;
    }
    if (out) out.textContent = landing == null ? '—' : money2(landing);
  }
  const avgRow = $('[data-land-average]', root);
  if (!avgRow) return;
  const products = new Set(kgLines.map(c => c.el.dataset.product));
  const show = products.size === 1 && kgLines.length > 1 && per != null && kg > 0;
  avgRow.hidden = !show;
  if (show) $('[data-land-avg]', avgRow).textContent = money2(Math.round(value / kg) + per);
}

function landChargeAmount(tr) {
  const qtyEl = $('[data-land-qty]', tr);
  const rateEl = $('[data-land-rate]', tr);
  const cell = $('[data-land-amt]', tr);
  const descEl = $('[data-land-desc]', tr);
  const desc = descEl ? descEl.value.trim() : 'Pick-up';
  const qtyRaw = qtyEl.value.trim();
  const rateRaw = rateEl.value.trim();
  const started = descEl ? Boolean(desc || qtyRaw || rateRaw) : Boolean(qtyRaw || rateRaw);
  if (!started) {
    qtyEl.classList.remove('is-bad');
    rateEl.classList.remove('is-bad');
    cell.textContent = '';
    return 0;
  }
  const qty = Number(qtyRaw);
  const rate = parseMoney(rateRaw);
  const okQty = qty > 0 && qty <= 100000;
  const okRate = Number.isInteger(rate) && rate >= 0;
  qtyEl.classList.toggle('is-bad', !okQty);
  rateEl.classList.toggle('is-bad', !okRate);
  if (!okQty || !okRate) {
    cell.textContent = '';
    return null;
  }
  const total = Math.round(qty * rate);
  cell.textContent = money2(total);
  return total;
}

function readCropMoney(el) {
  if (el.value.trim() === '') {
    el.classList.add('is-bad');
    return null;
  }
  const n = parseMoney(el.value);
  const ok = Number.isInteger(n) && n >= 0;
  el.classList.toggle('is-bad', !ok);
  return ok ? n : null;
}

function landBasisLabel(basis, qty) {
  const n = plainNum(qty) || '0';
  const one = Number(qty) === 1;
  if (basis === 'hour') return `${n} ${one ? 'hour' : 'hours'}`;
  if (basis === 'trip') return `${n} ${one ? 'trip' : 'trips'}`;
  return n;
}

function landChargeRow(kind, line = {}) {
  const basis = kind === 'ground' ? `<td class="lh-by"><select data-land-basis aria-label="Trips or hours">
      <option value="trip"${line.basis === 'hour' ? '' : ' selected'}>Trips</option>
      <option value="hour"${line.basis === 'hour' ? ' selected' : ''}>Hours</option>
    </select></td>` : '';
  const rate = line.rate == null || line.rate === '' ? '' : (Number(line.rate) / 100).toFixed(2);
  const what = kind === 'ground'
    ? '<td>Pick-up</td>'
    : `<td><input data-land-desc maxlength="80" aria-label="Other charge" value="${esc(line.description || '')}" placeholder="Ice, boxes, or another charge"></td>`;
  return `<tr data-land-line data-kind="${kind}">
    ${what}
    ${basis}
    <td class="lh-qty"><input data-land-qty inputmode="decimal" aria-label="Quantity" value="${line.qty ? esc(plainNum(line.qty)) : ''}"></td>
    <td class="lh-rate"><input data-land-rate inputmode="decimal" aria-label="Rate in MVR" value="${esc(rate)}"></td>
    <td class="num lh-amt" data-land-amt></td>
    <td class="lh-act"><button type="button" class="btn btn-ghost btn-sm" data-land-remove>Remove</button></td>
  </tr>`;
}

function landChargeTable(kind, lines) {
  if (!lines.length) return '';
  const ground = kind === 'ground';
  const head = ground
    ? '<th>What</th><th>By</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th><th></th>'
    : '<th>What</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th><th></th>';
  return `<div class="tbl-wrap land-editor"><table class="tbl order-lines lh-work">
      <thead><tr>${head}</tr></thead>
      <tbody data-land-charges="${kind}">${lines.map(l => landChargeRow(kind, l)).join('')}</tbody>
    </table></div>`;
}

function landChargeRead(line, kind) {
  const sub = kind === 'ground'
    ? `${landBasisLabel(line.basis, line.qty)} × ${money2(line.rate)}`
    : `${plainNum(line.qty) || '0'} × ${money2(line.rate)}`;
  const name = kind === 'ground' ? 'Pick-up' : line.description;
  return `<div class="land-row"><span class="land-label">${esc(name)}<span class="land-sub">${sub}</span></span><b class="land-value">${money2(line.line_total)}</b></div>`;
}

function landCropRow(l, editable) {
  const grade = l.grade ? ` · ${esc(l.grade)}` : '';
  const qtyMain = (l.unit || 'kg') === 'kg'
    ? (plainNum(l.kg) || '0')
    : `${plainNum(l.kg) || '0'} ${esc(l.unit || '')}`;
  const receivedNote = (l.unit || 'kg') === 'kg' && Math.abs(Number(l.received_kg) - Number(l.kg)) > 0.001
    ? `<span class="land-sub">${plainNum(l.received_kg) || '0'} received</span>`
    : '';
  const qty = `${qtyMain}${receivedNote}`;
  const fromGrn = String(l.key || '').startsWith('g:');
  const paid = editable && !fromGrn
    ? `<input class="land-money" data-land-cost inputmode="decimal" aria-label="Buying price for ${esc(l.product)}" value="${(Number(l.unit_cost) / 100).toFixed(2)}">`
    : money2(l.unit_cost);
  return `<tr data-land-crop data-key="${esc(l.key)}" data-product="${esc(l.product_id || l.product)}" data-kg="${l.kg}" data-received="${l.received_kg}" data-unit="${esc(l.unit || 'kg')}" data-cost="${l.unit_cost}">
    <td>${esc(l.product)}${grade}</td>
    <td class="num">${qty}</td>
    <td class="num">${paid}</td>
    <td class="num" data-land-result>${l.landing_per_kg == null ? '—' : money2(l.landing_per_kg)}</td>
  </tr>`;
}

function landCropHint(landing) {
  const kg = (landing.lines || []).filter(l => (l.unit || 'kg') === 'kg' && Number(l.kg) > 0);
  const names = new Set(kg.map(l => l.product));
  if (kg.length > 1 && names.size === 1) return 'The moving cost per kg is the same for every grade. Break even differs where the buying price differs.';
  if (names.size > 1) return 'The moving cost per kg is shared. Each grade keeps its own break-even price.';
  return 'Break even is the buying price, spread over the kg left to sell, plus the moving cost per kg.';
}

function landingPanelHtml(landing, { savePrimary = false } = {}) {
  const editable = canOps();
  const boatLabel = landing.boat_name ? `Boat freight (${landing.boat_name})` : 'Boat freight';
  const boatNote = landing.has_enquiry ? 'Approved price enquiry' : 'No approved price enquiry';
  const laborNote = landing.labor_ref ? `Form ${landing.labor_ref}` : '';
  const groundBlock = editable
    ? `<div data-land-slot="ground">${landChargeTable('ground', landing.ground_lines || [])}</div>`
    : (landing.ground_lines || []).map(l => landChargeRead(l, 'ground')).join('');
  const otherBlock = editable
    ? `<div data-land-slot="other">${landChargeTable('other', landing.other_lines || [])}</div>`
    : (landing.other_lines || []).map(l => landChargeRead(l, 'other')).join('');
  const adds = editable ? `<div class="land-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-land-add="ground">Pick-up</button>
      ${landing.labor_ref ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-add-labor>Labour hire</button>'}
      <button type="button" class="btn btn-ghost btn-sm" data-land-add="other">Other charge</button>
    </div>` : '';
  const kgCount = (landing.lines || []).filter(l => (l.unit || 'kg') === 'kg' && Number(l.kg) > 0).length;
  const showAvg = landing.one_crop && kgCount > 1;
  const crops = (landing.lines || []).length
    ? `<div class="tbl-wrap"><table class="tbl land-crops">
        <thead><tr><th>Crop</th><th class="num">To sell</th><th class="num">Buying price</th><th class="num">Break even</th></tr></thead>
        <tbody>
          ${landing.lines.map(l => landCropRow(l, editable)).join('')}
          <tr data-land-average${showAvg ? '' : ' hidden'}><td colspan="3">Average for this crop</td><td class="num" data-land-avg>${landing.landing_per_kg == null ? '' : money2(landing.landing_per_kg)}</td></tr>
        </tbody>
      </table></div>
      <p class="hint">${esc(landCropHint(landing))}</p>`
    : '<p class="hint">This shipment has no crop weight yet.</p>';
  const save = editable
    ? `<p class="land-add"><button type="button" class="${savePrimary ? 'btn btn-primary' : 'btn'}" data-land-save>Save landing cost</button></p>`
    : '';
  return `<div class="land-sheet" data-landing data-editable="${editable ? 1 : 0}" data-land-boat="${landing.boat_freight || 0}" data-land-labor="${landing.labor_hire || 0}" data-land-ground="${landing.ground_transport || 0}" data-land-other="${landing.other_charges || 0}" data-save-primary="${savePrimary ? 1 : 0}">
      <div class="land-head">Charges</div>
      ${groundBlock}
      <div class="land-row"><span class="land-label">${esc(boatLabel)}<span class="land-sub">${boatNote}</span></span><b class="land-value">${money2(landing.boat_freight || 0)}</b></div>
      ${landing.labor_ref
        ? `<div class="land-row"><span class="land-label">Labour hire<span class="land-sub">${esc(laborNote)}</span></span><b class="land-value">${money2(landing.labor_hire || 0)}</b></div>`
        : ''}
      ${otherBlock}
      ${adds}
      <div class="land-row"><span class="land-label">Total logistic charges</span><b class="land-value" data-land-logistic></b></div>
      <div class="land-row land-result"><span class="land-label">Moving cost per kg<span class="land-sub">${esc(landing.weight_note || '')}</span></span><b class="land-value" data-land-perkg></b></div>
    </div>
    <div class="card-title mb section-gap">Each crop</div>
    ${crops}
    ${save}`;
}

function readChargePayload(root, kind) {
  const rows = [];
  for (const tr of $$(`[data-land-line][data-kind="${kind}"]`, root)) {
    const description = kind === 'ground' ? 'Pick-up' : $('[data-land-desc]', tr).value.trim();
    const qtyRaw = $('[data-land-qty]', tr).value.trim();
    const rateRaw = $('[data-land-rate]', tr).value.trim();
    if (kind === 'ground' ? !qtyRaw && !rateRaw : !description && !qtyRaw && !rateRaw) continue;
    const label = kind === 'ground' ? 'pick-up or hourly hire' : 'other charge';
    if (!description) return { error: `Name the ${label}` };
    const qty = Number(qtyRaw);
    const rate = parseMoney(rateRaw);
    if (!(qty > 0)) return { error: `Enter the quantity for the ${label}` };
    if (!Number.isInteger(rate) || rate < 0) return { error: 'Enter the rate in rufiyaa' };
    const basis = kind === 'ground' ? $('[data-land-basis]', tr).value : 'each';
    rows.push({ description, basis, qty, rate });
  }
  return { rows };
}

async function saveLanding(modal, shipmentId) {
  const root = $('[data-landing-root]', modal);
  paintLanding(root);
  const ground = readChargePayload(root, 'ground');
  const other = readChargePayload(root, 'other');
  if (ground.error) return toast(ground.error, 'err');
  if (other.error) return toast(other.error, 'err');
  const lines = [];
  for (const el of $$('[data-land-crop]', root)) {
    const input = $('[data-land-cost]', el);
    const unit_cost = input ? readCropMoney(input) : Number(el.dataset.cost);
    if (unit_cost == null) return toast('Enter the price paid for each crop', 'err');
    lines.push({ key: el.dataset.key, unit_cost });
  }
  const sheet = $('[data-landing]', root);
  const savePrimary = sheet?.dataset.savePrimary === '1';
  const landing = await api('/api/shipments/' + shipmentId + '/landing', {
    body: { ground: ground.rows, other: other.rows, lines },
  });
  root.innerHTML = landingPanelHtml(landing, { savePrimary });
  paintLanding(root);
  toast(landing.logistic_per_kg == null
    ? 'Saved. There are no kilograms to spread the charges over yet.'
    : `Moving cost ${money2(landing.logistic_per_kg)} per kg.`);
}

function wireLanding(modal, shipmentId) {
  const root = $('[data-landing-root]', modal);
  if (!root || root.dataset.wired) return;
  root.dataset.wired = '1';
  paintLanding(root);
  root.addEventListener('input', () => paintLanding(root));
  root.addEventListener('click', async e => {
    const add = e.target.closest('[data-land-add]');
    if (add) {
      const kind = add.dataset.landAdd;
      const count = $$(`[data-land-line][data-kind="${kind}"]`, root).length;
      if (count >= 12) {
        return toast(kind === 'ground' ? 'A shipment can hold 12 pick-up lines' : 'A shipment can hold 12 other charges', 'err');
      }
      const body = $(`[data-land-charges="${kind}"]`, root);
      const slot = $(`[data-land-slot="${kind}"]`, root);
      if (!body && slot) slot.insertAdjacentHTML('beforeend', landChargeTable(kind, [{}]));
      else if (body) body.insertAdjacentHTML('beforeend', landChargeRow(kind, {}));
      paintLanding(root);
      return;
    }
    const remove = e.target.closest('[data-land-remove]');
    if (remove) {
      const tr = remove.closest('[data-land-line]');
      const tbody = tr.parentElement;
      tr.remove();
      if (!tbody.children.length) tbody.closest('.land-editor')?.remove();
      paintLanding(root);
      return;
    }
    const save = e.target.closest('[data-land-save]');
    if (!save || save.disabled) return;
    save.disabled = true;
    try {
      await saveLanding(modal, shipmentId);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      const again = $('[data-land-save]', root);
      if (again) again.disabled = false;
    }
  });
}

function verifyBadge(s) {
  if (s.verify_state === 'verified') return '<span class="badge b-good">Verified</span>';
  if (s.verify_state === 'sent_back') return '<span class="badge b-serious">Sent back</span>';
  if (s.verify_state === 'waiting') return '<span class="badge b-warn">Waiting</span>';
  return '—';
}

// Someone in Operations other than whoever filled the GRN in or last corrected
// it verifies it. Admin can verify any.
function canVerifyHarvest(s) {
  return canOps() && (isAdmin() || (s.harvest_by !== me?.id && s.harvest_fixed_by !== me?.id));
}

function harvestCheckHtml(s) {
  const when = date => (date ? ` on ${fmtDate(date)}` : '');
  if (s.verify_state === 'verified') {
    return `<p class="hint">Verified by ${esc(s.regional_name)}${when(s.regional_date)}.</p>`;
  }
  if (s.verify_state === 'sent_back') {
    return `<p class="hint warn-text">Sent back by ${esc(s.sent_back_name)}${when(s.sent_back_at)}: ${esc(s.sent_back_note)}</p>
      ${canOps() ? `<p class="hv-check-actions"><button type="button" class="btn btn-sm btn-primary" data-hv-correct="${s.id}">Correct it</button></p>` : ''}`;
  }
  if (s.verify_state !== 'waiting') return '';
  const canCheck = canVerifyHarvest(s);
  const corrected = s.sent_back_note
    ? ` Corrected after ${esc(s.sent_back_name)} sent it back: ${esc(s.sent_back_note)}` : '';
  return `<p class="hint">${canCheck ? 'Waiting to be verified.' : 'Waiting to be verified by someone else in Operations.'}${corrected}</p>
    ${canCheck ? `<p class="hv-check-actions"><button type="button" class="btn btn-sm btn-primary" data-hv-verify="${s.id}">Verify</button>
      <button type="button" class="btn btn-sm" data-hv-send-back="${s.id}">Send back</button></p>` : ''}`;
}

function harvestBlocks(d) {
  const boat = d.shipment;
  const grns = d.harvest_grns || [];
  const lines = d.harvest_lines || [];
  if (!grns.length && !lines.length) return '';
  const groups = grns.length ? grns : [{ id: 0, harvest_ref: boat.harvest_ref, farmer_name: boat.farmer_name, farmer_island: boat.farmer_island }];
  return groups.map(g => {
    const own = lines.filter(l => l.harvest_grn_id === g.id);
    return `<section class="hv-grn">
      <div class="hv-grn-head"><b>${esc(g.harvest_ref || 'Harvest GRN')}</b>
        <span class="muted">${[g.farmer_name, g.farmer_island].filter(Boolean).map(esc).join(' · ')}</span></div>
      <div class="hv-grn-body">
      ${own.length ? harvestLinesHtml(own) : ''}
      <p class="hint">Received from the farmer. This is not sellable inventory yet.</p>
      ${harvestCheckHtml(g)}
      <p class="hv-check-actions">
        ${g.id ? `<a class="btn btn-sm btn-primary" href="/print/harvest-grn/${g.id}" target="_blank" rel="noopener">Print</a>` : ''}
        ${g.id && canOps() && boat?.status === 'enquiry' ? `<button type="button" class="btn btn-sm btn-danger" data-grn-remove="${g.id}">Remove</button>` : ''}
      </p>
      </div>
    </section>`;
  }).join('');
}

function receiptReviewStatus(s) {
  if (s.receipt_verified_by != null) return 'Verified';
  return s.receipt_checked_by != null ? 'Awaiting HOD verification' : 'Awaiting check';
}

async function shipmentDetailModal(id) {
  let d;
  try { d = await api('/api/shipments/' + id); }
  catch (err) { return toast(err.message, 'err'); }
  const s = d.shipment;
  const lines = d.lines || [];
  const enquiry = d.enquiry_lines || [];
  const labor = d.labor;
  const stage = shipmentStage(s);
  const trackedReceipt = Boolean(s.grn_ref && s.receipt_prepared_by != null);
  const canCheckReceipt = trackedReceipt && canOps() && s.receipt_checked_by == null
    && (isAdmin() || s.receipt_prepared_by !== me.id);
  const canVerifyReceipt = trackedReceipt && canApprove() && s.receipt_checked_by != null
    && s.receipt_verified_by == null && (isAdmin() || ![s.receipt_prepared_by, s.receipt_checked_by].includes(me.id));
  const showLanding = ['approved', 'in_transit', 'received'].includes(s.status || 'received');
  const print = [
    labor ? `<a class="btn" href="/print/labor-hire/${labor.id}" target="_blank" rel="noopener">Print labour hire</a>` : '',
    s.grn_ref ? `<a class="btn" href="/print/item-receipt/${s.id}" target="_blank" rel="noopener">Print item receipt</a>` : '',
  ].join('');
  const enquiryBtn = (s.status === 'harvested' || s.status === 'enquiry') && canOps()
    ? `<button class="btn${s.status === 'harvested' ? ' btn-primary' : ''}" data-enquiry>${s.status === 'enquiry' ? 'Edit price enquiry' : 'Price enquiry'}</button>`
    : '';
  const approveBtn = s.status === 'enquiry' && !s.enquiry_rejected && canApprove() ? '<button class="btn btn-primary" data-approve>Approve</button>' : '';
  const next = s.status === 'approved' && canOps() ? '<button class="btn btn-primary" data-boat>Boat note</button>'
    : s.status === 'in_transit' && canOps() ? '<button class="btn btn-primary" data-grn>Item receipt</button>'
    : '';
  const m = openModal({
    title: shipmentLabel(s),
    wide: true,
    body: `
      ${shipmentTrackHtml(s)}
      <p class="muted mb">${esc(harvestRefLine(s) || s.farmer_name || s.supplier || '')}
        ${s.farmer_name && harvestRefLine(s) ? ` · ${esc(s.farmer_name)}` : ''}
        ${s.loaded_from || s.destination ? ` · ${esc(s.loaded_from || s.farmer_island || '')} → ${esc(s.destination || '')}` : ''}
        ${s.grn_ref ? ' · ' + esc(s.grn_ref) : ''}</p>
      ${trackedReceipt ? `<section class="doc-block">
        <div class="doc-block-head"><b>Item receipt review</b><span class="badge ${s.receipt_verified_by != null ? 'b-good' : 'b-warn'}">${receiptReviewStatus(s)}</span></div>
        <div class="doc-block-body">
          <p>Prepared by <strong>${esc(s.prepared_name)}</strong> · ${esc(s.prepared_role)}</p>
          ${s.receipt_vendor ? `<p>Vendor: ${esc(s.receipt_vendor)}</p>` : ''}
          ${s.receipt_memo ? `<p>Memo: ${esc(s.receipt_memo)}</p>` : ''}
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Item</th><th class="num">Quantity received</th></tr></thead>
            <tbody>${lines.filter(l => l.received_qty > 0).map(l => `
              <tr><td>${esc(l.description || l.product)}</td><td class="num">${exactQty(l.received_qty, l.unit)}</td></tr>`
            ).join('')}</tbody>
          </table></div>
          ${s.receipt_checked_by != null ? `<p>Checked by <strong>${esc(s.checked_name)}</strong> · ${esc(s.checked_role)}</p>`
            : `<p class="hint">${isAdmin() ? 'As Admin, you can check this receipt and then verify it.' : 'A different Operations user must check this receipt.'}</p>`}
          ${s.receipt_verified_by != null ? `<p>Verified by <strong>${esc(s.verified_name)}</strong> · ${esc(s.verified_role)}</p>` : ''}
          ${canCheckReceipt ? '<div class="hv-check-actions"><button type="button" class="btn btn-primary" data-receipt-action="check">Check item receipt</button></div>' : ''}
          ${canVerifyReceipt ? '<div class="hv-check-actions"><button type="button" class="btn btn-primary" data-receipt-action="verify">Verify item receipt</button></div>' : ''}
        </div>
      </section>` : ''}
      ${s.enquiry_rejected ? `<p class="card card-pad"><strong>Price enquiry rejected</strong><br>${esc(s.enquiry_note)}<br>Edit the price enquiry and save it to resubmit for approval.</p>` : ''}
      ${harvestBlocks(d)}
      ${enquiry.length ? `<section class="doc-block">
        <div class="doc-block-head"><b>Boat price enquiry</b><a class="btn btn-sm btn-primary" href="/print/price-enquiry/${s.id}" target="_blank" rel="noopener">Print</a></div>
        <div class="doc-block-body">${enquiryLinesHtml(enquiry, d.enquiry_total)}
        ${s.approved_name ? `<p class="hint">Approved by ${esc(s.approved_name)}${s.approved_at ? ' on ' + fmtDate(s.approved_at) : ''}${s.enquiry_note ? ' · ' + esc(s.enquiry_note) : ''}.</p>` : s.enquiry_rejected ? '<p class="hint">Awaiting correction and resubmission.</p>' : '<p class="hint">Waiting for an Operations HOD to approve it. The boat note stays closed until then.</p>'}
        </div></section>` : ''}
      ${labor ? `<div class="card-title mb section-gap">Labour hire</div>${laborLinesHtml(labor.lines, labor.total)}
        <p class="hint">${[
          labor.note || '',
          labor.asked_name ? `Asked by ${labor.asked_name}` : '',
        ].filter(Boolean).map(esc).join(' · ') || 'Added to this shipment\'s landing cost.'}</p>
        ${isAdmin() ? '<p class="hv-check-actions"><button type="button" class="btn btn-sm" data-labor-edit>Edit labour hire</button></p>' : ''}` : ''}
      ${lines.length ? `<section class="doc-block">
        <div class="doc-block-head"><b>Boat note</b><a class="btn btn-sm btn-primary" href="/print/boat-note/${s.id}" target="_blank" rel="noopener">Print</a></div>
        <div class="doc-block-body">${boatLinesHtml(lines)}
        ${stage === 'transit' ? '<p class="hint">Stock is added when this arrives and the item receipt is written.</p>' : ''}
        </div></section>` : ''}
      ${!lines.length && stage === 'transit' ? '<p class="hint">Stock is added when this arrives and the item receipt is written.</p>' : ''}
      ${showLanding ? `<div class="card-title mb section-gap">Landing cost</div>
        <p class="hint mb">Pickup, the approved boat price, and labour hire when there was a hire, spread over the kilograms left to sell and added to the buying price of each grade. Break even is the price to sell at to cover this shipment.</p>
        <div data-landing-root>${landingPanelHtml(d.landing, { savePrimary: (s.status || 'received') === 'received' })}</div>` : ''}
      ${stage === 'received' ? `<div class="card-title mb section-gap">In inventory</div>${shipmentLotsHtml(d.lots)}` : ''}`,
    footer: `${isAdmin() ? '<button class="btn btn-danger" data-remove-ship>Remove shipment</button>' : ''}
      ${print}
      ${enquiryBtn}
      ${approveBtn}
      ${next}
      <button class="btn" data-close>Close</button>`,
  });
  if (showLanding) wireLanding(m.modal, s.id);
  const addLabor = $('[data-add-labor]', m.modal);
  if (addLabor) addLabor.addEventListener('click', () => {
    m.close();
    laborHireModal(null, { linkRef: s.reference });
  });
  const editLabor = $('[data-labor-edit]', m.modal);
  if (editLabor) editLabor.addEventListener('click', () => {
    m.close();
    laborHireModal(labor, { linkRef: labor.link_ref || s.reference });
  });
  const enquiryOpen = $('button[data-enquiry]', m.modal);
  if (enquiryOpen) enquiryOpen.addEventListener('click', () => { m.close(); priceEnquiryModal(d); });
  const approveOpen = $('button[data-approve]', m.modal);
  if (approveOpen) approveOpen.addEventListener('click', () => { m.close(); approveEnquiryModal(d); });
  const boatBtn = $('button[data-boat]', m.modal);
  if (boatBtn) boatBtn.addEventListener('click', () => { m.close(); boatNoteModal(d); });
  const grn = $('button[data-grn]', m.modal);
  if (grn) grn.addEventListener('click', () => { m.close(); grnModal(d); });
  const receiptAction = $('[data-receipt-action]', m.modal);
  if (receiptAction) busyClick(receiptAction, async () => {
    const action = receiptAction.dataset.receiptAction;
    const complete = async (strokes) => {
      await api(`/api/shipments/${id}/grn/${action}`, { method: 'POST', body: { strokes } });
      m.close();
      toast(action === 'check' ? 'Receipt checked and ready for verification.' : 'Item receipt verified.');
      refresh();
      shipmentDetailModal(id);
    };
    if (action === 'verify') return verifyWithSignature(me.name, s.grn_ref, complete);
    try { await complete(); } catch (err) { toast(err.message, 'err'); }
  });
  const grnById = id => (d.harvest_grns || []).find(g => g.id === id);
  for (const removeBtn of $$('[data-grn-remove]', m.modal)) busyClick(removeBtn, async () => {
    const g = grnById(+removeBtn.dataset.grnRemove);
    if (!g) return;
    const last = (d.harvest_grns || []).length === 1;
    const ok = await confirmModal(
      last
        ? `Remove ${g.harvest_ref}? It is the only harvest GRN on this price enquiry, so the enquiry is removed too.`
        : `Remove ${g.harvest_ref}? It comes off this price enquiry.`,
      { title: 'Remove harvest GRN', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      const res = await api('/api/harvest-grns/' + g.id, { method: 'DELETE' });
      m.close();
      toast(res.removed_enquiry ? `Removed ${g.harvest_ref}. The price enquiry is gone too.` : `Removed ${g.harvest_ref}.`);
      refresh();
      if (!res.removed_enquiry) shipmentDetailModal(s.id);
    } catch (err) { toast(err.message, 'err'); }
  });
  for (const verifyBtn of $$('[data-hv-verify]', m.modal)) busyClick(verifyBtn, async () => {
    const g = grnById(+verifyBtn.dataset.hvVerify);
    if (!g) return;
    verifyWithSignature(me.name, g.harvest_ref, async strokes => {
      await api(`/api/harvest-grns/${g.id}/verify`, { body: { strokes } });
      m.close();
      toast(`Verified ${g.harvest_ref}.`);
      refresh();
    });
  });
  for (const sendBackBtn of $$('[data-hv-send-back]', m.modal)) {
    sendBackBtn.addEventListener('click', () => {
      const g = grnById(+sendBackBtn.dataset.hvSendBack);
      if (!g) return;
      m.close();
      sendBackModal(g);
    });
  }
  for (const correctBtn of $$('[data-hv-correct]', m.modal)) {
    correctBtn.addEventListener('click', () => {
      const g = grnById(+correctBtn.dataset.hvCorrect);
      if (!g) return;
      m.close();
      harvestGrnModal(d, g.id);
    });
  }
  const removeBtn = $('[data-remove-ship]', m.modal);
  if (removeBtn) busyClick(removeBtn, async () => {
    const label = shipmentLabel(s);
    const ok = await confirmModal(
      `Remove ${label}? This deletes the harvest GRN, the price enquiry, the boat note, and any stock this shipment put into inventory. A labour hire linked to it stays, without the shipment.`,
      { title: 'Remove shipment', confirmLabel: 'Remove shipment', danger: true });
    if (!ok) return;
    try {
      const res = await api('/api/shipments/' + s.id, { method: 'DELETE' });
      const sales = res.orders_removed || res.orders_changed ? ' Sales of that stock were removed with it.' : '';
      toast(res.had_stock
        ? `Removed ${res.reference}. Its stock is out of inventory.${sales}`
        : `Removed ${res.reference}.${sales}`);
      m.close();
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// A saved crop opens with its grades; their ids go back with a correction.
function harvestCropCard(products, line = null) {
  const t0 = todayStr();
  const grades = line?.grades.length
    ? line.grades.map(g => harvestGradeRow({
      id: g.id, grade: g.grade, kg: plainNum(g.kg) || '0', bag: plainNum(g.per_bag_kg) || '0',
      remarks: g.remarks, price: (Number(g.unit_cost || 0) / 100).toFixed(2),
      ...gradeTravel(g, line.product || line.description || ''),
    })).join('')
    : harvestGradeRow({ grade: 'A' });
  return `<div class="line-card" data-hv-line${line ? ` data-line-id="${line.id}"` : ''}>
    <div class="form-grid">
      <div class="field"><label>Crop</label>
        <select data-hv-product aria-label="Crop"><option value="">Choose an item</option>
          ${products.map(p => `<option value="${p.id}"${line?.product_id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></div>
      <div class="field"><label>Harvested date</label><input data-hv-date type="date" value="${esc(line?.harvested_at || t0)}" max="${t0}"></div>
    </div>
    <div class="form-grid">
      <div class="field"><label>Total harvest (kg)</label><input data-hv-kg inputmode="decimal" placeholder="53" value="${line ? plainNum(line.harvest_kg) : ''}"></div>
      <div class="field"><label>Damaged (kg)</label><input data-hv-dmg inputmode="decimal" value="${line ? plainNum(line.damaged_kg) || '0' : '0'}"></div>
      <div class="field"><label>Undamaged (kg)</label><input data-hv-good readonly tabindex="-1" value=""></div>
      <div class="field"><label>Bunches <span class="muted">(optional)</span></label><input data-hv-bunches inputmode="numeric" value="${line?.bunches || ''}"></div>
      <div class="field"><label>Hands <span class="muted">(optional)</span></label><input data-hv-hands inputmode="numeric" value="${line?.hands || ''}"></div>
    </div>
    <div class="hv-grades-head"><span class="field-label">Grades</span><span class="hint" data-hv-sum aria-live="polite"></span></div>
    <div class="tbl-wrap"><table class="tbl order-lines hv-grades">
      <thead><tr><th class="hv-g-name">Grade</th><th class="hv-g-kg">Kg</th><th class="hv-g-price">Buying price</th><th class="hv-g-travel">Travels as</th>
        <th class="hv-g-count">How many</th><th class="hv-g-bag">Kg in each bag</th><th>Remarks</th><th class="hv-g-act"></th></tr></thead>
      <tbody data-hv-grades>${grades}</tbody>
    </table></div>
    <p class="hv-line-actions">
      <button type="button" class="btn btn-sm" data-hv-grade-add>Add grade</button>
      <button type="button" class="btn btn-ghost btn-sm" data-hv-remove>Remove crop</button>
    </p>
  </div>`;
}

const GRADE_TRAVEL = [['box', 'Boxes'], ['sack', 'Sacks'], ['basket', 'Baskets'], ['bunch', 'Bunches']];

function gradeTravel(g, cropName = '') {
  const known = GRADE_TRAVEL.map(([unit]) => unit);
  if (known.includes(g?.pack_unit)) {
    const n = g.pack_unit === 'bunch' ? g.bunches : g.pack_count;
    return { travel: g.pack_unit, count: n ? plainNum(n) : '' };
  }
  const banana = /banana/i.test(cropName);
  if (Number(g?.bunches) > 0 && (banana || !(Number(g?.pack_count) > 0))) return { travel: 'bunch', count: plainNum(g.bunches) };
  if (Number(g?.pack_count) > 0) return { travel: 'box', count: plainNum(g.pack_count) };
  return { travel: banana ? 'bunch' : 'box', count: '' };
}

function paintGradeBag(row) {
  if (!row) return;
  const bunch = $('[data-hv-travel]', row).value === 'bunch';
  const bag = $('[data-hv-bag]', row);
  bag.disabled = bunch;
  if (bunch) bag.value = '';
}

function harvestGradeRow({ id = null, grade = '', kg = '', bag = '0', remarks = '', price = '', travel = 'box', count = '' } = {}) {
  const bunch = travel === 'bunch';
  return `<tr data-hv-grade-row${id ? ` data-grade-id="${id}"` : ''}>
    <td class="hv-g-name" data-label="Grade"><input data-hv-grade maxlength="20" aria-label="Grade" value="${esc(grade)}"></td>
    <td class="hv-g-kg" data-label="Kg"><input data-hv-grade-kg inputmode="decimal" aria-label="Kg in this grade" value="${esc(kg)}"></td>
    <td class="hv-g-price" data-label="Buying price per kg"><input data-hv-price inputmode="decimal" aria-label="Buying price per kg" placeholder="30.00" value="${esc(price)}"></td>
    <td class="hv-g-travel" data-label="Travels as"><select data-hv-travel aria-label="How this grade travels">${GRADE_TRAVEL.map(([unit, label]) => `<option value="${unit}"${unit === travel ? ' selected' : ''}>${label}</option>`).join('')}</select></td>
    <td class="hv-g-count" data-label="How many"><input data-hv-count inputmode="numeric" aria-label="How many" placeholder="${bunch ? '12' : '2'}" value="${esc(count)}"></td>
    <td class="hv-g-bag" data-label="Kg in each bag"><input data-hv-bag inputmode="decimal" aria-label="Kg in each bag" value="${bunch ? '' : esc(bag)}"${bunch ? ' disabled' : ''}></td>
    <td class="hv-g-remarks" data-label="Remarks (optional)"><input data-hv-remarks maxlength="120" aria-label="Remarks" value="${esc(remarks)}"></td>
    <td class="hv-g-act"><button type="button" class="btn btn-ghost btn-sm" data-hv-grade-remove>Remove</button></td>
  </tr>`;
}

const round3 = n => Math.round(n * 1000) / 1000;

function undamagedKg(card) {
  const v = $('[data-hv-good]', card).value;
  return v === '' ? null : Number(v);
}

function paintUndamaged(card) {
  const kg = Number($('[data-hv-kg]', card).value);
  const dmg = Number($('[data-hv-dmg]', card).value);
  const out = $('[data-hv-good]', card);
  if (!Number.isFinite(kg) || !Number.isFinite(dmg) || kg < 0 || dmg < 0 || dmg > kg) out.value = '';
  else out.value = String(round3(kg - dmg));
  paintGrades(card);
}

// The first grade takes whatever the other grades leave, until someone types
// its kg, so a crop with one grade needs no extra typing.
function paintGrades(card) {
  const undamaged = undamagedKg(card);
  const kgInputs = $$('[data-hv-grade-kg]', card);
  const kgOf = input => Number(input.value) || 0;
  const [first, ...rest] = kgInputs;
  if (undamaged != null && !first.dataset.typed) {
    first.value = plainNum(Math.max(0, undamaged - rest.reduce((sum, input) => sum + kgOf(input), 0))) || '0';
  }
  const out = $('[data-hv-sum]', card);
  out.classList.remove('warn-text');
  if (undamaged == null) { out.textContent = ''; return; }
  const graded = round3(kgInputs.reduce((sum, input) => sum + kgOf(input), 0));
  const left = round3(undamaged - graded);
  const base = `Grades add up to ${plainNum(graded) || '0'} of ${plainNum(undamaged) || '0'} kg`;
  if (left > 0) out.textContent = `${base} · ${plainNum(left)} kg left`;
  else if (left < 0) {
    out.textContent = `${base} · ${plainNum(-left)} kg too much`;
    out.classList.add('warn-text');
  } else out.textContent = base;
}

function addHarvestGrade(card) {
  const body = $('[data-hv-grades]', card);
  if (body.children.length >= 10) return toast('A crop can have up to 10 grades', 'err');
  const last = $('[data-hv-grade]', body.lastElementChild).value.trim();
  const next = /^[a-y]$/i.test(last) ? String.fromCharCode(last.charCodeAt(0) + 1).toUpperCase() : '';
  const undamaged = undamagedKg(card);
  const graded = $$('[data-hv-grade-kg]', card).reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const left = undamaged == null ? 0 : round3(undamaged - graded);
  const crop = $('[data-hv-product]', card)?.selectedOptions[0]?.textContent || '';
  body.insertAdjacentHTML('beforeend', harvestGradeRow({
    grade: next, kg: left > 0 ? plainNum(left) : '', travel: /banana/i.test(crop) ? 'bunch' : 'box',
  }));
  paintGrades(card);
  $('[data-hv-grade-kg]', body.lastElementChild).focus();
}

// Farmers by ID card. An ID card on more than one contract lists the active
// contract first, then the newest.
function farmersByIdCard(farmers) {
  const map = new Map();
  for (const f of farmers) {
    const key = String(f.id_card || '').trim().toUpperCase();
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (farmerStateOf(a) === 'inactive') - (farmerStateOf(b) === 'inactive')
      || String(b.started_on || '').localeCompare(String(a.started_on || '')) || b.id - a.id);
  }
  return map;
}

// A farmer record can hold two numbers split by a slash. The GRN takes the first.
const farmerPhone = raw => /^(\d+)(?:\/\d+)*$/.exec(String(raw || '').trim())?.[1] || '';

// Written the way the paper book writes it, HRC/O-8/2026/018, with each island
// keeping its own count. The server makes the same number when the GRN is saved.
const harvestIsland = code => code.trim().toUpperCase().replace(/^([A-Z])-0*(?=\d)/, '$1-');
const harvestRefFor = (code, year, n) => `HRC/${harvestIsland(code)}/${year}/${String(n).padStart(3, '0')}`;
const boatRefFor = (code, year, n) => `BN/${harvestIsland(code)}/${year}/${String(n).padStart(3, '0')}`;

async function harvestGrnDetail(id) {
  let d;
  try { d = await api('/api/harvest-grns/' + id); }
  catch (err) { return toast(err.message, 'err'); }
  const g = d.grn;
  const lines = d.lines || [];
  const m = openModal({
    title: g.harvest_ref,
    wide: true,
    body: `
      <p class="muted mb">${esc(g.farmer_name || '')}${g.farmer_island ? ` · ${esc(g.farmer_island)}` : ''}</p>
      ${harvestLinesHtml(lines)}
      <p class="hint">This harvest GRN is not on a boat yet. A price enquiry gathers the GRNs that travel together. The boat starts when the boat note is written.</p>
      ${harvestCheckHtml(g)}
      <p class="hv-check-actions">
        <a class="btn btn-sm btn-primary" href="/print/harvest-grn/${g.id}" target="_blank" rel="noopener">Print</a>
        ${canOps() && !g.shipment_id ? '<button type="button" class="btn btn-sm btn-danger" data-grn-remove>Remove</button>' : ''}
      </p>`,
    footer: `${canOps() && !g.shipment_id ? '<button class="btn btn-primary" data-enquiry>Price enquiry</button>' : ''}
      <button class="btn" data-close>Close</button>`,
  });
  const enquiry = $('button[data-enquiry]', m.modal);
  if (enquiry) enquiry.addEventListener('click', () => { m.close(); priceEnquiryModal(null, [g.id]); });
  const removeGrn = $('[data-grn-remove]', m.modal);
  if (removeGrn) busyClick(removeGrn, async () => {
    const ok = await confirmModal(`Remove ${g.harvest_ref}? This deletes the harvest GRN.`,
      { title: 'Remove harvest GRN', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      await api('/api/harvest-grns/' + g.id, { method: 'DELETE' });
      m.close();
      toast(`Removed ${g.harvest_ref}.`);
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
  for (const verifyBtn of $$('[data-hv-verify]', m.modal)) busyClick(verifyBtn, async () => {
    verifyWithSignature(me.name, g.harvest_ref, async strokes => {
      await api(`/api/harvest-grns/${g.id}/verify`, { body: { strokes } });
      m.close();
      toast(`Verified ${g.harvest_ref}.`);
      refresh();
    });
  });
  for (const sendBackBtn of $$('[data-hv-send-back]', m.modal)) {
    sendBackBtn.addEventListener('click', () => { m.close(); sendBackModal(g); });
  }
  for (const correctBtn of $$('[data-hv-correct]', m.modal)) {
    correctBtn.addEventListener('click', () => {
      m.close();
      harvestGrnModal({
        shipment: g.boat_status ? { status: g.boat_status } : null,
        harvest_grns: [g],
        harvest_lines: lines,
      }, g.id);
    });
  }
}

// A new harvest GRN, or, given the shipment detail of one that was sent back,
// its correction on the same form.
async function harvestGrnModal(saved = null, grnId = null) {
  const boat = saved?.shipment ?? null;
  const grn = grnId ? (saved?.harvest_grns || []).find(g => g.id === grnId) || null : null;
  const s = grn;
  let products, farmers, next;
  try {
    [products, farmers, next] = await Promise.all([
      api('/api/products?active=1'),
      api('/api/farmers').catch(() => []),
      api(`/api/harvest-grns/next${grn ? `?except=${grn.id}` : ''}`).catch(() => null),
    ]);
  } catch (err) { return toast(err.message, 'err'); }
  products = products.filter(p => p.active !== 0);
  const byIdCard = farmersByIdCard(farmers);
  const t0 = todayStr();
  const val = key => esc(s?.[key] ?? '');
  const refLocked = boat?.status === 'received';
  const m = openModal({
    title: s ? `Correct ${s.harvest_ref}` : 'Harvest GRN',
    wide: true,
    body: `
      ${s ? `<p class="hint warn-text mb">Sent back by ${esc(s.sent_back_name)}${s.sent_back_at ? ` on ${fmtDate(s.sent_back_at)}` : ''}: ${esc(s.sent_back_note)}</p>`
        : '<p class="hint mb">This records produce received from the farmer. It does not put the goods into sellable inventory. That happens when the boat arrives and the item receipt is written.</p>'}
      <div class="card-title mb">Farmer</div>
      <div class="form-grid">
        <div class="field"><label>Farmer ID <span class="muted">(optional)</span></label><input name="farmer_code" maxlength="40" list="hv-farmer-ids" autocomplete="off" placeholder="DEMO-ID" value="${val('farmer_code')}">
          <span class="hint" data-farmer-found aria-live="polite"></span></div>
        <div class="field"><label>GRN ref no</label><input name="harvest_ref" maxlength="40" placeholder="${next ? 'Fills in from the island' : 'HRC/O-8/2026/017'}" value="${val('harvest_ref')}"${refLocked ? ' readonly' : ''}>
          <span class="hint" data-ref-hint aria-live="polite">${refLocked ? 'The GRN ref no stays as it is once the item receipt is posted.' : ''}</span></div>
        <div class="field"><label>Farmer name</label><input name="farmer_name" maxlength="80" placeholder="Abdul Azeez (Fahigovaan)" value="${val('farmer_name')}"></div>
        <div class="field"><label>Island</label><input name="farmer_island" maxlength="80" placeholder="L. Fonadhoo" value="${val('farmer_island')}"></div>
        <div class="field"><label>Island code</label><input name="island_code" maxlength="20" placeholder="O-08" value="${val('island_code')}"></div>
        <div class="field"><label>Phone</label><input name="farmer_phone" inputmode="numeric" data-phone placeholder="Phone number" value="${val('farmer_phone')}"></div>
        <div class="field"><label>Contract no <span class="muted">(optional)</span></label><input name="farmer_contract" maxlength="40" placeholder="R4/O-8/2021/103" value="${val('farmer_contract')}"></div>
      </div>
      <datalist id="hv-farmer-ids">${[...byIdCard.values()].map(([f]) =>
        `<option value="${esc(f.id_card.trim())}" label="${esc(f.name)}${f.island ? ` · ${esc(f.island)}` : ''}"></option>`).join('')}</datalist>
      <div class="card-title mb">Crops</div>
      <div data-hv-lines></div>
      <p><button type="button" class="btn btn-sm" data-hv-add>Add crop</button></p>
      <div class="form-grid section-gap">
        <div>
          <div class="card-title mb">Receiver at harvesting point</div>
          <div class="field"><label>Name</label><input name="coord_name" maxlength="80" value="${s ? val('coord_name') : esc(me?.name ?? '')}"></div>
          <div class="field"><label>Date</label><input name="coord_date" type="date" value="${esc(s?.coord_date || t0)}" max="${t0}"></div>
        </div>
        <div>
          <div class="card-title mb">Farmer</div>
          <div class="field"><label>Name</label><input name="farmer_signed_name" maxlength="80" value="${val('farmer_signed_name')}"></div>
          <div class="field"><label>Date</label><input name="farmer_signed_date" type="date" value="${esc(s?.farmer_signed_date || t0)}" max="${t0}"></div>
        </div>
      </div>
      <p class="hint">${s
        ? 'Saving sends it to be verified again.'
        : 'After you save, someone else in Operations verifies it. It stays a harvest GRN until a price enquiry gathers it and the boat note is written.'}</p>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>${s ? 'Save and send to verify' : 'Save harvest GRN'}</button>`,
  });
  const lines = $('[data-hv-lines]', m.modal);
  const addCrop = () => lines.insertAdjacentHTML('beforeend', harvestCropCard(products));
  const savedLines = (saved?.harvest_lines || []).filter(l => !grn || l.harvest_grn_id === grn.id);
  if (savedLines.length) {
    for (const line of savedLines) lines.insertAdjacentHTML('beforeend', harvestCropCard(products, line));
    for (const card of lines.children) paintUndamaged(card);
  } else addCrop();
  const named = name => $(`[name=${name}]`, m.modal);
  const farmer = named('farmer_name');
  const signed = named('farmer_signed_name');
  const island = named('farmer_island');
  const code = named('island_code');
  const ref = named('harvest_ref');
  const idCard = named('farmer_code');
  const found = $('[data-farmer-found]', m.modal);
  const refHint = $('[data-ref-hint]', m.modal);
  bindIslandPair(island, code);
  if (s && s.farmer_signed_name && s.farmer_signed_name !== s.farmer_name) signed.dataset.touched = '1';
  const syncSigned = () => { if (!signed.dataset.touched) signed.value = farmer.value; };
  farmer.addEventListener('input', syncSigned);
  signed.addEventListener('input', () => { signed.dataset.touched = '1'; });

  // The GRN ref no follows the island code until someone types over it.
  // Clearing it hands it back. A correction starts from the ref it was saved with.
  let refAuto = Boolean(next) && !s;
  const paintRef = () => {
    if (refLocked) return;
    const islandCode = codeValue(island.value, code.value);
    if (refAuto) {
      const n = (next.last[harvestIsland(islandCode)] || 0) + 1;
      ref.value = islandCode ? harvestRefFor(islandCode, next.year, n) : '';
      refHint.textContent = '';
      return;
    }
    const typed = /^HRC\/([^/]+)\//i.exec(ref.value.trim());
    refHint.textContent = s && next && islandCode && typed && harvestIsland(typed[1]) !== harvestIsland(islandCode)
      ? 'This ref no has another island code. Clear it to make a new one for this island.' : '';
  };
  ref.addEventListener('input', () => { refAuto = false; paintRef(); });
  ref.addEventListener('change', () => {
    if (next && !ref.value.trim()) { refAuto = true; paintRef(); }
  });
  for (const el of [island, code]) {
    el.addEventListener('input', paintRef);
    el.addEventListener('change', paintRef);
  }

  // An ID card found in Farmers fills in the farmer's details. Picking another
  // farmer clears what the last one filled in, unless it was changed since.
  let filled = null;
  const fillFarmer = () => {
    const hits = byIdCard.get(idCard.value.trim().toUpperCase());
    if (filled && hits?.[0].id === filled.id) return;
    if (filled) {
      for (const [name, value] of Object.entries(filled.values)) if (named(name).value === value) named(name).value = '';
      filled = null;
    }
    found.textContent = '';
    if (hits) {
      const f = hits[0];
      if (idCard.value !== f.id_card.trim()) idCard.value = f.id_card.trim();
      filled = { id: f.id, values: {} };
      const values = { farmer_name: f.name, farmer_island: f.island, farmer_phone: farmerPhone(f.phone), farmer_contract: f.contract_no };
      for (const [name, value] of Object.entries(values)) {
        if (!value) continue;
        named(name).value = value;
        filled.values[name] = value;
      }
      island.dispatchEvent(new Event('change'));
      if (code.value) filled.values.island_code = code.value;
      found.textContent = [
        'Filled in from Farmers.',
        farmerStateOf(f) === 'inactive' ? 'The contract is inactive.' : '',
        hits.length > 1 ? `This ID card also has contract ${hits.slice(1).map(h => h.contract_no).join(', ')}.` : '',
        codeValue(island.value, code.value) ? '' : 'Pick the island from the list to fill in its code.',
      ].filter(Boolean).join(' ');
    }
    syncSigned();
    paintRef();
  };
  idCard.addEventListener('input', fillFarmer);
  idCard.addEventListener('change', () => {
    if (!filled && idCard.value.trim()) found.textContent = 'Not in Farmers. Fill in the details yourself.';
  });
  m.modal.addEventListener('change', e => {
    if (e.target.matches('[data-hv-travel]')) {
      const row = e.target.closest('[data-hv-grade-row]');
      paintGradeBag(row);
      const count = $('[data-hv-count]', row);
      count.placeholder = e.target.value === 'bunch' ? '12' : '2';
      return;
    }
    if (!e.target.matches('[data-hv-product]')) return;
    if (!/banana/i.test(e.target.selectedOptions[0]?.textContent || '')) return;
    const card = e.target.closest('[data-hv-line]');
    for (const row of $$('[data-hv-grade-row]', card)) {
      if ($('[data-hv-count]', row).value.trim()) continue;
      $('[data-hv-travel]', row).value = 'bunch';
      paintGradeBag(row);
    }
  });
  m.modal.addEventListener('input', e => {
    const card = e.target.closest('[data-hv-line]');
    if (!card) return;
    if (e.target.matches('[data-hv-kg], [data-hv-dmg]')) paintUndamaged(card);
    else if (e.target.matches('[data-hv-grade-kg]')) {
      e.target.dataset.typed = '1';
      paintGrades(card);
    }
  });
  $('[data-hv-add]', m.modal).addEventListener('click', () => {
    if (lines.children.length >= 20) return toast('A harvest GRN can hold 20 crops', 'err');
    addCrop();
  });
  lines.addEventListener('click', e => {
    const card = e.target.closest('[data-hv-line]');
    if (!card) return;
    if (e.target.closest('[data-hv-grade-add]')) return addHarvestGrade(card);
    const gradeRemove = e.target.closest('[data-hv-grade-remove]');
    if (gradeRemove) {
      if ($('[data-hv-grades]', card).children.length === 1) return toast('Keep at least one grade', 'err');
      gradeRemove.closest('[data-hv-grade-row]').remove();
      return paintGrades(card);
    }
    if (!e.target.closest('[data-hv-remove]')) return;
    if (lines.children.length === 1) return toast('Keep at least one crop', 'err');
    card.remove();
  });
  busyClick($('[data-save]', m.modal), async () => {
    const field = name => $(`[name=${name}]`, m.modal).value.trim();
    if (!field('harvest_ref')) {
      return toast(refAuto ? 'Pick the island from the list or enter its code to make the GRN ref no' : 'Enter the GRN ref no', 'err');
    }
    if (!field('farmer_name')) return toast('Enter the farmer name', 'err');
    if (!field('farmer_island')) return toast('Enter the island', 'err');
    if (!field('farmer_phone')) return toast('Enter the phone number', 'err');
    if (!field('coord_name')) return toast('Enter who received it at the harvesting point', 'err');
    const crops = [];
    for (const card of lines.children) {
      const productId = $('[data-hv-product]', card).value;
      const kg = $('[data-hv-kg]', card).value.trim();
      if (!productId && !kg) continue;
      if (!productId) return toast('Choose the crop', 'err');
      if (!kg) return toast('Enter the total harvest', 'err');
      if (!$('[data-hv-good]', card).value) return toast('Damaged amount cannot be more than the harvest', 'err');
      if (!$('[data-hv-date]', card).value) return toast('Enter the harvested date', 'err');
      const cropName = $('[data-hv-product]', card).selectedOptions[0].textContent;
      const grades = [];
      for (const row of $$('[data-hv-grade-row]', card)) {
        const grade = $('[data-hv-grade]', row).value.trim();
        const gradeKg = $('[data-hv-grade-kg]', row).value.trim();
        if (!grade) return toast(`Enter the grade for ${cropName}`, 'err');
        if (grades.some(g => g.grade.toLowerCase() === grade.toLowerCase())) {
          return toast(`Grade ${grade} is listed twice for ${cropName}`, 'err');
        }
        if (!gradeKg) return toast(`Enter the kg for grade ${grade} of ${cropName}`, 'err');
        if (!(Number(gradeKg) >= 0)) return toast(`The kg for grade ${grade} of ${cropName} must be a number`, 'err');
        const priceRaw = $('[data-hv-price]', row).value.trim();
        const price = parseMoney(priceRaw);
        if (!priceRaw || !Number.isInteger(price) || price < 0) {
          return toast(`Enter the buying price for grade ${grade} of ${cropName}`, 'err');
        }
        const travel = $('[data-hv-travel]', row).value;
        const countRaw = $('[data-hv-count]', row).value.trim();
        if (countRaw && !/^\d+$/.test(countRaw)) return toast(`How many for grade ${grade} of ${cropName} must be a whole number`, 'err');
        const count = countRaw ? Number(countRaw) : 0;
        const bunch = travel === 'bunch';
        grades.push({
          id: Number(row.dataset.gradeId) || undefined,
          grade,
          kg: Number(gradeKg),
          unit_cost: price,
          pack_unit: travel,
          pack_count: bunch ? 0 : count,
          per_bag_kg: bunch ? 0 : Number($('[data-hv-bag]', row).value || 0),
          bunches: bunch ? count : 0,
          remarks: $('[data-hv-remarks]', row).value.trim(),
        });
      }
      const undamaged = undamagedKg(card);
      const graded = round3(grades.reduce((sum, g) => sum + g.kg, 0));
      if (Math.abs(graded - undamaged) >= 0.0005) {
        return toast(`The grades for ${cropName} add up to ${plainNum(graded) || '0'} kg. They need to add up to the ${plainNum(undamaged) || '0'} kg undamaged.`, 'err');
      }
      const empty = grades.length > 1 && grades.find(g => !(g.kg > 0));
      if (empty) return toast(`Grade ${empty.grade} of ${cropName} has no weight. Enter its kg or remove it.`, 'err');
      crops.push({
        id: Number(card.dataset.lineId) || undefined,
        product_id: Number(productId),
        harvested_at: $('[data-hv-date]', card).value,
        harvest_kg: Number(kg),
        damaged_kg: Number($('[data-hv-dmg]', card).value || 0),
        bunches: $('[data-hv-bunches]', card).value.trim(),
        hands: $('[data-hv-hands]', card).value.trim(),
        grades,
      });
    }
    if (!crops.length) return toast('Add at least one crop', 'err');
    try {
      const res = await api(grn ? `/api/harvest-grns/${grn.id}/correct` : '/api/harvest-grns', { body: {
        harvest_ref: field('harvest_ref'),
        harvest_ref_auto: refAuto,
        farmer_name: field('farmer_name'),
        farmer_code: field('farmer_code'),
        farmer_island: islandValue(field('farmer_island')),
        island_code: codeValue(field('farmer_island'), field('island_code')),
        farmer_phone: field('farmer_phone'),
        farmer_contract: field('farmer_contract'),
        coord_name: field('coord_name'),
        coord_date: field('coord_date'),
        farmer_signed_name: field('farmer_signed_name'),
        farmer_signed_date: field('farmer_signed_date'),
        lines: crops,
      } });
      shipTab = s ? 'verify' : 'harvest';
      m.close();
      toast(s ? `Harvest GRN ${res.ref} corrected and sent to be verified again.`
        : `Harvest GRN ${res.ref} saved, waiting to be verified.`, 'ok', {
        action: { label: 'Print', fn: () => { window.open('/print/harvest-grn/' + (res.grn_id || res.id), '_blank', 'noopener'); } },
      });
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

const ENQUIRY_UNITS = ['kg', 'bunch', 'box', 'sack', 'basket'];

function enquiryPack(line, grade) {
  const kg = Number(grade?.kg) || 0;
  const banana = /banana/i.test(`${line?.product || ''} ${line?.description || ''}`);
  let unit = grade?.pack_unit || '';
  if (!ENQUIRY_UNITS.includes(unit) || unit === 'kg') {
    if (Number(grade?.bunches) > 0 && (banana || !(Number(grade?.pack_count) > 0))) unit = 'bunch';
    else if (Number(grade?.pack_count) > 0) unit = 'box';
    else unit = '';
  }
  const boxes = unit === 'bunch' ? 0 : (Number(grade?.pack_count) || 0);
  const graded = (line?.grades || []).filter(g => Number(g.kg) > 0);
  const own = unit === 'bunch' ? (Number(grade?.bunches) || 0) : 0;
  const bunches = own || (unit !== 'box' && unit !== 'sack' && unit !== 'basket' && graded.length <= 1 ? (Number(line?.bunches) || 0) : 0);
  if (unit === 'bunch' && bunches > 0) return { qty: bunches, unit: 'bunch', kg, boxes: 0, bunches };
  if ((unit === 'box' || unit === 'sack' || unit === 'basket') && boxes > 0) return { qty: boxes, unit, kg, boxes, bunches: 0 };
  if (bunches > 0) return { qty: bunches, unit: 'bunch', kg, boxes: 0, bunches };
  return { qty: kg, unit: 'kg', kg, boxes, bunches };
}

function enquiryRow(preset = {}) {
  const rate = preset.rateText != null ? preset.rateText
    : (preset.rate == null || preset.rate === '' ? '' : (Number(preset.rate) / 100).toFixed(2));
  const unit = preset.unit || 'kg';
  const choices = ENQUIRY_UNITS.includes(unit) ? ENQUIRY_UNITS : [unit, ...ENQUIRY_UNITS];
  const crop = preset.crop ? ` data-crop="${esc(preset.crop)}"` : '';
  return `<tr data-pq-line${crop}${preset.gradeId ? ` data-grade-id="${preset.gradeId}"` : ''} data-kg="${Number(preset.kg) || 0}" data-bunches="${Number(preset.bunches) || 0}" data-boxes="${Number(preset.boxes) || 0}" data-sacks="${Number(preset.sacks) || 0}" data-baskets="${Number(preset.baskets) || 0}">
    <td><input data-pq-qty inputmode="decimal" aria-label="Qty" value="${preset.qty ? esc(plainNum(preset.qty)) : ''}"></td>
    <td><select data-pq-unit aria-label="Units">${choices.map(u => `<option value="${esc(u)}"${u === unit ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select></td>
    <td><input data-pq-desc maxlength="160" aria-label="Description" value="${esc(preset.description || '')}"></td>
    <td><input data-pq-rate inputmode="decimal" aria-label="Rate per unit in MVR" placeholder="50" value="${esc(rate)}"></td>
    <td class="num" data-pq-total></td>
    <td><button type="button" class="btn btn-ghost btn-sm" data-pq-remove>Remove</button></td>
  </tr>`;
}

function paintEnquiry(modal) {
  let sum = 0;
  for (const tr of $$('[data-pq-line]', modal)) {
    const qty = Number($('[data-pq-qty]', tr).value);
    const rate = parseMoney($('[data-pq-rate]', tr).value);
    const cell = $('[data-pq-total]', tr);
    if (qty > 0 && Number.isInteger(rate) && rate >= 0 && $('[data-pq-rate]', tr).value.trim()) {
      const total = Math.round(qty * rate);
      sum += total;
      cell.textContent = money(total);
    } else cell.textContent = '';
  }
  const foot = $('[data-pq-sum]', modal);
  if (foot) foot.textContent = money(sum);
}

// One line per crop. Grades and harvest GRNs are added together, and the unit
// switch reads the matching total: bunches, boxes, sacks, baskets, or kg.
function enquiryCropTotals(grns) {
  const crops = new Map();
  for (const grn of grns) {
    for (const line of grn.lines || []) {
      const name = String(line.product || line.description || 'Crop').trim() || 'Crop';
      const key = name.toLowerCase();
      if (!crops.has(key)) crops.set(key, { key, name, farmers: new Set(), gradeId: null, kg: 0, bunches: 0, boxes: 0, sacks: 0, baskets: 0 });
      const row = crops.get(key);
      if (line.farmer_name) row.farmers.add(line.farmer_name);
      for (const grade of line.grades || []) {
        if (!(Number(grade.kg) > 0)) continue;
        if (!row.gradeId) row.gradeId = grade.id;
        const pack = enquiryPack(line, grade);
        row.kg += pack.kg;
        row.bunches += pack.bunches;
        if (pack.unit === 'box') row.boxes += pack.boxes;
        else if (pack.unit === 'sack') row.sacks += pack.boxes;
        else if (pack.unit === 'basket') row.baskets += pack.boxes;
      }
    }
  }
  return [...crops.values()].map(row => {
    const counts = { bunch: row.bunches, box: row.boxes, sack: row.sacks, basket: row.baskets };
    const used = Object.entries(counts).filter(([, n]) => n > 0);
    const unit = used.length === 1 ? used[0][0] : 'kg';
    const farmer = row.farmers.size === 1 ? [...row.farmers][0] : '';
    return {
      crop: row.key,
      gradeId: row.gradeId,
      description: `${farmer ? `${farmer} · ` : ''}${row.name}`.slice(0, 160),
      unit,
      qty: unit === 'kg' ? row.kg : counts[unit],
      kg: Math.round(row.kg * 1000) / 1000,
      bunches: row.bunches,
      boxes: row.boxes,
      sacks: row.sacks,
      baskets: row.baskets,
    };
  });
}

function boatFieldHtml(inputName, value) {
  const label = inputName === 'vessel_name' ? 'Vessel name' : 'Boat name';
  return `<div class="field">
    <div class="field-label-row">
      <label>${label}</label>
      ${canEditBoats() ? '<button type="button" class="btn btn-ghost btn-sm" data-boats-edit>Edit list</button>' : ''}
    </div>
    <div class="boat-pick" data-boat-pick>
      <input name="${inputName}" maxlength="80" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" placeholder="Search the boat list" value="${esc(value || '')}">
      <ul class="boat-menu" role="listbox" hidden></ul>
    </div>
  </div>`;
}

function wireBoatPick(modal, boats, { name, phone }) {
  const input = $(`[name=${name}]`, modal);
  const pick = input?.closest('[data-boat-pick]');
  if (!input || !pick) return;
  const phoneEl = phone ? $(`[name=${phone}]`, modal) : null;
  const menu = $('.boat-menu', pick);
  let list = boats || [];
  let active = -1;
  const hits = () => {
    const q = input.value.trim().toLowerCase();
    return list.filter(b => !q || `${b.name} ${b.kind} ${b.operator}`.toLowerCase().includes(q)).slice(0, 40);
  };
  const paint = () => {
    const rows = hits();
    menu.innerHTML = rows.length
      ? rows.map((b, i) => `<li role="option" data-id="${b.id}"${i === active ? ' aria-selected="true"' : ''}><b>${esc(b.name)}</b>${[b.kind, b.operator].filter(Boolean).length ? `<span>${[b.kind, b.operator].filter(Boolean).map(esc).join(' · ')}</span>` : ''}</li>`).join('')
      : '<li class="boat-empty">No boat matches</li>';
  };
  const show = () => { paint(); menu.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  const hide = () => { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = id => {
    const b = list.find(row => row.id === id);
    if (!b) return;
    input.value = b.name;
    if (phoneEl) phoneEl.value = b.phone || '';
    hide();
  };
  input.addEventListener('focus', show);
  input.addEventListener('input', () => { active = -1; show(); });
  input.addEventListener('keydown', e => {
    const rows = hits();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!rows.length) return;
      active = Math.min(active + 1, rows.length - 1);
      show();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      active = Math.max(active - 1, 0);
      show();
    } else if (e.key === 'Enter' && !menu.hidden && rows[active]) {
      e.preventDefault();
      choose(rows[active].id);
    } else if (e.key === 'Escape') hide();
  });
  menu.addEventListener('mousedown', e => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    e.preventDefault();
    choose(Number(li.dataset.id));
  });
  modal.addEventListener('mousedown', e => {
    if (!pick.contains(e.target)) hide();
  });
  const edit = $('[data-boats-edit]', input.closest('.field'));
  if (edit) edit.addEventListener('click', e => {
    e.preventDefault();
    boatsModal(async () => { list = await api('/api/boats'); });
  });
}

export async function boatsModal(onChange) {
  let boats;
  try { boats = await api('/api/boats'); }
  catch (err) { return toast(err.message, 'err'); }
  let editingId = null;
  const m = openModal({
    title: 'Boats',
    wide: true,
    body: `
      <p class="hint mb">Picking a boat fills its contact number on the price enquiry and the boat note. Nahuzaam, Najah, and Ibbe can change this list.</p>
      <div class="labor-toolbar">
        <input data-boat-filter placeholder="Find a boat" aria-label="Find a boat">
        <button type="button" class="btn btn-primary btn-sm" data-boat-add>Add boat</button>
      </div>
      <div class="form-grid" data-boat-form hidden>
        <div class="field"><label>Boat name</label><input name="name" maxlength="80"></div>
        <div class="field"><label>Contact <span class="muted">(optional)</span></label><input name="phone" inputmode="numeric" data-phone maxlength="15"></div>
        <div class="field"><label>Type <span class="muted">(optional)</span></label><input name="kind" maxlength="40" placeholder="Supply Boat"></div>
        <div class="field"><label>Operator <span class="muted">(optional)</span></label><input name="operator" maxlength="80"></div>
      </div>
      <p data-boat-form-actions hidden>
        <button type="button" class="btn btn-primary btn-sm" data-boat-save>Save boat</button>
        <button type="button" class="btn btn-sm" data-boat-cancel>Cancel</button>
      </p>
      <div class="tbl-wrap boat-rows"><table class="tbl">
        <thead><tr><th>Boat</th><th>Contact</th><th>Type</th><th>Operator</th><th></th></tr></thead>
        <tbody data-boat-rows></tbody>
      </table></div>`,
    footer: `<button class="btn" data-close>Close</button>`,
  });
  const form = $('[data-boat-form]', m.modal);
  const actions = $('[data-boat-form-actions]', m.modal);
  const filter = $('[data-boat-filter]', m.modal);
  const tbody = $('[data-boat-rows]', m.modal);
  const field = name => $(`[name=${name}]`, form);
  const paint = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = boats.filter(b => !q || `${b.name} ${b.phone} ${b.kind} ${b.operator}`.toLowerCase().includes(q));
    tbody.innerHTML = shown.length ? shown.map(b => `<tr>
      <td><b>${esc(b.name)}</b></td>
      <td>${esc(b.phone) || '—'}</td>
      <td>${esc(b.kind) || '—'}</td>
      <td>${esc(b.operator) || '—'}</td>
      <td class="actions">
        <button type="button" class="btn btn-ghost btn-sm" data-boat-edit="${b.id}">Edit</button>
        <button type="button" class="btn btn-ghost btn-sm btn-danger" data-boat-remove="${b.id}">Remove</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty">${boats.length ? 'No boats match.' : 'No boats yet.'}</td></tr>`;
  };
  const closeForm = () => { form.hidden = true; actions.hidden = true; editingId = null; };
  const openForm = boat => {
    editingId = boat?.id || null;
    field('name').value = boat?.name || '';
    field('phone').value = boat?.phone || '';
    field('kind').value = boat?.kind || '';
    field('operator').value = boat?.operator || '';
    form.hidden = false;
    actions.hidden = false;
    field('name').focus();
  };
  paint();
  filter.addEventListener('input', paint);
  $('[data-boat-add]', m.modal).addEventListener('click', () => openForm(null));
  $('[data-boat-cancel]', m.modal).addEventListener('click', closeForm);
  busyClick($('[data-boat-save]', m.modal), async () => {
    const body = {
      name: field('name').value.trim(),
      phone: field('phone').value.trim(),
      kind: field('kind').value.trim(),
      operator: field('operator').value.trim(),
    };
    if (!body.name) return toast('Enter the boat name', 'err');
    try {
      if (editingId) await api(`/api/boats/${editingId}`, { method: 'PATCH', body });
      else await api('/api/boats', { body });
      boats = await api('/api/boats');
      closeForm();
      filter.value = '';
      paint();
      toast(editingId ? 'Boat updated' : 'Boat added');
      if (onChange) await onChange();
    } catch (err) { toast(err.message, 'err'); }
  });
  tbody.addEventListener('click', async e => {
    const edit = e.target.closest('[data-boat-edit]');
    if (edit) {
      openForm(boats.find(b => b.id === Number(edit.dataset.boatEdit)));
      return;
    }
    const remove = e.target.closest('[data-boat-remove]');
    if (!remove) return;
    const boat = boats.find(b => b.id === Number(remove.dataset.boatRemove));
    if (!boat) return;
    const ok = await confirmModal(`Remove ${boat.name}? It comes off the list. Notes already written keep the name they have.`, {
      title: 'Remove this boat?', confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/boats/${boat.id}`, { method: 'DELETE' });
      boats = boats.filter(b => b.id !== boat.id);
      if (editingId === boat.id) closeForm();
      paint();
      toast(`Removed ${boat.name}`);
      if (onChange) await onChange();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function priceEnquiryModal(d = null, presetIds = []) {
  const s = d?.shipment || null;
  const editing = s?.status === 'enquiry';
  let catalog, next, boats;
  try {
    [catalog, next, boats] = await Promise.all([
      api('/api/harvest-grns'),
      api(`/api/price-enquiries/next${editing ? `?except=${s.id}` : ''}`).catch(() => null),
      api('/api/boats').catch(() => []),
    ]);
  } catch (err) { return toast(err.message, 'err'); }
  const choices = catalog.filter(g => !g.boat_no && (!g.shipment_id || g.shipment_id === s?.id));
  if (!s && !choices.length) {
    return toast('Save a harvest GRN first. It stays a harvest GRN until a price enquiry gathers it.', 'err');
  }
  const selected = new Set((presetIds.length ? presetIds : (d?.harvest_grns || []).map(g => g.id)).map(Number));
  const picked = choices.filter(g => selected.has(g.id));
  const islands = [...new Set(picked.map(g => g.farmer_island).filter(Boolean))];
  const loadedFrom = editing ? (s.loaded_from || '') : (islands.length === 1 ? islands[0] : '');
  const islandCode = editing ? (s.island_code || '') : (islands.length === 1 ? (picked[0].island_code || '') : '');
  const m = openModal({
    title: editing ? `Edit price enquiry · ${s.enquiry_ref || s.reference}` : 'Price enquiry',
    wide: true,
    body: `
      <p class="hint mb">Choose the harvest GRNs that travel together. This is not a boat yet. The boat starts when the boat note is written, and every GRN on this enquiry is on that boat.</p>
      <div class="field pq-grns">
        <label>Harvest GRNs</label>
        ${choices.length ? `<div class="pq-grn-list">${choices.map(g => `<label class="pq-grn">
          <input type="checkbox" data-pq-grn value="${g.id}"${selected.has(g.id) ? ' checked' : ''}>
          <span class="pq-grn-mark" aria-hidden="true"></span>
          <span class="pq-grn-text"><b>${esc(g.harvest_ref)}</b>${g.farmer_name ? `<span>${esc(g.farmer_name)}</span>` : ''}</span>
        </label>`).join('')}</div>` : '<p class="hint">No harvest GRN is free to add.</p>'}
      </div>
      <div class="form-grid">
        <div class="field"><label>BN ref no</label><input name="enquiry_ref" maxlength="40" placeholder="${next ? 'Fills in from the island' : 'BN/O-8/2026/003'}" value="${esc(s?.enquiry_ref || '')}">
          <span class="hint" data-bn-ref-hint aria-live="polite"></span></div>
        <div class="field"><label>Loaded from</label><input name="loaded_from" maxlength="80" value="${esc(loadedFrom)}"></div>
        <div class="field"><label>Island code</label><input name="island_code" maxlength="20" value="${esc(islandCode)}" placeholder="O-08"></div>
        <div class="field"><label>Destination</label><input name="destination" maxlength="80" placeholder="K. Male" value="${esc(editing ? s.destination || '' : '')}"></div>
        ${boatFieldHtml('vessel_name', editing ? s.vessel_name || '' : '')}
        <div class="field"><label>Vessel contact <span class="muted">(optional)</span></label><input name="vessel_phone" inputmode="numeric" data-phone placeholder="Phone number" value="${esc(editing ? s.vessel_phone || '' : '')}"></div>
        <div class="field"><label>Vessel date <span class="muted">(optional)</span></label><input name="vessel_date" type="date" value="${esc(editing ? s.vessel_date || '' : '')}"></div>
      </div>
      <div class="card-title mb">Lines</div>
      <div class="tbl-wrap"><table class="tbl order-lines">
        <thead><tr><th>Qty</th><th>Units</th><th>Description</th><th>Rate per unit (MVR)</th><th class="num">Total</th><th></th></tr></thead>
        <tbody data-pq-lines></tbody>
      </table></div>
      <p><button type="button" class="btn btn-sm" data-pq-add>Add line</button></p>
      <p class="hint">Each line is one crop, totalled across the harvest GRNs. Switch the unit to see that total in bunches, boxes, or kilograms. The rate is the boat's price for one of those units. Total <b data-pq-sum>MVR 0</b></p>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>Save price enquiry</button>`,
  });
  bindIslandPair($('[name=loaded_from]', m.modal), $('[name=island_code]', m.modal));
  bindIslandPair($('[name=destination]', m.modal), null);
  wireBoatPick(m.modal, boats, { name: 'vessel_name', phone: 'vessel_phone' });
  const bnRef = $('[name=enquiry_ref]', m.modal);
  const loadedFromEl = $('[name=loaded_from]', m.modal);
  const islandCodeEl = $('[name=island_code]', m.modal);
  const bnRefHint = $('[data-bn-ref-hint]', m.modal);
  // The BN ref follows the island until someone types over it. Clearing it hands it back.
  let refAuto = Boolean(next) && !editing;
  let routeAuto = !editing;
  const paintBnRef = () => {
    const islandCode = codeValue(loadedFromEl.value, islandCodeEl.value);
    if (refAuto && next) {
      const n = (next.last[harvestIsland(islandCode)] || 0) + 1;
      bnRef.value = islandCode ? boatRefFor(islandCode, next.year, n) : '';
      bnRefHint.textContent = '';
      return;
    }
    const typed = /^BN\/([^/]+)\//i.exec(bnRef.value.trim());
    bnRefHint.textContent = next && islandCode && typed && harvestIsland(typed[1]) !== harvestIsland(islandCode)
      ? 'This ref no has another island code. Clear it to make a new one for this island.' : '';
  };
  const syncRouteFromGrns = () => {
    if (!routeAuto) return;
    const pickedNow = [...$$('[data-pq-grn]:checked', m.modal)]
      .map(el => choices.find(g => g.id === Number(el.value))).filter(Boolean);
    const names = [...new Set(pickedNow.map(g => g.farmer_island).filter(Boolean))];
    const codes = [...new Set(pickedNow.map(g => String(g.island_code || '').trim()).filter(Boolean))];
    if (names.length === 1) {
      loadedFromEl.value = names[0];
      loadedFromEl.dispatchEvent(new Event('change'));
      if (!islandCodeEl.value.trim() && codes.length === 1) islandCodeEl.value = codes[0];
    } else if (codes.length === 1 && !names.length) {
      islandCodeEl.value = codes[0];
      islandCodeEl.dispatchEvent(new Event('change'));
    } else if (pickedNow.length) {
      loadedFromEl.value = '';
      islandCodeEl.value = '';
    }
    paintBnRef();
  };
  bnRef.addEventListener('input', () => { refAuto = false; paintBnRef(); });
  bnRef.addEventListener('change', () => {
    if (next && !bnRef.value.trim()) { refAuto = true; paintBnRef(); }
  });
  for (const el of [loadedFromEl, islandCodeEl]) {
    el.addEventListener('input', () => { routeAuto = false; paintBnRef(); });
    el.addEventListener('change', paintBnRef);
  }
  paintBnRef();
  const tbody = $('[data-pq-lines]', m.modal);
  const add = preset => tbody.insertAdjacentHTML('beforeend', enquiryRow(preset));
  const savedLines = editing ? (d.enquiry_lines || []) : [];
  const checkedGrns = () => [...$$('[data-pq-grn]:checked', m.modal)]
    .map(el => choices.find(g => g.id === Number(el.value))).filter(Boolean);
  const countFor = (row, unit) => Number(row[{ bunch: 'bunches', box: 'boxes', sack: 'sacks', basket: 'baskets' }[unit] || 'kg']) || 0;
  const rebuildCrops = () => {
    const prior = new Map();
    for (const tr of [...tbody.children]) {
      if (!tr.dataset.crop) continue;
      prior.set(tr.dataset.crop, { rateText: $('[data-pq-rate]', tr).value, unit: $('[data-pq-unit]', tr).value });
      tr.remove();
    }
    for (const tr of [...tbody.children]) {
      const blank = !$('[data-pq-desc]', tr).value.trim() && !$('[data-pq-qty]', tr).value.trim() && !$('[data-pq-rate]', tr).value.trim();
      if (blank) tr.remove();
    }
    const firstHand = tbody.firstElementChild;
    for (const row of enquiryCropTotals(checkedGrns())) {
      const kept = prior.get(row.crop);
      const saved = savedLines.filter(l => String(l.description || '').toLowerCase().includes(row.crop));
      const sameRate = saved.length > 0 && saved.every(l => l.rate === saved[0].rate);
      const sameUnit = saved.length > 0 && saved.every(l => l.unit === saved[0].unit);
      const unit = kept?.unit && countFor(row, kept.unit) > 0 ? kept.unit
        : (sameUnit && countFor(row, saved[0].unit) > 0 ? saved[0].unit : row.unit);
      const html = enquiryRow({
        ...row, unit, qty: countFor(row, unit),
        rateText: kept ? kept.rateText : undefined,
        rate: !kept && sameRate ? saved[0].rate : '',
      });
      if (firstHand) firstHand.insertAdjacentHTML('beforebegin', html);
      else tbody.insertAdjacentHTML('beforeend', html);
    }
    if (!tbody.children.length) add();
    paintEnquiry(m.modal);
  };
  rebuildCrops();
  m.modal.addEventListener('change', e => {
    const box = e.target.closest('[data-pq-grn]');
    if (!box) return;
    rebuildCrops();
    syncRouteFromGrns();
  });
  tbody.addEventListener('input', () => paintEnquiry(m.modal));
  tbody.addEventListener('change', e => {
    const unit = e.target.closest('[data-pq-unit]');
    if (!unit) return;
    const tr = unit.closest('tr');
    if (tr.dataset.crop) $('[data-pq-qty]', tr).value = plainNum(countFor(tr.dataset, unit.value));
    else {
      const n = plainNum(countFor(tr.dataset, unit.value));
      if (n) $('[data-pq-qty]', tr).value = n;
    }
    paintEnquiry(m.modal);
  });
  $('[data-pq-add]', m.modal).addEventListener('click', () => {
    if (tbody.children.length >= 40) return toast('A price enquiry can hold 40 lines', 'err');
    add();
  });
  tbody.addEventListener('click', e => {
    const btn = e.target.closest('[data-pq-remove]');
    if (!btn) return;
    if (tbody.children.length === 1) {
      const tr = btn.closest('tr');
      $$('input', tr).forEach(i => { i.value = ''; });
      const unit = $('[data-pq-unit]', tr);
      if (unit) unit.value = 'kg';
      paintEnquiry(m.modal);
      return;
    }
    btn.closest('tr').remove();
    paintEnquiry(m.modal);
  });
  busyClick($('[data-save]', m.modal), async () => {
    const field = name => $(`[name=${name}]`, m.modal).value.trim();
    if (!field('enquiry_ref')) return toast(refAuto ? 'Choose the island so the BN ref no can be made' : 'Enter the BN ref no', 'err');
    if (!field('loaded_from')) return toast('Enter where it is loaded from', 'err');
    if (!field('destination')) return toast('Enter the destination', 'err');
    if (!field('vessel_name')) return toast('Enter the vessel name', 'err');
    const lines = [];
    for (const tr of tbody.children) {
      const description = $('[data-pq-desc]', tr).value.trim();
      const qtyRaw = $('[data-pq-qty]', tr).value.trim();
      const rateRaw = $('[data-pq-rate]', tr).value.trim();
      if (!description && !qtyRaw && !rateRaw) continue;
      if (!description) return toast('Enter a description', 'err');
      const qty = Number(qtyRaw);
      const rate = parseMoney(rateRaw);
      if (!(qty > 0)) return toast('Enter the qty', 'err');
      if (!Number.isInteger(rate) || rate < 0) return toast('Enter the rate', 'err');
      lines.push({
        description, qty, unit: $('[data-pq-unit]', tr).value.trim(), rate,
        harvest_grade_id: Number(tr.dataset.gradeId) || undefined,
      });
    }
    if (!lines.length) return toast('Add at least one line', 'err');
    const grnIds = [...$$('[data-pq-grn]:checked', m.modal)].map(el => Number(el.value));
    if (!grnIds.length) return toast('Choose at least one harvest GRN', 'err');
    try {
      const res = await api(s ? `/api/shipments/${s.id}/price-enquiry` : '/api/price-enquiries', { body: {
        enquiry_ref: field('enquiry_ref'),
        enquiry_ref_auto: refAuto,
        loaded_from: islandValue(field('loaded_from')),
        island_code: codeValue(field('loaded_from'), field('island_code')),
        destination: islandValue(field('destination')),
        vessel_name: field('vessel_name'),
        vessel_phone: field('vessel_phone'),
        vessel_date: field('vessel_date'),
        grn_ids: grnIds,
        lines,
      } });
      shipTab = 'enquiry';
      m.close();
      toast('Price enquiry saved. An Operations HOD approves it before the boat note.', 'ok', {
        action: { label: 'Print', fn: () => { window.open('/print/price-enquiry/' + (res.id || s.id), '_blank', 'noopener'); } },
      });
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function laborChoices(value, options) {
  const chosen = String(value || '').split('; ').filter(Boolean);
  return [...new Set([...options, ...chosen])].map(option =>
    `<option value="${esc(option)}" ${chosen.includes(option) ? 'selected' : ''}>${esc(option)}</option>`).join('');
}
const LABOR_REASONS = ['Loading', 'Unloading', 'Shortage of staff', 'Urgent shipment', 'Heavy cargo', 'Sorting and packing'];
const LABOR_WORK = ['Loading', 'Unloading', 'Sorting', 'Packing', 'Moving stock', 'Cleaning'];

function laborDropdown(select) {
  const dropdown = document.createElement('details');
  dropdown.className = 'labor-dropdown';
  const label = select.getAttribute('aria-label');
  dropdown.innerHTML = `<summary aria-label="${esc(label)}"></summary><div class="labor-dropdown-options"></div>`;
  const options = $('.labor-dropdown-options', dropdown);
  for (const option of select.options) {
    const row = document.createElement('button');
    row.type = 'button';
    row.textContent = option.textContent;
    row.setAttribute('aria-pressed', String(option.selected));
    options.append(row);
    row.addEventListener('click', () => {
      if (select.disabled) return;
      option.selected = !option.selected;
      row.setAttribute('aria-pressed', String(option.selected));
      paint();
      dropdown.open = false;
      $('summary', dropdown).focus();
      select.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  const paint = () => {
    $('summary', dropdown).textContent = [...select.selectedOptions].map(o => o.textContent).join(', ') || 'Choose…';
  };
  select.hidden = true;
  select.after(dropdown);
  dropdown.addEventListener('keydown', e => {
    if (e.key === 'Escape' && dropdown.open) {
      e.stopPropagation();
      dropdown.open = false;
      $('summary', dropdown).focus();
    }
  });
  dropdown.addEventListener('focusout', e => {
    if (e.relatedTarget && !dropdown.contains(e.relatedTarget)) dropdown.open = false;
  });
  paint();
}

function laborRow(preset = {}) {
  const rate = preset.rate == null ? '' : (preset.rate / 100).toFixed(2);
  return `<tr data-lh-line>
    <td><select data-lh-desc multiple aria-label="What was hired">${laborChoices(preset.description, LABOR_WORK)}</select></td>
    <td class="lh-qty"><input data-lh-qty inputmode="decimal" aria-label="Qty" value="${preset.qty ? esc(plainNum(preset.qty)) : ''}"></td>
    <td class="lh-rate"><input data-lh-rate inputmode="decimal" aria-label="Rate in MVR" placeholder="2.00" value="${rate}"></td>
    <td class="num lh-amt" data-lh-total></td>
    <td class="lh-act"><button type="button" class="btn btn-ghost btn-sm" data-lh-remove>Remove</button></td>
  </tr>`;
}

function paintLabor(modal) {
  let sum = 0;
  for (const tr of $$('[data-lh-line]', modal)) {
    const qty = Number($('[data-lh-qty]', tr).value);
    const rate = parseMoney($('[data-lh-rate]', tr).value);
    const cell = $('[data-lh-total]', tr);
    if (qty > 0 && Number.isInteger(rate) && rate >= 0 && $('[data-lh-rate]', tr).value.trim()) {
      const total = Math.round(qty * rate);
      sum += total;
      cell.textContent = money2(total);
    } else cell.textContent = '';
  }
  const foot = $('[data-lh-sum]', modal);
  if (foot) foot.textContent = money2(sum);
}

function laborPerson(prefix, title, person, { role = false } = {}) {
  return `<div>
    <div class="card-title mb">${title}</div>
    <div class="field"><label>Name</label><input name="${prefix}_name" maxlength="80" value="${esc(person.name || '')}"></div>
    ${role ? `<div class="field"><label>Role</label><input name="${prefix}_role" maxlength="40" value="${esc(person.role || '')}"></div>` : ''}
    <div class="field"><label>Date</label><input name="${prefix}_date" type="date" value="${esc(person.date || '')}" max="${todayStr()}"></div>
  </div>`;
}

function laborHireModal(hire, { linkRef = null } = {}) {
  hire = hire || {};
  if (!hire.id) hire = { ...hire, asked_name: me.name, asked_role: roleLabel(me.role), asked_date: todayStr() };
  const saved = !!hire.id;
  const canEdit = !saved || isAdmin();
  const forShipment = linkRef != null;
  const m = openModal({
    title: hire.reference ? `Labour hire · ${hire.reference}` : 'New labour hire',
    wide: true,
    body: `
      <p class="hint mb">${saved && !canEdit
        ? 'This labour hire is saved. An admin can change it or remove it.'
        : forShipment
          ? 'Optional for this shipment. The total is added to its landing cost. Each name prints with a blank line to sign.'
          : 'This labour hire is not for a shipment, so it is not added to a landing cost. Each name prints with a blank line to sign.'}</p>
      <div class="form-grid">
        <div class="field"><label>Reference</label><input name="reference" maxlength="40" value="${esc(hire.reference || '')}" placeholder="OPS/LH/134"></div>
        <div class="field"><label>Date</label><input name="hired_on" type="date" value="${esc(hire.hired_on || todayStr())}" max="${todayStr()}"></div>
        <div class="field"><label>Why</label><select name="note" multiple aria-label="Why">${laborChoices(hire.note, LABOR_REASONS)}</select></div>
      </div>
      <div class="card-title mb">The work</div>
      <div class="tbl-wrap"><table class="tbl order-lines lh-work">
        <thead><tr><th>What was hired</th><th class="lh-qty">Qty</th><th class="lh-rate">Rate (MVR)</th><th class="num lh-amt">Amount</th><th class="lh-act"></th></tr></thead>
        <tbody data-lh-lines></tbody>
      </table></div>
      <p><button type="button" class="btn btn-sm" data-lh-add>Add line</button></p>
      <p class="hint">Qty is people or hours. Amount is qty × rate. Total <b data-lh-sum>MVR 0</b></p>
      <div class="card-title mb section-gap">Who signs</div>
      <div class="form-grid">
        ${laborPerson('asked', 'Asked for the hire', { name: hire.asked_name, role: hire.asked_role, date: hire.asked_date }, { role: true })}
        ${laborPerson('approved', 'Approved the hire', { name: hire.approved_name, role: hire.approved_role, date: hire.approved_date }, { role: true })}
      </div>
      <div class="form-grid-3 section-gap">
        ${laborPerson('worked', 'Did the work', { name: hire.worked_name, date: hire.worked_date })}
        ${laborPerson('checked', 'Checked the work', { name: hire.checked_name, role: hire.checked_role, date: hire.checked_date }, { role: true })}
        ${laborPerson('paid', 'Took the payment', { name: hire.paid_name, date: hire.paid_date })}
      </div>`,
    footer: `${saved && isAdmin() ? '<button class="btn btn-danger labor-remove" data-labor-remove>Remove</button>' : ''}
      ${saved ? `<a class="btn" href="/print/labor-hire/${hire.id}" target="_blank" rel="noopener">Print</a>` : ''}
      <button class="btn" data-close>${canEdit ? 'Cancel' : 'Close'}</button>
      ${canEdit ? '<button class="btn btn-primary" data-save>Save labour hire</button>' : ''}`,
  });
  for (const prefix of ['asked', 'approved', 'checked']) {
    for (const input of $$('input[name^="' + prefix + '_"]', m.modal)) input.readOnly = true;
  }
  for (const [action, allowed, label] of [
    ['approve', saved && !hire.approved_name && canApprove(), 'Approve hire'],
    ['check', saved && hire.approved_name && !hire.checked_name && canOps(), 'Check work'],
  ]) {
    if (!allowed) continue;
    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.textContent = label;
    $('.modal-foot', m.modal).append(button);
    busyClick(button, async () => {
      try {
        await api(`/api/labor-hires/${hire.id}/${action}`, { body: {} });
        m.close();
        toast(action === 'approve' ? 'Labour hire approved.' : 'Work checked.');
        refresh();
      } catch (err) { toast(err.message, 'err'); }
    });
  }
  const tbody = $('[data-lh-lines]', m.modal);
  const add = preset => {
    tbody.insertAdjacentHTML('beforeend', laborRow(preset));
    laborDropdown($('[data-lh-desc]', tbody.lastElementChild));
  };
  laborDropdown($('[name=note]', m.modal));
  const existing = hire.lines || [];
  if (existing.length) existing.forEach(add);
  else add();
  if (!canEdit) {
    $$('input, textarea, select', m.modal).forEach(el => { el.disabled = true; });
    $$('[data-lh-add]', m.modal).forEach(el => el.closest('p')?.remove());
    $$('[data-lh-remove]', m.modal).forEach(el => el.remove());
    $$('.labor-dropdown summary', m.modal).forEach(el => {
      el.setAttribute('aria-disabled', 'true');
      el.addEventListener('click', e => e.preventDefault());
    });
  }
  paintLabor(m.modal);
  tbody.addEventListener('input', () => paintLabor(m.modal));
  const addBtn = $('[data-lh-add]', m.modal);
  if (addBtn) addBtn.addEventListener('click', () => {
    if (tbody.children.length >= 12) return toast('A labour hire form can hold 12 lines', 'err');
    add();
  });
  tbody.addEventListener('click', e => {
    const btn = e.target.closest('[data-lh-remove]');
    if (!btn) return;
    if (tbody.children.length === 1) {
      const row = btn.closest('tr');
      $$('input', row).forEach(i => { if (i.type !== 'checkbox') i.value = ''; });
      for (const option of $('[data-lh-desc]', row).options) option.selected = false;
      $('.labor-dropdown', row).remove();
      laborDropdown($('[data-lh-desc]', row));
      paintLabor(m.modal);
      return;
    }
    btn.closest('tr').remove();
    paintLabor(m.modal);
  });
  const removeBtn = $('[data-labor-remove]', m.modal);
  if (removeBtn) busyClick(removeBtn, async () => {
    const ok = await confirmModal(
      `Remove labour hire ${hire.reference}? A shipment that used it will no longer include this cost.`,
      { title: 'Remove labour hire', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      await api(`/api/labor-hires/${hire.id}`, { method: 'DELETE' });
      if (!forShipment) shipTab = 'labor';
      m.close();
      toast(`Removed ${hire.reference}`);
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
  const saveBtn = $('[data-save]', m.modal);
  if (saveBtn) busyClick(saveBtn, async () => {
    const field = name => $(`[name=${name}]`, m.modal).value.trim();
    if (!field('reference')) return toast('Enter the reference', 'err');
    if (!field('hired_on')) return toast('Enter the date', 'err');
    if (!field('asked_name')) return toast('Enter who asked for the hire', 'err');
    const lines = [];
    for (const tr of tbody.children) {
      const description = [...$('[data-lh-desc]', tr).selectedOptions].map(o => o.value).join('; ');
      const qtyRaw = $('[data-lh-qty]', tr).value.trim();
      const rateRaw = $('[data-lh-rate]', tr).value.trim();
      if (!description && !qtyRaw && !rateRaw) continue;
      if (!description) return toast('Enter what was hired', 'err');
      const qty = Number(qtyRaw);
      const rate = parseMoney(rateRaw);
      if (!(qty > 0)) return toast('Enter the qty', 'err');
      if (!Number.isInteger(rate) || rate < 0) return toast('Enter the rate', 'err');
      lines.push({ description, qty, rate });
    }
    if (!lines.length) return toast('Add at least one line', 'err');
    try {
      const res = await api(hire.id ? `/api/labor-hires/${hire.id}` : '/api/labor-hires', { body: {
        reference: field('reference'),
        hired_on: field('hired_on'),
        link_ref: forShipment ? linkRef : '',
        note: [...$('[name=note]', m.modal).selectedOptions].map(o => o.value).join('; '),
        asked_name: field('asked_name'),
        asked_role: field('asked_role'),
        asked_date: field('asked_date'),
        approved_name: field('approved_name'),
        approved_role: field('approved_role'),
        approved_date: field('approved_date'),
        worked_name: field('worked_name'),
        worked_date: field('worked_date'),
        checked_name: field('checked_name'),
        checked_role: field('checked_role'),
        checked_date: field('checked_date'),
        paid_name: field('paid_name'),
        paid_date: field('paid_date'),
        lines,
      } });
      if (!forShipment) shipTab = 'labor';
      m.close();
      toast(`Labour hire saved. ${money2(res.total)}.`, 'ok', {
        action: { label: 'Print', fn: () => { window.open('/print/labor-hire/' + res.id, '_blank', 'noopener'); } },
      });
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function moveGrnModal(d, grnId) {
  const g = (d.harvest_grns || []).find(item => item.id === grnId);
  if (!g) return;
  const s = d.shipment;
  let rows;
  try { rows = await api('/api/shipments'); }
  catch (err) { return toast(err.message, 'err'); }
  const open = rows.filter(b => b.id !== s.id && (b.status === 'harvested' || b.status === 'enquiry'));
  const shared = (d.harvest_grns || []).length > 1;
  const lastOnEnquiry = !shared && s.status === 'enquiry';
  const label = b => {
    const who = (b.grns || []).map(item => item.farmer_name).filter(Boolean).join(', ') || b.farmer_name || '';
    return `${shipmentLabel(b)}${who ? ` · ${who}` : ''}${b.status === 'enquiry' ? ' · price enquiry open' : ''}`;
  };
  const m = openModal({
    title: `Put ${g.harvest_ref} on a boat`,
    body: `
      <p class="hint mb">It can move until that boat's price enquiry is approved. The price enquiry, the boat note, and the landing cost then cover every harvest GRN on the boat.</p>
      ${open.length ? `<div class="field"><label>Open boat</label>
        <select name="boat">${open.map(b => `<option value="${b.id}">${esc(label(b))}</option>`).join('')}</select></div>`
        : '<p class="hint">No other boat is still open. Save another harvest GRN first, then put this one on it.</p>'}
      ${lastOnEnquiry ? '<p class="hint">This is the last harvest GRN on a boat that already has a price enquiry. Moving it drops that price enquiry.</p>' : ''}`,
    footer: `${shared ? '<button class="btn" type="button" data-own>Give it its own boat</button>' : ''}
      ${open.length ? '<button class="btn btn-primary" type="button" data-save>Put it on this boat</button>' : ''}
      <button class="btn" data-close>Cancel</button>`,
  });
  const go = async body => {
    if (lastOnEnquiry) {
      const ok = await confirmModal(`Move ${g.harvest_ref}? The price enquiry on this boat is dropped.`,
        { title: 'Move harvest GRN', confirmLabel: 'Move it', danger: true });
      if (!ok) return;
    }
    try {
      const res = await api(`/api/harvest-grns/${g.id}/boat`, { body });
      m.close();
      toast(`${g.harvest_ref} is on its boat.`);
      refresh();
      shipmentDetailModal(res.shipment_id);
    } catch (err) { toast(err.message, 'err'); }
  };
  const save = $('[data-save]', m.modal);
  if (save) save.addEventListener('click', () => go({ shipment_id: Number($('[name=boat]', m.modal).value) }));
  const own = $('[data-own]', m.modal);
  if (own) own.addEventListener('click', () => go({ own: true }));
}

function sendBackModal(s) {
  const m = openModal({
    title: `Send back ${s.harvest_ref}`,
    body: `
      <p class="hint mb">It goes back to be corrected, then comes back to be verified.</p>
      <div class="field"><label>What needs correcting</label>
        <textarea name="note" maxlength="200" rows="3"></textarea></div>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>Send back</button>`,
  });
  busyClick($('[data-save]', m.modal), async () => {
    const note = $('[name=note]', m.modal).value.trim();
    if (note.length < 2) return toast('Write what needs correcting', 'err');
    try {
      await api(`/api/harvest-grns/${s.id}/send-back`, { body: { note } });
      shipTab = 'verify';
      m.close();
      toast(`Sent back ${s.harvest_ref}.`);
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function approveEnquiryModal(d) {
  const s = d.shipment;
  const m = openModal({
    title: `Review ${s.enquiry_ref}`,
    body: `
      <p class="mb">${esc(s.loaded_from)} → ${esc(s.destination)} · <b>${money(d.enquiry_total)}</b></p>
      <div class="form-grid">
        <div class="field"><label for="enquiry-approver">Approved by</label><input id="enquiry-approver" value="${esc(me.name)}" readonly></div>
        <div class="field"><label for="enquiry-approved-date">Date</label><input id="enquiry-approved-date" value="${esc(fmtDate(todayStr()))}" readonly></div>
      </div>
      <p class="hint mb">Sign to approve. Your signature, name, and approval date are saved together on the printed form.</p>
      <div class="field" data-rejection hidden><label for="enquiry-reason">Reason for rejection</label>
        <textarea id="enquiry-reason" name="reason" maxlength="200" rows="3"></textarea></div>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-danger" data-reject>Reject</button>
      <button class="btn btn-primary" data-save>Approve</button>`,
  });
  busyClick($('[data-reject]', m.modal), async () => {
    const field = $('[data-rejection]', m.modal);
    if (field.hidden) {
      field.hidden = false;
      $('[data-reject]', m.modal).textContent = 'Confirm rejection';
      $('[name=reason]', m.modal).focus();
      return;
    }
    const reason = $('[name=reason]', m.modal).value.trim();
    if (!reason) return toast('Enter a reason for rejection', 'err');
    try {
      await api(`/api/shipments/${s.id}/reject-enquiry`, { body: { reason } });
      m.close();
      toast('Price enquiry returned for correction.');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
  busyClick($('[data-save]', m.modal), async () => {
    verifyWithSignature(me.name, s.enquiry_ref, async strokes => {
      await api(`/api/shipments/${s.id}/approve-enquiry`, { body: { strokes } });
      shipTab = 'enquiry';
      m.close();
      toast(`Approved ${s.enquiry_ref}. The boat note can be written now.`);
      refresh();
    }, 'Sign and approve');
  });
}

// The boat note takes one line per crop from the price enquiry. The pack count
// is that line's bunches, boxes, sacks, or baskets. The kilogram qty is the
// harvest total for the same crop.
function boatNotePresets(d) {
  const harvest = (d.harvest_lines || []).filter(l => l.product_id);
  const kgByProduct = new Map();
  const lineByGrade = new Map();
  const byProduct = new Map();
  for (const line of harvest) {
    kgByProduct.set(line.product_id, (kgByProduct.get(line.product_id) || 0) + (Number(line.undamaged_kg) || 0));
    if (!byProduct.has(line.product_id)) byProduct.set(line.product_id, line);
    for (const grade of line.grades || []) lineByGrade.set(grade.id, line);
  }
  const enquiry = d.enquiry_lines || [];
  const packKind = { bunch: 'bunches', box: 'boxes', basket: 'baskets', sack: 'sacks' };
  const groups = new Map();
  for (const line of enquiry) {
    const linked = lineByGrade.get(line.harvest_grade_id);
    let productLine = linked ? byProduct.get(linked.product_id) : null;
    if (!productLine) {
      const desc = String(line.description || '').toLowerCase();
      let best = '';
      for (const row of byProduct.values()) {
        const name = String(row.product || '').toLowerCase();
        if (name && desc.includes(name) && name.length > best.length) {
          best = name;
          productLine = row;
        }
      }
    }
    const key = productLine ? `p:${productLine.product_id}` : `e:${line.id}`;
    if (!groups.has(key)) groups.set(key, { productLine, lines: [] });
    groups.get(key).lines.push(line);
  }
  const cropRows = enquiry.length ? [...groups.values()].map(group => {
    const kind = group.lines.map(l => packKind[l.unit]).find(Boolean) || '';
    const unit = Object.entries(packKind).find(([, name]) => name === kind)?.[0];
    const pack = kind
      ? group.lines.filter(l => l.unit === unit).reduce((sum, l) => sum + (Number(l.qty) || 0), 0)
      : '';
    const product = group.productLine;
    const kg = product
      ? Math.round((kgByProduct.get(product.product_id) || 0) * 1000) / 1000
      : (group.lines.length === 1 && group.lines[0].unit === 'kg' ? group.lines[0].qty : '');
    return {
      product_id: product?.product_id || '',
      description: product ? (product.description || product.product) : (group.lines[0].description || ''),
      qty: kg,
      pack,
      packKind: kind,
    };
  }) : [...byProduct.values()].map(line => ({
    product_id: line.product_id,
    description: line.description || line.product,
    qty: Math.round((kgByProduct.get(line.product_id) || 0) * 1000) / 1000,
  }));
  const grns = new Map();
  for (const line of harvest) {
    if (!line.harvest_ref) continue;
    const id = line.harvest_grn_id || line.harvest_ref;
    if (!grns.has(id)) grns.set(id, { description: line.harvest_ref, qty: 0 });
    grns.get(id).qty += Number(line.undamaged_kg) || 0;
  }
  const grnRows = [...grns.values()].map(g => ({
    description: g.description,
    qty: Math.round(g.qty * 1000) / 1000,
    reference: true,
  }));
  return [...cropRows, ...grnRows];
}

function boatLineRow(products, dest, preset = {}) {
  return `<tr>
    <td><select data-bn-product aria-label="Item">
      <option value="">Reference only</option>
      ${products.map(p => `<option value="${p.id}" data-unit="${esc(p.unit)}"${String(p.id) === String(preset.product_id || '') ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
    </select></td>
    <td><input data-bn-desc maxlength="120" aria-label="Description" placeholder="Or a reference, HRC / H-1 / 2026 / 172" value="${esc(preset.description || '')}"></td>
    <td class="pack-cell"><span class="pack-pair">
      <input data-bn-pack inputmode="numeric" aria-label="How many baskets, boxes, or bunches" placeholder="21" value="${preset.pack ? esc(plainNum(preset.pack)) : ''}">
      <select data-bn-pack-kind aria-label="Baskets, boxes, or bunches">
        <option value="baskets"${preset.packKind === 'baskets' ? ' selected' : ''}>Baskets</option>
        <option value="boxes"${preset.packKind === 'boxes' ? ' selected' : ''}>Boxes</option>
        <option value="sacks"${preset.packKind === 'sacks' ? ' selected' : ''}>Sacks</option>
        <option value="bunches"${preset.packKind === 'bunches' ? ' selected' : ''}>Bunches</option>
      </select>
    </span></td>
    <td class="qty-cell"><span class="qty-pair">
      <input data-bn-qty inputmode="decimal" aria-label="Produce qty" placeholder="252.4" value="${preset.qty ? esc(plainNum(preset.qty)) : ''}">
      <span class="muted" data-bn-unit></span>
    </span></td>
    <td><input data-bn-dest maxlength="80" aria-label="Destination" value="${esc(dest)}"></td>
    <td><button type="button" class="btn btn-ghost btn-sm" data-bn-remove>Remove</button></td>
  </tr>`;
}

async function boatNoteModal(d) {
  const s = d.shipment;
  let products, boats;
  try {
    [products, boats] = await Promise.all([
      api('/api/products'),
      api('/api/boats').catch(() => []),
    ]);
  } catch (err) { return toast(err.message, 'err'); }
  const t0 = todayStr();
  const m = openModal({
    title: `Boat note · ${s.enquiry_ref}`,
    wide: true,
    body: `
      <p class="hint mb">The price enquiry ${esc(s.enquiry_ref)} is approved. ${esc(s.loaded_from)} → ${esc(s.destination)}. The boat note loads the boat. Stock is added later, when the item receipt is written.</p>
      <div class="card-title mb">Delivery details</div>
      <div class="form-grid">
        <div class="field"><label>BN ref no</label>
          <input name="reference" maxlength="40" value="${esc(s.enquiry_ref)}" readonly></div>
        ${boatFieldHtml('boat_name', s.vessel_name)}
        <div class="field"><label>Contact no <span class="muted">(optional)</span></label>
          <input name="boat_phone" value="${esc(s.vessel_phone)}" inputmode="numeric" data-phone placeholder="Phone number"></div>
        <div class="field"><label>Loaded from</label>
          <input name="loaded_from" maxlength="80" value="${esc(s.loaded_from)}"></div>
        <div class="field"><label>Island code <span class="muted">(optional)</span></label>
          <input name="island_code" maxlength="20" value="${esc(s.island_code || '')}" placeholder="H-01"></div>
        <div class="field"><label>Loaded date</label>
          <input name="loaded_at" type="date" value="${t0}" max="${addDaysStr(t0, 7)}"></div>
        <div class="field"><label>Dispatch destination</label>
          <input name="destination" maxlength="80" value="${esc(s.destination)}"></div>
      </div>
      <div class="card-title mb">Items</div>
      <p class="hint">Baskets, boxes, or bunches is how the load is packed. Bananas go in bunches. Qty is the amount of produce, and that is what the item receipt puts into inventory. A reference line, such as an HRC number, is printed and does not become stock.</p>
      <div class="tbl-wrap"><table class="tbl order-lines bn-lines">
        <thead><tr><th>Item</th><th>Description</th><th>Baskets / boxes / bunches</th><th>Qty</th><th>Destination</th><th></th></tr></thead>
        <tbody data-bn-lines></tbody>
      </table></div>
      <p><button type="button" class="btn btn-sm" data-bn-add>Add line</button></p>
      <div class="form-grid">
        <div>
          <div class="card-title mb">Delivered by</div>
          <div class="field"><label>Name</label><input name="delivered_name" maxlength="80"></div>
          <div class="field"><label>Designation <span class="muted">(optional)</span></label><input name="delivered_role" maxlength="80" placeholder="R.COORDINATOR"></div>
          <div class="field"><label>Contact no <span class="muted">(optional)</span></label><input name="delivered_phone" inputmode="numeric" data-phone></div>
        </div>
        <div>
          <div class="card-title mb">Received by (boat / cargo)</div>
          <div class="field"><label>Name <span class="muted">(optional)</span></label><input name="cargo_name" maxlength="80"></div>
          <div class="field"><label>Designation <span class="muted">(optional)</span></label><input name="cargo_role" maxlength="80" placeholder="CASHIER"></div>
          <div class="field"><label>Contact no <span class="muted">(optional)</span></label><input name="cargo_phone" inputmode="numeric" data-phone></div>
        </div>
      </div>
      <p class="hint">The destination signs on the item receipt when the boat arrives. That receipt is what puts the goods into inventory. Nothing is added when you save this note.</p>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>Create boat note</button>`,
  });
  const tbody = $('[data-bn-lines]', m.modal);
  const destInput = $('[name=destination]', m.modal);
  wireBoatPick(m.modal, boats, { name: 'boat_name', phone: 'boat_phone' });
  bindIslandPair($('[name=loaded_from]', m.modal), $('[name=island_code]', m.modal));
  bindIslandPair(destInput, null);
  const addRow = (dest, preset = {}) => {
    tbody.insertAdjacentHTML('beforeend', boatLineRow(products, dest, preset));
    const tr = tbody.lastElementChild;
    bindIslandPair($('[data-bn-dest]', tr), null);
    const sel = $('[data-bn-product]', tr);
    const unit = $('[data-bn-unit]', tr);
    if (sel.value) unit.textContent = sel.selectedOptions[0]?.dataset.unit || '';
    if (preset.reference) tr.dataset.bnRef = '1';
    if (!preset.packKind && sel.value && /banana/i.test(sel.selectedOptions[0].textContent)) $('[data-bn-pack-kind]', tr).value = 'bunches';
  };
  const presets = boatNotePresets(d);
  if (presets.length) presets.forEach(preset => addRow(preset.reference ? '' : s.destination, preset));
  else for (let i = 0; i < 4; i++) addRow('');
  let lastDest = '';
  destInput.addEventListener('input', () => {
    const next = destInput.value;
    $$('[data-bn-dest]', tbody).forEach(input => {
      if (input.closest('tr').dataset.bnRef) return;
      if (!input.value || input.value === lastDest) input.value = next;
    });
    lastDest = next;
  });
  tbody.addEventListener('change', e => {
    const sel = e.target.closest('[data-bn-product]');
    if (!sel) return;
    const tr = sel.closest('tr');
    const unit = $('[data-bn-unit]', tr);
    if (!sel.value) { unit.textContent = ''; return; }
    unit.textContent = sel.selectedOptions[0].dataset.unit || '';
    if (/banana/i.test(sel.selectedOptions[0].textContent)) $('[data-bn-pack-kind]', tr).value = 'bunches';
    const desc = $('[data-bn-desc]', tr);
    if (!desc.value.trim()) desc.value = sel.selectedOptions[0].textContent;
  });
  tbody.addEventListener('click', e => {
    const btn = e.target.closest('[data-bn-remove]');
    if (!btn) return;
    const tr = btn.closest('tr');
    if (tbody.children.length === 1) {
      $$('input', tr).forEach(i => { i.value = ''; });
      $('[data-bn-product]', tr).value = '';
      $('[data-bn-pack-kind]', tr).value = 'baskets';
      $('[data-bn-unit]', tr).textContent = '';
      return;
    }
    tr.remove();
  });
  $('[data-bn-add]', m.modal).addEventListener('click', () => {
    if (tbody.children.length >= 40) return toast('A boat note can hold 40 lines', 'err');
    addRow(destInput.value.trim());
  });
  busyClick($('[data-save]', m.modal), async () => {
    const reference = $('[name=reference]', m.modal).value.trim();
    const boatName = $('[name=boat_name]', m.modal).value.trim();
    const loadedFrom = $('[name=loaded_from]', m.modal).value.trim();
    const destination = destInput.value.trim();
    const deliveredName = $('[name=delivered_name]', m.modal).value.trim();
    if (!reference) return toast('Enter the BN ref no', 'err');
    if (!boatName) return toast('Enter the boat name', 'err');
    if (!loadedFrom) return toast('Enter where it was loaded', 'err');
    if (!destination) return toast('Enter the dispatch destination', 'err');
    if (!$('[name=loaded_at]', m.modal).value) return toast('Enter the loaded date', 'err');
    if (!deliveredName) return toast('Enter who delivered it', 'err');
    const lines = [];
    for (const tr of tbody.children) {
      const productId = $('[data-bn-product]', tr).value;
      const description = $('[data-bn-desc]', tr).value.trim();
      const packRaw = $('[data-bn-pack]', tr).value.trim();
      const picked = $('[data-bn-pack-kind]', tr).value;
      const kind = picked === 'boxes' || picked === 'bunches' || picked === 'sacks' ? picked : 'baskets';
      const qtyRaw = $('[data-bn-qty]', tr).value.trim();
      if (!productId && !description && !packRaw && !qtyRaw) continue;
      let packing = '';
      if (packRaw) {
        const n = Number(packRaw);
        if (!Number.isInteger(n) || n < 1) return toast('Baskets, boxes, or bunches must be a whole number', 'err');
        const one = { baskets: 'basket', boxes: 'box', bunches: 'bunch', sacks: 'sack' }[kind];
        packing = `${n} ${n === 1 ? one : kind}`;
      }
      const qty = qtyRaw === '' ? 0 : Number(qtyRaw);
      if (qtyRaw !== '' && (!Number.isFinite(qty) || qty < 0)) return toast('Qty must be a number', 'err');
      if (productId && !packing) return toast('Enter how many baskets, boxes, or bunches', 'err');
      if (productId && !(qty > 0)) return toast('Enter the produce qty for each item', 'err');
      if (!productId && !description) return toast('A reference line needs a description', 'err');
      lines.push({
        product_id: productId ? Number(productId) : null,
        description,
        packing,
        qty,
        destination: islandValue($('[data-bn-dest]', tr).value),
      });
    }
    if (!lines.some(l => l.product_id)) return toast('Add at least one product', 'err');
    try {
      const res = await api('/api/shipments/' + s.id + '/boat-note', { body: {
        boat_name: boatName,
        boat_phone: $('[name=boat_phone]', m.modal).value.trim(),
        loaded_from: islandValue(loadedFrom),
        loaded_at: $('[name=loaded_at]', m.modal).value,
        destination: islandValue(destination),
        island_code: codeValue(loadedFrom, $('[name=island_code]', m.modal).value),
        delivered_name: deliveredName,
        delivered_role: $('[name=delivered_role]', m.modal).value.trim(),
        delivered_phone: $('[name=delivered_phone]', m.modal).value.trim(),
        cargo_name: $('[name=cargo_name]', m.modal).value.trim(),
        cargo_role: $('[name=cargo_role]', m.modal).value.trim(),
        cargo_phone: $('[name=cargo_phone]', m.modal).value.trim(),
        lines,
      } });
      shipTab = 'all';
      m.close();
      toast('Boat note created. It stays in transit until the item receipt.', 'ok', {
        action: { label: 'Print', fn: () => { window.open('/print/boat-note/' + res.id, '_blank', 'noopener'); } },
      });
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function vendorFromFarmer(s) {
  const name = String(s.farmer_name || '').trim();
  const code = String(s.farmer_code || '').trim();
  const island = String(s.farmer_island || '').trim();
  const contract = String(s.farmer_contract || '').trim();
  const lines = [];
  const head = [name ? `CF_${name}` : '', code].filter(Boolean).join(' ');
  if (head) lines.push(head);
  if (name) lines.push(name);
  if (code) lines.push(code);
  const place = [island, contract].filter(Boolean).join(' ');
  if (place) lines.push(place);
  const text = lines.join('\n');
  if (text.length <= 300) return text;
  const cut = text.slice(0, 300);
  const nl = cut.lastIndexOf('\n');
  return (nl > 0 ? cut.slice(0, nl) : cut).trimEnd();
}

async function grnModal(d) {
  let bins, lossBins;
  try { ({ bins, loss_bins: lossBins } = await api('/api/stock-lookups')); }
  catch (err) { return toast(err.message, 'err'); }
  const lossNames = new Set(Object.values(lossBins).map(b => b.toLowerCase()));
  const storageBins = bins.filter(b => !lossNames.has(b.toLowerCase()));
  const s = d.shipment;
  const vendor = vendorFromFarmer(s);
  const t0 = todayStr();
  const stockLines = (d.lines || []).filter(l => l.product_id);
  const refs = (d.lines || []).filter(l => !l.product_id);
  const arrivedDefault = t0 < s.loaded_at ? s.loaded_at : t0;
  const m = openModal({
    title: `Item receipt · ${s.reference}`,
    wide: true,
    body: `
      <p class="muted mb">${esc(s.boat_name)} · ${esc(s.loaded_from)} → ${esc(s.destination)} · loaded ${fmtDate(s.loaded_at)}</p>
      <div class="form-grid">
        <div class="field"><label>Date</label>
          <input name="arrived" type="date" value="${arrivedDefault}" min="${esc(s.loaded_at)}" max="${t0}"></div>
        <div class="field"><label for="receipt-bin">Bin <span class="muted">(optional)</span></label>
          <select id="receipt-bin" name="bin">
            <option value="">No bin</option>
            ${storageBins.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>Vendor</label>
          <textarea name="vendor" maxlength="300" rows="4" placeholder="Vendor name and address">${esc(vendor)}</textarea>
          ${vendor ? '<p class="hint">From the harvest GRN. The vendor is the farmer.</p>' : ''}</div>
        <div class="field"><label>Memo <span class="muted">(optional)</span></label>
          <textarea name="memo" maxlength="200" rows="4" placeholder="banana bonthi 104.2"></textarea></div>
      </div>
      <div class="card-title mb">Into inventory</div>
      <p class="hint">Qty from the boat note is the produce. That amount is printed on the item receipt and put into inventory. Change it to what actually arrived. Baskets, boxes, and bunches are only how it was packed.</p>
      <div class="tbl-wrap"><table class="tbl order-lines receipt-lines">
        <thead><tr><th>Item</th><th>Baskets / boxes / bunches</th><th class="num">Qty on note</th><th class="num">Into inventory</th></tr></thead>
        <tbody>
          ${stockLines.map(l => `
            <tr>
              <td><b>${esc(l.description || l.product)}</b>${l.unit ? `<span class="sub">${esc(l.unit)}</span>` : ''}</td>
              <td data-label="Packing">${cell(l.packing)}</td>
              <td class="num" data-label="Qty on note">${plainNum(l.qty) ? `${plainNum(l.qty)}${l.unit ? ' ' + esc(l.unit) : ''}` : dash}</td>
              <td class="qty-cell" data-label="Into inventory"><input data-grn-qty="${l.id}" inputmode="decimal" value="${plainNum(l.suggest_qty)}" aria-label="Amount of ${esc(l.description || l.product)} into inventory"></td>
            </tr>`).join('')}
          ${refs.map(l => `
            <tr>
              <td>${esc(l.description)}<span class="sub">Reference only — printed on the receipt, not stock</span></td>
              <td data-label="Packing">${cell(l.packing)}</td>
              <td class="num" data-label="Qty on note">${plainNum(l.qty) || dash}</td>
              <td class="num muted" data-label="Into inventory">—</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
      <div class="section-gap">
        <div class="card-title mb">Prepared by</div>
        <div class="form-grid">
          <div class="field"><label for="receipt-preparer">Name</label><input id="receipt-preparer" value="${esc(me.name)}" readonly></div>
          <div class="field"><label for="receipt-preparer-role">Designation</label><input id="receipt-preparer-role" value="${esc(roleLabel(me.role))}" readonly></div>
        </div>
        <p class="hint">${isAdmin() ? 'As Admin, you can check and verify this receipt after posting.' : 'The receipt goes to another Operations user for checking, then to Operations HOD for verification.'}</p>
      </div>`,
    footer: `<button class="btn" data-close>Cancel</button>
      <button class="btn btn-primary" data-save>Post item receipt</button>`,
  });
  busyClick($('[data-save]', m.modal), async () => {
    const arrived = $('[name=arrived]', m.modal).value;
    if (!arrived) return toast('Enter the arrival date', 'err');
    const lines = [];
    for (const input of $$('[data-grn-qty]', m.modal)) {
      const raw = input.value.trim();
      if (!raw) continue;
      const qty = Number(raw);
      if (!Number.isFinite(qty) || qty <= 0) return toast('Enter the amount that arrived', 'err');
      lines.push({ id: Number(input.dataset.grnQty), qty });
    }
    if (!lines.length) return toast('Enter the amount that arrived', 'err');
    const field = name => $(`[name=${name}]`, m.modal).value.trim();
    try {
      const res = await api(`/api/shipments/${s.id}/grn`, { body: {
        arrived_at: arrived,
        bin_location: field('bin'),
        vendor: field('vendor'),
        memo: field('memo'),
        lines,
      } });
      m.close();
      toast(`Item receipt ${res.grn_ref} posted to inventory and awaiting check.`, 'ok', {
        action: { label: 'Print', fn: () => { window.open('/print/item-receipt/' + s.id, '_blank', 'noopener'); } },
      });
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---- POS ----
// Cash and transfer are counter sales. Wholesale is a bill to a named customer.
// The bill lives in memory until it is placed or cleared.

function openTill(customerId) {
  pos.pane = 'sell';
  pos.bill = 'wholesale';
  pos.customerId = Number(customerId) || null;
  if (location.hash === '#/pos') refresh();
  else location.hash = '#/pos';
}

const pos = {
  pane: 'sell',
  q: '',
  cat: 'all',
  delivery: '',
  notes: '',
  pay: 'cash',
  bill: 'counter',
  customerId: null,
  slipFile: null,
  slipName: '',
  lines: [],
};

const tillMoney = laari => 'MVR ' + (laari / 100).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const posQtyText = q => String(Math.round(Number(q) * 1000) / 1000);
const posStep = unit => (unit === 'kg' ? 0.5 : 1);
let openPosCatalog = () => {};

async function renderPos(view) {
  if (!pos.delivery) pos.delivery = todayStr();
  let products, settings, customers;
  try {
    [products, settings, customers] = await Promise.all([
      api('/api/products'),
      api('/api/settings'),
      api('/api/customers').catch(() => []),
    ]);
  } catch (err) {
    view.innerHTML = `<div class="card error-box">${esc(err.message)}</div>`;
    return;
  }
  const byId = new Map(products.map(p => [p.id, p]));
  pos.lines = pos.lines.filter(l => byId.has(l.productId));
  const t0 = todayStr();
  const onTill = p => Number(p.pos_on) !== 0;
  const sellable = products.filter(onTill);
  const cats = ['fruit', 'vegetable', 'herb', 'other'].filter(c => sellable.some(p => p.category === c));
  const gstOn = String(settings.biz_tin || '').trim() && (Number.parseFloat(settings.gst_rate) || 0) > 0;
  const billCustomers = customers.filter(c => !(c.type === 'retail' && c.name.trim().toLowerCase() === 'walk-in'));
  if (pos.customerId && !billCustomers.some(c => c.id === pos.customerId)) pos.customerId = null;
  if (pos.pay !== 'cash' && pos.pay !== 'transfer') pos.pay = 'cash';
  if (pos.bill !== 'wholesale') pos.bill = 'counter';
  const wholesale = pos.bill === 'wholesale';

  view.innerHTML = `
    <div class="filter-tabs" role="tablist" aria-label="POS">
      <button type="button" class="filter-tab${pos.pane === 'sell' ? ' active' : ''}" data-pos-pane="sell" role="tab" aria-selected="${pos.pane === 'sell'}">Sell</button>
      <button type="button" class="filter-tab${pos.pane === 'history' ? ' active' : ''}" data-pos-pane="history" role="tab" aria-selected="${pos.pane === 'history'}">Sales</button>
    </div>
    <div data-pos-sell ${pos.pane === 'history' ? 'hidden' : ''}>
    <div class="pos">
      <div class="pos-products">
        <button type="button" class="btn btn-primary mobile-bill-jump" data-pos-jump hidden>View current bill</button>
        <div class="pos-tools">
          <input class="pos-search" data-pos-search type="search" placeholder="Search products" value="${esc(pos.q)}" autocomplete="off" aria-label="Search products">
          ${cats.length > 1 ? `<div class="filter-tabs" role="tablist">${
            [['all', 'All'], ...cats.map(c => [c, STOCK_CAT[c][0]])].map(([k, label]) =>
              `<button type="button" class="filter-tab${pos.cat === k ? ' active' : ''}" data-pos-cat="${k}" role="tab">${label}</button>`).join('')
          }</div>` : ''}
        </div>
        <div class="pos-grid" data-pos-grid></div>
      </div>
      <aside class="card pos-bill" aria-labelledby="pos-current-bill">
        <div class="pos-bill-head">
          <h2 id="pos-current-bill" tabindex="-1">
            <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4.2 6.4h9.6l-.8 7.2H5z"/><path d="M6.6 6.4V5a2.4 2.4 0 0 1 4.8 0v1.4"/></svg>
            Current bill
          </h2>
          <button type="button" class="pos-clear" data-pos-clear aria-label="Clear bill">
            <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3.2 9a5.8 5.8 0 1 0 1.7-4.1"/><path d="M3 3.4V6.6h3.2"/></svg>
          </button>
        </div>
        <div class="field">
          <span class="field-label" id="pos-bill-label">Bill</span>
          <div class="seg" role="radiogroup" aria-labelledby="pos-bill-label">
            <label><input type="radio" name="pos-bill" value="counter" ${wholesale ? '' : 'checked'} ${canSell() ? '' : 'disabled'}><span>Counter</span></label>
            <label><input type="radio" name="pos-bill" value="wholesale" ${wholesale ? 'checked' : ''} ${canSell() ? '' : 'disabled'}><span>Wholesale</span></label>
          </div>
        </div>
        <p class="pos-kicker" data-pos-kicker>${gstOn ? 'Counter sale · prices include GST' : 'Counter sale'}</p>
        <div data-pos-lines></div>
        <div class="pos-sums" data-pos-sums></div>
        <p class="pos-fine" data-pos-fine>The customer pays now. Recording the sale saves it as paid and takes the stock.</p>
        <div class="field"><span class="field-label">Customer</span>
          <p class="pos-walkin" data-pos-walkin ${wholesale ? 'hidden' : ''}>Walk-in</p>
          <select data-pos-customer aria-label="Customer" ${wholesale ? '' : 'hidden'} ${canSell() ? '' : 'disabled'}>
            <option value="">Choose…</option>
            ${billCustomers.map(c => `<option value="${c.id}" ${c.id === pos.customerId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
          <p class="hint" data-pos-credit ${wholesale ? '' : 'hidden'}></p>
        </div>
        <div class="field"><label for="pos-delivery">Delivery</label>
          <input id="pos-delivery" data-pos-delivery type="date" value="${esc(pos.delivery)}" min="${addDaysStr(t0, -7)}" max="${addDaysStr(t0, 14)}"></div>
        <div class="field"><label for="pos-notes">Note <span class="muted">(optional)</span></label>
          <input id="pos-notes" data-pos-notes maxlength="300" value="${esc(pos.notes)}"></div>
        <div class="field" data-pos-pay-field ${wholesale ? 'hidden' : ''}>
          <span class="field-label" id="pos-pay-label">Paid with</span>
          <div class="seg" role="radiogroup" aria-labelledby="pos-pay-label">
            <label><input type="radio" name="pos-pay" value="cash" ${pos.pay === 'cash' ? 'checked' : ''} ${canSell() ? '' : 'disabled'}><span>Cash</span></label>
            <label><input type="radio" name="pos-pay" value="transfer" ${pos.pay === 'transfer' ? 'checked' : ''} ${canSell() ? '' : 'disabled'}><span>Transfer</span></label>
          </div>
        </div>
        <div class="pos-slip" data-pos-slip-row ${pos.pay === 'transfer' ? '' : 'hidden'}>
          <button type="button" class="btn" data-pos-pick ${canSell() ? '' : 'disabled'}>${pos.slipName ? 'Replace slip' : 'Upload transfer slip'}</button>
          <span class="pos-slip-name" data-pos-slip-name>${esc(pos.slipName)}</span>
        </div>
        ${canSell()
          ? `<button type="button" class="btn btn-primary pos-place" data-pos-place disabled>Record sale</button>`
          : `<p class="pos-fine">Sales records the sale.</p>`}
      </aside>
    </div>
    </div>
    <div data-pos-history ${pos.pane === 'sell' ? 'hidden' : ''}></div>`;

  const grid = $('[data-pos-grid]', view);
  const linesEl = $('[data-pos-lines]', view);
  const sumsEl = $('[data-pos-sums]', view);
  const totalOf = () => pos.lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0);

  function gstOf(total) {
    const rate = Number.parseFloat(settings.gst_rate) || 0;
    if (!gstOn || !(total > 0)) return null;
    const gst = Math.round(total * rate / (100 + rate));
    return { rate, gst, excl: total - gst };
  }

  function paintGrid() {
    const q = pos.q.trim().toLowerCase();
    const on = products.filter(onTill);
    const rows = on.filter(p => {
      if (pos.cat !== 'all' && p.category !== pos.cat) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || String(p.code || '').toLowerCase().includes(q);
    });
    rows.sort((a, b) => (b.stock > 0) - (a.stock > 0));
    grid.innerHTML = rows.length ? rows.map(p => {
      const line = pos.lines.find(l => l.productId === p.id);
      const out = !(p.stock > 0);
      return `<button type="button" class="pos-tile${out ? ' is-out' : ''}" data-pos-add="${p.id}" ${out ? 'disabled' : ''}>
        <span class="pos-tile-copy">
          ${line ? `<span class="pos-inbill">${esc(posQtyText(line.qty))}</span>` : ''}
          <b>${esc(p.name)}</b>
          <span class="pos-tile-price">${tillMoney(p.price)} / ${esc(p.unit)}</span>
          <span class="pos-tile-stock">${out ? 'Out' : `${fmtQty(p.stock, p.unit)} on hand`}</span>
        </span>
        <span class="pos-tile-art">${posMark(p.name)}</span>
      </button>`;
    }).join('') : `<p class="pos-none">${on.length ? 'No products match.' : 'No items on the till.'}</p>`;
  }

  function posItemsModal() {
    const m = openModal({
      title: 'Items on the till',
      wide: true,
      body: `
        <p class="hint mb">Off items stay in Items and inventory. They just don't show on the till.</p>
        <input class="pos-search" data-pos-item-q type="search" placeholder="Search items" autocomplete="off" aria-label="Search items">
        <div class="pos-item-list" data-pos-item-list></div>`,
      footer: `<button class="btn" data-close>Done</button>`,
    });
    const list = $('[data-pos-item-list]', m.modal);
    const qEl = $('[data-pos-item-q]', m.modal);
    const paintList = () => {
      const q = (qEl.value || '').trim().toLowerCase();
      const rows = products.filter(p => !q
        || p.name.toLowerCase().includes(q)
        || String(p.code || '').toLowerCase().includes(q));
      list.innerHTML = rows.length ? rows.map(p => {
        const on = onTill(p);
        return `<div class="pos-item-row${on ? '' : ' is-off'}">
          <span><b>${esc(p.name)}</b>${p.code ? `<span class="sub">${esc(p.code)}</span>` : ''}</span>
          <button type="button" class="btn btn-sm${on ? '' : ' btn-ghost'}" data-pos-on="${p.id}" aria-pressed="${on ? 'true' : 'false'}">${on ? 'On till' : 'Off till'}</button>
        </div>`;
      }).join('') : `<p class="hint">No items match.</p>`;
    };
    paintList();
    qEl.addEventListener('input', paintList);
    m.modal.addEventListener('click', async e => {
      const btn = e.target.closest('[data-pos-on]');
      if (!btn || btn.disabled) return;
      const p = byId.get(+btn.dataset.posOn);
      if (!p) return;
      const next = !onTill(p);
      btn.disabled = true;
      try {
        await api(`/api/products/${p.id}`, { method: 'PATCH', body: { pos_on: next } });
        p.pos_on = next ? 1 : 0;
        toast(next ? `${p.name} is on the till` : `${p.name} is off the till`);
        paintList();
        paintGrid();
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    });
    qEl.focus();
  }
  openPosCatalog = posItemsModal;

  function paintLines() {
    if (!pos.lines.length) {
      linesEl.innerHTML = `<div class="pos-empty">
        <svg viewBox="0 0 18 18" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3.4 6.2h11.2l-1 7.4H4.4z"/><path d="M6.2 6.2V4.6a2.8 2.8 0 0 1 5.6 0v1.6"/></svg>
        <p>${canSell() ? 'Tap a product to add it.' : 'Sales places orders from here.'}</p>
      </div>`;
      return;
    }
    linesEl.innerHTML = `<ul class="pos-lines">${pos.lines.map(l => {
      const p = byId.get(l.productId);
      return `<li class="pos-line">
        <div class="pos-line-id">
          <b>${esc(p.name)}</b>
          <label class="pos-line-price">MVR
            <input class="pos-price" data-pos-price="${p.id}" inputmode="decimal" value="${(l.price / 100).toFixed(2)}" aria-label="Price for ${esc(p.name)}" ${canSell() ? '' : 'readonly'}>
            / ${esc(p.unit)}</label>
        </div>
        <div class="pos-step">
          <button type="button" data-pos-dec="${p.id}" aria-label="Less ${esc(p.name)}">−</button>
          <input data-pos-qty="${p.id}" inputmode="decimal" value="${esc(posQtyText(l.qty))}" aria-label="Quantity for ${esc(p.name)}">
          <button type="button" data-pos-inc="${p.id}" aria-label="More ${esc(p.name)}">+</button>
        </div>
        <b class="pos-line-amt" data-pos-amt="${p.id}">${tillMoney(Math.round(l.qty * l.price))}</b>
        <button type="button" class="pos-drop" data-pos-drop="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>
      </li>`;
    }).join('')}</ul>`;
  }

  function paintBillMode() {
    const wholesale = pos.bill === 'wholesale';
    const walk = $('[data-pos-walkin]', view);
    const pick = $('[data-pos-customer]', view);
    const credit = $('[data-pos-credit]', view);
    const fine = $('[data-pos-fine]', view);
    const kicker = $('[data-pos-kicker]', view);
    const btn = $('[data-pos-place]', view);
    const payField = $('[data-pos-pay-field]', view);
    const slip = $('[data-pos-slip-row]', view);
    if (walk) walk.hidden = wholesale;
    if (pick) pick.hidden = !wholesale;
    if (payField) payField.hidden = wholesale;
    if (slip) slip.hidden = wholesale || pos.pay !== 'transfer';
    if (credit) {
      credit.hidden = !wholesale;
      const c = billCustomers.find(x => x.id === pos.customerId);
      if (!wholesale || !c) {
        credit.textContent = '';
        credit.className = 'hint';
      } else {
        const committed = c.balance + (c.pending_total ?? 0);
        const total = totalOf();
        if (!c.credit_limit) {
          credit.textContent = committed ? `Committed ${money(committed)} · no credit limit set` : '';
          credit.className = 'hint';
        } else {
          const after = committed + total;
          credit.textContent = `Committed ${money(committed)} of ${money(c.credit_limit)}`
            + (total ? ` → ${money(after)} after this bill` : '');
          credit.className = after > c.credit_limit ? 'hint warn-text' : 'hint';
        }
      }
    }
    if (kicker) kicker.textContent = wholesale
      ? (gstOn ? 'Wholesale bill · prices include GST' : 'Wholesale bill')
      : (gstOn ? 'Counter sale · prices include GST' : 'Counter sale');
    if (fine) fine.textContent = wholesale
      ? 'Billed to the customer and left unpaid. Stock is taken now.'
      : 'The customer pays now. Recording the sale saves it as paid and takes the stock.';
    if (btn) btn.textContent = wholesale ? 'Record bill' : 'Record sale';
  }

  function paintSums() {
    const total = totalOf();
    const jump = $('[data-pos-jump]', view);
    jump.hidden = !pos.lines.length;
    jump.textContent = `View bill · ${tillMoney(total)}`;
    const gst = gstOf(total);
    sumsEl.innerHTML = `
      ${gst ? `<div class="pos-sum"><span>Excl. GST</span><b>${tillMoney(gst.excl)}</b></div>
        <div class="pos-sum"><span>GST ${esc(String(gst.rate))}%</span><b>${tillMoney(gst.gst)}</b></div>` : ''}
      <div class="pos-sum due"><span>Total</span><b>${tillMoney(total)}</b></div>`;
    const ready = canSell() && pos.lines.length > 0 && (pos.bill !== 'wholesale' || pos.customerId);
    for (const b of $$('[data-pos-place]', view)) b.disabled = !ready;
    paintBillMode();
  }

  function paint() { paintGrid(); paintLines(); paintSums(); }

  function bump(id, dir) {
    if (!canSell()) return toast('Sales places orders', 'err');
    const p = byId.get(id);
    if (!p) return;
    const line = pos.lines.find(l => l.productId === id);
    const cur = line?.qty ?? 0;
    let next = Math.round((cur + dir * posStep(p.unit)) * 1000) / 1000;
    if (dir > 0) {
      if (!(p.stock > 0)) return toast(`${p.name} is out of stock`, 'err');
      if (next > p.stock + 1e-9) {
        if (cur + 1e-9 >= p.stock) return toast(`Only ${fmtQty(p.stock, p.unit)} of ${p.name} is on hand`, 'err');
        next = Math.round(p.stock * 1000) / 1000;
      }
    }
    if (next <= 0) pos.lines = pos.lines.filter(l => l.productId !== id);
    else if (line) line.qty = next;
    else pos.lines.push({ productId: id, qty: next, price: p.price });
    paint();
  }

  async function clearBill() {
    if (!pos.lines.length && !pos.notes) return;
    if (pos.lines.length) {
      const ok = await confirmModal('Clear this bill? Nothing has been saved.', {
        title: 'Clear bill', confirmLabel: 'Clear', danger: true,
      });
      if (!ok) return;
    }
    pos.lines = [];
    pos.notes = '';
    pos.slipFile = null;
    pos.slipName = '';
    const notes = $('[data-pos-notes]', view);
    if (notes) notes.value = '';
    const slipName = $('[data-pos-slip-name]', view);
    const slipBtn = $('[data-pos-pick]', view);
    if (slipName) slipName.textContent = '';
    if (slipBtn) slipBtn.textContent = 'Upload transfer slip';
    paint();
  }

  let placing = false;
  async function place(override = false) {
    if (!canSell() || (placing && !override)) return;
    if (!pos.lines.length) return toast('Add at least one product', 'err');
    const wholesale = pos.bill === 'wholesale';
    if (wholesale && !pos.customerId) return toast('Choose a customer', 'err');
    const delivery = $('[data-pos-delivery]', view).value;
    if (!delivery) return toast('Choose a delivery date', 'err');
    for (const l of pos.lines) {
      const p = byId.get(l.productId);
      if (!(l.qty >= 0.001)) return toast(`Enter a quantity for ${p.name}`, 'err');
      if (!Number.isInteger(l.price) || l.price < 0) return toast(`Enter a valid price for ${p.name}`, 'err');
    }
    const body = {
      delivery_date: delivery,
      notes: pos.notes.trim(),
      channel: wholesale ? 'wholesale' : 'pos',
      items: pos.lines.map(l => ({ product_id: l.productId, qty: l.qty, unit_price: l.price })),
    };
    if (wholesale) {
      body.customer_id = pos.customerId;
      if (override) body.override = true;
    } else body.payment_method = pos.pay;
    placing = true;
    try {
      const r = await api('/api/orders', { body });
      const slip = pos.pay === 'transfer' ? pos.slipFile : null;
      const buyer = billCustomers.find(c => c.id === pos.customerId);
      pos.lines = [];
      pos.notes = '';
      pos.slipFile = null;
      pos.slipName = '';
      const label = wholesale ? `Bill #${r.id} for ${buyer?.name ?? 'customer'}` : `Sale #${r.id} paid · ${payLabel(pos.pay)}`;
      toast(label, 'ok', { action: { label: 'Undo', fn: async () => {
        try {
          await api(`/api/orders/${r.id}/cancel`, { method: 'POST' });
          closeAllModals();
          toast(`${wholesale ? 'Bill' : 'Sale'} #${r.id} cancelled`, 'ok', { action: restoreAction(r.id) });
          refresh();
        } catch (err) { toast(err.message, 'err'); throw err; }
      } } });
      if (slip) {
        try { await uploadSlip(r.id, slip); toast('Transfer slip saved'); }
        catch (err) { toast(err.message, 'err'); }
      }
      refresh();
    } catch (err) {
      if (wholesale && err.data?.code === 'CREDIT_LIMIT') {
        placing = false;
        const buyer = billCustomers.find(c => c.id === pos.customerId);
        const ok = await confirmModal(
          `${buyer?.name ?? 'This customer'} already has ${money(err.data.exposure ?? err.data.balance)} committed (unpaid + pending) against a ${money(err.data.credit_limit)} limit. Record the bill anyway?`,
          { title: 'Over credit limit', confirmLabel: 'Record anyway' });
        if (ok) await place(true);
        return;
      }
      toast(err.message, 'err');
    } finally {
      placing = false;
    }
  }

  paint();

  async function loadPosHistory() {
    const el = $('[data-pos-history]', view);
    if (!el) return;
    el.innerHTML = `<div class="loading">Loading…</div>`;
    let counter, wholesaleRows;
    try {
      [counter, wholesaleRows] = await Promise.all([
        api('/api/orders?channel=pos'),
        api('/api/orders?channel=wholesale'),
      ]);
    }
    catch (err) {
      if (el.isConnected) el.innerHTML = `<div class="card error-box">${esc(err.message)}</div>`;
      return;
    }
    if (pos.pane !== 'history' || !el.isConnected) return;
    const rows = [...counter, ...wholesaleRows].sort((a, b) =>
      b.delivery_date.localeCompare(a.delivery_date) || b.id - a.id);
    const paidWith = o => o.channel === 'wholesale'
      ? `Wholesale${o.pay_method ? ` · ${payLabel(o.pay_method)}` : ''}`
      : (o.pay_method ? payLabel(o.pay_method) : '');
    el.innerHTML = `<div class="card tbl-wrap"><table class="tbl">
      <thead><tr><th>Sale</th><th>Customer</th><th>When</th><th>Items</th>
        <th class="num">Total</th><th>Paid with</th><th>Status</th></tr></thead>
      <tbody>${rows.length ? rows.map(o => `
        <tr class="row-click" data-pos-open="${o.id}">
          <td>#${o.id}</td>
          <td><b>${esc(o.customer)}</b></td>
          <td>${histWhen(o.created_at)}</td>
          <td>${esc(o.top_item ?? '')}${o.item_count > 1 ? ` <span class="muted">+${o.item_count - 1}</span>` : ''}</td>
          <td class="num">${tillMoney(o.total)}</td>
          <td>${paidWith(o) ? esc(paidWith(o)) : '<span class="muted">—</span>'}${o.channel !== 'wholesale' && o.pay_method === 'transfer'
            ? `<span class="sub">${o.has_slip
              ? `<a class="btn btn-sm" href="/api/orders/${o.id}/slip" target="_blank" rel="noopener" data-pos-slip>View slip</a>`
              : (canSell() ? `<button type="button" class="btn btn-sm" data-pos-upload="${o.id}">Upload slip</button>` : '')}</span>`
            : ''}</td>
          <td>${orderBadge(o)}${!o.voided && o.outstanding > 0 ? `<span class="sub">${money(o.outstanding)} due</span>` : ''}</td>
        </tr>`).join('')
        : `<tr><td colspan="7" class="empty">No sales recorded at the till yet.</td></tr>`}
      </tbody></table></div>`;
  }

  if (pos.pane === 'history') loadPosHistory();

  view.addEventListener('click', async e => {
    const pane = e.target.closest('[data-pos-pane]');
    if (pane) {
      pos.pane = pane.dataset.posPane;
      $$('[data-pos-pane]', view).forEach(b => {
        const on = b === pane;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      $('[data-pos-sell]', view).hidden = pos.pane !== 'sell';
      $('[data-pos-history]', view).hidden = pos.pane !== 'history';
      if (pos.pane === 'history') loadPosHistory();
      return;
    }
    if (e.target.closest('[data-pos-slip]')) { e.stopPropagation(); return; }
    const upload = e.target.closest('[data-pos-upload]');
    if (upload) {
      e.stopPropagation();
      const file = await pickSlipFile();
      if (!file) return;
      upload.disabled = true;
      try {
        await uploadSlip(+upload.dataset.posUpload, file);
        toast('Transfer slip saved');
        loadPosHistory();
      } catch (err) { toast(err.message, 'err'); upload.disabled = false; }
      return;
    }
    const opened = e.target.closest('[data-pos-open]');
    if (opened) return orderDetailModal(+opened.dataset.posOpen);
    const add = e.target.closest('[data-pos-add]');
    if (add) return bump(+add.dataset.posAdd, 1);
    const inc = e.target.closest('[data-pos-inc]');
    if (inc) return bump(+inc.dataset.posInc, 1);
    const dec = e.target.closest('[data-pos-dec]');
    if (dec) return bump(+dec.dataset.posDec, -1);
    const drop = e.target.closest('[data-pos-drop]');
    if (drop) {
      pos.lines = pos.lines.filter(l => l.productId !== +drop.dataset.posDrop);
      paint();
      return;
    }
    const cat = e.target.closest('[data-pos-cat]');
    if (cat) {
      pos.cat = cat.dataset.posCat;
      $$('[data-pos-cat]', view).forEach(b => b.classList.toggle('active', b === cat));
      paintGrid();
      return;
    }
    if (e.target.closest('[data-pos-jump]')) {
      const heading = $('#pos-current-bill', view);
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: 'start' });
      return;
    }
    if (e.target.closest('[data-pos-clear]')) return clearBill();
    if (e.target.closest('[data-pos-place]')) return place();
    if (e.target.closest('[data-pos-pick]')) {
      const file = await pickSlipFile();
      if (!file) return;
      if (file.size > 6_000_000) return toast('Slip must be under 6 MB', 'err');
      pos.slipFile = file;
      pos.slipName = file.name;
      const name = $('[data-pos-slip-name]', view);
      const btn = $('[data-pos-pick]', view);
      if (name) name.textContent = file.name;
      if (btn) btn.textContent = 'Replace slip';
    }
  });

  view.addEventListener('input', e => {
    if (e.target.matches('[data-pos-search]')) {
      pos.q = e.target.value;
      paintGrid();
      return;
    }
    if (e.target.matches('[data-pos-notes]')) { pos.notes = e.target.value; return; }
    if (e.target.matches('[name=pos-bill]')) {
      pos.bill = e.target.value === 'wholesale' ? 'wholesale' : 'counter';
      paintSums();
      return;
    }
    if (e.target.matches('[name=pos-pay]')) {
      pos.pay = e.target.value === 'transfer' ? 'transfer' : 'cash';
      if (pos.pay !== 'transfer') { pos.slipFile = null; pos.slipName = ''; }
      const row = $('[data-pos-slip-row]', view);
      if (row) row.hidden = pos.pay !== 'transfer';
      const name = $('[data-pos-slip-name]', view);
      const btn = $('[data-pos-pick]', view);
      if (name) name.textContent = pos.slipName;
      if (btn) btn.textContent = pos.slipName ? 'Replace slip' : 'Upload transfer slip';
      paintSums();
      return;
    }
    if (e.target.matches('[data-pos-qty]')) {
      const id = +e.target.dataset.posQty;
      const line = pos.lines.find(l => l.productId === id);
      const p = byId.get(id);
      const q = Number.parseFloat(e.target.value);
      if (!line || !p || !(q > 0)) return;
      if (q > p.stock + 1e-9) {
        line.qty = Math.round(p.stock * 1000) / 1000;
        e.target.value = posQtyText(line.qty);
        toast(`Only ${fmtQty(p.stock, p.unit)} of ${p.name} is on hand`, 'err');
      } else line.qty = Math.round(q * 1000) / 1000;
      const amt = view.querySelector(`[data-pos-amt="${id}"]`);
      if (amt) amt.textContent = tillMoney(Math.round(line.qty * line.price));
      paintGrid();
      paintSums();
      return;
    }
    if (e.target.matches('[data-pos-price]')) {
      const id = +e.target.dataset.posPrice;
      const line = pos.lines.find(l => l.productId === id);
      const price = parseMoney(e.target.value);
      if (!line || !Number.isFinite(price) || price < 0) return;
      line.price = price;
      const amt = view.querySelector(`[data-pos-amt="${id}"]`);
      if (amt) amt.textContent = tillMoney(Math.round(line.qty * line.price));
      paintSums();
    }
  });

  view.addEventListener('change', e => {
    if (e.target.matches('[data-pos-delivery]')) { pos.delivery = e.target.value; return; }
    if (e.target.matches('[data-pos-customer]')) {
      pos.customerId = Number(e.target.value) || null;
      paintSums();
      return;
    }
    if (e.target.matches('[data-pos-qty]')) {
      const id = +e.target.dataset.posQty;
      const q = Number.parseFloat(e.target.value);
      if (!(q > 0)) {
        pos.lines = pos.lines.filter(l => l.productId !== id);
        paint();
      }
      return;
    }
    if (e.target.matches('[data-pos-price]')) {
      const id = +e.target.dataset.posPrice;
      const line = pos.lines.find(l => l.productId === id);
      const price = parseMoney(e.target.value);
      if (!line || (Number.isFinite(price) && price >= 0)) return;
      line.price = byId.get(id).price;
      e.target.value = (line.price / 100).toFixed(2);
      paintSums();
    }
  });
}

// ---- page registry ----

export const pages = {
  dashboard: {
    title: 'Dashboard',
    sub: () => {
      if (!dashboardYear) return 'Stock on hand — ' + fmtDate(todayStr());
      if (dashboardYear < Number(todayStr().slice(0, 4))) return `${dashboardYear} totals — on hand is what is still left from that year`;
      return `${dashboardYear} to date — stock on hand is today's shelf`;
    },
    render: renderDashboard,
  },
  'sell-first': {
    title: 'Sell first',
    sub: () => 'Stock expiring within 3 days — move it before it becomes waste',
    render: renderSellFirst,
  },
  pos: {
    title: 'POS',
    sub: () => 'Counter sales and wholesale bills',
    actions: [{ label: 'Till items', show: canPosCatalog, onClick: () => openPosCatalog() }],
    render: renderPos,
  },
  inventory: {
    title: 'Inventory',
    sub: () => 'Every receipt, sale and adjustment, plus what is on hand by bin',
    actions: [],
    render: renderInventory,
  },
  shipments: {
    title: 'Shipments',
    sub: () => 'A harvest GRN receives produce from the farmer. An Operations HOD approves the boat price enquiry, then the boat note can be written. Stock is added when the item receipt is written on arrival.',
    actions: [
      { label: 'New harvest GRN', primary: true, show: canOps, onClick: () => harvestGrnModal() },
    ],
    render: renderShipments,
  },
  customers: {
    title: 'Customers',
    sub: () => '',
    actions: [{ label: 'New customer', show: canSell, onClick: () => customerFormModal() }],
    render: renderCustomers,
  },
  farmers: {
    title: 'Farmers',
    sub: () => '',
    actions: [],
    render: renderFarmers,
  },
  products: {
    title: 'Items',
    sub: () => canSell() && !canOps()
      ? 'Name, code, unit, shelf life and cost. You set the sell price.'
      : 'Name, code, unit, shelf life and cost. Sales sets the sell price.',
    actions: [{ label: 'New item', primary: true, show: canOps, onClick: () => productFormModal() }],
    render: renderProducts,
  },
  history: {
    title: 'History',
    sub: () => "Who did what, when — every action is logged",
    actions: [],
    render: renderHistory,
  },
};
