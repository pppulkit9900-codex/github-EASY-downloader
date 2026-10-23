(() => {
  'use strict';
  const { buildModel } = globalThis.EZDL;

  const CARD_ID = 'ezdl-container';
  const OS_LABEL = { windows: ['🪟', 'Windows'], mac: ['🍎', 'macOS'], linux: ['🐧', 'Linux'] };
  const RESERVED = new Set([
    'about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'copilot', 'customer-stories',
    'dashboard', 'enterprise', 'events', 'explore', 'features', 'issues', 'join', 'login', 'marketplace',
    'new', 'notifications', 'orgs', 'organizations', 'premium-support', 'pricing', 'pulls', 'readme',
    'resources', 'search', 'security', 'settings', 'sitemap', 'solutions', 'sponsors', 'stars', 'team',
    'topics', 'trending', 'users', 'watching', 'why-github',
  ]);
  const NAME_RE = /^[\w.-]+$/;

  const state = { key: null, model: undefined, busy: false };

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
    const ua = navigator.userAgent;
    const plat = (uad?.platform || '').toLowerCase();
    let os = null;
    let arch = 'x64';

    if (plat.includes('windows') || /Windows/.test(ua)) {
      os = 'windows';
      // Check if it's a 32-bit Windows environment (Win32 / IA32 without Win64/WOW64)
      if (/Win32|IA32|x86/.test(ua) && !/Win64|WOW64/.test(ua)) {
        arch = 'x86';
      }
    } else if (plat.includes('mac') || /Macintosh|Mac OS X/.test(ua)) {
      os = 'mac';
    } else if (/Android/.test(ua)) {
      os = null;
    } else if (plat.includes('linux') || /Linux|X11|CrOS/.test(ua)) {
      os = 'linux';
    }

    try {
      const hi = await uad?.getHighEntropyValues?.(['architecture']);
      if (hi?.architecture === 'arm') arch = 'arm64';
      else if (hi?.architecture === 'x86' && os === 'windows') arch = 'x86';
    } catch {}
    return { os, arch };
  }

  const removeWidget = () => document.getElementById(CARD_ID)?.remove();

  function render(model, user, key) {
    removeWidget();

    const container = h('div', { id: CARD_ID, class: 'ezdl-wrapper' });
    const hasApp = Boolean(model && model.sections && model.sections.length > 0);

    // Floating trigger ball
    const ball = h('button', { 
      class: 'ezdl-ball' + (hasApp ? ' ezdl-ball--active' : ' ezdl-ball--sad'),
      title: hasApp ? 'Click for Downloads' : 'No installer binaries found'
    }, hasApp ? '📥' : '😢');

    container.append(ball);

    // Build the popup menu card
    const card = h('div', { class: 'ezdl-popup' });

    if (hasApp) {
      const sections = [...model.sections].sort((a, b) => (b.os === user.os) - (a.os === user.os));

      const closeBtn = h('button', { class: 'ezdl-close', title: 'Close' }, '×');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        container.classList.remove('ezdl-open');
      });

      card.append(
        h('header', { class: 'ezdl-head' },
          h('div', { class: 'ezdl-head-left' },
            h('span', { class: 'ezdl-title', text: '⚡ Instant Download' }),
            model.tag && h('span', { class: 'ezdl-ver', text: model.tag })
          ),
          closeBtn
        )
      );

      if (user.os && !sections.some((s) => s.os === user.os)) {
        card.append(h('p', { class: 'ezdl-note', text: `No ${OS_LABEL[user.os][1]} version in latest release.` }));
      }

      sections.forEach((s, i) => {
        const mine = s.os === user.os;
        const [emoji, label] = OS_LABEL[s.os];
        const det = h('details', { class: 'ezdl-os', open: i === 0 },
          h('summary', {},
            h('span', { class: 'ezdl-sum' },
              h('span', { text: `${emoji} ${label}` }),
              mine && h('span', { class: 'ezdl-badge', text: 'Your system' }))));
        
        s.rows.forEach((r, j) => {
          det.append(
            h('a', { class: 'ezdl-btn' + (mine && j === 0 ? ' ezdl-btn--primary' : ''), href: r.url, rel: 'noopener' },
              h('span', { class: 'ezdl-btn-main', text: r.title }),
              r.sub && h('span', { class: 'ezdl-btn-sub', text: r.sub }))
          );
        });
        card.append(det);
      });

      const date = model.published
        ? new Date(model.published).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : '';
      card.append(
        h('footer', { class: 'ezdl-foot' },
          model.url && h('a', { href: model.url, target: '_blank', text: 'All files & notes' }),
          date && h('span', { text: date }))
      );
    } else {
      // Sad popup message for non-app repos
      card.append(
        h('div', { class: 'ezdl-no-app' },
          h('span', { class: 'ezdl-sad-icon', text: '😢' }),
          h('div', { class: 'ezdl-sad-title', text: 'No Desktop Installers' }),
          h('p', { class: 'ezdl-sad-desc', text: 'This repository doesn\'t seem to host pre-compiled executable files.' })
        )
      );
    }

    container.append(card);

    // Toggle on Click
    ball.addEventListener('click', (e) => {
      e.stopPropagation();
      container.classList.toggle('ezdl-open');
    });

    // Toggle on Hover with a smooth 1-second grace delay on leave
    let hideTimeout;
    container.addEventListener('mouseenter', () => {
      clearTimeout(hideTimeout);
      container.classList.add('ezdl-open');
    });
    container.addEventListener('mouseleave', () => {
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        container.classList.remove('ezdl-open');
      }, 500);
    });

    document.body.append(container);
  }

  async function run() {
    const m = parseRepo();
    if (!m) {
      removeWidget();
      state.key = null;
      state.model = undefined;
      return;
    }
    const key = `${m.owner}/${m.repo}`;
    if (state.key !== key) {
      removeWidget();
      state.key = key;
      state.model = undefined;
    }
    if (state.busy || state.model === null) return;
    if (state.model && document.getElementById(CARD_ID)) return;

    state.busy = true;
    try {
      const [res, user] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'ezdl:release', owner: m.owner, repo: m.repo }),
        detectUser(),
      ]);
      if (currentKey() !== key) return;

      if (!res?.ok || !res.data) {
        state.model = null;
        render(null, user, key); // Render sad ball if API returns nothing/no releases
        return;
      }

      const topics = [...document.querySelectorAll('a.topic-tag')].map((a) => a.textContent.trim().toLowerCase());
      state.model = buildModel(res.data, topics, user);
      render(state.model, user, key);
    } catch {
      state.model = null;
    } finally {
      state.busy = false;
    }
  }

  const safeRun = () => run().catch(() => {});
  ['turbo:load', 'turbo:render', 'pjax:end'].forEach((ev) => document.addEventListener(ev, safeRun));
  window.addEventListener('popstate', safeRun);
  setInterval(safeRun, 1500);
  safeRun();
})();