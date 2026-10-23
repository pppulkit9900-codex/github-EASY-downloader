// Pure logic (no DOM). Exposed as globalThis.EZDL so content.js can use it
// and it can be tested in Node.
(() => {
  'use strict';

  // ---------- Tunable settings ----------
  const CONFIG = {
    // A repo must reach this "looks like a desktop app" score to show the card.
    // dmg / AppImage / msix = 2, setup-style exe/msi = 2, plain exe/msi = 1,
    // pkg / flatpak / snap = 1, deb / rpm = 0.5. Zips/tarballs = 0.
    minAppScore: 2,
    // Repos with any of these GitHub topics are treated as dev tooling, not apps.
    blockedTopics: new Set([
      'cli', 'command-line', 'command-line-tool', 'command-line-app',
      'library', 'framework', 'sdk', 'api', 'npm-package', 'devops',
      'kubernetes', 'docker', 'terraform', 'ansible', 'shell', 'bash',
      'script', 'scripts', 'dotfiles', 'awesome', 'awesome-list',
      'tutorial', 'boilerplate', 'template',
    ]),
  };

  // ---------- Asset classification ----------
  // ext -> [os, kind, format priority]
  const BY_EXT = {
    exe: ['windows', 'installer', 3],
    msi: ['windows', 'installer', 2],
    msix: ['windows', 'installer', 1],
    msixbundle: ['windows', 'installer', 1],
    appx: ['windows', 'installer', 1],
    dmg: ['mac', 'installer', 3],
    pkg: ['mac', 'installer', 2],
    appimage: ['linux', 'portable', 3],
    deb: ['linux', 'installer', 3],
    rpm: ['linux', 'installer', 2],
    flatpak: ['linux', 'installer', 1],
    snap: ['linux', 'installer', 1],
  };
  const EXT_RE = /\.(exe|msi|msixbundle|msix|appx|dmg|pkg|appimage|deb|rpm|flatpak|snap)$/;
  const ARCHIVE_RE = /\.(zip|7z|tar\.gz|tgz|tar\.xz|txz|tar\.bz2)$/;
  const SKIP_RE = /(^|[^a-z0-9])(src|source|sources|debug|symbols|dbg)([^a-z0-9]|$)/;
  const OS_TOKEN = {
    mac: /(^|[^a-z])(mac|macos|macosx|osx|darwin|apple)([^a-z]|$)/,
    windows: /(^|[^a-z])(win|win32|win64|windows)([^a-z]|$)/,
    linux: /(^|[^a-z])linux([^a-z]|$)/,
  };

  function archOf(n) {
    if (/(arm64|aarch64|armv8)/.test(n)) return 'arm64';
    if (/universal/.test(n)) return 'universal';
    if (/(armv7|armhf|armv6|arm32)/.test(n)) return 'arm32';
    if (/(x86[_-]64|x64|amd64|win64)/.test(n)) return 'x64';
    if (/(ia32|i[3-6]86|x86|win32)/.test(n)) return 'x86';
    return 'any'; // unlabeled
  }

  function classify(asset) {
    const n = (asset.name || '').toLowerCase();
    if (!n || SKIP_RE.test(n)) return null;

    const base = {
      name: asset.name,
      url: asset.url,
      size: asset.size,
      arch: archOf(n),
      extLabel: (asset.name.match(/\.(tar\.(gz|xz|bz2)|[a-z0-9]+)$/i) || [''])[0],
    };

    const e = n.match(EXT_RE);
    if (e) {
      let [os, kind, prio] = BY_EXT[e[1]];
      if (os === 'windows' && /portable/.test(n)) kind = 'portable';
      const format = e[1] === 'msixbundle' || e[1] === 'appx' ? 'msix' : e[1];
      return { ...base, os, kind, format, prio, setup: /setup|install/.test(n) };
    }

    if (ARCHIVE_RE.test(n)) {
      let os = Object.keys(OS_TOKEN).find((k) => OS_TOKEN[k].test(n));
      if (!os && /portable/.test(n)) os = 'windows'; // "-portable.zip" is almost always Windows
      if (!os) return null;
      const zip = /\.(zip|7z)$/.test(n);
      return { ...base, os, kind: 'portable', format: zip ? 'zip' : 'tar', prio: zip ? 2 : 1, setup: false };
    }
    return null;
  }

  // ---------- "Is this a normal desktop app?" ----------
  function appScore(cands) {
    const best = {};
    for (const c of cands) {
      if (c.kind === 'portable' && c.format !== 'appimage') continue; // archives/portable exes say little
      const w =
        { dmg: 2, appimage: 2, msix: 2, pkg: 1, flatpak: 1, snap: 1, deb: 0.5, rpm: 0.5 }[c.format] ??
        (c.setup ? 2 : 1); // exe / msi
      best[c.format] = Math.max(best[c.format] || 0, w);
    }
    return Object.values(best).reduce((a, b) => a + b, 0);
  }

  // ---------- Picking the right file per OS ----------
  function archScore(a, target) {
    if (a === target) return 3;
    if (a === 'universal') return 2;
    if (a === 'any') return 1.5;
    if (target === 'x64' && a === 'x86') return 0.5;
    if (target === 'arm64' && a === 'x64') return 0.4; // runs via emulation
    return -1;
  }

  function bestFor(list, target) {
    return list
      .map((c) => ({ c, s: archScore(c.arch, target) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || b.c.prio - a.c.prio || b.c.size - a.c.size)[0]?.c;
  }

  // ---------- Per-OS rows: every CPU variant is listed, the visitor's own is flagged ----------
  const ARCH_LABEL = { x64: '64-bit', x86: '32-bit', arm64: 'ARM64', arm32: 'ARM 32-bit', universal: 'Universal', any: '' };
  const ARCH_ORDER = ['x64', 'x86', 'arm64', 'universal', 'any', 'arm32'];

  // Best file for each CPU type inside one group (same OS + kind, and same format for Linux installers).
  function perArch(list, os) {
    const byArch = new Map();
    for (const c of list) {
      if (c.arch === 'arm32' && os !== 'linux') continue;
      const cur = byArch.get(c.arch);
      if (!cur || c.prio > cur.prio || (c.prio === cur.prio && c.size > cur.size)) byArch.set(c.arch, c);
    }
    if (byArch.has('x64')) byArch.delete('any'); // an unlabeled build next to an x64 one is almost always the same thing
    return [...byArch.values()];
  }

  // Flag the pick that suits the visitor's machine (only on their own OS) and list it first.
  function orderPicks(picks, user, os) {
    let best = null;
    let bestScore = -1;
    if (os === user.os) {
      for (const c of picks) {
        const s = archScore(c.arch, user.arch);
        if (os === 'linux' && s < 1.5) continue; // Windows/macOS can emulate other CPUs; Linux can't
        if (s > bestScore) { bestScore = s; best = c; }
      }
    }
    return picks
      .map((c) => ({ ...c, mine: c === best, choice: picks.length > 1 }))
      .sort((a, b) => (b.mine - a.mine) || ARCH_ORDER.indexOf(a.arch) - ARCH_ORDER.indexOf(b.arch));
  }

  // Mac users often don't know their chip, so show both unless a universal build exists.
  function macPicks(list, user) {
    const onMac = user.os === 'mac';
    const uni = bestFor(list.filter((c) => c.arch === 'universal'), 'universal');
    if (uni) return [{ ...uni, label: 'macOS', mine: onMac, choice: false }];

    const arm = bestFor(list.filter((c) => c.arch === 'arm64'), 'arm64');
    const intel = bestFor(list.filter((c) => c.arch !== 'arm64'), 'x64');
    const out = [arm, intel].filter(Boolean);
    const both = out.length > 1;
    return out
      .map((c) => {
        const isArm = c.arch === 'arm64';
        const mine = onMac && (both ? isArm === (user.arch === 'arm64') : !isArm || user.arch === 'arm64');
        return { ...c, label: isArm ? 'Apple Silicon' : both ? 'Intel' : 'macOS', mine, choice: both };
      })
      .sort((a, b) => b.mine - a.mine);
  }

  const LINUX_NAMES = {
    deb: 'Debian / Ubuntu',
    rpm: 'Fedora / openSUSE',
    flatpak: 'Flatpak',
    snap: 'Snap',
  };

  function fmtSize(b) {
    if (!b) return '';
    const mb = b / 1048576;
    return mb >= 100 ? `${Math.round(mb)} MB` : mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
  }

  function toRow(c) {
    let title;
    if (c.label) title = c.label + (c.kind === 'portable' ? ' (portable)' : '');
    else if (c.os === 'linux' && c.kind === 'installer') title = LINUX_NAMES[c.format] || 'Installer';
    else if (c.format === 'appimage') title = 'Portable (AppImage)';
    else title = c.kind === 'portable' ? 'Portable' : 'Installer';
    if (!c.label && ARCH_LABEL[c.arch]) title += ` \u00b7 ${ARCH_LABEL[c.arch]}`;
    return {
      title,
      sub: [c.extLabel, fmtSize(c.size)].filter(Boolean).join(' \u00b7 '),
      url: c.url,
      kind: c.kind,
      mine: Boolean(c.mine),
      choice: Boolean(c.choice),
    };
  }

  function rowsFor(os, list, user) {
    const rows = [];
    for (const kind of ['installer', 'portable']) {
      const ofKind = list.filter((c) => c.kind === kind);
      if (!ofKind.length) continue;
      if (os === 'mac') rows.push(...macPicks(ofKind, user));
      else if (os === 'linux' && kind === 'installer') {
        for (const fmt of Object.keys(LINUX_NAMES)) {
          const group = ofKind.filter((c) => c.format === fmt);
          if (group.length) rows.push(...orderPicks(perArch(group, os), user, os));
        }
      } else {
        rows.push(...orderPicks(perArch(ofKind, os), user, os));
      }
    }
    return rows.slice(0, 8).map(toRow);
  }

  // ---------- Public: release -> UI model (or null if not an app) ----------
  function buildModel(release, topics, user) {
    if (!release || !Array.isArray(release.assets)) return null;
    if ((topics || []).some((t) => CONFIG.blockedTopics.has(t))) return null;

    // Only ever link to GitHub-hosted downloads.
    const cands = release.assets
      .filter((a) => typeof a.url === 'string' && a.url.startsWith('https://github.com/'))
      .map(classify)
      .filter(Boolean);
    if (appScore(cands) < CONFIG.minAppScore) return null;

    const sections = [];
    for (const os of ['windows', 'mac', 'linux']) {
      const rows = rowsFor(os, cands.filter((c) => c.os === os), user);
      if (rows.length) sections.push({ os, rows });
    }
    if (!sections.length) return null;
    return { tag: release.tag, url: release.url, published: release.published, sections };
  }

  // ---------- Visitor detection (pure, so it can be tested) ----------
  // Chrome reports architecture "x86" for BOTH 32- and 64-bit Intel/AMD; `bitness` tells them apart.
  function userFromHints({ platform = '', ua = '', architecture = '', bitness = '' } = {}) {
    const plat = platform.toLowerCase();
    let os = null;
    if (plat.includes('windows') || /Windows/.test(ua)) os = 'windows';
    else if (plat.includes('mac') || /Macintosh|Mac OS X/.test(ua)) os = 'mac';
    else if (/Android/.test(ua)) os = null;
    else if (plat.includes('linux') || /Linux|X11|CrOS/.test(ua)) os = 'linux';

    let arch;
    if (architecture === 'arm') arch = bitness === '32' ? 'arm32' : 'arm64';
    else if (architecture === 'x86') arch = bitness === '32' ? 'x86' : 'x64';
    else if (os === 'windows') arch = /Win64|WOW64|x64|amd64/i.test(ua) ? 'x64' : 'x86'; // no client hints: use the UA string
    else if (os === 'mac') arch = 'arm64'; // can't be told from the UA; most Macs in use are Apple Silicon
    else arch = 'x64';
    return { os, arch };
  }

  globalThis.EZDL = { CONFIG, classify, appScore, buildModel, userFromHints };
})();