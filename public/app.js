// Boot: auth gate, router, topbar, theme.
import { $, $$, busyClick, closeAllModals, toast } from './helpers.js';
import { accountModal, boatsModal, businessModal, pages, setCurrentUser, setRefresh, usersModal } from './views.js';

let view = $('#view');
let currentUser = null;
const phoneLayout = matchMedia('(max-width: 520px)');
const mainNav = $('#main-nav');
const mobileNavToggle = $('#mobile-nav-toggle');

function setMobileNav(open) {
  mainNav.classList.toggle('is-expanded', open);
  mobileNavToggle.setAttribute('aria-expanded', String(open));
}

function routeFromHash() {
  if (location.hash.replace(/\/$/, '') === '#/orders') history.replaceState(null, '', '#/pos');
  const h = location.hash.replace(/^#\//, '');
  return pages[h] ? h : 'dashboard';
}

async function render() {
  if (!currentUser) return;
  const key = routeFromHash();
  const page = pages[key];
  document.title = `${page.title} — agro-OPS`;
  $('#page-title').textContent = page.title;
  $('#page-sub').textContent = typeof page.sub === 'function' ? page.sub() : (page.sub ?? '');
  $$('.nav-item').forEach(a => {
    const on = a.dataset.route === key;
    a.classList.toggle('active', on);
    if (on && !phoneLayout.matches) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  const actions = $('#page-actions');
  actions.textContent = '';
  for (const a of page.actions ?? []) {
    if (a.show && !a.show()) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (a.primary ? ' btn-primary' : '');
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    actions.append(b);
  }

  // Replace the view node wholesale so per-page listeners don't stack.
  const fresh = view.cloneNode(false);
  view.replaceWith(fresh);
  view = fresh;
  fresh.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await page.render(fresh);
  } catch (err) {
    if (err.status === 401) return; // login screen is taking over
    console.error(err);
    fresh.innerHTML = `<div class="card error-box">Couldn't load this page (${err.message}). Is the server running?</div>`;
  }
  updateNavCount();
}

async function updateNavCount() {
  try {
    const rows = await fetch('/api/sell-first').then(r => (r.ok ? r.json() : null));
    const el = $('[data-count="sell-first"]');
    if (!Array.isArray(rows)) return;
    el.hidden = rows.length === 0;
    el.textContent = String(rows.length);
  } catch { /* nav badge is best-effort */ }
  try {
    // Harvest GRNs this user can verify, and their own that were sent back.
    const waiting = await fetch('/api/harvest-grns/waiting').then(r => (r.ok ? r.json() : null));
    const el = $('[data-count="shipments"]');
    if (!waiting) return;
    const n = waiting.verify + waiting.correct;
    el.hidden = n === 0;
    el.textContent = String(n);
  } catch { /* nav badge is best-effort */ }
}

// ---- login ----

const LOGIN_SCENES = [
  '/login-scene-aisle.jpg',
  '/login-scene-dock.jpg',
  '/login-scene-market.jpg',
];
const LOGIN_SCENE_MS = 50000;
let loginSceneTimer = 0;

function otherScene(current) {
  const pool = LOGIN_SCENES.filter(src => src !== current);
  return pool[Math.floor(Math.random() * pool.length)];
}

function showLogin(defaultAdmin) {
  if ($('.login-wrap')) return;
  if (loginSceneTimer) {
    clearInterval(loginSceneTimer);
    loginSceneTimer = 0;
  }
  closeAllModals();
  $('.shell').inert = true; // keep focus and clicks inside the login card
  const wrap = document.createElement('div');
  wrap.className = 'login-wrap';
  wrap.innerHTML = `
    <div class="login-scenes" aria-hidden="true">
      <div class="login-scene login-scene-back"></div>
      <div class="login-scene login-scene-front"></div>
    </div>
    <form class="login-card">
      <div class="login-brand">
        <svg viewBox="0 0 64 64" width="44" height="44" aria-hidden="true">
          <g fill="#3bea62">
            <path d="M31 45C18 38 4 26 12 6c12 6 16 22 19 39z"/>
            <path d="M33 45c13-7 27-19 19-39-12 6-16 22-19 39z"/>
            <path d="M29.6 40h4.8V56a2.4 2.4 0 0 1-4.8 0V40z"/>
          </g>
        </svg>
        <div class="login-word">agro-<span>OPS</span></div>
      </div>
      <h1>Welcome back</h1>
      <p class="login-sub">Log in to your workspace</p>
      <label class="login-field">
        <span>Username</span>
        <span class="login-control">
          <svg class="login-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 19.2c.8-3.2 3.2-4.8 6.5-4.8s5.7 1.6 6.5 4.8"/></svg>
          <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="username">
        </span>
      </label>
      <label class="login-field">
        <span>Password</span>
        <span class="login-control">
          <svg class="login-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="6" y="10.5" width="12" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>
          <input name="password" type="password" autocomplete="current-password" placeholder="password">
          <button class="login-eye" type="button" aria-label="Show password" aria-pressed="false">
            <svg class="eye-on" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.4"/></svg>
            <svg class="eye-off" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" hidden><path d="M3 4.5 20 19"/><path d="M9.5 6.4A9 9 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3.1 3.6"/><path d="M6.2 7.2C4 8.8 2.5 12 2.5 12S6 18 12 18c1.1 0 2.2-.2 3.2-.6"/><path d="M9.8 9.9a2.4 2.4 0 0 0 3.4 3.3"/></svg>
          </button>
        </span>
      </label>
      <div class="login-row">
        <label class="login-check"><input name="remember" type="checkbox" checked> Remember me</label>
        <button class="login-link" type="button" data-help-open>Forgot password?</button>
      </div>
      <div class="login-error" data-error role="alert"></div>
      <button class="login-submit" type="submit">Log in <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 10h12M12 5.5 16.5 10 12 14.5"/></svg></button>
      <p class="login-foot">Need access? <button class="login-link" type="button" data-help-open>Contact your admin</button></p>
      <p class="login-help" data-help hidden tabindex="-1">An admin can add you or reset a password. Ask them, then sign in here.</p>
      ${defaultAdmin ? `<p class="login-note">Sign in as <b>admin</b> using the password supplied during setup.</p>` : ''}
    </form>`;
  document.body.append(wrap);
  const back = $('.login-scene-back', wrap);
  const front = $('.login-scene-front', wrap);
  let current = otherScene('');
  const paint = (el, src) => { el.style.backgroundImage = `url("${src}")`; };
  paint(back, current);
  for (const src of LOGIN_SCENES) {
    const img = new Image();
    img.src = src;
  }
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion) {
    let fading = false;
    const advance = () => {
      if (!wrap.isConnected) {
        clearInterval(loginSceneTimer);
        loginSceneTimer = 0;
        return;
      }
      if (fading) return;
      fading = true;
      const next = otherScene(current);
      paint(front, next);
      front.classList.remove('is-on');
      front.offsetHeight;
      front.classList.add('is-on');
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        front.removeEventListener('transitionend', onEnd);
        paint(back, next);
        front.style.transition = 'none';
        front.classList.remove('is-on');
        front.offsetHeight;
        front.style.transition = '';
        current = next;
        fading = false;
      };
      const onEnd = e => {
        if (e.propertyName === 'opacity') finish();
      };
      front.addEventListener('transitionend', onEnd);
      setTimeout(finish, 1200);
    };
    loginSceneTimer = setInterval(advance, LOGIN_SCENE_MS);
  }
  const form = $('form', wrap);
  const errEl = $('[data-error]', wrap);
  const password = $('[name=password]', form);
  const eye = $('.login-eye', form);
  eye.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    $('.eye-on', eye).hidden = show;
    $('.eye-off', eye).hidden = !show;
  });
  const help = $('[data-help]', form);
  form.addEventListener('click', e => {
    if (!e.target.closest('[data-help-open]')) return;
    help.hidden = false;
    help.focus();
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    if (btn.disabled) return;
    btn.disabled = true;
    errEl.textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('[name=username]', form).value.trim(),
          password: password.value,
          remember: $('[name=remember]', form).checked,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign-in failed');
      location.reload();
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
    }
  });
  $('[name=username]', wrap).focus();
}

// ---- shell wiring after auth ----

function initShell() {
  const u = currentUser;
  setCurrentUser(u);
  $('#user-line').hidden = false;
  $('#user-name').textContent = u.name;
  $('#user-role').textContent = u.role === 'operations_hod' ? 'Operations HOD' : u.role;
  $('#account-btn').hidden = false;
  $('#logout-btn').hidden = false;
  if (u.role === 'admin') $('#users-btn').hidden = false;
  if (u.role === 'admin' || ['nahuzaam', 'najah', 'ibbe'].includes(String(u.username || '').toLowerCase())) {
    $('#boats-btn').hidden = false;
  }
  // Business details are admin-only (the server enforces the PATCH).
  if (u.role !== 'admin') $('#biz-btn').hidden = true;

  $('#account-btn').addEventListener('click', () => accountModal(u));
  $('#users-btn').addEventListener('click', () => usersModal(u));
  $('#boats-btn').addEventListener('click', () => boatsModal());
  busyClick($('#logout-btn'), async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch { /* signing out anyway */ }
    location.reload();
  });

  mobileNavToggle.addEventListener('click', () => {
    const open = mobileNavToggle.getAttribute('aria-expanded') === 'false';
    setMobileNav(open);
    if (open) (mainNav.querySelector('.active') ?? mainNav.querySelector('a'))?.focus();
  });
  document.addEventListener('click', e => {
    if (!mainNav.classList.contains('is-expanded') || mobileNavToggle.contains(e.target)) return;
    const navLink = e.target.closest('#main-nav a');
    if (!mainNav.contains(e.target) || navLink) {
      if (navLink && !navLink.hasAttribute('data-mobile-primary') && phoneLayout.matches) {
        mobileNavToggle.focus({ preventScroll: true });
      }
      setMobileNav(false);
    }
  });
  phoneLayout.addEventListener('change', () => setMobileNav(false));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !phoneLayout.matches || !mainNav.classList.contains('is-expanded')) return;
    setMobileNav(false);
    mobileNavToggle.focus({ preventScroll: true });
  });
  window.addEventListener('hashchange', () => {
    setMobileNav(false);
    if (phoneLayout.matches) window.scrollTo(0, 0);
    render();
  });
  window.addEventListener('auth-lost', () => {
    if ($('.login-wrap')) return; // parallel 401s — one overlay, one toast
    toast('Signed out — session ended', 'err');
    showLogin(false);
  });
  setRefresh(render);
  render();
}

// ---- theme. Canopy is the default. Auto still follows the system when chosen. ----
const THEME_IDS = ['light', 'dark', 'citrus', 'grove', 'canopy', 'depth'];
const THEME_LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark', citrus: 'Citrus', grove: 'Grove', canopy: 'Canopy', depth: 'Depth' };
const quickBtn = $('#quick-toggle');
const quickMenu = $('#quick-menu');
const quickMain = $('#quick-main');
const themesBtn = $('#themes-btn');
const themeList = $('#theme-list');
const currentTheme = () => {
  const t = localStorage.getItem('baazaru-theme');
  if (t === 'auto' || THEME_IDS.includes(t)) return t;
  return 'canopy';
};
const menuItems = () => [...quickMenu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
  .filter(el => !el.closest('[hidden]'));
const resetThemes = () => {
  themeList.hidden = true;
  quickMain.hidden = false;
  themesBtn.setAttribute('aria-expanded', 'false');
};
const closeQuick = () => {
  quickMenu.hidden = true;
  quickBtn.setAttribute('aria-expanded', 'false');
  resetThemes();
};
const openQuick = () => {
  showTheme();
  resetThemes();
  quickMenu.hidden = false;
  quickBtn.setAttribute('aria-expanded', 'true');
};
const openThemes = () => {
  showTheme();
  quickMain.hidden = true;
  themeList.hidden = false;
  themesBtn.setAttribute('aria-expanded', 'true');
  themeList.querySelector('[aria-checked="true"]')?.focus();
};
const showTheme = () => {
  const id = currentTheme();
  quickMenu.querySelectorAll('[data-theme-current]').forEach(el => {
    el.textContent = THEME_LABELS[id];
  });
  themeList.querySelectorAll('[data-theme-choice]').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.themeChoice === id));
  });
};
const applyTheme = id => {
  if (id === 'auto') {
    localStorage.setItem('baazaru-theme', 'auto');
    delete document.documentElement.dataset.theme;
  } else if (THEME_IDS.includes(id)) {
    localStorage.setItem('baazaru-theme', id);
    document.documentElement.dataset.theme = id;
  }
  showTheme();
};
quickBtn.addEventListener('click', e => {
  e.stopPropagation();
  setMobileNav(false);
  if (quickMenu.hidden) openQuick();
  else closeQuick();
});
quickMenu.addEventListener('click', e => {
  const choice = e.target.closest('[data-theme-choice]');
  if (choice) {
    e.stopPropagation();
    applyTheme(choice.dataset.themeChoice);
    return;
  }
  if (e.target.closest('#themes-btn')) {
    e.stopPropagation();
    openThemes();
    return;
  }
  if (e.target.closest('#themes-back')) {
    e.stopPropagation();
    resetThemes();
    themesBtn.focus();
    return;
  }
  if (e.target.closest('.quick-item')) closeQuick();
});
quickMenu.addEventListener('keydown', e => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); closeQuick(); quickBtn.focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
  else if (e.key === 'End') { e.preventDefault(); items.at(-1)?.focus(); }
});
document.addEventListener('click', e => {
  if (quickMenu.contains(e.target) || quickBtn.contains(e.target)) return;
  closeQuick();
});
showTheme();

busyClick($('#biz-btn'), () => businessModal());

// ---- phone fields take digits only ----
// Only the newly typed, pasted, or autofilled text is cut down to digits (a
// pasted +960 in front of a 7-digit number is dropped). Text already in the
// field stays until someone deletes it, so an older entry holding two numbers
// and a slash is never run together into one long number.
const PHONE_DIGITS = 15;
const phoneWas = new WeakMap();
const isPhone = el => el instanceof HTMLInputElement && el.matches('[data-phone]');
const phoneDigits = text =>
  text.replace(/^\s*(?:\+|00)\s*960[\s-]*(?=(?:\d\D*){7}$)/, '').replace(/\D/g, '');
function keepDigits(el) {
  const was = phoneWas.get(el) ?? el.defaultValue;
  const now = el.value;
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) head++;
  let tail = 0;
  while (tail < was.length - head && tail < now.length - head
    && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  const added = now.slice(head, now.length - tail);
  const room = Math.max(0, PHONE_DIGITS - (now.length - added.length));
  const digits = phoneDigits(added).slice(0, room);
  if (digits !== added) {
    el.value = now.slice(0, head) + digits + now.slice(now.length - tail);
    if (document.activeElement === el) el.setSelectionRange(head + digits.length, head + digits.length);
  }
  phoneWas.set(el, el.value);
}
document.addEventListener('focusin', e => { if (isPhone(e.target)) phoneWas.set(e.target, e.target.value); });
document.addEventListener('input', e => { if (isPhone(e.target) && !e.isComposing) keepDigits(e.target); }, true);
document.addEventListener('compositionend', e => { if (isPhone(e.target)) keepDigits(e.target); }, true);

// ---- boot ----
(async () => {
  let me = { user: null, default_admin: false };
  try {
    const res = await fetch('/api/me');
    if (res.ok) me = await res.json();
  } catch { /* fall through to login */ }
  if (!me.user) {
    showLogin(me.default_admin);
    return;
  }
  currentUser = me.user;
  initShell();
})();
