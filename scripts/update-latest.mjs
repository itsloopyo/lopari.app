// Replaces the content between <!-- LATEST_RELEASE:START --> and
// <!-- LATEST_RELEASE:END --> in index.html with a fresh download block
// driven by the env vars set by the calling workflow.
//
// Run from the repo root: `node scripts/update-latest.mjs`.

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
const html = readFileSync(indexPath, "utf8");

const START = "<!-- LATEST_RELEASE:START -->";
const END = "<!-- LATEST_RELEASE:END -->";
const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  throw new Error(
    `couldn't find LATEST_RELEASE markers in index.html - looked for ${START} ... ${END}`
  );
}

const block = `${START}
      <p class="download-version">Latest: <strong>Lopari ${escape(env.VERSION)}</strong></p>
      <div class="download-cta">
        <a class="action" href="${escape(env.NSIS_URL)}">Download for Windows</a>
        <a class="action plain" href="https://patreon.com/itsloopyo" target="_blank" rel="noopener">Support on Patreon</a>
      </div>
      <details class="download-verify">
        <summary>Verify your download (SHA256)</summary>
        <p>Optional. If you want to confirm the installer you downloaded matches what CI built, run:</p>
        <pre><code>Get-FileHash .\\${escape(env.NSIS_FILENAME)} -Algorithm SHA256</code></pre>
        <p>Expected digest for this release:</p>
        <p><code class="sha-digest">${escape(env.NSIS_SHA256)}</code></p>
      </details>
      ${END}`;

const updated =
  html.slice(0, startIdx) + block + html.slice(endIdx + END.length);

writeFileSync(indexPath, updated);
console.log(`Updated index.html → Lopari ${env.VERSION}`);

function escape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
