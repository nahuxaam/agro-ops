// Signature boxes on a printed form. Tap an empty box, draw, and save; the
// page reloads with the signature printed in the box. A signed box shows who
// signed and when, and an admin or the person who took it can remove it.
const INK = '#1b2f6e';
const sheet = document.querySelector('[data-sign-doc]');
const boxes = sheet ? [...sheet.querySelectorAll('[data-sign]')] : [];

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r1 = n => Math.round(n * 10) / 10;

if (boxes.length) {
  document.documentElement.classList.add('can-sign');
  const hint = document.querySelector('[data-sign-hint]');
  if (hint) {
    if (boxes.every(b => b.dataset.signed)) hint.textContent = 'Every box on this form is signed.';
    hint.hidden = false;
  }
  for (const box of boxes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (box.dataset.signed) {
      btn.className = 'esig-btn esig-btn-signed';
      btn.textContent = `${box.dataset.signLabel}: signed by ${box.dataset.signedBy}`;
    } else {
      btn.className = 'esig-btn';
      btn.textContent = 'Sign here';
      btn.setAttribute('aria-label', `Sign here: ${box.dataset.signLabel}`);
    }
    (box.querySelector('[data-ink]') || box).append(btn);
    box.addEventListener('click', () => (box.dataset.signed ? showSigned(box) : showPad(box)));
  }
}

// Reload in signing mode, so the print dialog stays closed.
const reopen = () => location.replace(`${location.pathname}?sign`);

async function send(method, url, body) {
  let res;
  try {
    res = await fetch(url, body
      ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method });
  } catch {
    throw new Error('agro-OPS could not be reached. Check the connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('You are signed out. Sign in to agro-OPS, then open this form again.');
  if (!res.ok) throw new Error(data.error || 'That did not go through. Try again.');
  return data;
}

function dialog(html, box, { dismiss = false, onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sp-backdrop';
  backdrop.innerHTML = `<div class="sp" role="dialog" aria-modal="true" aria-labelledby="sp-title" tabindex="-1">
    <h2 id="sp-title">${esc(box.dataset.signLabel)}</h2>
    <p class="sp-doc">${esc(box.dataset.documentLabel || sheet?.dataset.signForm || '')} ${esc(sheet?.dataset.signRef || '')}</p>
    ${html}
  </div>`;
  const panel = backdrop.firstElementChild;
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') keepFocus(e, panel);
  };
  const close = () => {
    onClose?.();
    backdrop.remove();
    document.documentElement.classList.remove('sp-open');
    document.removeEventListener('keydown', onKey, true);
    box.querySelector('.esig-btn')?.focus({ preventScroll: true });
  };
  document.addEventListener('keydown', onKey, true);
  if (dismiss) backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  panel.addEventListener('click', e => { if (e.target.closest('[data-cancel]')) close(); });
  document.body.append(backdrop);
  document.documentElement.classList.add('sp-open');
  panel.closeSignature = close;
  return panel;
}

function keepFocus(e, panel) {
  const items = [...panel.querySelectorAll('button, input')].filter(el => !el.disabled && el.offsetParent);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function showPad(box, submit) {
  const submitLabel = box.dataset.submitLabel || 'Sign and verify';
  let observer = null;
  const panel = dialog(`
    <label class="sp-name"><span>Name of the person signing</span>
      <input name="signer" maxlength="80" autocomplete="off" autocapitalize="words" spellcheck="false" value="${esc(box.dataset.signName)}" ${submit || box.dataset.signNameLocked ? 'readonly' : ''}>
    </label>
    <div class="sp-area">
      <canvas role="img" aria-label="Signature pad. Draw the signature with a finger, pen, or mouse."></canvas>
      <span class="sp-line" aria-hidden="true"></span>
      <span class="sp-hint" aria-hidden="true">Sign above the line</span>
    </div>
    <p class="sp-err" role="alert" hidden></p>
    <div class="sp-actions">
      <button type="button" class="sp-quiet" data-clear disabled>Clear</button>
      <span class="sp-gap"></span>
      <button type="button" data-cancel>Cancel</button>
      <button type="button" class="sp-primary" data-save>${submit ? submitLabel : 'Save signature'}</button>
    </div>`, box, { onClose: () => observer?.disconnect() });

  const input = panel.querySelector('[name=signer]');
  const area = panel.querySelector('.sp-area');
  const canvas = panel.querySelector('canvas');
  const clear = panel.querySelector('[data-clear]');
  const save = panel.querySelector('[data-save]');
  const err = panel.querySelector('.sp-err');
  const ctx = canvas.getContext('2d');
  const strokes = [];
  let current = null;
  let pointer = null;
  let size = { w: 0, h: 0 };
  let frame = 0;

  const fail = (message, field) => {
    err.textContent = message;
    err.hidden = false;
    field?.focus();
  };

  const draw = () => {
    frame = 0;
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      if (s.length === 1) {
        ctx.beginPath();
        ctx.arc(s[0].x, s[0].y, 1.3, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length - 1; i++) {
        ctx.quadraticCurveTo(s[i].x, s[i].y, (s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2);
      }
      ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y);
      ctx.stroke();
    }
    area.classList.toggle('inked', strokes.length > 0);
    clear.disabled = strokes.length === 0;
  };
  const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

  // Keep the canvas sharp on high-density screens, and keep what is already
  // drawn in place if the pad changes size (a phone turning sideways).
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (size.w && (r.width !== size.w || r.height !== size.h)) {
      const sx = r.width / size.w;
      const sy = r.height / size.h;
      for (const s of strokes) for (const p of s) { p.x *= sx; p.y *= sy; }
    }
    size = { w: r.width, h: r.height };
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  if ('ResizeObserver' in window) {
    observer = new ResizeObserver(fit);
    observer.observe(canvas);
  }
  fit();

  const add = e => {
    const r = canvas.getBoundingClientRect();
    const p = {
      x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
      y: Math.min(Math.max(e.clientY - r.top, 0), r.height),
    };
    const last = current[current.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1) return;
    current.push(p);
  };

  canvas.addEventListener('pointerdown', e => {
    if (current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    pointer = e.pointerId;
    current = [];
    strokes.push(current);
    add(e);
    err.hidden = true;
    redraw();
  });
  canvas.addEventListener('pointermove', e => {
    if (!current || e.pointerId !== pointer) return;
    const many = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const one of many.length ? many : [e]) add(one);
    redraw();
  });
  const end = e => {
    if (!current || e.pointerId !== pointer) return;
    current = null;
    pointer = null;
    redraw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);

  clear.addEventListener('click', () => {
    strokes.length = 0;
    current = null;
    pointer = null;
    err.hidden = true;
    draw();
  });

  const enough = () => {
    let points = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
      for (const p of s) {
        points++;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    return points >= 6 && (maxX - minX) + (maxY - minY) >= 24;
  };

  save.addEventListener('click', async () => {
    const name = input.value.trim().replace(/\s+/g, ' ');
    if (name.length < 2) return fail('Type the name of the person signing.', input);
    if (!enough()) return fail('Draw the signature in the box first.');
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      if (submit) {
        await submit(strokes.map(s => s.flatMap(p => [r1(p.x), r1(p.y)])));
        panel.closeSignature();
        return;
      }
      await send('POST', '/api/signatures', {
        doc: sheet.dataset.signDoc,
        id: Number(sheet.dataset.signId),
        slot: box.dataset.sign,
        name,
        strokes: strokes.map(s => s.flatMap(p => [r1(p.x), r1(p.y)])),
      });
      reopen();
    } catch (e) {
      save.disabled = false;
      save.textContent = submit ? submitLabel : 'Save signature';
      fail(e.message);
    }
  });

  // A phone keyboard would cover the pad, so only a desk computer starts in
  // the name field.
  if (!input.value && matchMedia('(hover: hover)').matches) input.focus();
  else panel.focus({ preventScroll: true });
}

function showSigned(box) {
  const ink = box.querySelector('.esig svg');
  const panel = dialog(`
    <div class="sp-preview">${ink ? ink.outerHTML : ''}</div>
    <p class="sp-meta">Signed by <b>${esc(box.dataset.signedBy)}</b> on ${esc(box.dataset.signedAt)}</p>
    <p class="sp-err" role="alert" hidden></p>
    <div class="sp-actions" data-view>
      <button type="button" class="sp-quiet sp-warn" data-remove>Remove signature</button>
      <span class="sp-gap"></span>
      <button type="button" class="sp-primary" data-cancel>Done</button>
    </div>
    <div class="sp-actions" data-ask hidden>
      <p class="sp-ask">Take this signature off the form?</p>
      <span class="sp-gap"></span>
      <button type="button" data-keep>Keep</button>
      <button type="button" class="sp-danger" data-drop>Remove</button>
    </div>`, box, { dismiss: true });

  panel.querySelector('.sp-preview svg')?.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const view = panel.querySelector('[data-view]');
  const ask = panel.querySelector('[data-ask]');
  const err = panel.querySelector('.sp-err');
  const remove = panel.querySelector('[data-remove]');
  const keep = panel.querySelector('[data-keep]');
  const drop = panel.querySelector('[data-drop]');

  remove.addEventListener('click', () => {
    view.hidden = true;
    ask.hidden = false;
    err.hidden = true;
    keep.focus();
  });
  keep.addEventListener('click', () => {
    ask.hidden = true;
    view.hidden = false;
    remove.focus();
  });
  drop.addEventListener('click', async () => {
    drop.disabled = true;
    drop.textContent = 'Removing…';
    try {
      await send('DELETE', `/api/signatures/${box.dataset.signed}`);
      reopen();
    } catch (e) {
      drop.disabled = false;
      drop.textContent = 'Remove';
      ask.hidden = true;
      view.hidden = false;
      err.textContent = e.message;
      err.hidden = false;
    }
  });
  panel.querySelector('[data-cancel]').focus();
}

export function verifyWithSignature(name, label, submit, actionLabel = 'Sign and verify') {
  const box = document.createElement('div');
  box.dataset.signName = name;
  box.dataset.signLabel = actionLabel;
  box.dataset.submitLabel = actionLabel;
  box.dataset.documentLabel = label;
  showPad(box, submit);
}
