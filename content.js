(() => {
  'use strict';
  const { buildModel, userFromHints } = globalThis.EZDL;

  const CARD_ID = 'ezdl-container';
  const POS_KEY = 'ezdl:pos';
  const RETRY_MS = 30000;
  const NOTICE_MS = 2000; // how long the "no installers" note stays on screen
  const NOTICE_TEXT = '(no desktop installers)';
  const OS_LABEL = { windows: ['🪟', 'Windows'], mac: ['🍎', 'macOS'], linux: ['🐧', 'Linux'] };
  const RESERVED = new Set([
    'about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'copilot', 'customer-stories',
    'dashboard', 'enterprise', 'events', 'explore', 'features', 'issues', 'join', 'login', 'marketplace',
    'new', 'notifications', 'orgs', 'organizations', 'premium-support', 'pricing', 'pulls', 'readme',
    'resources', 'search', 'security', 'settings', 'sitemap', 'solutions', 'sponsors', 'stars', 'team',
    'topics', 'trending', 'users', 'watching', 'why-github',
  ]);
  const NAME_RE = /^[\w.-]+$/;

  // model: undefined = not loaded yet, null = nothing to download, object = show it
  const state = { key: null, model: undefined, busy: false, retryAt: 0 };
  let ui = null; // the widget currently on screen
  let savedPos = { side: 'right', y: 0.5 }; // y = vertical centre as a fraction of the window height

  const posReady = (async () => {
    try {
      const p = (await chrome.storage.local.get(POS_KEY))[POS_KEY];
      if (p && (p.side === 'left' || p.side === 'right') && typeof p.y === 'number') {
        savedPos = { side: p.side, y: Math.min(Math.max(p.y, 0.03), 0.97) };
      }
    } catch { /* storage unavailable: keep defaults */ }
  })();

  // ---------- helpers ----------
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const viewW = () => document.documentElement.clientWidth || window.innerWidth; // excludes the scrollbar

  function parseRepo() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    const [owner, repo] = parts;
    if (RESERVED.has(owner.toLowerCase()) || !NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
    return { owner, repo };
  }

  const currentKey = () => {
    const r = parseRepo();
    return r ? `${r.owner}/${r.repo}` : null;
  };

  async function detectUser() {
    const uad = navigator.userAgentData;
    let hi = {};
    try {
      hi = (await uad?.getHighEntropyValues?.(['architecture', 'bitness'])) || {};
    } catch { /* fall back to the UA string */ }
    return userFromHints({
      platform: uad?.platform || '',
      ua: navigator.userAgent,
      architecture: hi.architecture || '',
      bitness: hi.bitness || '',
    });
  }

  function removeWidget() {
    if (ui) {
      clearTimeout(ui.hideTimer);
      clearTimeout(ui.snapTimer);
    }
    document.getElementById(CARD_ID)?.remove();
    ui = null;
  }

  // ---------- position (draggable, remembered) ----------
  function applyPos(container) {
    container.classList.toggle('ezdl-left', savedPos.side === 'left');
    const hgt = container.offsetHeight || 36;
    container.style.top = `${clamp(savedPos.y * window.innerHeight - hgt / 2, 8, window.innerHeight - hgt - 8)}px`;
  }

  // Vertically centre a floating element (popup / big sad emoji) on the ball, kept inside the window.
  function placeFloating(container, el) {
    const wr = container.getBoundingClientRect();
    const cy = wr.top + wr.height / 2;
    const eh = el.offsetHeight;
    const top = clamp(cy - eh / 2, 8, window.innerHeight - eh - 8);
    el.style.top = `${top - wr.top}px`;
    el.style.transformOrigin = `${container.classList.contains('ezdl-left') ? 'left' : 'right'} ${Math.round(cy - top)}px`;
  }

  function enableDrag(me) {
    const { container, ball } = me;
    let d = null;

    ball.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      clearTimeout(me.snapTimer);
      const r = container.getBoundingClientRect();
      d = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false };
      try { ball.setPointerCapture(e.pointerId); } catch { /* not critical */ }
    });

    ball.addEventListener('pointermove', (e) => {
      if (!d || e.pointerId !== d.id) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return; // below this it's a click, not a drag
        d.moved = true;
        me.pinned = false;
        container.classList.remove('ezdl-open', 'ezdl-snapping');
        container.classList.add('ezdl-dragging');
        container.style.right = 'auto';
      }
      const w = container.offsetWidth;
      const hh = container.offsetHeight;
      container.style.left = `${clamp(e.clientX - d.ox, 0, viewW() - w)}px`;
      container.style.top = `${clamp(e.clientY - d.oy, 8, window.innerHeight - hh - 8)}px`;
    });

    const end = (e) => {
      if (!d || e.pointerId !== d.id) return;
      const moved = d.moved;
      d = null;
      try { ball.releasePointerCapture(e.pointerId); } catch { /* not critical */ }
      if (!moved) return;

      me.justDragged = true; // swallow the click that follows a drag
      setTimeout(() => { me.justDragged = false; }, 0);

      // Snap to the nearest side edge, keep the height.
      const r = container.getBoundingClientRect();
      const side = r.left + r.width / 2 < viewW() / 2 ? 'left' : 'right';
      savedPos = { side, y: clamp((r.top + r.height / 2) / window.innerHeight, 0.03, 0.97) };
      container.classList.add('ezdl-snapping');
      container.style.left = `${side === 'left' ? 0 : viewW() - r.width}px`;
      me.snapTimer = setTimeout(() => {
        if (!container.isConnected) return;
        container.classList.remove('ezdl-snapping', 'ezdl-dragging');
        container.style.left = '';
        container.style.right = '';
        applyPos(container);
      }, 280);
      try { chrome.storage.local.set({ [POS_KEY]: savedPos }).catch(() => {}); } catch { /* ignore */ }
    };
    ball.addEventListener('pointerup', end);
    ball.addEventListener('pointercancel', end);
  }

  // ---------- popup ----------
  function openPopup() {
    if (!ui?.popup) return;
    placeFloating(ui.container, ui.popup);
    ui.container.classList.add('ezdl-open');
  }

  function closePopup() {
    if (!ui?.popup) return;
    ui.pinned = false;
    ui.container.classList.remove('ezdl-open');
  }

  function buildPopup(model, user) {
    const sections = [...model.sections].sort((a, b) => (b.os === user.os) - (a.os === user.os));
    const popup = h('div', { class: 'ezdl-popup' });

    const closeBtn = h('button', { class: 'ezdl-close', title: 'Close', 'aria-label': 'Close', type: 'button' }, '×');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closePopup();
    });

    popup.append(
      h('header', { class: 'ezdl-head' },
        h('div', { class: 'ezdl-head-left' },
          h('span', { class: 'ezdl-title', text: '⚡ Instant Download' }),
          model.tag && h('span', { class: 'ezdl-ver', text: model.tag })
        ),
        closeBtn
      )
    );

    if (user.os && !sections.some((s) => s.os === user.os)) {
      popup.append(h('p', { class: 'ezdl-note', text: `No ${OS_LABEL[user.os][1]} version in latest release.` }));
    }

    sections.forEach((s, i) => {
      const mine = s.os === user.os;
      const [emoji, label] = OS_LABEL[s.os];
      const det = h('details', { class: 'ezdl-os', open: i === 0 },
        h('summary', {},
          h('span', { class: 'ezdl-sum' },
            h('span', { text: `${emoji} ${label}` }),
            mine && h('span', { class: 'ezdl-badge', text: 'Your system' }))));

      let primaryUsed = false;
      s.rows.forEach((r) => {
        const yours = mine && r.mine;
        const primary = yours && !primaryUsed;
        if (primary) primaryUsed = true;
        det.append(
          h('a', { class: 'ezdl-btn' + (primary ? ' ezdl-btn--primary' : ''), href: r.url, rel: 'noopener' },
            h('span', { class: 'ezdl-btn-main' },
              r.title,
              // Only worth saying when there's a choice (e.g. 32-bit vs 64-bit)
              yours && r.choice && h('span', { class: 'ezdl-you', text: '(your system)' })),
            r.sub && h('span', { class: 'ezdl-btn-sub', text: r.sub }))
        );
      });
      popup.append(det);
    });

    const date = model.published
      ? new Date(model.published).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    popup.append(
      h('footer', { class: 'ezdl-foot' },
        model.url && h('a', { href: model.url, target: '_blank', rel: 'noopener', text: 'All files & notes' }),
        date && h('span', { text: date }))
    );
    return popup;
  }

  // ---------- the ball (there is something to download) ----------
  function render(model, user) {
    removeWidget();

    const container = h('div', { id: CARD_ID, class: 'ezdl-wrapper' });
    const ball = h('button', {
      class: 'ezdl-ball ezdl-ball--active',
      type: 'button',
      title: 'Downloads available · drag to move',
      'aria-label': 'Show download options',
    }, '📥');
    const popup = buildPopup(model, user);
    container.append(ball, popup);
    document.body.append(container);
    applyPos(container);

    const me = (ui = { container, ball, popup, pinned: false, justDragged: false, hideTimer: 0, snapTimer: 0 });

    // Hover opens it; a click pins it open (click again, ×, or click elsewhere to close).
    ball.addEventListener('click', (e) => {
      e.stopPropagation();
      if (me.justDragged) { me.justDragged = false; return; }
      if (me.pinned) closePopup();
      else { me.pinned = true; openPopup(); }
    });
    container.addEventListener('mouseenter', () => {
      if (container.classList.contains('ezdl-dragging')) return;
      clearTimeout(me.hideTimer);
      openPopup();
    });
    container.addEventListener('mouseleave', () => {
      if (me.pinned) return;
      clearTimeout(me.hideTimer);
      me.hideTimer = setTimeout(() => container.classList.remove('ezdl-open'), 500);
    });

    enableDrag(me);
  }

  // ---------- nothing to download: a small note slides in, waits 2s, slides back out ----------
  function renderSad() {
    removeWidget();

    const container = h('div', { id: CARD_ID, class: 'ezdl-wrapper ezdl-sad' });
    const note = h('div', { class: 'ezdl-notice', role: 'status' },
      h('span', { class: 'ezdl-notice-icon', text: '💀' }),
      h('span', { text: NOTICE_TEXT }));
    container.append(note);
    document.body.append(container);
    applyPos(container);

    const me = (ui = { container, hideTimer: 0, snapTimer: 0 });
    // Each step checks the widget is still the current one (SPA navigation may have removed it).
    const later = (fn, ms) => setTimeout(() => { if (container.isConnected && ui === me) fn(); }, ms);

    void note.offsetWidth; // flush the off-screen starting state so the slide-in animates
    note.classList.add('ezdl-notice--in');
    later(() => note.classList.remove('ezdl-notice--in'), 300 + NOTICE_MS); // slide back out
    later(() => removeWidget(), 300 + NOTICE_MS + 400);
  }

  // ---------- main loop ----------
  async function run() {
    const m = parseRepo();
    if (!m) {
      removeWidget();
      state.key = null;
      state.model = undefined;
      state.retryAt = 0;
      return;
    }
    const key = `${m.owner}/${m.repo}`;
    if (state.key !== key) {
      removeWidget();
      state.key = key;
      state.model = undefined;
      state.retryAt = 0;
    }
    if (state.busy || state.model === null) return;
    if (state.model && document.getElementById(CARD_ID)) return;
    if (Date.now() < state.retryAt) return;

    state.busy = true;
    try {
      const [res, user] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'ezdl:release', owner: m.owner, repo: m.repo }),
        detectUser(),
        posReady,
      ]);
      if (currentKey() !== key) return;

      // Rate limit / network error: say nothing (we don't actually know) and try again later.
      if (!res?.ok) { state.retryAt = Date.now() + RETRY_MS; return; }

      const topics = [...document.querySelectorAll('a.topic-tag')].map((a) => a.textContent.trim().toLowerCase());
      state.model = res.data ? buildModel(res.data, topics, user) : null;
      if (state.model) render(state.model, user);
      else renderSad();
    } catch {
      state.retryAt = Date.now() + RETRY_MS;
    } finally {
      state.busy = false;
    }
  }

  const safeRun = () => run().catch(() => {});
  ['turbo:load', 'turbo:render', 'pjax:end'].forEach((ev) => document.addEventListener(ev, safeRun));
  window.addEventListener('popstate', safeRun);
  // Clicking anywhere else closes a pinned popup
  document.addEventListener('pointerdown', (e) => {
    if (ui?.pinned && !ui.container.contains(e.target)) closePopup();
  }, true);
  window.addEventListener('resize', () => {
    if (ui?.container.isConnected && !ui.container.classList.contains('ezdl-dragging')) applyPos(ui.container);
  });
  setInterval(safeRun, 1500);
  safeRun();
})();