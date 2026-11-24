// Hand-rolled SVG charts following the dataviz reference method:
// single series in categorical slot 1, hairline solid grid, 2px line with a
// ringed end dot, ≤24px bars with a 4px rounded data end, selective direct
// labels, hover tooltips, and a table twin supplied by the chart card wrapper.
// Colors come from CSS custom properties so both themes just work.

import { esc } from './helpers.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function niceTicks(maxVal, steps = 3) {
  const v = Math.max(maxVal, 1);
  const rough = v / steps;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s * steps >= v);
  const max = Math.ceil(v / step) * step;
  const ticks = [];
  for (let t = 0; t <= max + step / 2; t += step) ticks.push(t);
  return { max, ticks };
}

function showTip(tip, host, x, y, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const hw = host.clientWidth;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = x + 12;
  if (left + tw > hw - 4) left = Math.max(x - tw - 12, 4);
  let top = y - th - 10;
  if (top < 0) top = y + 14;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

// points: [{ label, value, tip }]
export function lineChart(host, tip, { points, yFmt }) {
  host.replaceChildren(tip);
  if (!points.length) return;
  const W = Math.max(host.clientWidth - 4, 280);
  const H = 218;
  const { max, ticks } = niceTicks(Math.max(...points.map(p => p.value)));
  const yLabelW = Math.max(...ticks.map(t => yFmt(t).length)) * 6.5 + 12;
  const m = { t: 14, r: 58, b: 26, l: yLabelW };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const x = i => m.l + (points.length === 1 ? pw / 2 : (i / (points.length - 1)) * pw);
  const y = v => m.t + ph - (v / max) * ph;

  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });

  for (const t of ticks) {
    const gy = y(t);
    svg.append(svgEl('line', {
      x1: m.l, x2: m.l + pw, y1: gy, y2: gy,
      stroke: t === 0 ? 'var(--baseline)' : 'var(--hairline)',
      'stroke-width': 1, 'shape-rendering': 'crispEdges',
    }));
    const lbl = svgEl('text', { x: m.l - 8, y: gy + 4, 'text-anchor': 'end', class: 'ax' });
    lbl.textContent = yFmt(t);
    svg.append(lbl);
  }

  const every = Math.max(1, Math.ceil(points.length / 6));
  points.forEach((p, i) => {
    const isLast = i === points.length - 1;
    if (!isLast && (i % every !== 0 || points.length - 1 - i < every / 2)) return;
    const t = svgEl('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'ax' });
    t.textContent = p.label;
    svg.append(t);
  });

  const pts = points.map((p, i) => [x(i), y(p.value)]);
  const dLine = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  svg.append(svgEl('path', {
    d: `${dLine} L${pts.at(-1)[0].toFixed(1)} ${y(0).toFixed(1)} L${pts[0][0].toFixed(1)} ${y(0).toFixed(1)} Z`,
    fill: 'var(--chart-1)', opacity: 0.1,
  }));
  svg.append(svgEl('path', {
    d: dLine, fill: 'none', stroke: 'var(--chart-1)',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }));

  const [ex, ey] = pts.at(-1);
  svg.append(svgEl('circle', { cx: ex, cy: ey, r: 4.5, fill: 'var(--chart-1)', stroke: 'var(--surface)', 'stroke-width': 2 }));
  const endLbl = svgEl('text', { x: ex + 8, y: ey + 4, class: 'end-label' });
  endLbl.textContent = yFmt(points.at(-1).value);
  svg.append(endLbl);

  const vline = svgEl('line', { y1: m.t, y2: m.t + ph, stroke: 'var(--baseline)', 'stroke-width': 1, visibility: 'hidden' });
  const hdot = svgEl('circle', { r: 4.5, fill: 'var(--chart-1)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(vline, hdot);

  const bw = pw / Math.max(points.length - 1, 1);
  points.forEach((p, i) => {
    const band = svgEl('rect', {
      x: x(i) - bw / 2, y: m.t, width: bw, height: ph, fill: 'transparent',
    });
    band.addEventListener('mouseenter', () => {
      vline.setAttribute('x1', x(i)); vline.setAttribute('x2', x(i));
      vline.setAttribute('visibility', 'visible');
      hdot.setAttribute('cx', x(i)); hdot.setAttribute('cy', y(p.value));
      hdot.setAttribute('visibility', 'visible');
      showTip(tip, host, x(i), y(p.value), `<b>${esc(p.tip ?? p.label)}</b>${esc(yFmt(p.value))}`);
    });
    band.addEventListener('mouseleave', () => {
      vline.setAttribute('visibility', 'hidden');
      hdot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
    svg.append(band);
  });

  host.append(svg);
}

// rows: [{ label, value, tip }]
export function barChartH(host, tip, { rows, vFmt, empty = 'No sales in this period yet.' }) {
  host.replaceChildren(tip);
  if (!rows.length) {
    const note = document.createElement('div');
    note.className = 'loading';
    note.textContent = empty;
    host.append(note);
    return;
  }
  const W = Math.max(host.clientWidth - 4, 280);
  const rowH = 32, barH = 16, rr = 4;
  const H = rows.length * rowH + 8;
  const labelW = Math.min(150, Math.max(...rows.map(r => r.label.length)) * 6.6 + 14);
  const valueW = Math.max(...rows.map(r => vFmt(r.value).length)) * 7 + 16;
  const pw = Math.max(W - labelW - valueW - 8, 60);
  const maxV = Math.max(...rows.map(r => r.value), 1);

  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svg.append(svgEl('line', {
    x1: labelW, x2: labelW, y1: 2, y2: H - 4,
    stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
  }));

  rows.forEach((r, i) => {
    const cy = i * rowH + rowH / 2 + 4;
    const lbl = svgEl('text', { x: labelW - 8, y: cy + 4, 'text-anchor': 'end', class: 'bar-label' });
    lbl.textContent = r.label.length > 20 ? r.label.slice(0, 19) + '…' : r.label;
    const full = svgEl('title');
    full.textContent = r.label;
    lbl.append(full);
    svg.append(lbl);

    const w = Math.max((r.value / maxV) * pw, rr + 1);
    const yTop = cy - barH / 2;
    // square at the baseline, 4px rounded data end
    const d = `M${labelW} ${yTop} h${(w - rr).toFixed(1)} a${rr} ${rr} 0 0 1 ${rr} ${rr} v${barH - 2 * rr} a${rr} ${rr} 0 0 1 ${-rr} ${rr} h${(-(w - rr)).toFixed(1)} Z`;
    svg.append(svgEl('path', { d, fill: 'var(--chart-1)' }));

    const val = svgEl('text', { x: labelW + w + 7, y: cy + 4, class: 'bar-value' });
    val.textContent = vFmt(r.value);
    svg.append(val);

    const band = svgEl('rect', { x: 0, y: i * rowH + 4, width: W, height: rowH, fill: 'transparent' });
    band.addEventListener('mouseenter', () => showTip(tip, host, labelW + w, cy - 8, `<b>${esc(r.label)}</b>${esc(r.tip ?? vFmt(r.value))}`));
    band.addEventListener('mouseleave', () => { tip.hidden = true; });
    svg.append(band);
  });

  host.append(svg);
}

function pctText(value, total) {
  const p = (value / total) * 100;
  if (p > 0 && p < 0.5) return '<1%';
  return Math.round(p) + '%';
}

function arcPath(cx, cy, r, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// slices: [{ label, value, color, tip, display }]
// A composition: ring starts at 12 o'clock, total sits in the hole, names live
// in a legend so the slices are never the only way to read the chart.
export function donutChart(host, tip, { slices, center, centerSub = '', empty = 'Nothing to show yet.' }) {
  host.replaceChildren(tip);
  const total = slices.reduce((s, x) => s + (x.value || 0), 0);
  if (!slices.length || total <= 0) {
    const note = document.createElement('div');
    note.className = 'loading';
    note.textContent = empty;
    host.append(note);
    return;
  }

  const width = Math.max(host.clientWidth - 4, 260);
  const stacked = width < 340;
  const box = 176;
  const cx = box / 2;
  const cy = box / 2;
  const r = 62;
  const thick = 18;

  const wrap = document.createElement('div');
  wrap.className = stacked ? 'donut donut-stack' : 'donut';
  const svg = svgEl('svg', {
    width: box, height: box, viewBox: `0 0 ${box} ${box}`, role: 'img',
    'aria-label': slices.map(s => `${s.label} ${pctText(s.value, total)}`).join(', '),
  });

  const paths = [];
  if (slices.length === 1) {
    const vis = svgEl('circle', {
      cx, cy, r, fill: 'none', stroke: slices[0].color, 'stroke-width': thick,
    });
    svg.append(vis);
    paths.push(vis);
  } else {
    let cursor = -Math.PI / 2;
    for (const s of slices) {
      const sweep = (s.value / total) * Math.PI * 2;
      const gap = sweep > 0.14 ? 0.03 : 0;
      const vis = svgEl('path', {
        d: arcPath(cx, cy, r, cursor + gap, cursor + sweep - gap),
        fill: 'none', stroke: s.color, 'stroke-width': thick,
      });
      svg.append(vis);
      paths.push(vis);
      cursor += sweep;
    }
  }

  const totalText = svgEl('text', { x: cx, y: cy - 1, 'text-anchor': 'middle', class: 'donut-total' });
  totalText.textContent = center;
  svg.append(totalText);
  if (centerSub) {
    const sub = svgEl('text', { x: cx, y: cy + 16, 'text-anchor': 'middle', class: 'donut-sub' });
    sub.textContent = centerSub;
    svg.append(sub);
  }

  const legend = document.createElement('ul');
  legend.className = 'donut-legend';
  const rows = slices.map(s => {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'donut-swatch';
    sw.style.background = s.color;
    const name = document.createElement('span');
    name.className = 'donut-name';
    name.textContent = s.label;
    const meta = document.createElement('span');
    meta.className = 'donut-meta';
    const pct = pctText(s.value, total);
    meta.textContent = s.display ? `${s.display} · ${pct}` : pct;
    li.append(sw, name, meta);
    return li;
  });
  legend.append(...rows);

  const highlight = i => {
    paths.forEach((p, j) => { p.style.opacity = i === null || j === i ? '1' : '0.35'; });
    rows.forEach((li, j) => li.classList.toggle('on', i !== null && j === i));
  };
  const tipFor = (s, evt) => {
    const rect = host.getBoundingClientRect();
    showTip(tip, host, evt.clientX - rect.left, evt.clientY - rect.top, `<b>${esc(s.label)}</b>${esc(s.tip ?? s.display ?? '')}`);
  };
  slices.forEach((s, i) => {
    const enter = evt => { highlight(i); tipFor(s, evt); };
    const move = evt => tipFor(s, evt);
    const leave = () => { highlight(null); tip.hidden = true; };
    for (const node of [paths[i], rows[i]]) {
      node.addEventListener('mouseenter', enter);
      node.addEventListener('mousemove', move);
      node.addEventListener('mouseleave', leave);
    }
  });

  wrap.append(svg, legend);
  host.append(wrap);
}

// Tiny trend for a stat tile: muted line, current period dot in the chart hue.
export function sparklineHtml(values, w = 92, h = 26) {
  if (values.length < 2) return '';
  const min = Math.min(...values), span = Math.max(...values) - min || 1;
  const px = i => 3 + (i / (values.length - 1)) * (w - 10);
  const py = v => h - 4 - ((v - min) / span) * (h - 9);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join('');
  const lx = px(values.length - 1).toFixed(1), ly = py(values.at(-1)).toFixed(1);
  return `<svg width="${w}" height="${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--ink-3)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lx}" cy="${ly}" r="3" fill="var(--chart-1)" stroke="var(--surface)" stroke-width="2"/></svg>`;
}

// ---- chart card with table twin + resize handling ----

let seq = 0;

// Returns html; call wireChartCards(root) after inserting.
// def: { title, sub, render(host, tip), tableHtml }
const pending = new Map();

export function chartCard({ title, sub = '', render, tableHtml }) {
  const id = 'chart-' + (++seq);
  pending.set(id, { render, tableHtml });
  return `
    <div class="card" data-chart-card="${id}">
      <div class="card-head">
        <div class="card-title">${title}${sub ? `<small>${sub}</small>` : ''}</div>
        <button class="chart-toggle" type="button" aria-pressed="false" title="Toggle table view">table</button>
      </div>
      <div class="chart-body" data-chart-host><div class="chart-tip" hidden></div></div>
    </div>`;
}

export function wireChartCards(root) {
  for (const card of root.querySelectorAll('[data-chart-card]')) {
    const def = pending.get(card.dataset.chartCard);
    if (!def) continue;
    pending.delete(card.dataset.chartCard);
    const body = card.querySelector('[data-chart-host]');
    const tip = body.querySelector('.chart-tip');
    const toggle = card.querySelector('.chart-toggle');
    let mode = 'chart';
    let lastW = 0;

    const draw = () => {
      if (mode === 'chart') {
        body.innerHTML = '';
        body.append(tip);
        def.render(body, tip);
      } else {
        body.innerHTML = def.tableHtml;
      }
    };
    toggle.addEventListener('click', () => {
      mode = mode === 'chart' ? 'table' : 'chart';
      toggle.setAttribute('aria-pressed', String(mode === 'table'));
      toggle.textContent = mode === 'table' ? 'chart' : 'table';
      draw();
    });

    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0].contentRect.width);
      if (Math.abs(w - lastW) < 8) return;
      lastW = w;
      if (mode === 'chart') requestAnimationFrame(draw);
    });
    ro.observe(body);
    draw();
  }
}

export function chartTableHtml(headers, rows) {
  return `<table class="chart-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
