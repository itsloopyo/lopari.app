// pixi run update-metadata
//
// Republish ../lopari/catalog/mods.json with everything the launcher needs
// to know about installable builds, so it never has to touch the GitHub
// API at runtime:
//
//   - `release` (per released mod): the latest stable release pin plus the
//     version-picker list.
//   - `distribution.pinned` (per dev-release mod): the rolling `dev`
//     pre-release snapshot.
//   - `launcher` (top-level): the launcher's own latest release, for the
//     self-update check.
//
// The pinned catalog is written to TWO places:
//
//   - lopari.app/mods.json - the Pages copy the launcher fetches at runtime
//     (and re-fetches every 12 hours while it's open).
//   - ../lopari/catalog/mods.json - the copy baked into the launcher binary
//     via include_str!, used offline / before the first successful fetch.
//
// The lopari repo's catalog stays the source of truth for authored data
// (id, repo, features, hotkeys, known_issues, ...). Pin blocks are volatile
// publish-time metadata this script refreshes in place on every run.
//
// Per-mod failures don't abort the run - any pin block from the previous
// run is left in place (its download URLs are still valid), and a non-empty
// error list at the end exits non-zero so the degraded run is visible.
//
// Auth is REQUIRED. ~30 mods x 1-2 calls each barely fits the 60/hr
// anonymous cap; a retry blows the budget. Token resolution order:
//
//   1. $GITHUB_TOKEN env var (any PAT with public_repo read works).
//   2. `gh auth token` from the GitHub CLI.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CATALOG_PATH = resolve(REPO_ROOT, "..", "lopari", "catalog", "mods.json");
// Catalog is republished to the Pages site root so the launcher can
// fetch it from lopari.app/mods.json. The lopari repo is private, so
// raw.githubusercontent.com 404s anonymously; lopari.app is public
// Pages and reachable without auth.
const CATALOG_OUT_PATH = resolve(REPO_ROOT, "mods.json");

// The launcher's public release mirror. Source of truth for the launcher
// self-update pin - the private lopari source repo never gets release tags.
const LAUNCHER_REPO = "itsloopyo/lopari-releases";

// Git tag of the rolling dev pre-release each mod repo publishes (see
// cameraunlock-core NightlyRelease.psm1).
const DEV_RELEASE_TAG = "dev";

// How many stable releases the launcher's version picker can offer.
const VERSION_LIST_LIMIT = 25;

const TOKEN = resolveToken();

function resolveToken() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim()) {
    console.log("auth: using $GITHUB_TOKEN");
    return process.env.GITHUB_TOKEN.trim();
  }
  try {
    const tok = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (tok) {
      console.log("auth: using `gh auth token`");
      return tok;
    }
  } catch {
    // gh missing or not logged in - fall through to the hard error.
  }
  console.error(
    "\nerror: no GitHub token available.\n\n" +
      "  Pick one:\n" +
      "    (a) `gh auth login` once, then re-run this command.\n" +
      "    (b) Set $env:GITHUB_TOKEN to a PAT with public_repo read scope.\n\n" +
      "  Anonymous access (60 req/hr) is not enough for this catalog.\n"
  );
  process.exit(2);
}

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "lopari-metadata-builder",
  Authorization: `Bearer ${TOKEN}`,
};

async function githubJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---------- catalog ---------------------------------------------------------

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
const publicMods = catalog.mods.filter((m) => m.public === true);

console.log(
  `catalog: ${catalog.mods.length} entries total, ${publicMods.length} public (the rest are dev-only).`,
);

function installerAsset(release) {
  return (release.assets || []).find((a) =>
    a.name.toLowerCase().endsWith("-installer.zip"),
  );
}

function stripV(tag) {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

// Stable-release channel for a released mod: one /releases call covers both
// the latest pin and the version-picker list. Shape matches the launcher's
// `ReleaseChannel` struct (lopari/src-tauri/src/catalog/mods.rs).
// catalog::validate enforces an https://github.com/ host on every
// download_url, so don't ever emit a different host here.
//
// Pre-releases (the rolling `dev` tag) and drafts are excluded - the dev
// channel is surfaced separately via `distribution.pinned`, and the version
// picker is for stable builds only. Returns null when no stable release
// carries a *-installer.zip yet.
async function fetchReleaseChannel(repo) {
  const releases = await githubJson(
    `https://api.github.com/repos/${repo}/releases?per_page=${VERSION_LIST_LIMIT}`,
  );
  const versions = releases
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => {
      const asset = installerAsset(r);
      return {
        tag_name: r.tag_name,
        version: stripV(r.tag_name),
        name: r.name || null,
        html_url: r.html_url,
        published_at: r.published_at || null,
        zip_filename: asset ? asset.name : null,
        download_url: asset ? asset.browser_download_url : null,
        size_bytes: asset ? asset.size : null,
      };
    });
  const latest = versions.find((v) => v.download_url);
  if (!latest) return null;
  return {
    pinned: {
      version: latest.version,
      tag_name: latest.tag_name,
      name: latest.name,
      html_url: latest.html_url,
      published_at: latest.published_at,
      zip_filename: latest.zip_filename,
      download_url: latest.download_url,
      size_bytes: latest.size_bytes,
    },
    versions,
  };
}

// Resolve the latest `dev` pre-release for a mod and shape it into the
// launcher's `PinnedDevRelease` struct (catalog/mods.rs): four fields,
// no more. catalog::validate enforces an https://github.com/ host on
// download_url, so don't ever emit a different host here. Returns null
// when the release exists but has no -installer.zip asset yet.
async function fetchDevReleasePin(repo) {
  const release = await githubJson(
    `https://api.github.com/repos/${repo}/releases/tags/${DEV_RELEASE_TAG}`,
  );
  const asset = installerAsset(release);
  if (!asset) return null;
  // Mirror how the dev publisher titles releases: strip the
  // "Development build " prefix, else fall back to the tag.
  const name = release.name || "";
  const version = name.startsWith("Development build ")
    ? name.slice("Development build ".length).trim()
    : release.tag_name || DEV_RELEASE_TAG;
  return {
    version,
    built_at: release.published_at || "",
    zip_filename: asset.name,
    download_url: asset.browser_download_url,
  };
}

// Launcher self-update pin. Shape matches the launcher's `LauncherPin`
// struct (catalog/mod.rs). Prefers the NSIS -setup.exe (it handles
// killing the running launcher); the .msi rides along as a fallback.
async function fetchLauncherPin() {
  const release = await githubJson(
    `https://api.github.com/repos/${LAUNCHER_REPO}/releases/latest`,
  );
  const assets = release.assets || [];
  const pinAsset = (suffix) => {
    const a = assets.find((x) => x.name.toLowerCase().endsWith(suffix));
    return a
      ? { name: a.name, download_url: a.browser_download_url, size_bytes: a.size }
      : null;
  };
  return {
    version: stripV(release.tag_name),
    html_url: release.html_url,
    published_at: release.published_at || null,
    setup_exe: pinAsset("-setup.exe"),
    msi: pinAsset(".msi"),
  };
}

// ---------- run -------------------------------------------------------------

const errors = [];
let releasePinned = 0;
let devPinned = 0;

// Sequential, not parallel: avoids GitHub's secondary rate limit
// (concurrent-request throttle) and keeps the failure log in a
// predictable order. ~30 mods x ~200ms RTT = a few seconds total.
for (const m of publicMods) {
  const hasRelease = m.released === true;
  const hasDevRelease = m.distribution && m.distribution.type === "dev-release";
  if (!hasRelease && !hasDevRelease) continue;
  console.log(`[${m.id}] ${m.repo}`);

  if (hasRelease) {
    try {
      const channel = await fetchReleaseChannel(m.repo);
      if (channel) {
        m.release = channel;
        releasePinned++;
        console.log(
          `  release pinned ${channel.pinned.version} (${channel.versions.length} versions in picker)`,
        );
      } else {
        console.log("  release: no stable release with an -installer.zip yet");
      }
    } catch (e) {
      console.warn(`  release: FAILED - ${e.message}`);
      errors.push({ mod: m.id, error: e.message });
    }
  }

  if (hasDevRelease) {
    try {
      const pin = await fetchDevReleasePin(m.repo);
      if (pin) {
        m.distribution.pinned = pin;
        devPinned++;
        console.log(`  dev pinned ${pin.version} (${pin.built_at})`);
      } else {
        console.log(`  dev: '${DEV_RELEASE_TAG}' release has no -installer.zip yet`);
      }
    } catch (e) {
      console.warn(`  dev: FAILED - ${e.message}`);
      errors.push({ mod: m.id, error: e.message });
    }
  }
}

try {
  catalog.launcher = await fetchLauncherPin();
  console.log(`[launcher] ${LAUNCHER_REPO}\n  pinned ${catalog.launcher.version}`);
} catch (e) {
  console.warn(`[launcher] FAILED - ${e.message}`);
  errors.push({ mod: "(launcher)", error: e.message });
}

catalog.updated_at = new Date().toISOString();

// Two-space indent matches the source file's style; subscribers fetching
// this file see a normal JSON shape, not a one-liner.
const output = JSON.stringify(catalog, null, 2) + "\n";

// Pages copy: what the launcher fetches at runtime.
writeFileSync(CATALOG_OUT_PATH, output, "utf8");
// Write-back to the lopari repo: what gets baked into the launcher binary
// as the offline / first-run fallback. Commit it there so the next build
// ships current pins.
writeFileSync(CATALOG_PATH, output, "utf8");

console.log(
  `\nwrote ${CATALOG_OUT_PATH}\nwrote ${CATALOG_PATH}\n` +
    `mods: ${publicMods.length}, releases pinned: ${releasePinned}, dev pinned: ${devPinned}, errors: ${errors.length}`,
);

if (errors.length > 0) {
  console.error("\nfailures (commit the partial file or fix and re-run):");
  for (const e of errors) {
    console.error(`  ${e.mod}: ${e.error}`);
  }
  process.exit(1);
}
