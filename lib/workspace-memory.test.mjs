import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLastOpenSession,
  setLastOpenSession,
  clearLastOpen,
  workspaceKeyOf,
  FOREIGN_MEMORY_FRESH_MS,
  resetWorkspaceWindowIdForTests,
  getLastSelectedCwd,
  saveLastSelectedCwd,
} = await jiti.import("./workspace-memory.ts");

beforeEach(() => resetWorkspaceWindowIdForTests());

const GLOBAL_KEY = "pi-web:last-open-by-workspace";
const WINDOW_KEY = "pi-web:last-open-window";
const WINDOW_ID_KEY = "pi-web:window-id";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function withGlobalMap(map) {
  return { [GLOBAL_KEY]: JSON.stringify(map) };
}

test("returns null for an unknown workspace", () => {
  assert.equal(getLastOpenSession("root-a", { global: createStorage() }), null);
});

test("set then get round-trips the remembered session", () => {
  const global = createStorage();
  setLastOpenSession("root-a", "session-1", { global });
  assert.equal(getLastOpenSession("root-a", { global }), "session-1");
});

test("workspaces are remembered independently", () => {
  const global = createStorage();
  setLastOpenSession("root-a", "session-a", { global });
  setLastOpenSession("root-b", "session-b", { global });
  assert.equal(getLastOpenSession("root-a", { global }), "session-a");
  assert.equal(getLastOpenSession("root-b", { global }), "session-b");
});

test("the window store wins over the shared store", () => {
  const global = createStorage();
  const win = createStorage();
  // Another window's fresh entry in the shared store…
  global.setItem(GLOBAL_KEY, JSON.stringify({
    "root-a": { id: "other-window-session", w: "other-window", t: Date.now() },
  }));
  // …must not override what this window opened itself.
  win.setItem(WINDOW_KEY, JSON.stringify({ "root-a": "own-session" }));
  assert.equal(getLastOpenSession("root-a", { global, window: win }), "own-session");
});

test("writes go to the window store and tag the shared entry with the writer", () => {
  const global = createStorage();
  const win = createStorage();
  setLastOpenSession("root-a", "session-1", { global, window: win });

  const own = JSON.parse(win.values.get(WINDOW_KEY));
  assert.equal(own["root-a"], "session-1");
  // The window id is persisted so it survives reloads.
  assert.ok(win.values.get(WINDOW_ID_KEY));

  const shared = JSON.parse(global.values.get(GLOBAL_KEY));
  assert.equal(shared["root-a"].id, "session-1");
  assert.equal(shared["root-a"].w, win.values.get(WINDOW_ID_KEY));
  assert.ok(shared["root-a"].t <= Date.now());
});

test("a fresh shared entry from another window is not restored here", () => {
  const global = createStorage(withGlobalMap({
    "root-a": { id: "their-session", w: "another-window", t: Date.now() },
  }));
  assert.equal(getLastOpenSession("root-a", { global }), null);
});

test("a stale shared entry from another window still restores", () => {
  const global = createStorage(withGlobalMap({
    "root-a": { id: "their-session", w: "another-window", t: Date.now() - FOREIGN_MEMORY_FRESH_MS - 1 },
  }));
  assert.equal(getLastOpenSession("root-a", { global }), "their-session");
});

test("own shared entries are always restorable regardless of age", () => {
  const win = createStorage();
  const ownId = (() => {
    // Discover this window's id by performing a write first.
    const global = createStorage();
    setLastOpenSession("warmup-root", "warmup", { global, window: win });
    return win.values.get(WINDOW_ID_KEY);
  })();
  const global = createStorage(withGlobalMap({
    "root-a": { id: "my-session", w: ownId, t: Date.now() },
  }));
  assert.equal(getLastOpenSession("root-a", { global, window: win }), "my-session");
});

test("legacy plain-string shared entries still restore", () => {
  const global = createStorage(withGlobalMap({ "root-a": "legacy-session" }));
  assert.equal(getLastOpenSession("root-a", { global }), "legacy-session");
});

test("clearLastOpen removes the workspace from both stores", () => {
  const global = createStorage();
  const win = createStorage();
  setLastOpenSession("root-a", "session-a", { global, window: win });
  setLastOpenSession("root-b", "session-b", { global, window: win });
  clearLastOpen("root-a", { global, window: win });
  assert.equal(getLastOpenSession("root-a", { global, window: win }), null);
  assert.equal(getLastOpenSession("root-b", { global, window: win }), "session-b");
});

test("clearing the last entry removes the storage keys entirely", () => {
  const global = createStorage();
  const win = createStorage();
  setLastOpenSession("root-a", "session-a", { global, window: win });
  clearLastOpen("root-a", { global, window: win });
  assert.equal(global.values.has(GLOBAL_KEY), false);
  assert.equal(win.values.has(WINDOW_KEY), false);
  // The window id must survive — it identifies this window, not a workspace.
  assert.ok(win.values.get(WINDOW_ID_KEY));
});

test("ignores a corrupt stored map", () => {
  const global = createStorage({ [GLOBAL_KEY]: "{not-json" });
  assert.equal(getLastOpenSession("root-a", { global }), null);
});

test("ignores a stored map of the wrong shape", () => {
  const global = createStorage({ [GLOBAL_KEY]: `"just a string"` });
  assert.equal(getLastOpenSession("root-a", { global }), null);
});

test("recovers from an array-shaped stored map", () => {
  const global = createStorage({ [GLOBAL_KEY]: "[]" });
  setLastOpenSession("root-a", "session-a", { global });
  assert.equal(getLastOpenSession("root-a", { global }), "session-a");
});

test("ignores an empty or non-string session id", () => {
  const global = createStorage({
    [GLOBAL_KEY]: `{"root-a": {"id": "", "w": "x", "t": 0}, "root-b": 42, "root-c": {"id": "ok", "w": "x", "t": 0}}`,
  });
  assert.equal(getLastOpenSession("root-a", { global }), null);
  assert.equal(getLastOpenSession("root-b", { global }), null);
  assert.equal(getLastOpenSession("root-c", { global }), "ok");
});

test("falls back to null / no-ops when browser storage is unavailable", () => {
  const unavailable = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(getLastOpenSession("root-a", { global: unavailable, window: unavailable }), null);
  assert.doesNotThrow(() => setLastOpenSession("root-a", "session-a", { global: unavailable, window: unavailable }));
  assert.doesNotThrow(() => clearLastOpen("root-a", { global: unavailable, window: unavailable }));
});

test("falls back when browser storage access throws", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const blockedWindow = {};
  Object.defineProperty(blockedWindow, "localStorage", {
    get() { throw new DOMException("blocked", "SecurityError"); },
  });
  Object.defineProperty(blockedWindow, "sessionStorage", {
    get() { throw new DOMException("blocked", "SecurityError"); },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: blockedWindow,
  });

  try {
    assert.equal(getLastOpenSession("root-a"), null);
    assert.doesNotThrow(() => setLastOpenSession("root-a", "session-a"));
    assert.doesNotThrow(() => clearLastOpen("root-a"));
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
});

test("workspaceKeyOf prefers projectKey, then projectRoot, then cwd", () => {
  assert.equal(
    workspaceKeyOf({ cwd: "/repos/a/worktrees/b", projectRoot: "/repos/a", projectKey: "project:a" }),
    "project:a",
  );
  assert.equal(workspaceKeyOf({ cwd: "/repos/a/worktrees/b", projectRoot: "/repos/a" }), "/repos/a");
  assert.equal(workspaceKeyOf({ cwd: "/plain/dir", projectRoot: null }), "/plain/dir");
  assert.equal(workspaceKeyOf({ cwd: "/plain/dir" }), "/plain/dir");
});

test("last selected cwd round-trips in the window store", () => {
  const win = createStorage();
  assert.equal(getLastSelectedCwd({ window: win }), null);
  saveLastSelectedCwd("/repos/project-b", { window: win });
  assert.equal(getLastSelectedCwd({ window: win }), "/repos/project-b");
});

test("last selected cwd is window-scoped, not shared", () => {
  const writer = createStorage();
  const reader = createStorage();
  saveLastSelectedCwd("/repos/project-b", { window: writer });
  // A different window (fresh tab) has no memory and must not inherit it.
  assert.equal(getLastSelectedCwd({ window: reader }), null);
});

test("saveLastSelectedCwd ignores empty values and broken storage", () => {
  const win = createStorage();
  saveLastSelectedCwd("", { window: win });
  assert.equal(win.values.has("pi-web:last-selected-cwd"), false);
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(getLastSelectedCwd({ window: broken }), null);
  assert.doesNotThrow(() => saveLastSelectedCwd("/repos/x", { window: broken }));
});

test("last selected cwd tolerates a corrupt stored value", () => {
  const win = createStorage({ "pi-web:last-selected-cwd": "{not-json" });
  assert.equal(getLastSelectedCwd({ window: win }), null);
  saveLastSelectedCwd("/repos/x", { window: win });
  assert.equal(getLastSelectedCwd({ window: win }), "/repos/x");
});
