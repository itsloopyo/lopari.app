// Runs after `node scripts/update-metadata.mjs` (see pixi.toml).
//
// Writes feed.xml, an Atom feed of newly added mods served at
// https://lopari.app/feed.xml. The profile README and the launcher only
// reach people who come back to look; a feed reader tells them.
//
// Built from each public mod's `added` date and nothing that moves on its
// own, including the feed-level <updated>, so a run with nothing new
// leaves the file byte-identical and commit-catalog.mjs has nothing to
// commit. Release status is left out for the same reason: a promotion
// would rewrite an old entry and readers would show it as new again.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = resolve(REPO_ROOT, "mods.json");
const FEED_PATH = resolve(REPO_ROOT, "feed.xml");
const SITE = "https://lopari.app/";
const ENTRY_COUNT = 30;

function xml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function timestamp(date) {
  return `${date}T00:00:00Z`;
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
const mods = catalog.mods.filter((m) => m.public === true);
for (const m of mods) {
  if (!m.added) throw new Error(`${m.id} is public with no "added" date - set it in the lopari catalog`);
}
const recent = mods
  .sort((a, b) =>
    b.added.localeCompare(a.added) ||
    a.display_name.localeCompare(b.display_name, "en", { sensitivity: "base" }))
  .slice(0, ENTRY_COUNT);

const entries = recent.map((m) => {
  const url = `https://github.com/${m.repo}`;
  const summary = m.description
    ? `\n    <summary>${xml(m.description)}</summary>`
    : "";
  return `  <entry>
    <id>tag:lopari.app,2026:mod/${m.id}</id>
    <title>${xml(m.display_name)}</title>
    <link rel="alternate" href="${xml(url)}"/>
    <published>${timestamp(m.added)}</published>
    <updated>${timestamp(m.added)}</updated>${summary}
  </entry>`;
});

const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${SITE}feed.xml</id>
  <title>New head tracking mods in Lopari</title>
  <subtitle>One entry for each head tracking mod added to the Lopari catalog.</subtitle>
  <link rel="self" href="${SITE}feed.xml"/>
  <link rel="alternate" href="${SITE}"/>
  <author><name>itsloopyo</name></author>
  <updated>${timestamp(recent[0].added)}</updated>
${entries.join("\n")}
</feed>
`;

let previous = null;
try {
  previous = readFileSync(FEED_PATH, "utf8");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
if (feed === previous) {
  console.log(`feed.xml unchanged (${recent.length} entries)`);
} else {
  writeFileSync(FEED_PATH, feed, "utf8");
  console.log(`wrote ${FEED_PATH} (${recent.length} entries, newest ${recent[0].added})`);
}
