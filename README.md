# lopari.app

Marketing site for [Lopari](https://github.com/itsloopyo/lopari-releases) - a desktop launcher for the head-tracking-capable games on your PC.

Static site, deployed via GitHub Pages from `main`. No build step for normal edits; the `update-latest` workflow runs on a `repository_dispatch` from the (private) `lopari` source repo whenever a release is cut, and rewrites the download section of `index.html` between the `LATEST_RELEASE` markers.

## Files

- `index.html` - landing page
- `privacy.html` - privacy policy
- `terms.html` - terms of service
- `eula.html` - end user licence agreement (shown at install time too)
- `styles.css` - shared styles
- `favicon.png` - app mark
- `CNAME` - custom domain (lopari.app)
- `.nojekyll` - disables Jekyll processing on GH Pages
- `scripts/update-latest.mjs` - templater that the release workflow runs
- `scripts/update-metadata.mjs` - regenerates `mods.json` from the lopari catalog (run via `pixi run update-metadata`); also writes the pinned copy back to `../lopari/catalog/mods.json` so the launcher bakes it in as its offline fallback
- `mods.json` - the lopari catalog with release / dev-build / launcher-update pins for every public mod; Lopari fetches this on startup (and every 12 hours) and never queries the GitHub API itself

## Deploy

In the repo settings on GitHub: Pages → Source = `Deploy from a branch`, Branch = `main`, Folder = `/`. Point the `lopari.app` DNS at GitHub Pages and the site is live.
