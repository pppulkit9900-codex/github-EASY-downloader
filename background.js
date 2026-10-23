// Fetches the latest release for a repo and caches it (GitHub's unauthenticated
// API limit is 60 requests/hour per IP, so caching matters).

const TTL_MS = 60 * 60 * 1000; // 1 hour
const NAME_RE = /^[\w.-]+$/;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ezdl:release') return;
  getRelease(msg.owner, msg.repo)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the channel open for the async response
});

async function getRelease(owner, repo) {
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) throw new Error('bad repo name');

  const key = `release:${owner}/${repo}`.toLowerCase();
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && Date.now() - cached.t < TTL_MS) return cached.v;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });

  if (res.status === 404) {
    // No releases (or private/nonexistent repo) -> cache the "nothing" result.
    await chrome.storage.local.set({ [key]: { t: Date.now(), v: null } });
    return null;
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status}`); // e.g. rate limited; not cached

  const j = await res.json();
  const v = {
    tag: j.tag_name || '',
    url: j.html_url || '',
    published: j.published_at || '',
    assets: (j.assets || []).map((a) => ({
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
    })),
  };
  await chrome.storage.local.set({ [key]: { t: Date.now(), v } });
  return v;
}
