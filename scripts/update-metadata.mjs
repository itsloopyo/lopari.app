// pixi run update-metadata
//
// Walks ../lopari/catalog/mods.json and for each public mod, queries
// GitHub for:
//   - the latest published release (tag, html_url, installer asset URL)
//   - the latest successful nightly workflow run on the configured branch
//     (head SHA, commit subject, nightly.link download URL)
//
// Writes the combined result to metadata.json at the lopari.app repo root.
// Lopari fetches that single file at startup, falls back to a locally
// cached copy if the site is unreachable. Reduces per-mod GitHub API
// calls in the client from N (one per mod, every detail-pane visit) to
// zero (one fetch, of one file we own).
//
// Per-mod failures don't abort the run - if GitHub 404s on a mod's
// release, that mod's `latest_release` is `null` in the output and the
// rest of the catalog still publishes. A non-empty error list at the
// end is non-zero exit so CI / pre-commit can catch a degraded run.
//
// Auth is REQUIRED. 26 mods × 2 calls each = ~52 requests per run, and
// the anonymous 60/hr cap means a single run barely fits while a retry
// blows the budget. The script resolves a token in this order:
//
//   1. $GITHUB_TOKEN env var (any classic or fine-grained PAT with
//      public_repo read works).
//   2. `gh auth token` from the GitHub CLI (which the release script
//      already uses, so most devs already have it set up).
//
// If neither is available the script aborts immediately rather than
// fetching anonymously - a degraded metadata.json that quietly drops
// half the catalog is worse than a clean error.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CATALOG_PATH = resolve(REPO_ROOT, "..", "lopari", "catalog", "mods.json");
const OUT_PATH = resolve(REPO_ROOT, "metadata.json");

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
  `catalog: ${catalog.mods.length} entries total, ${publicMods.length} public (the rest are dev-only).`
);

// ---------- per-mod fetchers ------------------------------------------------

async function fetchLatestRelease(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(url, { headers });
  if (res.status === 404) {
    // Repo exists but no published release yet (or repo is private to us
    // even with the PAT, which a public-catalog mod shouldn't be).
    return null;
  }
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const r = await res.json();
  // Match the shape Lopari's `update::ReleaseInfo` expects - we'll
  // deserialize this on the Rust side, so keep field names aligned
  // with the GitHub API response (snake_case, the underlying API
  // names) since the existing ReleaseInfo struct already reads those.
  return {
    tag_name: r.tag_name,
    name: r.name,
    html_url: r.html_url,
    published_at: r.published_at,
    body: r.body || "",
    assets: (r.assets || []).map((a) => ({
      name: a.name,
      browser_download_url: a.browser_download_url,
      size: a.size,
      content_type: a.content_type,
    })),
  };
}

async function fetchLatestNightly(repo, nightlyCfg) {
  const workflow = nightlyCfg.workflow || "build";
  const branch = nightlyCfg.branch || "main";
  const artifactName = resolveArtifactName(repo, nightlyCfg);
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}.yml/runs` +
    `?branch=${encodeURIComponent(branch)}&status=success&per_page=1`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const run = (body.workflow_runs || [])[0];
  if (!run) return null;

  const downloadUrl = `https://nightly.link/${repo}/workflows/${workflow}/${branch}/${artifactName}.zip`;
  const headSha = run.head_sha;
  const shortSha = headSha.slice(0, 7);
  const commitSubject =
    (run.head_commit && firstLine(run.head_commit.message)) || "";

  return {
    head_sha: headSha,
    short_sha: shortSha,
    branch: run.head_branch || branch,
    commit_subject: commitSubject,
    created_at: run.created_at,
    run_html_url: run.html_url,
    download_url: downloadUrl,
    artifact_name: artifactName,
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

// ---------- run -------------------------------------------------------------

const errors = [];
const modsOut = {};

// Sequential, not parallel: avoids GitHub's secondary rate limit
// (concurrent-request throttle) and keeps the failure log in a
// predictable order. 26 mods × 2 calls × ~200ms RTT ≈ 10s total.
for (const m of publicMods) {
  console.log(`\n[${m.id}] ${m.repo}`);
  const entry = {
    repo: m.repo,
    latest_release: null,
    nightly: null,
  };

  if (m.released) {
    try {
      entry.latest_release = await fetchLatestRelease(m.repo);
      if (entry.latest_release) {
        console.log(`  release: ${entry.latest_release.tag_name}`);
      } else {
        console.log(`  release: none published yet`);
      }
    } catch (e) {
      console.warn(`  release: FAILED - ${e.message}`);
      errors.push({ mod: m.id, kind: "release", error: e.message });
    }
  } else {
    console.log(`  release: skipped (catalog.released=false)`);
  }

  if (m.nightly) {
    try {
      entry.nightly = await fetchLatestNightly(m.repo, m.nightly);
      if (entry.nightly) {
        console.log(
          `  nightly: ${entry.nightly.short_sha} (${entry.nightly.created_at})`
        );
      } else {
        console.log(`  nightly: no successful runs on branch`);
      }
    } catch (e) {
      console.warn(`  nightly: FAILED - ${e.message}`);
      errors.push({ mod: m.id, kind: "nightly", error: e.message });
    }
  } else {
    console.log(`  nightly: skipped (no catalog.nightly config)`);
  }

  modsOut[m.id] = entry;
}

const output = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source_catalog_updated_at: catalog.updated_at || null,
  mods: modsOut,
};

writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

console.log(`\nwrote ${OUT_PATH}`);
console.log(
  `mods: ${Object.keys(modsOut).length}, errors: ${errors.length}`
);

if (errors.length > 0) {
  console.error("\nfailures (commit the partial file or fix and re-run):");
  for (const e of errors) {
    console.error(`  ${e.mod} / ${e.kind}: ${e.error}`);
  }
  process.exit(1);
}
