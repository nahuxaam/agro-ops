// Shared utilities: DOM, formatting, API client, modals, toasts.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(path, { method, body } = {}) {
  const opts = body !== undefined
    ? { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: method ?? 'GET' };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Session gone (expired or signed out elsewhere) → hand over to the login screen.
    if (res.status === 401 && path !== '/api/login') {
      window.dispatchEvent(new CustomEvent('auth-lost'));
    }
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---- money (laari ints over the wire) ----

export function money(laari) {
  const v = laari / 100;
  const whole = Math.abs(v % 1) < 0.005;
  return 'MVR ' + v.toLocaleString('en-US', whole
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function moneyShort(laari) {
  const v = laari / 100;
  if (Math.abs(v) >= 1000) {
    const k = v / 1000;
    return (Math.abs(k) >= 100 ? k.toFixed(0) : k.toFixed(1)) + 'k';
  }
  return String(Math.round(v));
}

// "12.50" → 1250 laari; NaN when not parseable
export function parseMoney(text) {
  const v = Number.parseFloat(String(text).replace(/,/g, ''));
  return Number.isFinite(v) ? Math.round(v * 100) : NaN;
}

export const fmtQty = (q, unit) =>
  (+q).toLocaleString('en-US', { maximumFractionDigits: 1 }) + (unit ? ' ' + unit : '');

// ---- dates ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysFromToday(dateStr) {
  return Math.round((new Date(dateStr + 'T12:00:00') - new Date(todayStr() + 'T12:00:00')) / 86400000);
}

export function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const sameYear = y === new Date().getFullYear();
  return `${d} ${MONTHS[m - 1]}${sameYear ? '' : ' ' + y}`;
}

export function relDay(dateStr) {
  const n = daysFromToday(dateStr.slice(0, 10));
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return fmtDate(dateStr);
}

export function daysLeftLabel(n) {
  if (n < 0) return 'Expired';
  if (n === 0) return 'Last day';
  if (n === 1) return '1 day left';
  return `${n} days left`;
}

// ---- badges & chips ----

export function lotBadge(status, daysLeft) {
  const map = {
    fresh: ['good', 'Fresh'],
    soon: ['warn', daysLeftLabel(daysLeft)],
    critical: ['serious', daysLeftLabel(daysLeft)],
    expired: ['crit', 'Expired'],
  };
  const [kind, label] = map[status] ?? ['', status];
  return `<span class="badge b-${kind}">${esc(label)}</span>`;
}

export function orderBadge(o) {
  if (o.voided) return '<span class="badge">Voided</span>';
  if (o.status === 'paid') return '<span class="badge b-good">Paid</span>';
  if (o.status === 'cancelled') return '<span class="badge">Cancelled</span>';
  if (o.status === 'pending') return '<span class="badge b-blue">Pending</span>';
  if (o.overdue) return '<span class="badge b-crit">Overdue</span>';
  return '<span class="badge b-warn">Unpaid</span>';
}

export const typeChip = t => `<span class="chip">${esc(t)}</span>`;

// Wire an async click handler that disables the button while the request is in
// flight — without this, a double-click submits twice (duplicate orders,
// double-recorded payments).
export function busyClick(btn, fn) {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await fn();
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });
}

// ---- toast ----

// toast('Saved') · toast('Nope', 'err') · toast('Delivered', 'ok', { action: { label: 'Undo', fn } })
// The removal timer pauses while hovered or focused, is cancelled while the
// action runs (never yank a toast mid-undo), and a FAILED action re-arms the
// toast so the undo can be retried — action.fn must throw on failure.
export function toast(msg, kind = 'ok', { action } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  const text = document.createElement('span');
  text.textContent = msg;
  el.append(text);
  let timer;
  const schedule = ms => { clearTimeout(timer); timer = setTimeout(() => el.remove(), ms); };
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      clearTimeout(timer);
      try {
        await action.fn();
        el.remove();
      } catch {
        btn.disabled = false;
        schedule(8000);
      }
    });
    el.append(btn);
  }
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => schedule(3000));
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', () => schedule(3000));
  el.addEventListener('click', e => { if (!e.target.closest('.toast-action')) el.remove(); });
  $('#toast-root').append(el);
  schedule(kind === 'err' ? 6000 : action ? 8000 : 3500);
}

// ---- modal ----

const openModals = new Set();

// Close every open modal — used by toast undo actions, which can change the
// data a modal was rendered from (e.g. voiding a payment under an open
// payment form).
export function closeAllModals() {
  for (const close of [...openModals]) close();
}

export function openModal({ title, body, footer = '', wide = false, onClose }) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2>
        <button class="modal-close" type="button" aria-label="Close">×</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">${footer}</div>
    </div>`;
  root.append(backdrop);
  const modal = $('.modal', backdrop);

  const close = () => {
    if (!openModals.has(close)) return; // already closed
    openModals.delete(close);
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  openModals.add(close);
  // Only the topmost modal responds to Escape (a confirm can sit on a form).
  const onKey = e => { if (e.key === 'Escape' && backdrop === root.lastElementChild) close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  $('.modal-close', backdrop).addEventListener('click', close);
  $$('[data-close]', backdrop).forEach(b => b.addEventListener('click', close));

  const first = $('input, select, textarea, button.btn-primary', modal);
  if (matchMedia('(max-width: 520px)').matches) {
    $('.modal-close', modal).focus({ preventScroll: true });
  } else {
    first?.focus();
  }
  return { backdrop, modal, close };
}

export function confirmModal(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    let decided = false;
    const m = openModal({
      title,
      body: `<p style="padding-bottom:8px">${esc(message)}</p>`,
      footer: `
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn btn-primary${danger ? ' btn-danger' : ''}" data-yes type="button">${esc(confirmLabel)}</button>`,
      onClose: () => { if (!decided) resolve(false); },
    });
    $('[data-yes]', m.modal).addEventListener('click', () => {
      decided = true;
      m.close();
      resolve(true);
    });
  });
}
