// Pick the crops a farmer grows from the Crops tab. The pick is saved as the
// crop names joined with ", ". A saved crop that is not on the list stays
// ticked until someone unticks it.
import { $, esc } from './helpers.js';

const fold = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const unique = names => names.filter((n, i) => names.findIndex(p => fold(p) === fold(n)) === i);
let seq = 0;

export function cropPicker(root, { saved = '', labelId = '', load }) {
  const uid = `crop-pick-${++seq}`;
  const original = String(saved ?? '').trim();
  const savedNames = unique(original.split(',').map(s => s.trim()).filter(Boolean));
  let crops = [];
  let extras = [];
  let picked = savedNames;
  let dirty = false;
  let query = '';
  let state = 'loading';

  root.classList.add('crop-pick');
  root.innerHTML = `
    <button type="button" class="crop-pick-btn" aria-expanded="false" aria-controls="${uid}-panel"
      aria-labelledby="${labelId ? `${labelId} ` : ''}${uid}-value">
      <span class="crop-pick-value" id="${uid}-value"></span>
      <svg class="crop-pick-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none"
        stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6l4 4 4-4"/></svg>
    </button>
    <div class="crop-pick-panel" id="${uid}-panel" hidden>
      <input type="search" class="crop-pick-q" placeholder="Search crops" aria-label="Search crops" autocomplete="off">
      <div class="crop-pick-list" role="group" aria-label="Crops"></div>
    </div>`;
  const btn = $('.crop-pick-btn', root);
  const panel = $('.crop-pick-panel', root);
  const search = $('.crop-pick-q', root);
  const list = $('.crop-pick-list', root);

  const isPicked = name => picked.some(p => fold(p) === fold(name));
  const option = (name, label) => `
    <label class="crop-pick-opt">
      <input type="checkbox" value="${esc(name)}" ${isPicked(name) ? 'checked' : ''}>
      <span>${esc(label)}</span>
    </label>`;
  const note = text => `<p class="crop-pick-note">${text}</p>`;

  const paintValue = () => {
    $('.crop-pick-value', root).innerHTML = picked.length
      ? picked.map(n => `<span class="crop-chip">${esc(n)}</span>`).join('')
      : '<span class="crop-pick-ph">Choose crops</span>';
  };

  const paintList = () => {
    if (state === 'loading') {
      list.innerHTML = note('Loading crops…');
      return;
    }
    const needle = fold(query);
    const hit = c => !needle || fold(c.crop).includes(needle)
      || fold(c.variety).includes(needle) || fold(c.name).includes(needle);
    const parts = [];
    const savedHits = extras.filter(n => !needle || fold(n).includes(needle));
    if (savedHits.length) {
      parts.push(`<div class="crop-pick-saved"><div class="crop-pick-head">Saved on this farmer</div>
        ${savedHits.map(n => option(n, n)).join('')}</div>`);
    }
    const families = [];
    for (const c of crops) {
      const last = families.at(-1);
      if (last && last.crop === c.crop) last.rows.push(c);
      else families.push({ crop: c.crop, rows: [c] });
    }
    for (const family of families) {
      const rows = family.rows.filter(hit);
      if (!rows.length) continue;
      if (family.rows.length === 1) {
        parts.push(option(rows[0].name, rows[0].name));
        continue;
      }
      parts.push(`<div class="crop-pick-family"><div class="crop-pick-crop">${esc(family.crop)}</div>
        <div class="crop-pick-kinds">${rows.map(c => option(c.name, c.variety || c.crop)).join('')}</div></div>`);
    }
    if (state === 'failed') parts.push(note('The crop list did not load. Close the form and open it again.'));
    else if (!crops.length && !needle) parts.push(note('No crops yet. Add them in the Crops tab.'));
    list.innerHTML = parts.join('') || note('No crop matches that.');
  };

  const setOpen = open => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    root.classList.toggle('open', open);
    if (!open) return;
    panel.scrollIntoView({ block: 'nearest' });
    if (matchMedia('(hover: hover)').matches) search.focus({ preventScroll: true });
  };

  btn.addEventListener('click', () => setOpen(panel.hidden));
  search.addEventListener('input', () => {
    query = search.value;
    paintList();
  });
  list.addEventListener('change', e => {
    const box = e.target.closest('input[type=checkbox]');
    if (!box) return;
    dirty = true;
    if (box.checked) {
      if (!isPicked(box.value)) picked = [...picked, box.value];
    } else {
      picked = picked.filter(p => fold(p) !== fold(box.value));
    }
    paintValue();
  });
  // Escape closes the list without closing the form behind it.
  root.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || panel.hidden) return;
    e.stopPropagation();
    setOpen(false);
    btn.focus();
  });
  (root.closest('.modal') || document).addEventListener('mousedown', e => {
    if (!panel.hidden && !root.contains(e.target)) setOpen(false);
  });
  root.addEventListener('focusout', e => {
    if (!panel.hidden && e.relatedTarget && !root.contains(e.relatedTarget)) setOpen(false);
  });

  paintValue();
  paintList();
  Promise.resolve()
    .then(load)
    .then(rows => {
      crops = rows;
      const known = new Map(crops.map(c => [fold(c.name), c.name]));
      picked = unique(savedNames.map(n => known.get(fold(n)) || n));
      extras = picked.filter(n => !known.has(fold(n)));
      state = 'ready';
    }, () => {
      extras = savedNames;
      state = 'failed';
    })
    .then(() => {
      if (!root.isConnected) return;
      paintValue();
      paintList();
    });

  return {
    value: () => (dirty ? picked.join(', ') : original),
  };
}
