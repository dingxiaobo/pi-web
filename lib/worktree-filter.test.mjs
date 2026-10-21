import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { filterSessionsByWorktree, isInWorktree, setWorktreeFilterMode, worktreeFilterInternals } = await jiti.import("./worktree-filter.ts");

function session(id, cwd, projectKey) {
  return { id, cwd, projectKey, projectRoot: cwd, name: undefined, created: "", modified: "", messageCount: 1, firstMessage: "" };
}

test("a session is in the worktree when its cwd is the checkout or under it", () => {
  assert.equal(isInWorktree("/repo/wt", "/repo/wt"), true);
  assert.equal(isInWorktree("/repo/wt/src/lib", "/repo/wt"), true);
  assert.equal(isInWorktree("/repo/wt", "/repo/wt/"), true);
  assert.equal(isInWorktree("/repo/wt/", "/repo/wt"), true);

  // A sibling checkout is another worktree.
  assert.equal(isInWorktree("/repo/main", "/repo/wt"), false);
  // A directory that only shares the prefix is not inside it.
  assert.equal(isInWorktree("/repo/wt-other", "/repo/wt"), false);
  assert.equal(isInWorktree("/repo", "/repo/wt"), false);
  assert.equal(isInWorktree("", "/repo/wt"), false);
  assert.equal(isInWorktree("/repo/wt", ""), false);
});

test("the filter narrows the current project to the worktree and leaves the others", () => {
  const sessions = [
    session("in-wt", "/repo/wt", "/repo"),
    session("in-wt-sub", "/repo/wt/src", "/repo"),
    session("in-main", "/repo", "/repo"),
    session("other-project", "/elsewhere", "/elsewhere"),
  ];
  const kept = filterSessionsByWorktree(sessions, { projectKey: "/repo", worktreePath: "/repo/wt" });
  assert.deepEqual(kept.map((entry) => entry.id), ["in-wt", "in-wt-sub", "other-project"]);
});

test("a session without a project key falls back to its own path", () => {
  const sessions = [session("no-key", "/repo/wt", undefined)];
  const kept = filterSessionsByWorktree(sessions, { projectKey: "/repo/wt", worktreePath: "/repo/wt" });
  assert.deepEqual(kept.map((entry) => entry.id), ["no-key"]);
});

test("the worktree filter preference writes and parses back", () => {
  // A no-storage environment: the choice applies in memory only.
  setWorktreeFilterMode("on");
  assert.equal(worktreeFilterInternals.readStoredMode(), "off", "no window, nothing persisted");
  setWorktreeFilterMode("off");

  // The parser accepts the two states; anything else is unfiltered.
  assert.equal(worktreeFilterInternals.parseWorktreeFilterMode("on"), "on");
  assert.equal(worktreeFilterInternals.parseWorktreeFilterMode("off"), "off");
  assert.equal(worktreeFilterInternals.parseWorktreeFilterMode("nonsense"), "off");
  assert.equal(worktreeFilterInternals.parseWorktreeFilterMode(null), "off");
});
