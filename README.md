# GitHub Easy Download (prototype)

A Manifest V3 Chromium extension prototype that adds a small download panel to GitHub repository pages when release assets look like desktop-app installers.

## Load it locally

1. Extract `github-easy-download.zip` to a folder.
2. Open `chrome://extensions` in Chrome, `brave://extensions` in Brave, or `edge://extensions` in Edge on desktop.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted `github-easy-download` folder (the folder containing `manifest.json`).
5. Open or reload a public GitHub repository page.

## Initial smoke-test checklist

- A desktop app with release assets such as `.exe`, `.dmg`, `.AppImage`, or `.deb` may show a download panel.
- A repository with only source-code archives should not show the panel.
- A repository tagged with a blocked topic such as `cli`, `library`, or `script` should not show the panel.
- A repository with no published latest release should remain quiet.
- Navigating from a repository page to `/issues` or another subpage should remove the panel.
- Click a listed option and verify that it points to the intended GitHub release asset.

## Current prototype limitations

- Detection relies mainly on latest-release assets and repository topics. It does not yet inspect README text or GitHub repository description, so false positives and false negatives are possible.
- It fetches the latest stable release endpoint, not every release or pre-release.
- Asset names do not always reliably identify OS, CPU architecture, installer vs portable status, or whether a ZIP is source code.
- This prototype does not verify the safety of downloaded software.

No build step is required. Keep all five extension files in the same folder.
