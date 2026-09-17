import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source-shape tests for the multi-tab isolation fixes: concurrent windows that
// share one repo (projectKey) must not hijack each other's session. The
// behavioral core (window-scoped memory, foreign-entry guard, path equality)
// is unit-tested in lib/workspace-memory.test.mjs and lib/cwd-compare.test.mjs;
// these assertions pin the wiring in the components.

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("AppShell compares cwd transitions through sameCwd, not raw equality", () => {
  assert.match(appShell, /import \{ sameCwd \} from "@\/lib\/cwd-compare";/);
  const handleCwdChangeStart = appShell.indexOf("const handleCwdChange = useCallback");
  const handleCwdChangeEnd = appShell.indexOf("const handleSelectSession", handleCwdChangeStart);
  const handleCwdChange = appShell.slice(handleCwdChangeStart, handleCwdChangeEnd);
  // Normalization-only cwd changes are treated as "no move" by both guards.
  assert.match(handleCwdChange, /const cwdUnchanged = sameCwd\(currentFreshCwd, cwd\);/);
  assert.match(handleCwdChange, /if \(cwdUnchanged && currentProject !== newProject\) return;/);
  assert.match(handleCwdChange, /\(selectedSession !== null \|\| cwdUnchanged\)/);
  assert.doesNotMatch(handleCwdChange, /currentFreshCwd === cwd/);
});

test("the workspace restore reads window-scoped memory only after a real switch", () => {
  const restoreStart = appShell.indexOf("const restoreWorkspaceContext = useCallback");
  const restoreEnd = appShell.indexOf("const handleCwdChange", restoreStart);
  const restore = appShell.slice(restoreStart, restoreEnd);
  assert.match(restore, /getLastOpenSession\(projectKey\)/);
  // And it stays confined to the cross-project branch of handleCwdChange.
  const handleCwdChangeStart = appShell.indexOf("const handleCwdChange = useCallback");
  const handleCwdChangeEnd = appShell.indexOf("const handleSelectSession", handleCwdChangeStart);
  const handleCwdChange = appShell.slice(handleCwdChangeStart, handleCwdChangeEnd);
  assert.match(handleCwdChange, /if \(currentProject !== newProject\) \{[\s\S]*?restoreWorkspaceContext\(newProject, cwd\);[\s\S]*?\}/);
});

test("projectFor memoizes resolved identities instead of regressing to raw paths", () => {
  assert.match(sidebar, /const stableIdentityRef = useRef<Map<string, ProjectSelection>>\(new Map\(\)\);/);
  assert.match(sidebar, /const remembered = lookupStableIdentity\(cwd\);/);
  assert.match(sidebar, /if \(remembered\) return remembered;/);
  // The blind raw-path fallback stays the last resort.
  const projectForStart = sidebar.indexOf("const projectFor = useCallback");
  const projectForEnd = sidebar.indexOf("const lastNotifiedProjectRef", projectForStart);
  const projectFor = sidebar.slice(projectForStart, projectForEnd);
  assert.match(projectFor, /return projectSelection\(cwd, cwd\);/);
  assert.ok(projectFor.lastIndexOf("return projectSelection(cwd, cwd);") > projectFor.indexOf("if (remembered) return remembered;"));
});

test("the cwd notify effect dedups path-equivalent cwds", () => {
  assert.match(
    sidebar,
    /if \(previous && sameCwd\(previous\.cwd, selectedCwd\) && previous\.key === \(project\?\.key \?\? null\)\) return;/,
  );
});

test("the selectedCwd prop sync ignores normalization-only differences", () => {
  const syncStart = sidebar.indexOf("const lastSyncedCwdPropRef = useRef");
  const syncEnd = sidebar.indexOf("// Load worktrees for the current effective cwd", syncStart);
  const sync = sidebar.slice(syncStart, syncEnd);
  assert.match(sync, /if \(sameCwd\(selectedCwdProp, lastSyncedCwdPropRef\.current\)\) return;/);
  assert.match(sync, /if \(sameCwd\(selectedCwdProp, selectedCwd\)\) return;/);
  assert.match(sync, /setSelectedCwd\(selectedCwdProp\);/);
});

test("a reloaded tab restores its own cwd before the most-recent project", () => {
  const autoSelectStart = sidebar.indexOf("// Auto-select cwd and restore session from URL on first load");
  const autoSelectEnd = sidebar.indexOf("// Prefer an exact UI selection while a refetch is in flight", autoSelectStart);
  const autoSelect = sidebar.slice(autoSelectStart, autoSelectEnd);
  assert.notEqual(autoSelectStart, -1, "auto-select effect found");
  // Window memory first, most-recent project only as the fallback.
  assert.match(autoSelect, /const rememberedCwd = getLastSelectedCwd\(\);/);
  assert.match(autoSelect, /if \(rememberedCwd\) \{[\s\S]*?setSelectedCwd\(rememberedCwd\);[\s\S]*?return;/);
  assert.ok(
    autoSelect.indexOf("setSelectedCwd(rememberedCwd)") < autoSelect.indexOf("setSelectedCwd(projects[0].root)"),
    "remembered cwd is adopted before the most-recent project",
  );
  // And the selection is persisted per window on every change.
  assert.match(sidebar, /if \(selectedCwd\) saveLastSelectedCwd\(selectedCwd\);/);
});
