// Server-rendered printable documents: invoice and delivery note.
// Each is a standalone A4-styled HTML page (no SPA chrome) that opens the
// print dialog on load, except a form with signature boxes on a touch screen,
// which opens ready to sign. All user-entered text is escaped here, server-side.
import { AppError, addDays, daysBetween, db, docNo, getSettings, harvestLinesByGrn, harvestLinesFor, shipmentLanding } from './db.mjs';
import { SIGN_FORMS, signaturesFor } from './signatures.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// For plain local YYYY-MM-DD fields (delivery_date, expires_at).
function fmtDate(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
// For full timestamps (created_at is stored as UTC ISO): format the LOCAL
// calendar date — string-slicing would print the UTC day, one day early for
// orders placed 00:00–04:59 Maldives time.
function fmtTimestampDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return fmtDate(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function mvr(laari) {
  const v = laari / 100;
  const sign = v < 0 ? '−' : '';
  return sign + 'MVR ' + Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// Full stored precision (3 decimals): on a financial document the printed
// qty × unit price must reconcile with the printed amount.
const fmtQty = (q, unit) =>
  (+q).toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' ' + unit;

function getBundle(orderId) {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
  if (!order) throw new AppError(404, 'Order not found');
  const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(order.customer_id);
  const items = db.prepare(
    `SELECT oi.*, pr.name product, pr.unit, pr.code FROM order_items oi
     JOIN products pr ON pr.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id`
  ).all(orderId).map(it => ({
    ...it,
    lots: db.prepare(
      `SELECT l.id lot_id, l.expires_at, a.qty FROM allocations a
       JOIN lots l ON l.id = a.lot_id WHERE a.order_item_id = ? ORDER BY l.expires_at`
    ).all(it.id),
  }));
  const paid = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) p FROM payments WHERE order_id = ?`).get(orderId).p;
  return { order, customer, items, paid };
}

function shell({ title, body, sheetClass = 'note-sheet', sign = null }) {
  const signAttrs = sign
    ? ` data-sign-doc="${sign.doc}" data-sign-id="${sign.id}" data-sign-form="${esc(sign.form.name)}" data-sign-ref="${esc(sign.ref)}"`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #14211c; margin: 0; background: #e7ece9; }
  .toolbar { max-width: 820px; margin: 18px auto 0; display: flex; justify-content: flex-end; align-items: center; gap: 10px; }
  .toolbar button { font: inherit; font-weight: 650; padding: 8px 16px; border: 0; border-radius: 8px; background: #0d6b4a; color: #fff; cursor: pointer; }
  .toolbar button:hover { background: #0b5a3e; }
  .toolbar .tb-back { margin-right: auto; background: #fff; color: #0d6b4a; box-shadow: inset 0 0 0 1px #c3d3ca; }
  .toolbar .tb-back:hover { background: #f2f7f4; }
  .toolbar .tb-hint { flex: 1; margin: 0; color: #4f5d57; font-size: 13px; }
  .esig { display: block; }
  .esig svg { display: block; width: 100%; height: 28px; overflow: visible; }
  .esig path { fill: none; stroke: #1b2f6e; stroke-width: 1.8px; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .esig small { display: block; margin-top: 1px; font-size: 8px; line-height: 1.25; color: #4f5d57; font-weight: 400; letter-spacing: 0; text-transform: none; overflow-wrap: anywhere; }
  @media (max-width: 860px) { .toolbar { padding: 0 12px; } }
  .sheet { max-width: 820px; margin: 12px auto 40px; background: #fff; padding: 40px 44px 36px; box-shadow: 0 8px 28px rgba(12, 40, 28, 0.08); }
  .note-sheet header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; border-bottom: 2px solid #14211c; padding-bottom: 16px; }
  .note-sheet .biz h1 { font-size: 20px; margin: 0 0 5px; letter-spacing: -0.01em; }
  .note-sheet .biz p { margin: 0; color: #5e6d66; white-space: pre-line; }
  .note-sheet .doc { text-align: right; flex-shrink: 0; }
  .note-sheet .doc h2 { margin: 0 0 2px; font-size: 23px; letter-spacing: 0.08em; }
  .note-sheet .doc p { margin: 2px 0 0; color: #5e6d66; }
  .note-sheet .due-line { margin-top: 6px; font-weight: 700; }
  .note-sheet .meta { display: flex; justify-content: space-between; gap: 30px; margin: 24px 0 18px; }
  .note-sheet .meta h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #5e6d66; margin: 0 0 5px; font-weight: 650; }
  .note-sheet .meta p { margin: 0 0 2px; }
  .note-sheet .meta .kv { display: grid; grid-template-columns: auto auto; gap: 2px 18px; text-align: left; }
  .note-sheet .meta .kv span { color: #5e6d66; }
  .note-sheet .meta .kv b { font-weight: 600; text-align: right; }
  .note-sheet table { width: 100%; border-collapse: collapse; }
  .note-sheet th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #5e6d66; font-weight: 650; border-bottom: 1.5px solid #14211c; padding: 8px 10px; }
  .note-sheet td { padding: 9px 10px; border-bottom: 1px solid #e3ebe6; vertical-align: top; }
  .note-sheet td .sub { display: block; font-size: 12px; color: #5e6d66; }
  .note-sheet .num, .note-sheet th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .note-sheet .totals { width: 280px; margin: 12px 0 0 auto; }
  .note-sheet .totals .row { display: flex; justify-content: space-between; padding: 5px 10px; }
  .note-sheet .totals .row.due { border-top: 2px solid #14211c; margin-top: 4px; padding-top: 10px; font-weight: 700; font-size: 15px; }
  .note-sheet .note { margin-top: 30px; border-top: 1px solid #e3ebe6; padding-top: 12px; color: #5e6d66; }
  .note-sheet .sig { display: flex; gap: 44px; margin-top: 8px; }
  .note-sheet .sig > div { flex: 1; font-size: 12px; color: #5e6d66; }
  .dn-pen { display: flex; flex-direction: column; justify-content: flex-end; height: 56px; margin-bottom: 6px; padding-bottom: 3px; border-bottom: 1px solid #14211c; color: #14211c; }
  .dn-pen .esig svg { height: 32px; }
  .tick { display: inline-block; width: 15px; height: 15px; border: 1.5px solid #5e6d66; border-radius: 3px; }
  .invoice { color: #14211c; }
  .inv-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 32px; }
  .inv-brand { min-width: 0; }
  .inv-logo { display: block; height: 64px; width: auto; }
  .inv-name { margin: 8px 0 0; font-size: 13px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; }
  .inv-address { margin: 6px 0 0; color: #5e6d66; white-space: pre-line; }
  .inv-contact { margin: 2px 0 0; color: #5e6d66; }
  .inv-id { text-align: right; flex-shrink: 0; }
  .inv-kicker { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #0d6b4a; }
  .inv-no { margin: 2px 0 0; font-size: 22px; line-height: 1.15; font-weight: 700; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .inv-date { margin: 4px 0 0; color: #5e6d66; }
  .inv-balance { margin-top: 12px; }
  .inv-balance b { display: block; font-size: 20px; line-height: 1.2; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .inv-balance span { color: #5e6d66; font-size: 12px; }
  .inv-balance.paid b { color: #0d6b4a; }
  .inv-parties { display: grid; grid-template-columns: 1.3fr 1fr; gap: 24px; margin: 28px 0 8px; padding-top: 20px; border-top: 1px solid #e3ebe6; }
  .inv-parties h3, .inv-terms h3 { margin: 0 0 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #5e6d66; }
  .inv-parties p { margin: 0; }
  .inv-parties .who { font-weight: 700; }
  .inv-parties .muted, .inv-fine { color: #5e6d66; }
  .inv-parties > div:last-child { justify-self: end; }
  .inv-facts { display: grid; grid-template-columns: auto auto; gap: 4px 16px; }
  .inv-facts span { color: #5e6d66; }
  .inv-facts b { font-weight: 650; text-align: right; font-variant-numeric: tabular-nums; }
  .invoice table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  .invoice th { text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #5e6d66; padding: 8px 16px 8px 0; border-bottom: 1.5px solid #14211c; }
  .invoice td { padding: 10px 16px 10px 0; border-bottom: 1px solid #e3ebe6; vertical-align: top; }
  .invoice th:last-child, .invoice td:last-child { padding-right: 0; }
  .invoice .num, .invoice th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; width: 1%; }
  .invoice .code, .invoice .unit { white-space: nowrap; width: 1%; }
  .invoice .code { color: #5e6d66; font-variant-numeric: tabular-nums; }
  .inv-foot { display: flex; justify-content: flex-end; margin-top: 8px; }
  .inv-totals { width: min(280px, 100%); }
  .inv-totals .row { display: flex; justify-content: space-between; gap: 24px; padding: 4px 0; color: #5e6d66; }
  .inv-totals .row b { color: #14211c; font-weight: 650; font-variant-numeric: tabular-nums; }
  .inv-totals .due { margin-top: 6px; padding-top: 10px; border-top: 1.5px solid #14211c; color: #14211c; font-weight: 700; font-size: 16px; }
  .inv-totals .due b { font-size: 16px; }
  .inv-banner { margin-top: 20px; color: #5e6d66; }
  .inv-terms { margin-top: 28px; padding-top: 16px; border-top: 1px solid #e3ebe6; }
  .inv-terms ol { margin: 0; padding-left: 18px; color: #5e6d66; }
  .inv-terms li { margin: 2px 0; }
  .inv-terms p { margin: 8px 0 0; }
  .inv-sign { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 28px; margin-top: 36px; }
  .inv-sign h3 { margin: 0 0 12px; font-size: 12px; font-weight: 700; }
  .inv-sign p { display: grid; grid-template-columns: 42px 1fr; gap: 8px; align-items: end; margin: 0 0 10px; color: #5e6d66; font-size: 12px; }
  .inv-sign i { display: block; border-bottom: 1px solid #14211c; height: 18px; font-style: normal; color: #14211c; }
  .inv-sign i.inked { height: auto; padding-bottom: 2px; }
  .inv-sign .esig svg { height: 30px; }
  .boat-sheet { font-size: 11px; line-height: 1.3; color: #111; }
  .sheet.boat-sheet { padding: 16px 18px 18px; }
  .boat-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 8px; }
  .boat-brand { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
  .boat-logo { height: 48px; width: auto; flex-shrink: 0; }
  .boat-brand h1 { margin: 0; font-size: 12px; line-height: 1.25; font-weight: 700; }
  .boat-brand p { margin: 1px 0 0; font-size: 10px; line-height: 1.35; white-space: pre-line; }
  .boat-title { margin: 4px 0 0; font-size: 22px; letter-spacing: 0.06em; font-weight: 800; }
  .boat-sheet table { width: 100%; border-collapse: collapse; margin: 0 0 8px; }
  .boat-sheet th, .boat-sheet td { border: 1px solid #111; padding: 2px 5px; vertical-align: middle; font-weight: 400; text-transform: none; letter-spacing: 0; color: #111; font-size: 11px; }
  .boat-sheet th { font-weight: 700; text-align: left; background: #f3f3f3; }
  .boat-sheet .lbl { font-weight: 700; white-space: nowrap; width: 1%; }
  .boat-sheet .num { text-align: center; width: 28px; }
  .boat-sheet .pack { text-align: center; width: 88px; }
  .boat-sheet .qty { text-align: center; width: 72px; }
  .boat-sheet .dest { width: 90px; }
  .boat-signs { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; break-inside: avoid; page-break-inside: avoid; }
  .boat-signs table { margin: 0; }
  .boat-signs .sig { height: 26px; }
  .boat-signs .esig svg { height: 22px; }
  .boat-signs .good { font-size: 10px; }
  .receipt-sheet { font-size: 12px; line-height: 1.3; color: #111; }
  .sheet.receipt-sheet { padding: 18px 20px 20px; }
  .ir-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 16px; }
  .ir-brand { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
  .ir-logo { height: 48px; width: auto; flex-shrink: 0; }
  .ir-brand p { margin: 0; font-size: 12px; line-height: 1.35; white-space: pre-line; }
  .ir-brand p + p { margin-top: 2px; }
  .ir-id { width: 280px; flex-shrink: 0; }
  .ir-id h2 { margin: 0 0 8px; text-align: right; font-size: 22px; font-weight: 800; letter-spacing: 0; }
  .receipt-sheet table { width: 100%; border-collapse: collapse; margin: 0; }
  .receipt-sheet th, .receipt-sheet td { border: 1px solid #111; padding: 4px 6px; vertical-align: top; font-weight: 400; text-transform: none; letter-spacing: 0; color: #111; font-size: 12px; text-align: left; }
  .receipt-sheet th { font-weight: 700; background: #ececec; }
  .ir-id td, .ir-id th { text-align: center; }
  .ir-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin: 8px 0 18px; }
  .ir-meta td { height: 88px; white-space: pre-line; }
  .ir-items tbody td { height: 22px; }
  .ir-items h3 { margin: 0 0 6px; font-size: 16px; }
  .receipt-sheet .num { text-align: center; width: 70px; }
  .receipt-sheet .um { text-align: center; width: 48px; }
  .receipt-sheet .code { width: 72px; }
  .ir-note { margin: 10px 0; font-size: 12px; }
  .ir-note p { margin: 0; }
  .ir-sign { margin-top: 6px; break-inside: avoid; page-break-inside: avoid; }
  .ir-sign .lbl { font-weight: 700; width: 1%; white-space: nowrap; }
  .ir-sign .sig { height: 46px; }
  .ir-sign .esig svg { height: 34px; }
  .harvest-sheet { font-size: 11px; color: #111; }
  .sheet.harvest-sheet { padding: 16px 18px 18px; }
  .hv-head, .pq-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 10px; }
  .hv-brand, .pq-brand { display: flex; gap: 10px; align-items: flex-start; }
  .hv-logo, .pq-logo { height: 52px; width: auto; }
  .hv-brand h1, .pq-brand h1 { margin: 0; font-size: 13px; line-height: 1.25; }
  .hv-brand p, .pq-brand p { margin: 1px 0 0; font-size: 11px; white-space: pre-line; }
  .hv-title { margin: 2px 0 10px; text-align: center; font-size: 16px; letter-spacing: 0.04em; }
  .harvest-sheet table, .pq-sheet table { width: 100%; border-collapse: collapse; margin: 0 0 10px; }
  .harvest-sheet th, .harvest-sheet td, .pq-sheet th, .pq-sheet td { border: 1px solid #111; padding: 4px 6px; vertical-align: top; font-weight: 400; text-transform: none; letter-spacing: 0; color: #111; font-size: 11px; text-align: left; }
  .harvest-sheet th, .pq-sheet th { background: #1f7a34; color: #fff; font-weight: 700; }
  .harvest-sheet .lbl, .pq-sheet .lbl { font-weight: 700; width: 1%; white-space: nowrap; background: #fff; color: #111; }
  .hv-sign { height: 42px; }
  .pq-sheet { font-size: 12px; color: #111; }
  .sheet.pq-sheet { padding: 16px 18px 18px; }
  .pq-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; margin-bottom: 12px; }
  .pq-title { margin: 8px 0 8px; text-align: right; font-size: 18px; letter-spacing: 0.03em; }
  .pq-meta { width: 320px; margin-left: auto; }
  .pq-total { margin: 8px 0 16px; text-align: right; font-weight: 700; }
  .pq-sign { height: 36px; width: 280px; margin-left: auto; }
  .harvest-sheet { page: receipt; }
  .pq-sheet { page: receipt; }
  .lh-sheet { color: #14211c; }
  .lh-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .lh-logo { display: block; height: 56px; width: auto; }
  .lh-name { margin: 8px 0 0; font-size: 14px; line-height: 1.3; font-weight: 650; }
  .lh-address { margin: 4px 0 0; color: #5e6d66; white-space: pre-line; font-size: 13px; }
  .lh-id { text-align: right; flex-shrink: 0; }
  .lh-kicker { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #0d6b4a; }
  .lh-title { margin: 2px 0 0; font-size: 26px; line-height: 1.1; letter-spacing: -0.03em; }
  .lh-ref { margin: 6px 0 0; font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .lh-date { margin: 2px 0 0; color: #5e6d66; }
  .lh-for { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 22px 0 0; padding-top: 16px; border-top: 1px solid #e3ebe6; }
  .lh-for span { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #5e6d66; }
  .lh-for b { font-weight: 650; }
  .lh-sheet table { width: 100%; border-collapse: collapse; margin-top: 18px; }
  .lh-sheet th { text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #5e6d66; padding: 8px 12px 8px 0; border-bottom: 1.5px solid #14211c; }
  .lh-sheet td { padding: 10px 12px 10px 0; border-bottom: 1px solid #e3ebe6; vertical-align: top; }
  .lh-sheet th:last-child, .lh-sheet td:last-child { padding-right: 0; }
  .lh-sheet td.num, .lh-sheet th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; width: 1%; padding-left: 28px; }
  .lh-unit { display: block; margin-top: 2px; font-size: 10px; font-weight: 500; letter-spacing: 0; text-transform: none; color: #5e6d66; }
  .lh-sum td { border-bottom: 0; padding-top: 12px; font-weight: 700; font-size: 16px; }
  .lh-why { margin: 18px 0 0; }
  .lh-why span { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #5e6d66; }
  .lh-signs { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 28px 32px; margin-top: 36px; }
  .lh-sign h3 { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #5e6d66; }
  .lh-sign b { display: block; min-height: 1.2em; }
  .lh-sign p { margin: 2px 0 0; min-height: 1.2em; color: #5e6d66; font-size: 13px; }
  .lh-pen { display: flex; flex-direction: column; justify-content: flex-end; min-height: 32px; padding-bottom: 3px; }
  .lh-line { border-top: 1px solid #14211c; padding-top: 4px; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: #5e6d66; }
  .lh-sheet { page: receipt; }
  .loss-sheet { color: #111; font-size: 11px; line-height: 1.3; }
  .sheet.loss-sheet { max-width: 980px; padding: 22px 24px 28px; }
  .loss-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .loss-brand { min-width: 0; }
  .loss-name { margin: 0; font-size: 13px; font-weight: 700; }
  .loss-brand p { margin: 1px 0 0; white-space: pre-line; }
  .loss-logo { height: 52px; width: auto; flex-shrink: 0; }
  .loss-title { margin: 8px 0 0; text-align: center; font-size: 20px; letter-spacing: 0.04em; text-decoration: underline; text-underline-offset: 3px; }
  .loss-meta { width: 240px; margin: 8px 0 10px auto; }
  .loss-meta div { display: flex; justify-content: space-between; gap: 12px; }
  .loss-meta span { color: #333; }
  .loss-sheet table { width: 100%; border-collapse: collapse; margin: 0; }
  .loss-sheet th, .loss-sheet td { border: 1px solid #111; padding: 3px 5px; vertical-align: middle; font-weight: 400; text-transform: none; letter-spacing: 0; color: #111; font-size: 10px; text-align: left; }
  .loss-sheet th { font-weight: 700; background: #f3f3f3; }
  .loss-sheet td.num, .loss-sheet th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .loss-sheet td.ctr, .loss-sheet th.ctr { text-align: center; }
  .loss-sheet tr.pad td { height: 22px; }
  .loss-sheet tr.sum td { font-weight: 700; background: #f3f3f3; }
  .loss-remarks { margin: 10px 0 0; }
  .loss-signs { display: grid; grid-template-columns: 1fr 1fr 1fr 1.15fr; gap: 16px; margin-top: 22px; break-inside: avoid; page-break-inside: avoid; }
  .loss-signs h3 { margin: 0 0 8px; font-size: 11px; }
  .loss-signs p { display: grid; grid-template-columns: 64px 1fr; gap: 8px; align-items: end; margin: 0 0 10px; font-size: 11px; }
  .loss-signs i { display: block; border-bottom: 1px solid #111; height: 16px; font-style: normal; }
  .loss-signs i.inked { height: auto; padding-bottom: 2px; }
  .loss-signs .esig svg { height: 26px; }
  .loss-sheet { page: receipt; }
  .itn-sheet { color: #111; font-size: 12px; line-height: 1.4; }
  .sheet.itn-sheet { max-width: 820px; }
  .itn-title { margin: 0 0 22px; text-align: center; font-size: 18px; font-weight: 650; letter-spacing: 0; }
  .itn-head { display: grid; grid-template-columns: 1fr 1.2fr; gap: 6px 32px; }
  .itn-head p, .itn-memo { margin: 0; display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .itn-head span, .itn-memo span { color: #333; }
  .itn-memo { margin-top: 10px; }
  .itn-sheet table { width: 100%; border-collapse: collapse; margin-top: 18px; }
  .itn-sheet th, .itn-sheet td { border: 0; border-bottom: 1px solid #111; padding: 5px 10px 5px 0; text-align: left; font-size: 12px; font-weight: 400; text-transform: none; letter-spacing: 0; color: #111; vertical-align: bottom; }
  .itn-sheet th { font-weight: 650; }
  .itn-sheet td.num, .itn-sheet th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .itn-page { margin-top: 64px; text-align: center; color: #333; }
  .itn-sheet { page: receipt; }
  @page { size: A4; margin: 15mm; }
  @page boat { size: A4; margin: 10mm; }
  @page receipt { size: A4; margin: 12mm; }
  .boat-sheet { page: boat; }
  .receipt-sheet { page: receipt; }
  tr, .totals, .sig, .note, .inv-sign, .inv-terms, .inv-totals { break-inside: avoid; page-break-inside: avoid; }
  @media screen and (max-width: 640px) {
    .loss-signs { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
    .boat-signs { grid-template-columns: 1fr; }
    .lh-signs, .inv-sign { grid-template-columns: 1fr 1fr; }
  }
  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    .sheet, .sheet.boat-sheet, .sheet.receipt-sheet, .sheet.harvest-sheet, .sheet.pq-sheet, .sheet.lh-sheet, .sheet.loss-sheet, .sheet.itn-sheet { max-width: none; margin: 0; padding: 0; box-shadow: none; }
  }
</style>
${sign ? '<link rel="stylesheet" href="/sign.css">' : ''}
</head>
<body>
<div class="toolbar">
  <button type="button" class="tb-back" data-back hidden>Back</button>
  ${sign ? '<p class="tb-hint" data-sign-hint hidden>Tap a “Sign here” box to sign.</p>' : ''}
  <button type="button" onclick="window.print()">Print</button>
</div>
<div class="sheet ${sheetClass}"${signAttrs}>${body}</div>
<script>
{
  const back = document.querySelector('[data-back]');
  if (history.length > 1) {
    back.hidden = false;
    back.addEventListener('click', () => history.back());
  }
  // Signing happens on a phone or tablet, and the page reloads after each
  // signature; neither should pop the print dialog over the form.
  const signing = document.querySelector('[data-sign]')
    && (new URLSearchParams(location.search).has('sign') || matchMedia('(pointer: coarse)').matches);
  if (!signing) addEventListener('load', () => {
    const pending = [...document.images].filter(img => !img.complete);
    const ready = pending.length
      ? Promise.all(pending.map(img => new Promise(r => { img.onload = img.onerror = r; })))
      : Promise.resolve();
    ready.then(() => setTimeout(() => window.print(), 200));
  });
}
</script>
${sign ? '<script type="module" src="/sign.js"></script>' : ''}
</body>
</html>`;
}

// The signatures already on a form, and what the page needs to take more.
function signBook(doc, id, ref) {
  return { doc, id, ref, form: SIGN_FORMS[doc], sigs: signaturesFor(doc, id) };
}

function signedStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

function signedDate(iso, sep) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return [String(d.getDate()).padStart(2, '0'), String(d.getMonth() + 1).padStart(2, '0'), d.getFullYear()].join(sep);
}

// One box a person signs. `name` is who the paperwork already says signs
// here; the caption names the signer only when someone else signed.
function signSpot(sign, slot, name = '') {
  const s = sign.sigs.get(slot) || null;
  const when = s ? signedStamp(s.signed_at) : '';
  const fold = v => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const other = s && fold(s.signer_name) !== fold(name) ? s.signer_name : '';
  const caption = !s ? '' : other ? `${other} · ${when}` : when;
  const locked = (sign.doc === 'item-receipt' && slot === 'verified') || (sign.doc === 'harvest-grn' && slot === 'regional') || (sign.doc === 'price-enquiry' && slot === 'approved');
  const attrs = locked ? '' : ` data-sign="${slot}" data-sign-label="${esc(sign.form.slots[slot])}" data-sign-name="${esc(name)}"`
    + (sign.doc === 'price-enquiry' && slot === 'approved' ? ' data-sign-name-locked="true"' : '')
    + (s ? ` data-signed="${s.id}" data-signed-by="${esc(s.signer_name)}" data-signed-at="${esc(when)}"` : '');
  const pen = (text = '') => s ? `<span class="esig">${s.svg}${text ? `<small>${esc(text)}</small>` : ''}</span>` : '';
  return { s, attrs, when, caption, other, who: s ? s.signer_name : '', pen };
}

function bizHeader(s, docHtml) {
  const contact = [s.biz_phone, s.biz_email].filter(Boolean).join(' · ');
  return `<header>
    <div class="biz">
      <h1>${esc(s.biz_name)}</h1>
      <p>${esc(s.biz_address)}</p>
      ${contact ? `<p>${esc(contact)}</p>` : ''}
      ${s.biz_tin ? `<p>TIN: ${esc(s.biz_tin)}</p>` : ''}
    </div>
    <div class="doc">${docHtml}</div>
  </header>`;
}

function customerBlock(title, c) {
  return `<div>
    <h3>${title}</h3>
    <p><b>${esc(c.name)}</b></p>
    ${c.island ? `<p>${esc(c.island)}</p>` : ''}
    ${c.contact ? `<p>${esc(c.contact)}</p>` : ''}
    ${c.phone ? `<p>${esc(c.phone)}</p>` : ''}
  </div>`;
}

const QTY = q => (+q).toLocaleString('en-US', { maximumFractionDigits: 3 });

function party(title, c) {
  const lines = [c.island, c.contact, c.phone].filter(Boolean).map(v => `<p class="muted">${esc(v)}</p>`).join('');
  return `<div>
    <h3>${title}</h3>
    <p class="who">${esc(c.name)}</p>
    ${lines}
  </div>`;
}

export function renderInvoice(orderId) {
  const { order, customer, items, paid } = getBundle(orderId);
  if (order.status === 'cancelled') throw new AppError(400, 'This order was cancelled — no invoice exists.');
  // A pending order gets a pro forma: same document, clearly labeled as
  // issued before delivery. It keeps the same number the final invoice will carry.
  const proForma = order.status === 'pending';

  const s = getSettings();
  const no = docNo('INV', order.id);
  const due = addDays(order.delivery_date, customer.terms_days);
  const balance = order.total - paid;
  const gstRate = Number.parseFloat(s.gst_rate) || 0;
  const gst = s.biz_tin && gstRate > 0
    ? Math.round(order.total * gstRate / (100 + gstRate))
    : null;
  const contact = [s.biz_phone, s.biz_email].filter(Boolean).join(' · ');
  const terms = String(s.invoice_terms || '').split('\n').map(t => t.trim()).filter(Boolean);
  const settled = balance <= 0;
  const sign = signBook('invoice', order.id, no);

  const body = `
    <div class="inv-top">
      <div class="inv-brand">
        <img class="inv-logo" src="/agro-national-logo.png" alt="">
        <h1 class="inv-name">${esc(s.biz_name)}</h1>
        ${s.biz_address ? `<p class="inv-address">${esc(s.biz_address)}</p>` : ''}
        ${contact ? `<p class="inv-contact">${esc(contact)}</p>` : ''}
        ${s.biz_tin ? `<p class="inv-contact">TIN ${esc(s.biz_tin)}</p>` : ''}
      </div>
      <div class="inv-id">
        <p class="inv-kicker">${proForma ? 'Pro forma' : 'Tax invoice'}</p>
        <p class="inv-no">${esc(no)}</p>
        <p class="inv-date">${fmtDate(order.delivery_date)}</p>
        <div class="inv-balance${settled ? ' paid' : ''}">
          <b>${settled ? 'Paid' : mvr(balance)}</b>
          <span>${settled ? 'Nothing outstanding' : `Due ${fmtDate(due)}`}</span>
        </div>
      </div>
    </div>
    <div class="inv-parties">
      ${party(proForma ? 'Customer' : 'Bill to', customer)}
      <div>
        <h3>Details</h3>
        <div class="inv-facts">
          <span>${proForma ? 'Delivery' : 'Delivered'}</span><b>${fmtDate(order.delivery_date)}</b>
          <span>Terms</span><b>${customer.terms_days} day${customer.terms_days === 1 ? '' : 's'}</b>
          <span>Due</span><b>${fmtDate(due)}</b>
          <span>Order</span><b>#${order.id}</b>
        </div>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Code</th>
          <th>Description</th>
          <th class="num">Qty</th>
          <th class="unit">Unit</th>
          <th class="num">Rate</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(it => `
          <tr>
            <td class="code">${it.code ? esc(it.code) : '—'}</td>
            <td>${esc(it.product)}</td>
            <td class="num">${QTY(it.qty)}</td>
            <td class="unit">${esc(it.unit)}</td>
            <td class="num">${mvr(it.unit_price)}</td>
            <td class="num">${mvr(it.line_total)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="inv-foot">
      <div class="inv-totals">
        ${gst !== null ? `
          <div class="row"><span>Excl. GST</span><b>${mvr(order.total - gst)}</b></div>
          <div class="row"><span>GST ${esc(String(gstRate))}%</span><b>${mvr(gst)}</b></div>` : ''}
        <div class="row"><span>Total</span><b>${mvr(order.total)}</b></div>
        ${paid > 0 ? `<div class="row"><span>Paid</span><b>− ${mvr(paid)}</b></div>` : ''}
        <div class="row due"><span>Balance due</span><b>${mvr(balance)}</b></div>
      </div>
    </div>
    ${gst !== null ? `<p class="inv-fine">Line rates include GST. The tax above is the ${esc(String(gstRate))}% included in the total.</p>` : ''}
    ${proForma ? `<p class="inv-banner">Pro forma, issued before delivery. This is not a tax invoice. The final invoice keeps this number.</p>` : ''}
    ${order.notes ? `<div class="inv-terms"><h3>Notes</h3><p>${esc(order.notes)}</p></div>` : ''}
    ${terms.length || s.invoice_note ? `<div class="inv-terms">
      ${terms.length ? `<h3>Terms</h3><ol>${terms.map(t => `<li>${esc(t)}</li>`).join('')}</ol>` : ''}
      ${s.invoice_note ? `<p>${esc(s.invoice_note)}</p>` : ''}
    </div>` : ''}
    <div class="inv-sign">
      ${['issued', 'delivered', 'received'].map(slot => {
        const spot = signSpot(sign, slot);
        return `
        <div${spot.attrs}>
          <h3>${sign.form.slots[slot]}</h3>
          <p>Name <i>${esc(spot.who)}</i></p>
          <p>Sign <i data-ink${spot.s ? ' class="inked"' : ''}>${spot.pen()}</i></p>
          <p>Date <i>${spot.s ? signedDate(spot.s.signed_at, '/') : ''}</i></p>
        </div>`;
      }).join('')}
    </div>`;

  return shell({
    title: `${no}${proForma ? ' (pro forma)' : ''} · ${s.biz_name}`,
    body,
    sheetClass: 'invoice',
    sign,
  });
}

export function renderDeliveryNote(orderId) {
  const { order, customer, items } = getBundle(orderId);
  if (order.status === 'cancelled') throw new AppError(400, 'This order was cancelled — no delivery note exists.');

  const s = getSettings();
  const no = docNo('DN', order.id);
  const sign = signBook('delivery-note', order.id, no);
  const delivered = signSpot(sign, 'delivered');
  const received = signSpot(sign, 'received');

  const body = `
    ${bizHeader(s, `
      <h2>DELIVERY NOTE</h2>
      <p>${no}</p>
      <p>${fmtDate(order.delivery_date)}</p>
    `)}
    <div class="meta">
      ${customerBlock('Deliver to', customer)}
      <div>
        <h3>Details</h3>
        <div class="kv">
          <span>Order</span><b>#${order.id}</b>
          <span>Placed</span><b>${fmtTimestampDate(order.created_at)}</b>
          <span>Delivery</span><b>${fmtDate(order.delivery_date)}</b>
          <span>Lines</span><b>${items.length}</b>
        </div>
      </div>
    </div>
    <table>
      <thead><tr><th>Item</th><th>Lot · best before</th><th class="num">Qty</th><th class="num">Received</th></tr></thead>
      <tbody>
        ${items.map(it => `
          <tr>
            <td>${esc(it.product)}</td>
            <td>${it.lots.length
              ? it.lots.map(l =>
                  `#${l.lot_id} · ${fmtDate(l.expires_at)}${it.lots.length > 1 ? ` · ${fmtQty(l.qty, esc(it.unit))}` : ''}`
                ).join('<br>')
              : '—'}</td>
            <td class="num">${fmtQty(it.qty, esc(it.unit))}</td>
            <td class="num"><span class="tick"></span></td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${order.notes ? `<div class="note">Order notes: ${esc(order.notes)}</div>` : ''}
    <div class="note">Please check quantities and freshness on receipt. Claims are accepted within 24 hours of delivery.</div>
    <div class="sig">
      <div${delivered.attrs}><span class="dn-pen" data-ink>${delivered.pen(delivered.who)}</span>Delivered by (name &amp; signature)</div>
      <div${received.attrs}><span class="dn-pen" data-ink>${received.pen(received.who)}</span>Received by (name &amp; signature)</div>
      <div><span class="dn-pen">${esc(received.when)}</span>Date &amp; time</div>
    </div>`;

  return shell({ title: `${no} · ${s.biz_name}`, body, sign });
}

function paperDate(iso, sep) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!y || !m || !d) return '';
  return `${d}${sep}${m}${sep}${y}`;
}

function paperQty(q, unit) {
  const n = Number(q);
  if (!Number.isFinite(n) || n === 0) return '';
  const num = String(Math.round(n * 1000) / 1000);
  return unit ? `${num} ${esc(unit)}` : num;
}

function signBox(title, person, spot) {
  const row = (label, value) => `<tr><td class="lbl">${label}</td><td>${esc(value || '')}</td></tr>`;
  return `<table>
    <tr><th colspan="2">${title}</th></tr>
    ${row('Name', person.name)}
    ${row('Designation', person.role)}
    ${row('Contact No', person.phone)}
    ${row('Date', person.date)}
    <tr><td class="lbl">Signature</td><td class="sig"${spot.attrs}>${spot.pen(spot.other)}</td></tr>
    <tr><td colspan="2" class="good">Received in good condition</td></tr>
  </table>`;
}

function packLabel(n, unit) {
  const names = { bunch: ['bunch', 'bunches'], box: ['box', 'boxes'], sack: ['sack', 'sacks'], basket: ['basket', 'baskets'] };
  const pair = names[unit];
  if (!pair || !(Number(n) > 0)) return '';
  return `${paperNum(n)} ${Number(n) === 1 ? pair[0] : pair[1]}`;
}

function gradeTravel(g) {
  if (g.pack_unit === 'bunch' || g.pack_unit === 'box' || g.pack_unit === 'sack' || g.pack_unit === 'basket') return g.pack_unit;
  if (Number(g.bunches) > 0 && !(Number(g.pack_count) > 0)) return 'bunch';
  if (Number(g.pack_count) > 0) return 'box';
  return '';
}

// Same crop, one line. Harvest GRN refs sit in the blank rows at the bottom,
// with that GRN's kilograms written beside the reference.
function boatPaperRows(shipment, savedLines) {
  const harvest = harvestLinesFor(shipment.id);
  if (!harvest.length) {
    return {
      crops: savedLines.map(l => ({
        description: l.description || l.product || '',
        packing: l.packing || '',
        qty: l.qty,
        unit: l.unit || '',
        destination: l.destination || '',
      })),
      refs: [],
    };
  }
  const crops = new Map();
  const grns = new Map();
  for (const line of harvest) {
    const key = line.product_id || String(line.product || line.description || 'Crop').toLowerCase();
    if (!crops.has(key)) crops.set(key, { name: line.description || line.product || 'Crop', kg: 0, bunch: 0, box: 0, sack: 0, basket: 0 });
    const crop = crops.get(key);
    crop.kg += Number(line.undamaged_kg) || 0;
    let fromGrades = false;
    for (const grade of line.grades || []) {
      const unit = gradeTravel(grade);
      if (!unit) continue;
      const n = unit === 'bunch' ? Number(grade.bunches) || 0 : Number(grade.pack_count) || 0;
      if (!(n > 0)) continue;
      crop[unit] += n;
      fromGrades = true;
    }
    if (!fromGrades && Number(line.bunches) > 0) crop.bunch += Number(line.bunches);
    if (line.harvest_ref) {
      const id = line.harvest_grn_id || line.harvest_ref;
      if (!grns.has(id)) grns.set(id, { ref: line.harvest_ref, kg: 0 });
      grns.get(id).kg += Number(line.undamaged_kg) || 0;
    }
  }
  const dest = shipment.destination || savedLines.find(l => l.destination)?.destination || '';
  const cropRows = [...crops.values()].map(crop => {
    const packing = ['bunch', 'box', 'sack', 'basket'].map(unit => packLabel(crop[unit], unit)).filter(Boolean).join(', ');
    return { description: crop.name, packing, qty: Math.round(crop.kg * 1000) / 1000, unit: 'kg', destination: dest };
  });
  const refs = [...grns.values()].map(grn => ({
    description: `${grn.ref} - ${paperNum(grn.kg)} kg`,
    packing: '',
    qty: '',
    unit: '',
    destination: '',
  }));
  return { crops: cropRows, refs };
}

export function renderBoatNote(shipmentId) {
  const s = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(shipmentId);
  if (!s) throw new AppError(404, 'Boat note not found');
  const lines = db.prepare(
    `SELECT sl.*, pr.name AS product, pr.unit
     FROM shipment_lines sl
     LEFT JOIN products pr ON pr.id = sl.product_id
     WHERE sl.shipment_id = ?
     ORDER BY sl.line_no, sl.id`
  ).all(shipmentId);
  if (!lines.length) throw new AppError(400, 'This shipment has no boat note to print');
  const paper = boatPaperRows(s, lines);
  const biz = getSettings();
  const name = biz.biz_name || 'agro-OPS';
  const address = biz.biz_address || '';
  const phone = biz.biz_phone ? `Phone: ${biz.biz_phone}` : '';
  const bnRef = s.enquiry_ref || s.reference;
  const loaded = s.loaded_at || s.arrived_at;
  const signed = paperDate(loaded, '-');
  const sign = signBook('boat-note', s.id, bnRef);
  const count = Math.max(paper.crops.length + paper.refs.length, 23);
  const slots = [
    ...paper.crops,
    ...Array(count - paper.crops.length - paper.refs.length).fill(null),
    ...paper.refs,
  ];
  const rows = [];
  for (let i = 0; i < count; i++) {
    const l = slots[i];
    rows.push(`<tr>
      <td class="num">${i + 1}</td>
      <td>${l ? esc(l.description) : ''}</td>
      <td class="pack">${l ? esc(l.packing) : ''}</td>
      <td class="qty">${l ? paperQty(l.qty, l.unit) : ''}</td>
      <td class="dest">${l ? esc(l.destination) : ''}</td>
    </tr>`);
  }
  const body = `
    <div class="boat-head">
      <div class="boat-brand">
        <img class="boat-logo" src="/agro-national-logo.png" alt="">
        <div>
          <h1>${esc(name)}</h1>
          <p>${esc(address)}</p>
          <p>${esc(phone)}</p>
        </div>
      </div>
      <h2 class="boat-title">BOAT NOTE</h2>
    </div>
    <table>
      <tr><th colspan="6">Delivery Details</th></tr>
      <tr>
        <td class="lbl">Boat Name</td><td colspan="2">${esc(s.boat_name)}</td>
        <td class="lbl">Contact No</td><td colspan="2">${esc(s.boat_phone)}</td>
      </tr>
      <tr>
        <td class="lbl">Loaded From</td><td colspan="2">${esc(s.loaded_from)}</td>
        <td class="lbl">Loaded Date</td><td colspan="2">${paperDate(loaded, '/')}</td>
      </tr>
      <tr>
        <td class="lbl">Dispatch Destination</td><td>${esc(s.destination)}</td>
        <td class="lbl">Island Code</td><td>${esc(s.island_code)}</td>
        <td class="lbl">BN Ref No</td><td>${esc(bnRef)}</td>
      </tr>
    </table>
    <table>
      <thead><tr><th class="num">#</th><th>Item Description</th><th class="pack">Packing</th><th class="qty">Qty</th><th class="dest">Destination</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <div class="boat-signs">
      ${signBox('Delivered by:', {
        name: s.delivered_name, role: s.delivered_role, phone: s.delivered_phone, date: signed,
      }, signSpot(sign, 'delivered', s.delivered_name))}
      ${signBox('Received by: (Boat/Cargo)', {
        name: s.cargo_name, role: s.cargo_role, phone: s.cargo_phone,
        date: s.cargo_name ? signed : '',
      }, signSpot(sign, 'cargo', s.cargo_name))}
      ${signBox('Received by:', {
        name: s.receiver_name, role: s.receiver_role, phone: s.receiver_phone,
        date: s.receiver_name ? paperDate(s.arrived_at, '-') : '',
      }, signSpot(sign, 'receiver', s.receiver_name))}
    </div>`;
  return shell({ title: `Boat note ${bnRef}`, body, sheetClass: 'boat-sheet', sign });
}

function paperNum(q) {
  const n = Number(q);
  if (!Number.isFinite(n) || n === 0) return '';
  return String(Math.round(n * 1000) / 1000);
}

export function renderItemReceipt(shipmentId) {
  const s = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(shipmentId);
  if (!s) throw new AppError(404, 'Item receipt not found');
  if (!s.grn_ref) throw new AppError(400, 'This boat note has no item receipt yet');
  const lines = db.prepare(
    `SELECT sl.*, pr.name AS product, pr.unit, pr.code AS item_code
     FROM shipment_lines sl
     LEFT JOIN products pr ON pr.id = sl.product_id
     WHERE sl.shipment_id = ?
     ORDER BY sl.line_no, sl.id`
  ).all(shipmentId);
  const products = lines.filter(l => l.product_id);
  const refs = lines.filter(l => !l.product_id && l.description).map(l => l.description);
  const items = products.map(l => ({
    code: l.item_code || '',
    description: l.description || l.product || '',
    qty: Number(l.received_qty) > 0 ? l.received_qty : l.qty,
    unit: l.unit || '',
  }));
  if (items.length === 1 && refs.length) items[0].description = [items[0].description, ...refs].join(' | ');
  else for (const ref of refs) items.push({ code: '', description: ref, qty: 0, unit: '' });
  const biz = getSettings();
  const name = biz.biz_name || 'agro-OPS';
  const address = biz.biz_address || '';
  const count = Math.max(items.length, 12);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const it = items[i];
    rows.push(`<tr>
      <td class="code">${it ? esc(it.code) : ''}</td>
      <td>${it ? esc(it.description) : ''}</td>
      <td class="num">${it ? paperNum(it.qty) : ''}</td>
      <td class="um">${it ? esc(it.unit) : ''}</td>
      <td></td>
      <td></td>
    </tr>`);
  }
  const person = who => `<td class="lbl">Name:</td><td>${esc(who)}</td>`;
  const sign = signBook('item-receipt', s.id, s.grn_ref);
  const spots = [
    signSpot(sign, 'prepared', s.prepared_name),
    signSpot(sign, 'checked', s.checked_name),
    signSpot(sign, 'verified', s.verified_name),
  ];
  const body = `
    <div class="ir-head">
      <div class="ir-brand">
        <img class="ir-logo" src="/agro-national-logo.png" alt="">
        <div>
          <p>${esc(name)}</p>
          <p>${esc(address)}</p>
        </div>
      </div>
      <div class="ir-id">
        <h2>Item Receipt</h2>
        <table>
          <tr><th>Date</th><th>Ref. No.</th></tr>
          <tr><td>${paperDate(s.arrived_at, '/')}</td><td>${esc(s.grn_ref)}</td></tr>
        </table>
      </div>
    </div>
    <div class="ir-meta">
      <table><tr><th>Vendor</th></tr><tr><td>${esc(s.receipt_vendor)}</td></tr></table>
      <table><tr><th>Memo</th></tr><tr><td>${esc(s.receipt_memo)}</td></tr></table>
    </div>
    <div class="ir-items">
      <h3>Items</h3>
      <table>
        <thead><tr><th>Item</th><th>Description</th><th class="num">Qty</th><th class="um">U/M</th><th>Customer:Job</th><th>Class</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>
    <div class="ir-note">
      <p>We have received all goods / service in good condition.</p>
      <p>If there is any issue in this document, it has to be noticed with in 2 days.</p>
    </div>
    <table class="ir-sign">
      <tr><th colspan="2">Prepared by:</th><th colspan="2">Checked by:</th><th colspan="2">Verified by:</th></tr>
      <tr>${person(s.prepared_name)}${person(s.checked_name)}${person(s.verified_name)}</tr>
      <tr>
        <td class="lbl">Designation:</td><td>${esc(s.prepared_role)}</td>
        <td class="lbl">Designation:</td><td>${esc(s.checked_role)}</td>
        <td class="lbl">Designation:</td><td>${esc(s.verified_role)}</td>
      </tr>
      <tr>${spots.map(spot => `<td class="lbl">Date:</td><td>${spot.s ? signedDate(spot.s.signed_at, '/') : ''}</td>`).join('')}</tr>
      <tr>${spots.map((spot, i) => {
        const available = s.receipt_prepared_by == null || [s.receipt_prepared_by, s.receipt_checked_by, s.receipt_verified_by][i] != null;
        return `<td class="lbl">Sign:</td><td class="sig"${available ? spot.attrs : ''}>${available ? spot.pen(spot.other) : ''}</td>`;
      }).join('')}</tr>
    </table>`;
  return shell({ title: `Item receipt ${s.grn_ref}`, body, sheetClass: 'receipt-sheet', sign });
}

function paperKg(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function blankCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '';
  return String(v);
}

export function renderHarvestGrn(id) {
  const g = db.prepare(`SELECT * FROM harvest_grns WHERE id = ?`).get(id)
    || db.prepare(`SELECT * FROM harvest_grns WHERE shipment_id = ? ORDER BY id LIMIT 1`).get(id);
  if (!g) throw new AppError(404, 'Harvest GRN not found');
  const boat = g.shipment_id
    ? db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(g.shipment_id)
    : null;
  const s = { ...(boat || {}), ...g, id: g.id };
  const lines = harvestLinesByGrn(g.id);
  const biz = getSettings();
  const name = biz.biz_name || 'agro-OPS';
  const address = biz.biz_address || '';
  const phone = biz.biz_phone ? `Phone: +960 ${biz.biz_phone}` : '';
  const sign = signBook('harvest-grn', g.id, g.harvest_ref);
  const spots = [
    signSpot(sign, 'coord', s.coord_name),
    signSpot(sign, 'farmer', s.farmer_signed_name),
    signSpot(sign, 'regional', s.regional_name),
  ];
  const crop = l => esc(l.description || l.product || '');
  const asBunches = g => g.pack_unit === 'bunch' || (!g.pack_unit && g.bunches > 0 && !(g.pack_count > 0));
  const packRows = lines.flatMap(l => l.grades.map(g => `<tr>
    <td>${crop(l)}</td>
    <td>${esc(g.grade)}</td>
    <td class="num">${paperKg(g.kg)}</td>
    <td class="num">${asBunches(g) ? blankCount(g.bunches) : ''}</td>
    <td class="num">${asBunches(g) ? '' : paperKg(g.pack_count)}</td>
    <td class="num">${asBunches(g) ? '' : paperKg(g.per_bag_kg)}</td>
    <td>${esc(g.remarks)}</td>
  </tr>`)).join('');
  const body = `
    <div class="hv-head">
      <img class="hv-logo" src="/agro-national-logo.png" alt="">
      <div class="hv-brand">
        <div>
          <h1>${esc(name)}</h1>
          <p>${esc(address)}</p>
          <p>${esc(phone)}</p>
        </div>
      </div>
    </div>
    <h2 class="hv-title">HARVEST - GOOD RECEIVED NOTE</h2>
    <table>
      <tr><th colspan="6">FARMER DETAILS</th></tr>
      <tr>
        <td class="lbl">FARMER NAME</td><td>${esc(s.farmer_name)}</td>
        <td class="lbl">FARMER ID</td><td>${esc(s.farmer_code)}</td>
        <td class="lbl">GRN REF NO</td><td>${esc(s.harvest_ref)}</td>
      </tr>
      <tr>
        <td class="lbl">ISLAND</td><td>${esc(s.farmer_island)}</td>
        <td class="lbl">PHONE NO</td><td>${esc(s.farmer_phone)}</td>
        <td class="lbl">FARMER CONTRACT NO</td><td>${esc(s.farmer_contract)}</td>
      </tr>
    </table>
    <table>
      <tr><th colspan="4">HARVESTING CROP DETAILS</th></tr>
      <tr><th>CROP NAME</th><th>TOTAL HARVEST AMOUNT (KG)</th><th>NO OF BUNCHES</th><th>NO OF HANDS</th></tr>
      ${lines.map(l => `<tr>
        <td>${crop(l)}</td>
        <td class="num">${paperKg(l.harvest_kg)}</td>
        <td class="num">${blankCount((l.grades || []).reduce((sum, g) => sum + ((g.pack_unit === 'bunch' || (!g.pack_unit && g.bunches > 0 && !(g.pack_count > 0))) ? Number(g.bunches) || 0 : 0), 0) || l.bunches)}</td>
        <td class="num">${blankCount(l.hands)}</td>
      </tr>`).join('')}
      <tr><th>ACTUAL HARVESTED DATE</th><th>DAMAGED AMOUNT (KG)</th><th>UNDAMAGED AMOUNT (KG)</th><th>GRADE</th></tr>
      ${lines.map(l => `<tr>
        <td>${paperDate(l.harvested_at, '-')}</td>
        <td class="num">${paperKg(l.damaged_kg)}</td>
        <td class="num">${paperKg(l.undamaged_kg)}</td>
        <td>${l.grades.map(g => `${esc(g.grade)} (${paperKg(g.kg)} KG)`).join(', ')}</td>
      </tr>`).join('')}
    </table>
    <table>
      <tr><th colspan="7">PACKING DETAILS</th></tr>
      <tr><th>CROP NAME</th><th>GRADE</th><th>QUANTITY (KG)</th><th>BUNCHES</th><th>NO OF BOXES/SACK/BASKETS</th><th>AMOUNT IN EACH BAG (KG)</th><th>REMARKS</th></tr>
      ${packRows}
    </table>
    <table>
      <tr>
        <th>COORDINATORS INFORMATION (RECEIVER AT HARVESTING POINT)</th>
        <th>FARMERS INFORMATION</th>
        <th>VERIFIED BY (REGIONAL)</th>
      </tr>
      <tr>
        <td>Name: ${esc(s.coord_name)}<br>Date: ${paperDate(s.coord_date, '-')}</td>
        <td>Name: ${esc(s.farmer_signed_name)}<br>Date: ${paperDate(s.farmer_signed_date, '-')}</td>
        <td>Name: ${esc(s.regional_name)}<br>Date: ${paperDate(s.regional_date, '-')}</td>
      </tr>
      <tr>${spots.map(spot => `<td class="hv-sign"${spot.attrs}>SIGN${spot.pen(spot.caption)}</td>`).join('')}</tr>
    </table>`;
  return shell({ title: `Harvest GRN ${s.harvest_ref}`, body, sheetClass: 'harvest-sheet', sign });
}

export function renderPriceEnquiry(shipmentId) {
  const s = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(shipmentId);
  if (!s) throw new AppError(404, 'Price enquiry not found');
  if (!s.enquiry_ref) throw new AppError(400, 'This shipment has no boat price enquiry');
  const lines = db.prepare(
    `SELECT * FROM enquiry_lines WHERE shipment_id = ? ORDER BY line_no, id`
  ).all(shipmentId);
  const total = lines.reduce((sum, l) => sum + l.line_total, 0);
  const sign = signBook('price-enquiry', s.id, s.enquiry_ref);
  const vessel = signSpot(sign, 'vessel');
  const approved = signSpot(sign, 'approved', s.approved_name);
  const rows = lines.map(l => `<tr>
      <td class="num">${paperKg(l.qty).replace(/\.00$/, '')}</td>
      <td>${esc(l.unit)}</td>
      <td>${esc(l.description)}</td>
      <td class="num">${mvr(l.rate).replace('MVR ', '')}</td>
      <td class="num">${mvr(l.line_total).replace('MVR ', '')}</td>
    </tr>`);
  const body = `
    <div class="pq-head">
      <div class="pq-brand">
        <div>
          <h1>Operations Department</h1>
          <p>agro-OPS</p>
        </div>
      </div>
      <img class="pq-logo" src="/agro-national-logo.png" alt="">
    </div>
    <div class="pq-top">
      <table>
        <tr><th colspan="2">VESSEL DETAILS</th></tr>
        <tr><td class="lbl">Vessel Name</td><td>${esc(s.vessel_name)}</td></tr>
        <tr><td class="lbl">Contact</td><td>${esc(s.vessel_phone)}</td></tr>
        <tr><td class="lbl">Signature</td><td class="hv-sign"${vessel.attrs}>${vessel.pen(vessel.caption)}</td></tr>
        <tr><td class="lbl">Date</td><td>${paperDate(s.vessel_date, '-')}</td></tr>
      </table>
      <div>
        <h2 class="pq-title">PRICE ENQUIRY FORM</h2>
        <table class="pq-meta">
          <tr><td class="lbl">BN Ref No</td><td>${esc(s.enquiry_ref)}</td></tr>
          <tr><td class="lbl">Loaded From</td><td>${esc(s.loaded_from)}</td></tr>
          <tr><td class="lbl">Destination</td><td>${esc(s.destination)}</td></tr>
        </table>
      </div>
    </div>
    <table>
      <thead><tr><th>QTY</th><th>UNITS</th><th>DESCRIPTION</th><th>RATE</th><th>TOTAL MVR</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <p class="pq-total">TOTAL ${mvr(total).replace('MVR ', '')}</p>
    <table class="pq-sign">
      <tr><th colspan="2">FOR OPERATIONS OFFICE USE</th></tr>
      <tr><td class="lbl">Approved by</td><td>${esc(s.approved_name)}</td></tr>
      <tr><td class="lbl">Date</td><td>${paperDate(s.approved_at, '-')}</td></tr>
      <tr><td class="lbl">Signature</td><td class="hv-sign"${approved.attrs}>${approved.pen(approved.caption)}</td></tr>
      <tr><td class="lbl">Note</td><td>${esc(s.enquiry_note)}</td></tr>
    </table>`;
  return shell({ title: `Price enquiry ${s.enquiry_ref}`, body, sheetClass: 'pq-sheet', sign });
}

function lhQty(q) {
  return Number(q).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function lhMoney(laari) {
  return (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function lhWho(title, { name, role, date }, spot) {
  const who = name || role || '';
  const sub = name && role ? role : '';
  return `<div class="lh-sign"${spot.attrs}>
    <h3>${title}</h3>
    <b>${who ? esc(who) : '&nbsp;'}</b>
    <p>${sub ? esc(sub) : '&nbsp;'}</p>
    <p>${date ? esc(fmtDate(date)) : '&nbsp;'}</p>
    <div class="lh-pen" data-ink>${spot.pen(spot.caption)}</div>
    <div class="lh-line">Sign</div>
  </div>`;
}

export function renderLabourHire(hireId) {
  const hire = db.prepare(`SELECT * FROM labor_hires WHERE id = ?`).get(hireId);
  if (!hire) throw new AppError(404, 'Labour hire not found');
  const s = hire.shipment_id
    ? db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(hire.shipment_id)
    : null;
  const lines = db.prepare(
    `SELECT * FROM labor_lines WHERE labor_id = ? ORDER BY line_no, id`
  ).all(hireId);
  const total = lines.reduce((sum, l) => sum + l.line_total, 0);
  const biz = getSettings();
  const contact = [biz.biz_phone, biz.biz_email].filter(Boolean).join(' · ');
  const sign = signBook('labor-hire', hire.id, hire.reference);
  const route = s ? [s.loaded_from || s.farmer_island, s.destination].filter(Boolean).join(' → ') : '';
  const facts = [
    hire.link_ref ? `<div><span>Shipment</span><b>${esc(hire.link_ref)}</b></div>` : '',
    (s?.enquiry_ref || hire.boat_ref) ? `<div><span>Boat note</span><b>${esc(s?.enquiry_ref || hire.boat_ref)}</b></div>` : '',
    route ? `<div><span>Route</span><b>${esc(route)}</b></div>` : '',
    s?.vessel_name ? `<div><span>Vessel</span><b>${esc(s.vessel_name)}</b></div>` : '',
  ].filter(Boolean).join('');
  const rows = lines.map(l => `<tr>
    <td>${esc(l.description)}</td>
    <td class="num">${lhQty(l.qty)}</td>
    <td class="num">${lhMoney(l.rate)}</td>
    <td class="num">${lhMoney(l.line_total)}</td>
  </tr>`).join('');
  const body = `
    <div class="lh-top">
      <div>
        <img class="lh-logo" src="/agro-national-logo.png" alt="">
        <h1 class="lh-name">${esc(biz.biz_name || 'agro-OPS')}</h1>
        ${biz.biz_address ? `<p class="lh-address">${esc(biz.biz_address)}</p>` : ''}
        ${contact ? `<p class="lh-address">${esc(contact)}</p>` : ''}
      </div>
      <div class="lh-id">
        <p class="lh-kicker">Operations</p>
        <h2 class="lh-title">Labour hire</h2>
        <p class="lh-ref">${esc(hire.reference)}</p>
        <p class="lh-date">${esc(fmtDate(hire.hired_on))}</p>
      </div>
    </div>
    ${facts ? `<div class="lh-for">${facts}</div>` : ''}
    <table>
      <thead><tr>
        <th>What was hired</th>
        <th class="num">Qty<span class="lh-unit">people or hours</span></th>
        <th class="num">Rate<span class="lh-unit">MVR</span></th>
        <th class="num">Amount<span class="lh-unit">MVR</span></th>
      </tr></thead>
      <tbody>
        ${rows}
        <tr class="lh-sum"><td colspan="3">Total</td><td class="num">${mvr(total)}</td></tr>
      </tbody>
    </table>
    ${hire.note ? `<p class="lh-why"><span>Why</span>${esc(hire.note)}</p>` : ''}
    <div class="lh-signs">
      ${lhWho('Asked for the hire', { name: hire.asked_name, role: hire.asked_role, date: hire.asked_date },
        signSpot(sign, 'asked', hire.asked_name))}
      ${lhWho('Approved the hire', { name: hire.approved_name, role: hire.approved_role, date: hire.approved_date },
        signSpot(sign, 'approved', hire.approved_name))}
      ${lhWho('Did the work', { name: hire.worked_name, date: hire.worked_date },
        signSpot(sign, 'worked', hire.worked_name))}
      ${lhWho('Checked the work', { name: hire.checked_name, role: hire.checked_role, date: hire.checked_date },
        signSpot(sign, 'checked', hire.checked_name))}
      ${lhWho('Took the payment', { name: hire.paid_name, date: hire.paid_date },
        signSpot(sign, 'paid', hire.paid_name))}
    </div>`;
  return shell({ title: `Labour hire ${hire.reference}`, body, sheetClass: 'lh-sheet', sign });
}

function formDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${d}-${MONTHS[m - 1]}-${String(y).slice(2)}`;
}

function plainQty(q) {
  return Math.abs(Number(q)).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function mvrNum(laari) {
  if (laari == null || !Number.isFinite(laari)) return '—';
  return (laari / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function noteSerial(prefix, type, at) {
  const year = at.slice(0, 4);
  const n = db.prepare(
    `SELECT COUNT(DISTINCT at) AS n FROM stock_moves WHERE type = ? AND at >= ? AND at <= ?`
  ).get(type, `${year}-01-01`, at).n;
  return `AGRO/${prefix}/${year}/${String(n).padStart(3, '0')}`;
}

function lossMoves(type, at) {
  return db.prepare(
    `SELECT m.id, m.qty, m.note, m.at,
            l.id AS lot_id, l.product_id, l.bin_location, l.received_at, l.shipment_id, l.unit_cost,
            l.reference AS lot_ref, l.boat_note, l.qty_left,
            pr.name AS product, pr.code, pr.unit
     FROM stock_moves m
     JOIN lots l ON l.id = m.lot_id
     JOIN products pr ON pr.id = l.product_id
     WHERE m.type = ? AND m.at = ?
     ORDER BY m.id`
  ).all(type, at);
}

const NOTE_MISSING = {
  damage: 'Disposal note not found',
  weight_loss: 'Weight loss note not found',
  stem_weight: 'Stem weight note not found',
};

function moveOn(id, type) {
  const missing = NOTE_MISSING[type] || 'Note not found';
  const move = db.prepare(`SELECT id, type, at FROM stock_moves WHERE id = ?`).get(id);
  if (!move || move.type !== type) throw new AppError(404, missing);
  const lines = lossMoves(type, move.at);
  if (!lines.length) throw new AppError(404, missing);
  return lines;
}

function landingRate(lot, cache) {
  if (!lot.shipment_id) return lot.unit_cost || null;
  if (!cache.has(lot.shipment_id)) cache.set(lot.shipment_id, shipmentLanding(lot.shipment_id));
  const view = cache.get(lot.shipment_id);
  if (!view) return lot.unit_cost || null;
  const all = (view.lines || []).filter(l => (l.unit || 'kg') === 'kg');
  const match = all.filter(l => l.product_id === lot.product_id);
  const live = match.filter(l => l.landing_per_kg != null && Number(l.kg) > 0);
  if (live.length) {
    const kg = live.reduce((sum, l) => sum + Number(l.kg), 0);
    return Math.round(live.reduce((sum, l) => sum + l.landing_per_kg * Number(l.kg), 0) / kg);
  }
  const received = match.reduce((sum, l) => sum + (Number(l.received_kg) || 0), 0);
  const receivedAll = all.reduce((sum, l) => sum + (Number(l.received_kg) || 0), 0);
  const paid = received > 0
    ? Math.round(match.reduce((sum, l) => sum + (l.unit_cost || 0) * (Number(l.received_kg) || 0), 0) / received)
    : (lot.unit_cost || 0);
  const logistic = (view.ground_transport || 0) + (view.other_charges || 0) + (view.labor_hire || 0) + (view.boat_freight || 0);
  const share = receivedAll > 0 ? Math.round(logistic / receivedAll) : 0;
  return paid + share;
}

function itemLabel(row) {
  const suffix = row.code ? ` (${row.code})` : '';
  const name = suffix && row.product.endsWith(suffix) ? row.product.slice(0, -suffix.length).trim() : row.product;
  return row.code ? `${row.code} - ${name}` : name;
}

function heldAround(row) {
  const laterMoves = db.prepare(
    `SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves
     WHERE lot_id = ? AND (at > ? OR (at = ? AND id > ?))`
  ).get(row.lot_id, row.at, row.at, row.id).q;
  const laterSales = db.prepare(
    `SELECT COALESCE(SUM(a.qty), 0) AS q
     FROM allocations a
     JOIN order_items oi ON oi.id = a.order_item_id
     JOIN orders o ON o.id = oi.order_id
     WHERE a.lot_id = ? AND o.status != 'cancelled' AND o.delivery_date > ?`
  ).get(row.lot_id, row.at).q;
  const after = Math.round((row.qty_left - laterMoves + laterSales) * 1000) / 1000;
  const before = Math.round((after - row.qty) * 1000) / 1000;
  return { before, after };
}

function lossRemark(lines) {
  const notes = [...new Set(lines.map(l => l.note).filter(Boolean))];
  if (notes.length !== 1) return '';
  const bins = [...new Set(lines.map(l => l.bin_location).filter(Boolean))];
  return bins.length === 1 ? `${notes[0]} at ${bins[0]}` : notes[0];
}

function lossHead(biz, title, serial, date) {
  const contact = [biz.biz_phone ? `Phone: ${biz.biz_phone}` : '', biz.biz_email].filter(Boolean).join('\n');
  return `<div class="loss-top">
      <div class="loss-brand">
        <p class="loss-name">${esc(biz.biz_name || 'agro-OPS')}</p>
        ${biz.biz_address ? `<p>${esc(biz.biz_address)}</p>` : ''}
        ${contact ? `<p>${esc(contact)}</p>` : ''}
      </div>
      <img class="loss-logo" src="/agro-national-logo.png" alt="">
    </div>
    <h2 class="loss-title">${title}</h2>
    <div class="loss-meta">
      <div><span>Serial no.</span><b>${esc(serial)}</b></div>
      <div><span>Date</span><b>${esc(date)}</b></div>
    </div>`;
}

function lossSigns(slots, sign) {
  return `<div class="loss-signs" style="grid-template-columns: repeat(${slots.length + 1}, minmax(0, 1fr))">
      ${slots.map(slot => {
        const spot = signSpot(sign, slot);
        return `<div${spot.attrs}>
        <h3>${sign.form.slots[slot]}</h3>
        <p><span>Name</span><i>${esc(spot.who)}</i></p>
        <p><span>Signature</span><i data-ink${spot.s ? ' class="inked"' : ''}>${spot.pen(spot.when)}</i></p>
      </div>`;
      }).join('')}
      <div>
        <h3>Finance use</h3>
        <p><span>Write-off by</span><i></i></p>
        <p><span>Name</span><i></i></p>
        <p><span>Date</span><i></i></p>
      </div>
    </div>`;
}

function padRows(filled, columns, count, min = 8) {
  const blank = '<tr class="pad">' + '<td></td>'.repeat(columns) + '</tr>';
  return filled + blank.repeat(Math.max(0, min - count));
}

export function renderDisposal(moveId) {
  const lines = moveOn(moveId, 'damage');
  const at = lines[0].at;
  const biz = getSettings();
  const serial = noteSerial('DN', 'damage', at);
  const sign = signBook('disposal', lines[0].id, serial);
  const rates = new Map();
  const priced = lines.map(row => {
    const rate = landingRate(row, rates);
    const qty = Math.abs(row.qty);
    const amount = rate == null ? null : Math.round(rate * qty);
    return { ...row, rate, qty, amount };
  });
  const amounts = priced.filter(r => r.amount != null);
  const total = amounts.length ? amounts.reduce((sum, r) => sum + r.amount, 0) : null;
  const units = [...new Set(priced.map(r => r.unit))];
  const qtyHead = units.length === 1 ? `Dispose qty (${units[0]})` : 'Dispose qty';
  const bodyRows = priced.map((row, i) => {
    const age = row.received_at ? daysBetween(row.received_at, row.at) : null;
    const item = itemLabel(row);
    return `<tr>
      <td class="ctr">${i + 1}</td>
      <td>${esc(item)}</td>
      <td>${esc(row.bin_location || '—')}</td>
      <td>${esc(row.note || '—')}</td>
      <td class="ctr">${formDate(row.received_at)}</td>
      <td class="ctr">${formDate(row.at)}</td>
      <td class="ctr">${age != null && age >= 0 ? age : '—'}</td>
      <td class="num">${plainQty(row.qty)}</td>
      <td class="num">${mvrNum(row.rate)}</td>
      <td class="num">${mvrNum(row.amount)}</td>
    </tr>`;
  }).join('');
  const body = `
    ${lossHead(biz, 'Disposal Note', serial, formDate(at))}
    <table>
      <thead><tr>
        <th class="ctr">#</th>
        <th>Item</th>
        <th>Dispose from</th>
        <th>Reason for disposal</th>
        <th class="ctr">Received</th>
        <th class="ctr">Disposed</th>
        <th class="ctr">Aging</th>
        <th class="num">${esc(qtyHead)}</th>
        <th class="num">Landing cost (MVR)</th>
        <th class="num">Total (MVR)</th>
      </tr></thead>
      <tbody>
        ${padRows(bodyRows, 10, priced.length)}
        <tr class="sum"><td colspan="9">TOTAL</td><td class="num">${mvrNum(total)}</td></tr>
      </tbody>
    </table>
    <p class="loss-remarks"><b>Remarks:</b> ${esc(lossRemark(priced))}</p>
    ${lossSigns(['prepared', 'verified', 'approved'], sign)}`;
  return shell({ title: `${serial} · Disposal note`, body, sheetClass: 'loss-sheet', sign });
}

function renderBalanceNote(moveId, type, { doc, prefix, title, qtyLabel }) {
  const lines = moveOn(moveId, type);
  const at = lines[0].at;
  const biz = getSettings();
  const serial = noteSerial(prefix, type, at);
  const sign = signBook(doc, lines[0].id, serial);
  const rates = new Map();
  const priced = lines.map(row => {
    const rate = landingRate(row, rates);
    const qty = Math.abs(row.qty);
    const amount = rate == null ? null : Math.round(rate * qty);
    return { ...row, rate, qty, amount, ...heldAround(row) };
  });
  const amounts = priced.filter(r => r.amount != null);
  const total = amounts.length ? amounts.reduce((sum, r) => sum + r.amount, 0) : null;
  const units = [...new Set(priced.map(r => r.unit))];
  const qtyHead = units.length === 1 ? `${qtyLabel} (${units[0]})` : qtyLabel;
  const bodyRows = priced.map(row => {
    const item = itemLabel(row);
    const itn = row.lot_ref || row.boat_note || '—';
    return `<tr>
      <td>${esc(itn)}</td>
      <td class="ctr">${formDate(row.at)}</td>
      <td>${esc(item)}</td>
      <td>${esc(row.bin_location || '—')}</td>
      <td>${esc(row.note || '—')}</td>
      <td class="num">${plainQty(row.before)}</td>
      <td class="num">${plainQty(row.after)}</td>
      <td class="num">${plainQty(row.qty)}</td>
      <td class="num">${mvrNum(row.rate)}</td>
      <td class="num">${mvrNum(row.amount)}</td>
    </tr>`;
  }).join('');
  const body = `
    ${lossHead(biz, title, serial, formDate(at))}
    <table>
      <thead><tr>
        <th>ITN no.</th>
        <th class="ctr">Date</th>
        <th>Item</th>
        <th>Bin (location)</th>
        <th>Reason</th>
        <th class="num">Book balance</th>
        <th class="num">Physical balance</th>
        <th class="num">${esc(qtyHead)}</th>
        <th class="num">Landing cost (MVR)</th>
        <th class="num">Total (MVR)</th>
      </tr></thead>
      <tbody>
        ${padRows(bodyRows, 10, priced.length)}
        <tr class="sum"><td colspan="9">TOTAL</td><td class="num">${mvrNum(total)}</td></tr>
      </tbody>
    </table>
    <p class="loss-remarks"><b>Remarks:</b> ${esc(lossRemark(priced))}</p>
    ${lossSigns(['prepared', 'counted', 'verified', 'approved'], sign)}`;
  return shell({ title: `${serial} · ${title}`, body, sheetClass: 'loss-sheet', sign });
}

export function renderWeightLoss(moveId) {
  return renderBalanceNote(moveId, 'weight_loss', {
    doc: 'weight-loss', prefix: 'WL', title: 'Weight Loss Note', qtyLabel: 'Weight loss qty',
  });
}

export function renderStemWeight(moveId) {
  return renderBalanceNote(moveId, 'stem_weight', {
    doc: 'stem-weight', prefix: 'SW', title: 'Stem Weight Note', qtyLabel: 'Stem weight qty',
  });
}

const LOSS_DOCS = {
  'disposal': { type: 'damage', prefix: 'DN' },
  'weight-loss': { type: 'weight_loss', prefix: 'WL' },
  'stem-weight': { type: 'stem_weight', prefix: 'SW' },
};

// The form a signature goes on, checked the way printing checks it. A loss
// note covers every movement saved with it, so it is keyed by the first one.
export function signTarget(doc, id) {
  if (doc === 'invoice' || doc === 'delivery-note') {
    const order = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id);
    if (!order) throw new AppError(404, 'Order not found');
    if (order.status === 'cancelled') throw new AppError(400, 'This order was cancelled');
    return { id, ref: docNo(doc === 'invoice' ? 'INV' : 'DN', id) };
  }
  if (doc === 'labor-hire') {
    const hire = db.prepare(`SELECT reference FROM labor_hires WHERE id = ?`).get(id);
    if (!hire) throw new AppError(404, 'Labour hire not found');
    return { id, ref: hire.reference };
  }
  if (LOSS_DOCS[doc]) {
    const { type, prefix } = LOSS_DOCS[doc];
    const lines = moveOn(id, type);
    return { id: lines[0].id, ref: noteSerial(prefix, type, lines[0].at) };
  }
  if (doc === 'harvest-grn') {
    const g = db.prepare(`SELECT id, harvest_ref FROM harvest_grns WHERE id = ?`).get(id)
      || db.prepare(`SELECT id, harvest_ref FROM harvest_grns WHERE shipment_id = ? ORDER BY id LIMIT 1`).get(id);
    if (!g || !g.harvest_ref) throw new AppError(404, 'Harvest GRN not found');
    return { id: g.id, ref: g.harvest_ref };
  }
  const s = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(id);
  if (!s) throw new AppError(404, 'Shipment not found');
  let ref;
  if (doc === 'price-enquiry') ref = s.enquiry_ref;
  else if (doc === 'item-receipt') ref = s.grn_ref;
  else if (doc === 'boat-note') {
    const lines = db.prepare(`SELECT COUNT(*) AS n FROM shipment_lines WHERE shipment_id = ?`).get(id).n;
    ref = lines ? (s.enquiry_ref || s.reference || `#${id}`) : '';
  } else {
    throw new AppError(400, 'This form has no signature boxes');
  }
  if (!ref) throw new AppError(400, 'This form has not been written yet');
  return { id, ref };
}

function slashDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!y || !m || !d) return '';
  return `${d}/${m}/${y}`;
}

function itnQty(q) {
  return Number(q).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function itnName(code, description) {
  const suffix = code ? ` (${code})` : '';
  return suffix && description.endsWith(suffix) ? description.slice(0, -suffix.length).trim() : description;
}

export function renderTransferNote(noteId) {
  const note = db.prepare(`SELECT * FROM transfer_notes WHERE id = ?`).get(noteId);
  if (!note) throw new AppError(404, 'Inventory transfer not found');
  const lines = db.prepare(
    `SELECT * FROM transfer_lines WHERE note_id = ? ORDER BY line_no, id`
  ).all(noteId);
  const body = `
    <h1 class="itn-title">Inventory Transfer</h1>
    <div class="itn-head">
      <p><span>Date</span><b>${esc(slashDate(note.moved_on))}</b></p>
      <p><span>Reference no.</span><b>${esc(note.reference)}</b><span>Class</span><b>${esc(note.class_name)}</b></p>
      <p><span>Transfer from</span><b>${esc(note.from_bin || '—')}</b></p>
      <p><span>Transfer to</span><b>${esc(note.to_bin || '—')}</b></p>
    </div>
    <p class="itn-memo"><span>Memo</span><b>${esc(note.memo || '')}</b></p>
    <table>
      <thead><tr>
        <th>Item</th>
        <th>Description</th>
        <th>From</th>
        <th class="num">QOH</th>
        <th class="num">Transfer qty</th>
        <th>To</th>
      </tr></thead>
      <tbody>
        ${lines.map(line => `<tr>
          <td>${esc(line.item_code || '—')}</td>
          <td>${esc(itnName(line.item_code, line.description))}</td>
          <td>${esc(line.from_bin || '—')}</td>
          <td class="num">${itnQty(line.qoh)}</td>
          <td class="num">${itnQty(line.qty)}</td>
          <td>${esc(line.to_bin || '—')}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="itn-page">Page 1</p>`;
  return shell({ title: `${note.reference} · Inventory transfer`, body, sheetClass: 'itn-sheet' });
}
