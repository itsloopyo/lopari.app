// Runs before `pixi run update-metadata` (see pixi.toml).
//
// update-metadata reads authored data from ../lopari and writes commits to
// three repos, and update-pins.yml re-pins this one on the hour, every
// hour. Regenerating from a stale checkout therefore races the bot: both
// sides emit the same pin blocks from the same upstream releases, the
// push is rejected, and the two commits have to be untangled by hand
// afterwards. Fast-forwarding first costs a fetch and removes the race.
//
// A pull is only safe to do unattended when it is a fast-forward. Pushing
// is manual here (see commit-catalog.mjs), so being ahead is the normal
// state and never blocks a run. Being behind fast-forwards. Being both is
// the case this script exists to stop: the merge or rebase needs a human
// deciding which side of the catalog wins, so say so and exit.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REPOS = [
  resolve(REPO_ROOT),
  resolve(REPO_ROOT, "..", "lopari"),
  resolve(REPO_ROOT, "..", "itsloopyo"),
];

// execFileSync lets the child's stderr through to ours by default, which
// would print git's own complaint before the handled message below says
// what it means. Capture it and re-throw it as the message instead, so an
// unhandled git failure still surfaces git's diagnostic and nothing else.
function git(repo, ...args) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    throw new Error((e.stderr || e.message).trim());
  }
}

function firstLine(e) {
  return e.message.trim().split("\n")[0].replace(/^(fatal|error): /, "");
}

let blocked = false;

for (const repo of REPOS) {
  const name = git(repo, "rev-parse", "--show-toplevel").split("/").pop();

  let upstream;
  try {
    upstream = git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  } catch {
    console.log(`${name}: no upstream branch - skipping`);
    continue;
  }

  // Offline is the one failure worth continuing through: the catalog is
  // rebuilt from the GitHub API anyway, so a run that gets this far
  // without a network is going to fail later on its own terms.
  try {
    git(repo, "fetch", "--quiet");
  } catch (e) {
    console.log(`${name}: fetch failed (${firstLine(e)}) - continuing on the checkout as-is`);
    continue;
  }

  const [behind, ahead] = git(repo, "rev-list", "--left-right", "--count", `${upstream}...HEAD`)
    .split(/\s+/)
    .map(Number);

  if (behind && ahead) {
    console.error(
      `${name}: diverged from ${upstream} (${ahead} local, ${behind} remote) - ` +
        `rebase it first:\n    git -C ${repo} rebase ${upstream}`,
    );
    blocked = true;
    continue;
  }

  if (behind) {
    // Uncommitted edits to a file the fast-forward touches land here. That
    // has to stop the run for the same reason a divergence does: the point
    // is not to regenerate on top of a stale checkout.
    try {
      git(repo, "merge", "--ff-only", upstream);
    } catch (e) {
      console.error(
        `${name}: cannot fast-forward ${behind} commit${behind === 1 ? "" : "s"} from ${upstream}` +
          `\n    ${firstLine(e)}`,
      );
      blocked = true;
      continue;
    }
    console.log(`${name}: fast-forwarded ${behind} commit${behind === 1 ? "" : "s"} from ${upstream}`);
    continue;
  }

  console.log(ahead ? `${name}: up to date (${ahead} unpushed)` : `${name}: up to date`);
}

if (blocked) {
  process.exit(1);
}
