// Rewrites the masthead and hero download links in index.html (between the
// MAST_DOWNLOAD and HERO_DOWNLOAD markers) with fresh URLs, version, and
// SHA256 driven by the env vars set by the calling workflow.
//
// Run from the repo root: `node scripts/update-latest.mjs`.
//
// The markup below is written verbatim into index.html, so its class names are
// a contract with styles.css. Change one in either place and you must change
// it in the other in the same commit, or the next release reverts the hero to
// markup the stylesheet no longer knows about. Verify with a round trip: run
// this script and diff index.html; at an unchanged version it must be a no-op.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED = [
  "VERSION",
  "NSIS_FILENAME",
  "NSIS_URL",
  "NSIS_SHA256",
];

const env = Object.fromEntries(REQUIRED.map((k) => [k, process.env[k]]));
for (const [k, v] of Object.entries(env)) {
  if (!v) throw new Error(`missing required env var: ${k}`);
}

const indexPath = resolve(process.cwd(), "index.html");
let html = readFileSync(indexPath, "utf8");

const mastBlock = `<!-- MAST_DOWNLOAD:START -->
      <a class="action mast-cta" href="${escape(env.NSIS_URL)}">Download</a>
      <!-- MAST_DOWNLOAD:END -->`;

const heroBlock = `<!-- HERO_DOWNLOAD:START -->
  <div class="hero-actions">
    <a class="action" href="${escape(env.NSIS_URL)}">
      <span class="action-main">Download for Windows</span>
      <span class="action-sub">${escape(env.VERSION)} · 64-bit · free</span>
    </a>
  </div>
  <p class="hero-spec">Windows 10 &amp; 11 · No account · No telemetry</p>
  <details class="download-verify">
    <summary>Verify your download (SHA256)</summary>
    <p>Optional. Confirm the installer matches what CI built:</p>
    <pre><code>Get-FileHash .\\${escape(env.NSIS_FILENAME)} -Algorithm SHA256</code></pre>
    <p>Expected digest for this release:</p>
    <p><code class="sha-digest">${escape(env.NSIS_SHA256)}</code></p>
  </details>
  <!-- HERO_DOWNLOAD:END -->`;

html = replaceBlock(html, "MAST_DOWNLOAD", mastBlock);
html = replaceBlock(html, "HERO_DOWNLOAD", heroBlock);

writeFileSync(indexPath, html);
console.log(`Updated index.html → Lopari ${env.VERSION}`);

function replaceBlock(source, marker, block) {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  const startIdx = source.indexOf(start);
  const endIdx = source.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `couldn't find ${marker} markers in index.html - looked for ${start} ... ${end}`
    );
  }
  return source.slice(0, startIdx) + block + source.slice(endIdx + end.length);
}

function escape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
