// `markstay check-staged` is the git-aware verb husky / lint-staged call. Every
// other verb works on files; this one works on a commit, because drop detection is
// a diff against the same document before the edit and only git knows what that
// was.
//
// The case these tests exist for: a rewrite big enough to drop stays is a rewrite
// git will not call a rename, so it lands as delete + create and a path-keyed
// baseline finds nothing. Similarity is anti-correlated with the failure mode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

// Findings and notes go to stderr (so a hook's output reaches the user even when a
// pipeline swallows stdout), and --json goes to stdout. spawnSync keeps both, on
// any exit code; execFileSync would return stdout alone and lose every note on a
// passing run.
function check(repo, args = []) {
  const r = spawnSync(process.execPath, [CLI, "check-staged", ...args], {
    cwd: repo, encoding: "utf8",
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { code: r.status ?? 1, stdout, stderr, out: stdout + stderr };
}

function withRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "markstay-staged-"));
  try {
    git(repo, "init", "-q");
    git(repo, "checkout", "-q", "-b", "main");
    fn(repo, (name, text) => {
      const p = join(repo, name);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/** A stamped document with n sections, ids <prefix>0..<prefix>n-1. */
const doc = (n, prefix = "s") =>
  "# Doc\n\n" + Array.from({ length: n }, (_, i) =>
    `## Section ${i}\n\nBody text for section ${i}, long enough to hash.\n`
    + `<!-- stay:${prefix}${i} -->\n`).join("\n");

test("catches a drop that a rename hid from path-keyed pairing", () => {
  withRepo((repo, write) => {
    write("STATUS.md", doc(9));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");

    git(repo, "mv", "STATUS.md", "PHASE1.md");
    write("PHASE1.md", "# Doc\n\n## Phase 1 (complete)\n\nAll nine done.\n<!-- stay:s0 -->\n");
    git(repo, "add", "-A");
    // git itself does not see a rename here; that is the premise
    assert.ok(git(repo, "diff", "--cached", "--name-status").startsWith("A"));

    const { code, out } = check(repo);
    assert.equal(code, 1, out);
    assert.equal((out.match(/DROPPED_ID/g) ?? []).length, 8, out);
    assert.ok(out.includes("baseline STATUS.md"), out);
    assert.ok(!out.includes("fatal:"), "git's own probe noise must not leak");
  });
});

test("a pure rename keeps every stay and passes", () => {
  withRepo((repo, write) => {
    write("STATUS.md", doc(5));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    git(repo, "mv", "STATUS.md", "RENAMED.md");
    git(repo, "add", "-A");
    const { code, out } = check(repo);
    assert.equal(code, 0, out);
    assert.ok(!out.includes("DROPPED_ID"), out);
  });
});

test("a stay moved between documents is a note, not a block", () => {
  withRepo((repo, write) => {
    const moved = "## Section 2\n\nBody text for section 2, long enough to hash.\n"
      + "<!-- stay:s2 -->\n";
    write("a.md", doc(3));
    write("b.md", doc(2, "t"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");

    write("a.md", doc(3).replace(moved, ""));
    write("b.md", doc(2, "t") + "\n" + moved);
    git(repo, "add", "-A");
    const { code, out } = check(repo);
    assert.equal(code, 0, out);
    assert.ok(!out.includes("DROPPED_ID"), out);
    assert.ok(out.includes("s2: moved out of a.md into b.md"), out);
  });
});

test("stays lost to a deletion are named without blocking", () => {
  withRepo((repo, write) => {
    write("doomed.md", doc(4, "d"));
    write("keep.md", doc(1, "k"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    git(repo, "rm", "-q", "doomed.md");
    const { code, out } = check(repo);
    assert.equal(code, 0, out);
    assert.ok(out.includes("deleted with 4 stay(s)"), out);
  });
});

test("filename arguments scope the report, not the baseline search", () => {
  // lint-staged appends the matched files (absolute paths) and never passes a
  // deleted one, so the commit still has to be read whole to find the baseline.
  withRepo((repo, write) => {
    write("STATUS.md", doc(9));
    write("other.md", doc(2, "o"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");

    git(repo, "mv", "STATUS.md", "PHASE1.md");
    write("PHASE1.md", "# Doc\n\n## Phase 1 (complete)\n\nAll nine done.\n<!-- stay:s0 -->\n");
    write("other.md", doc(2, "o").replace("Body text for section 0", "Reworded"));
    git(repo, "add", "-A");

    const scoped = check(repo, [join(repo, "PHASE1.md")]);
    assert.equal(scoped.code, 1, scoped.out);
    assert.ok(scoped.out.includes("DROPPED_ID"), scoped.out);
    assert.ok(!scoped.out.includes("other.md"), scoped.out);
  });
});

test("a commit that only adds a stay is silent", () => {
  // A hook speaks when there is something to act on. Minting a new id and editing
  // a stamped block in place are both non-actionable, so neither should produce
  // output that trains the committer to ignore this channel.
  withRepo((repo, write) => {
    write("a.md", doc(2));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    write("a.md", doc(3));          // add a section, keep every existing stay
    git(repo, "add", "-A");
    const { code, out } = check(repo);
    assert.equal(code, 0, out);
    assert.equal(out.trim(), "", out);
  });
});

test("--show-drift opts back into the quiet findings", () => {
  withRepo((repo, write) => {
    write("a.md", doc(2));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    write("a.md", doc(2).replace("Body text for section 0", "Reworded section 0"));
    git(repo, "add", "-A");
    assert.equal(check(repo).out.trim(), "", "drift alone is silent");
    assert.ok(check(repo, ["--show-drift"]).out.includes("HASH_DRIFT"));
  });
});

test("an empty staging area is a no-op", () => {
  withRepo((repo, write) => {
    write("a.md", doc(1));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    const { code, out } = check(repo);
    assert.equal(code, 0, out);
    assert.equal(out.trim(), "");
  });
});

test("--json carries findings and notes in the structured channel", () => {
  withRepo((repo, write) => {
    write("STATUS.md", doc(4));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    git(repo, "mv", "STATUS.md", "NEW.md");
    write("NEW.md", "# Doc\n\n## Collapsed\n\nOne block now.\n<!-- stay:s0 -->\n");
    git(repo, "add", "-A");
    const { code, stdout, out } = check(repo, ["--json"]);
    assert.equal(code, 1, out);
    const parsed = JSON.parse(stdout);
    const key = Object.keys(parsed.findings)[0];
    assert.ok(key.includes("baseline STATUS.md"), key);
    assert.ok(parsed.findings[key].some((f) => f.code === "DROPPED_ID"), out);
  });
});

// --- check-worktree: the same question, asked of the files on disk ---------------
// Commit-time checking fires once per commit. A measured loss sat in a working tree
// for 12 days and then landed inside a 406-line batch commit, so the commit hook
// could only ever have caught it at the very end.

function checkWorktree(repo, args = []) {
  const r = spawnSync(process.execPath, [CLI, "check-worktree", ...args], {
    cwd: repo, encoding: "utf8",
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { code: r.status ?? 1, stdout, stderr, out: stdout + stderr };
}

test("check-worktree sees a loss before anything is staged", () => {
  withRepo((repo, write) => {
    write("a.md", doc(4));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");

    write("a.md", "# Doc\n\n## All of it\n\nCollapsed.\n<!-- stay:s0 -->\n");
    assert.equal(git(repo, "diff", "--cached", "--name-only").trim(), "");
    assert.equal(check(repo).out.trim(), "", "nothing staged, so check-staged is quiet");

    const { code, out } = checkWorktree(repo);
    assert.equal(code, 1, out);
    assert.equal((out.match(/DROPPED_ID/g) ?? []).length, 3, out);
  });
});

test("check-worktree pairs an untracked rename", () => {
  withRepo((repo, write) => {
    write("STATUS.md", doc(9));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");

    rmSync(join(repo, "STATUS.md"));
    write("PHASE1.md", "# Doc\n\n## Phase 1 (complete)\n\nAll nine done.\n<!-- stay:s0 -->\n");
    const { code, out } = checkWorktree(repo);
    assert.equal(code, 1, out);
    assert.equal((out.match(/DROPPED_ID/g) ?? []).length, 8, out);
    assert.ok(out.includes("baseline STATUS.md"), out);
  });
});

test("check-worktree is quiet on a stay-preserving edit", () => {
  withRepo((repo, write) => {
    write("a.md", doc(3));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    write("a.md", doc(3).replace("Body text for section 1", "Reworded section 1"));
    const { code, out } = checkWorktree(repo);
    assert.equal(code, 0, out);
    assert.equal(out.trim(), "", out);
  });
});
