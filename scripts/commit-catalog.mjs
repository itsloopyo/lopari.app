// Runs after `pixi run update-metadata` (see pixi.toml).
//
// update-metadata.mjs writes the republished catalog to two repos - the
// Pages copy here and the authored source in ../lopari, which is baked
// into the launcher binary. The second one is easy to forget, and a
// forgotten write-back means the next launcher build ships stale pins.
// So commit both, in the same run that produced them.
//
// Pushing stays manual: the lopari repo is private and often mid-work,
// and its catalog commit usually rides along with whatever else is being
// released.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MESSAGE = "catalog: republish mods.json with current pins";

const TARGETS = [
  { repo: REPO_ROOT, file: "mods.json" },
  { repo: resolve(REPO_ROOT, "..", "lopari"), file: "catalog/mods.json" },
];

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

for (const { repo, file } of TARGETS) {
  const numstat = git(repo, "diff", "HEAD", "--numstat", "--", file).trim();
  if (!numstat) {
    console.log(`${file}: unchanged - nothing to commit`);
    continue;
  }
  // `updated_at` is restamped on every run, so a one-line-in, one-line-out
  // diff is a timestamp bump and nothing else. Committing those turns the
  // history into noise (and mirrors what update-pins.yml skips in CI).
  const [added, removed] = numstat.split("\t");
  if (Number(added) <= 1 && Number(removed) <= 1) {
    console.log(`${file}: only the updated_at timestamp moved - skipping commit`);
    continue;
  }
  git(repo, "commit", "-q", "-m", MESSAGE, "--", file);
  const sha = git(repo, "rev-parse", "--short", "HEAD").trim();
  console.log(`${file}: committed ${sha} (+${added}/-${removed}) in ${repo}`);
}

console.log("\npush both repos when you're ready.");
