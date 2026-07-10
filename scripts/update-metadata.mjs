// pixi run update-metadata
//
// Republish ../lopari/catalog/mods.json with everything the launcher needs
// to know about installable builds, so it never has to touch the GitHub
// API at runtime:
//
//   - `release` (per mod with a stable channel): the latest stable release
//     pin plus the version-picker list. Dev-release mods are polled for a
//     stable channel too; the first stable release stamps `released: true`,
//     which is what moves the mod out of the launcher's pre-release section.
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
// `--live` runs pins-only against this repo's own mods.json (in and out),
// never touching ../lopari. That's the CI mode (update-pins.yml): the
// runner has no private lopari checkout, and pins are the only thing a
// release changes. Authored-data edits still flow through a full local
// run, which refreshes both copies.
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
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const LIVE_ONLY = process.argv.includes("--live");
// Catalog is republished to the Pages site root so the launcher can
// fetch it from lopari.app/mods.json. The lopari repo is private, so
// raw.githubusercontent.com 404s anonymously; lopari.app is public
// Pages and reachable without auth.
const CATALOG_OUT_PATH = resolve(REPO_ROOT, "mods.json");
const CATALOG_PATH = LIVE_ONLY
  ? CATALOG_OUT_PATH
  : resolve(REPO_ROOT, "..", "lopari", "catalog", "mods.json");

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
//
// Each asset is downloaded and hashed: the launcher's
// verify_installer_bytes (commands.rs) skips hash verification when the
// pin has no sha256, so a pin without one silently weakens self-update
// to a size check. No auth header on the download - it's a public asset
// and the token must not ride the redirect to the CDN.
async function fetchLauncherPin() {
  const release = await githubJson(
    `https://api.github.com/repos/${LAUNCHER_REPO}/releases/latest`,
  );
  const assets = release.assets || [];
  const pinAsset = async (suffix) => {
    const a = assets.find((x) => x.name.toLowerCase().endsWith(suffix));
    if (!a) return null;
    const res = await fetch(a.browser_download_url, {
      headers: { "User-Agent": "lopari-metadata-builder" },
    });
    if (!res.ok) {
      throw new Error(
        `GET ${a.browser_download_url} -> ${res.status} ${res.statusText}`,
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length !== a.size) {
      throw new Error(
        `${a.name}: GitHub says ${a.size} bytes, downloaded ${bytes.length}`,
      );
    }
    return {
      name: a.name,
      download_url: a.browser_download_url,
      size_bytes: a.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  return {
    version: stripV(release.tag_name),
    html_url: release.html_url,
    published_at: release.published_at || null,
    setup_exe: await pinAsset("-setup.exe"),
    msi: await pinAsset(".msi"),
  };
}

// ---------- run -------------------------------------------------------------

const errors = [];
const promoted = [];
let releasePinned = 0;
let devPinned = 0;

// Sequential, not parallel: avoids GitHub's secondary rate limit
// (concurrent-request throttle) and keeps the failure log in a
// predictable order. ~30 mods x ~200ms RTT = a few seconds total.
for (const m of publicMods) {
  const hasDevRelease = m.distribution && m.distribution.type === "dev-release";
  if (m.released !== true && !hasDevRelease) continue;
  console.log(`[${m.id}] ${m.repo}`);

  try {
    const channel = await fetchReleaseChannel(m.repo);
    if (channel) {
      m.release = channel;
      releasePinned++;
      if (m.released !== true) {
        // First stable release. Stamping `released` is what moves the
        // mod out of the launcher's pre-release section, hides the
        // dev-build row and routes installs to the stable channel.
        // Never unstamped here: yanking a release is a deliberate act,
        // revert the flag by hand if that ever happens.
        m.released = true;
        promoted.push(m.id);
        console.log("  first stable release found - stamped released: true");
      }
      console.log(
        `  release pinned ${channel.pinned.version} (${channel.versions.length} versions in picker)`,
      );
    } else if (m.released === true) {
      console.log("  release: no stable release with an -installer.zip yet");
    }
  } catch (e) {
    console.warn(`  release: FAILED - ${e.message}`);
    errors.push({ mod: m.id, error: e.message });
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
const sourceOutput = JSON.stringify(catalog, null, 2) + "\n";
// Pages copy is world-readable, so non-public entries (in-progress mods
// not ready to surface) must not ship in it - only public mods.
const publicOutput =
  JSON.stringify({ ...catalog, mods: publicMods }, null, 2) + "\n";

// Pages copy: what the launcher fetches at runtime.
writeFileSync(CATALOG_OUT_PATH, publicOutput, "utf8");
// Write-back to the lopari repo: the hand-authored source of truth, kept
// whole (non-public entries and all) so they aren't lost. It's also baked
// into the launcher binary as the offline / first-run fallback; the
// launcher skips non-public entries at runtime. Commit it there so the
// next build ships current pins.
if (!LIVE_ONLY) writeFileSync(CATALOG_PATH, sourceOutput, "utf8");

console.log(
  `\nwrote ${CATALOG_OUT_PATH}${LIVE_ONLY ? "" : `\nwrote ${CATALOG_PATH}`}\n` +
    `mods: ${publicMods.length}, releases pinned: ${releasePinned}, dev pinned: ${devPinned}, errors: ${errors.length}` +
    (promoted.length ? `\npromoted to released: ${promoted.join(", ")}` : ""),
);

if (errors.length > 0) {
  console.error("\nfailures (commit the partial file or fix and re-run):");
  for (const e of errors) {
    console.error(`  ${e.mod}: ${e.error}`);
  }
  process.exit(1);
}
