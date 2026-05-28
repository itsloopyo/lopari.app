// pixi run update-metadata
//
// Republish ../lopari/catalog/mods.json to lopari.app/mods.json with the
// latest successful nightly workflow run stamped into each mod's
// `nightly.pinned` block. Subscribers (and the launcher's dev override)
// fetch lopari.app/mods.json at startup and short-circuit GitHub API
// nightly lookups when the pin is present - one cheap CDN GET instead
// of N rate-limited API calls per detail-pane visit.
//
// The lopari repo's catalog is the source of truth for authored data
// (id, repo, features, hotkeys, known_issues, ...). Pinning is volatile
// publish-time metadata that doesn't belong in source control, so it's
// injected here and lives only in the republished mods.json.
//
// Per-mod nightly failures don't abort the run - the mod's nightly
// block is left without a `pinned` field and the launcher falls back
// to a live lookup at install time. A non-empty error list at the end
// exits non-zero so CI / pre-commit can catch a degraded run.
//
// Auth is REQUIRED. ~30 mods × 1 call each barely fits the 60/hr
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

// ---------- catalog ---------------------------------------------------------

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
const publicMods = catalog.mods.filter((m) => m.public === true);

console.log(
  `catalog: ${catalog.mods.length} entries total, ${publicMods.length} public (the rest are dev-only).`,
);

// Nightly surfacing is pinned to `main` everywhere - the launcher's
// NightlyConfig schema has no `branch` field, so feature/bugfix branches
// can be pushed and shared privately via direct nightly.link URLs
// without ever becoming the lopari nightly. Refuse a stray `branch:`
// override here too so a hand-edit to lopari.app/mods.json can't
// quietly widen the surface.
const NIGHTLY_BRANCH = "main";

async function fetchLatestNightly(repo, nightlyCfg) {
  if (nightlyCfg.branch && nightlyCfg.branch !== NIGHTLY_BRANCH) {
    throw new Error(
      `nightly.branch override (${nightlyCfg.branch}) not allowed - all nightlies are pinned to ${NIGHTLY_BRANCH}`,
    );
  }
  const workflow = nightlyCfg.workflow || "build";
  const artifactName = resolveArtifactName(repo, nightlyCfg);
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}.yml/runs` +
    `?branch=${NIGHTLY_BRANCH}&status=success&per_page=1`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const run = (body.workflow_runs || [])[0];
  if (!run) return null;

  // Shape matches the launcher's `PinnedNightly` struct in
  // lopari/src-tauri/src/catalog/mods.rs - five fields, no more.
  // catalog::validate enforces an https://nightly.link/ host on
  // download_url, so don't ever emit a different host here.
  return {
    head_sha: run.head_sha,
    commit_subject:
      (run.head_commit && firstLine(run.head_commit.message)) || "",
    created_at: run.created_at,
    run_html_url: run.html_url,
    download_url: `https://nightly.link/${repo}/workflows/${workflow}/${NIGHTLY_BRANCH}/${artifactName}.zip`,
  };
}

function resolveArtifactName(repo, nightlyCfg) {
  if (nightlyCfg && nightlyCfg.artifact) return nightlyCfg.artifact;
  const slug = repo.split("/").pop();
  return deriveArtifactName(slug);
}

// Mirrors the Rust side `derive_artifact_name` in catalog/mods.rs.
function deriveArtifactName(slug) {
  const parts = slug.split("-").map((p) => {
    if (p.toLowerCase() === "headtracking") return "HeadTracking";
    return p.charAt(0).toUpperCase() + p.slice(1);
  });
  return parts.join("") + "-installer";
}

function firstLine(s) {
  return (s || "").split("\n")[0].trimEnd();
}

// Git tag of the rolling dev pre-release each mod repo publishes (see
// cameraunlock-core NightlyRelease.psm1). Must match DEV_RELEASE_TAG in
// the launcher's commands.rs.
const DEV_RELEASE_TAG = "dev";

// Resolve the latest `dev` pre-release for a mod and shape it into the
// launcher's `PinnedDevRelease` struct (catalog/mods.rs): four fields,
// no more. catalog::validate enforces an https://github.com/ host on
// download_url, so don't ever emit a different host here. Returns null
// when the release exists but has no -installer.zip asset yet.
async function fetchDevReleasePin(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${DEV_RELEASE_TAG}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const release = await res.json();
  const asset = (release.assets || []).find((a) =>
    a.name.toLowerCase().endsWith("-installer.zip"),
  );
  if (!asset) return null;
  // Mirror the launcher's dev_version_from_release: strip the
  // "Development build " title prefix, else fall back to the tag.
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

// ---------- run -------------------------------------------------------------

const errors = [];
let pinned = 0;
let devPinned = 0;

// Sequential, not parallel: avoids GitHub's secondary rate limit
// (concurrent-request throttle) and keeps the failure log in a
// predictable order. ~30 mods × ~200ms RTT ≈ 6s total.
for (const m of publicMods) {
  const hasNightly = Boolean(m.nightly);
  const hasDevRelease = m.distribution && m.distribution.type === "dev-release";
  if (!hasNightly && !hasDevRelease) continue;
  console.log(`[${m.id}] ${m.repo}`);

  if (hasNightly) {
    try {
      const pin = await fetchLatestNightly(m.repo, m.nightly);
      if (pin) {
        m.nightly.pinned = pin;
        pinned++;
        console.log(`  pinned ${pin.head_sha.slice(0, 7)} (${pin.created_at})`);
      } else {
        console.log(`  nightly: no successful runs on ${NIGHTLY_BRANCH} yet`);
      }
    } catch (e) {
      console.warn(`  nightly: FAILED - ${e.message}`);
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

// Republish the (possibly mutated) catalog. JSON.stringify with two-
// space indent matches the source file's style; subscribers fetching
// this file see a normal JSON shape, not a one-liner.
writeFileSync(
  CATALOG_OUT_PATH,
  JSON.stringify(catalog, null, 2) + "\n",
  "utf8",
);
console.log(
  `\nwrote ${CATALOG_OUT_PATH}\nmods: ${publicMods.length}, nightly pinned: ${pinned}, dev pinned: ${devPinned}, errors: ${errors.length}`,
);

if (errors.length > 0) {
  console.error("\nfailures (commit the partial file or fix and re-run):");
  for (const e of errors) {
    console.error(`  ${e.mod}: ${e.error}`);
  }
  process.exit(1);
}
