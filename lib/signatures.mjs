// Signatures drawn on printed forms. A signature is kept as the pen strokes
// (x, y pairs in the pad's pixels) and printed as a vector, so it stays sharp
// on paper at any size.
import { AppError, db } from './db.mjs';

// The boxes each form can be signed in, in the order they print.
export const SIGN_FORMS = {
  'invoice': {
    name: 'Invoice',
    slots: { issued: 'Issued by', delivered: 'Delivered by', received: 'Received by' },
  },
  'delivery-note': {
    name: 'Delivery note',
    slots: { delivered: 'Delivered by', received: 'Received by' },
  },
  'boat-note': {
    name: 'Boat note',
    slots: { delivered: 'Delivered by', cargo: 'Received by (boat/cargo)', receiver: 'Received by' },
  },
  'item-receipt': {
    name: 'Item receipt',
    slots: { prepared: 'Prepared by', checked: 'Checked by', verified: 'Verified by' },
  },
  'harvest-grn': {
    name: 'Harvest GRN',
    slots: { coord: 'Receiver at harvesting point', farmer: 'Farmer', regional: 'Verified by (regional)' },
  },
  'price-enquiry': {
    name: 'Price enquiry',
    slots: { vessel: 'Vessel', approved: 'Approved by' },
  },
  'labor-hire': {
    name: 'Labour hire',
    slots: {
      asked: 'Asked for the hire', approved: 'Approved the hire', worked: 'Did the work',
      checked: 'Checked the work', paid: 'Took the payment',
    },
  },
  'disposal': {
    name: 'Disposal note',
    slots: { prepared: 'Prepared by', verified: 'Verified by', approved: 'Approved by' },
  },
  'weight-loss': {
    name: 'Weight loss note',
    slots: { prepared: 'Prepared by', counted: 'Counted by', verified: 'Verified by', approved: 'Approved by' },
  },
  'stem-weight': {
    name: 'Stem weight note',
    slots: { prepared: 'Prepared by', counted: 'Counted by', verified: 'Verified by', approved: 'Approved by' },
  },
};

const MAX_COORD = 5000;
const MAX_POINTS = 10000;
const r1 = n => Math.round(n * 10) / 10;

export function parseStrokes(raw) {
  const unreadable = () => new AppError(400, 'The signature could not be read. Clear it and sign again.');
  if (!Array.isArray(raw) || raw.length > 300) throw unreadable();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, points = 0;
  const strokes = raw.map(stroke => {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length % 2 || stroke.length > MAX_POINTS * 2) {
      throw unreadable();
    }
    points += stroke.length / 2;
    return stroke.map((v, i) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_COORD) throw unreadable();
      const n = r1(v);
      if (i % 2) { minY = Math.min(minY, n); maxY = Math.max(maxY, n); }
      else { minX = Math.min(minX, n); maxX = Math.max(maxX, n); }
      return n;
    });
  });
  if (points > MAX_POINTS) throw new AppError(400, 'That signature is too long. Clear it and sign again.');
  if (points < 6 || (maxX - minX) + (maxY - minY) < 24) {
    throw new AppError(400, 'Draw the signature in the box first');
  }
  return strokes;
}

// Each point after the first curves toward the midpoint of the next segment,
// the same way the pad draws it on screen.
function strokePath(s) {
  const n = s.length / 2;
  if (n === 1) return `M${s[0]} ${s[1]}h0.1`;
  let d = `M${s[0]} ${s[1]}`;
  for (let i = 1; i < n - 1; i++) {
    const x = s[i * 2], y = s[i * 2 + 1];
    d += `Q${x} ${y} ${r1((x + s[i * 2 + 2]) / 2)} ${r1((y + s[i * 2 + 3]) / 2)}`;
  }
  return d + `L${s[n * 2 - 2]} ${s[n * 2 - 1]}`;
}

// Cropped to the ink, so the signature fills whatever box it prints in.
export function signatureSvg(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i < s.length; i += 2) {
      minX = Math.min(minX, s[i]); maxX = Math.max(maxX, s[i]);
      minY = Math.min(minY, s[i + 1]); maxY = Math.max(maxY, s[i + 1]);
    }
  }
  const w = Math.max(maxX - minX, 60) + 8;
  const h = Math.max(maxY - minY, 24) + 8;
  const box = [r1((minX + maxX - w) / 2), r1((minY + maxY - h) / 2), r1(w), r1(h)];
  return `<svg viewBox="${box.join(' ')}" preserveAspectRatio="xMinYMid meet" aria-hidden="true" focusable="false"><path d="${strokes.map(strokePath).join('')}"/></svg>`;
}

export function signaturesFor(doc, docId) {
  const rows = db.prepare(
    `SELECT id, slot, signer_name, strokes, signed_at FROM signatures WHERE doc = ? AND doc_id = ?`
  ).all(doc, docId);
  return new Map(rows.map(r => [r.slot, { ...r, svg: signatureSvg(JSON.parse(r.strokes)) }]));
}
