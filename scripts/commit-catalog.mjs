// Runs after `pixi run update-metadata` (see pixi.toml).
//
// update-metadata.mjs writes the republished catalog to two repos - the
// Pages copy here and the authored source in ../lopari, which is baked
// into the launcher binary - generate-readme.mjs rewrites the mod lists
// in a third, ../itsloopyo, and generate-feed.mjs rewrites feed.xml here.
// The extra two repos are easy to forget, and a forgotten write-back
// means the next launcher build ships stale pins or the public mod list
// drifts. So commit all of it, in the same run that produced it.
//
// Pushing stays manual: the lopari repo is private and often mid-work,
// and its catalog commit usually rides along with whatever else is being
// released.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_MESSAGE = "catalog: republish mods.json with current pins";

const TARGETS = [
  { repo: REPO_ROOT, file: "mods.json", message: CATALOG_MESSAGE, timestampOnly: true },
  {
    repo: REPO_ROOT,
    file: "feed.xml",
    message: "feed: regenerate from the lopari catalog",
    timestampOnly: false,
  },
  {
    repo: resolve(REPO_ROOT, "..", "lopari"),
    file: "catalog/mods.json",
    message: CATALOG_MESSAGE,
    timestampOnly: true,
  },
  {
    repo: resolve(REPO_ROOT, "..", "itsloopyo"),
    file: "README.md",
    message: "readme: regenerate the mod table from the lopari catalog",
    timestampOnly: false,
  },
];

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

for (const { repo, file, message, timestampOnly } of TARGETS) {
  // `git diff HEAD` is blind to an untracked file, so a target's first
  // generation would never be committed without this.
  if (git(repo, "ls-files", "--others", "--exclude-standard", "--", file).trim()) {
    git(repo, "add", "--", file);
  }
  const numstat = git(repo, "diff", "HEAD", "--numstat", "--", file).trim();
  if (!numstat) {
    console.log(`${file}: unchanged - nothing to commit`);
    continue;
  }
  // `updated_at` is restamped on every run, so a one-line-in, one-line-out
  // diff is a timestamp bump and nothing else. Committing those turns the
  // history into noise (and mirrors what update-pins.yml skips in CI). The
  // README and the feed carry no run timestamp, so every line that moves
  // there is real.
  const [added, removed] = numstat.split("\t");
  if (timestampOnly && Number(added) <= 1 && Number(removed) <= 1) {
    console.log(`${file}: only the updated_at timestamp moved - skipping commit`);
    continue;
  }
  git(repo, "commit", "-q", "-m", message, "--", file);
  const sha = git(repo, "rev-parse", "--short", "HEAD").trim();
  console.log(`${file}: committed ${sha} (+${added}/-${removed}) in ${repo}`);
}

console.log("\npush both repos when you're ready.");
