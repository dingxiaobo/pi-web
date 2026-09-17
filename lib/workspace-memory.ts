/**
 * Per-workspace "last open session" memory.
 *
 * Switching to a workspace (project root or cwd) restores the session the user
 * had open there last, instead of landing on a blank new-session page. Without
 * this, every workspace switch required re-picking the session by hand.
 *
 * The workspace key is the server-provided project identity when known, so
 * Windows path variants and all worktrees of one repo share one memory slot.
 * Transient and legacy session objects fall back to projectRoot/cwd.
 *
 * Two stores cooperate so concurrent windows (multi-tab usage) stay isolated:
 *
 *   - Window store (sessionStorage): what THIS window last opened per
 *     workspace. Session storage lives per tab and survives reloads, so a
 *     window always restores its own session, never the one another tab
 *     happened to open in the same project.
 *
 *   - Shared store (localStorage): the most recent session per workspace
 *     across all windows, tagged with the writer window id and time. It is a
 *     fallback for windows with no memory of their own (fresh tabs, browser
 *     restart). A shared entry another window wrote recently is NOT restored
 *     here — that window still has the workspace open, and adopting its
 *     session is exactly the "tab jumps to another tab's session" bug.
 *
 * Stored in browser storage; best-effort (silently ignored when unavailable).
 */

const STORAGE_KEY = "pi-web:last-open-by-workspace";
const WINDOW_STORAGE_KEY = "pi-web:last-open-window";
const WINDOW_ID_KEY = "pi-web:window-id";

/** A shared-store entry written by another window newer than this is skipped. */
export const FOREIGN_MEMORY_FRESH_MS = 5 * 60_000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Inject the storages for tests; omitted fields fall back to the browser. */
export interface WorkspaceMemoryStorages {
  global?: StorageLike | null;
  window?: StorageLike | null;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function getWindowStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function resolveGlobalStorage(storage: StorageLike | null | undefined): StorageLike | null {
  return storage === undefined ? getBrowserStorage() : storage;
}

function resolveWindowStorage(storage: StorageLike | null | undefined): StorageLike | null {
  return storage === undefined ? getWindowStorage() : storage;
}

function readMap(storage: StorageLike | null, key: string): Record<string, unknown> {
  if (!storage) return {};
  const raw = storage.getItem(key);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

interface SharedEntry {
  id: string | null;
  writer: string | null;
  writtenAt: number;
}

/** Shared-store values are `{ id, w, t }`; plain strings are the legacy format. */
function parseSharedEntry(value: unknown): SharedEntry {
  if (typeof value === "string") {
    return { id: value.length > 0 ? value : null, writer: null, writtenAt: 0 };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entry = value as { id?: unknown; w?: unknown; t?: unknown };
    return {
      id: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null,
      writer: typeof entry.w === "string" && entry.w.length > 0 ? entry.w : null,
      writtenAt: typeof entry.t === "number" && Number.isFinite(entry.t) ? entry.t : 0,
    };
  }
  return { id: null, writer: null, writtenAt: 0 };
}

let cachedWindowId: string | null = null;

/**
 * A stable id for this window, kept in sessionStorage. It identifies the
 * writer of shared-store entries so another window can tell "that entry is
 * mine" from "another tab is actively using this workspace".
 */
function getWindowId(windowStorage: StorageLike | null): string {
  if (cachedWindowId) return cachedWindowId;
  let id: string | null = null;
  try {
    id = windowStorage?.getItem(WINDOW_ID_KEY) ?? null;
  } catch {
    id = null;
  }
  if (!id) {
    id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try {
      windowStorage?.setItem(WINDOW_ID_KEY, id);
    } catch {
      // Window storage unavailable — the id stays valid for this page load.
    }
  }
  cachedWindowId = id;
  return id;
}

/** Tests only: forget the memoized window id so scenarios start fresh. */
export function resetWorkspaceWindowIdForTests(): void {
  cachedWindowId = null;
}

function writeMap(storage: StorageLike | null, key: string, map: Record<string, unknown>): void {
  if (!storage) return;
  // Keep the store clean: drop the key entirely when nothing is remembered.
  if (Object.keys(map).length === 0) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(map));
}

/** The remembered session id for a workspace, or null when none/stale/foreign. */
export function getLastOpenSession(
  workspaceKey: string,
  storages: WorkspaceMemoryStorages = {},
): string | null {
  const windowStorage = resolveWindowStorage(storages.window);
  const globalStorage = resolveGlobalStorage(storages.global);
  try {
    // This window's own memory wins: it can never be hijacked by another tab.
    const own = readMap(windowStorage, WINDOW_STORAGE_KEY)[workspaceKey];
    if (typeof own === "string" && own.length > 0) return own;

    const entry = parseSharedEntry(readMap(globalStorage, STORAGE_KEY)[workspaceKey]);
    if (!entry.id) return null;
    if (
      entry.writer
      && entry.writer !== getWindowId(windowStorage)
      && Date.now() - entry.writtenAt < FOREIGN_MEMORY_FRESH_MS
    ) {
      // Another window wrote this entry moments ago and presumably still has
      // the workspace open there — restoring it here would jump this tab to
      // that tab's session.
      return null;
    }
    return entry.id;
  } catch {
    return null;
  }
}

export function setLastOpenSession(
  workspaceKey: string,
  sessionId: string,
  storages: WorkspaceMemoryStorages = {},
): void {
  const windowStorage = resolveWindowStorage(storages.window);
  const globalStorage = resolveGlobalStorage(storages.global);
  const windowId = getWindowId(windowStorage);
  try {
    const own = readMap(windowStorage, WINDOW_STORAGE_KEY);
    own[workspaceKey] = sessionId;
    writeMap(windowStorage, WINDOW_STORAGE_KEY, own);
  } catch {
    // storage unavailable — memory is best-effort
  }
  try {
    const shared = readMap(globalStorage, STORAGE_KEY);
    shared[workspaceKey] = { id: sessionId, w: windowId, t: Date.now() };
    writeMap(globalStorage, STORAGE_KEY, shared);
  } catch {
    // storage unavailable — memory is best-effort
  }
}

export function clearLastOpen(
  workspaceKey: string,
  storages: WorkspaceMemoryStorages = {},
): void {
  const windowStorage = resolveWindowStorage(storages.window);
  const globalStorage = resolveGlobalStorage(storages.global);
  try {
    const own = readMap(windowStorage, WINDOW_STORAGE_KEY);
    delete own[workspaceKey];
    writeMap(windowStorage, WINDOW_STORAGE_KEY, own);
  } catch {
    // ignore
  }
  try {
    const shared = readMap(globalStorage, STORAGE_KEY);
    delete shared[workspaceKey];
    writeMap(globalStorage, STORAGE_KEY, shared);
  } catch {
    // ignore
  }
}

/**
 * The cwd this window (tab) had selected last, or null.
 *
 * Window-scoped (sessionStorage): a reload lands back on the project this tab
 * was on instead of the globally most-recent project — which belongs to
 * whichever tab happened to run the newest session. Without this, a
 * backgrounded tab that the browser discarded (reloaded on return) while it
 * sat on an anchor-less fresh composer jumped to another tab's project.
 */
const LAST_SELECTED_CWD_KEY = "pi-web:last-selected-cwd";

export function getLastSelectedCwd(
  storages: WorkspaceMemoryStorages = {},
): string | null {
  try {
    const value = readMap(resolveWindowStorage(storages.window), LAST_SELECTED_CWD_KEY)["cwd"];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveLastSelectedCwd(
  cwd: string,
  storages: WorkspaceMemoryStorages = {},
): void {
  if (!cwd) return;
  try {
    writeMap(resolveWindowStorage(storages.window), LAST_SELECTED_CWD_KEY, { cwd });
  } catch {
    // storage unavailable — best-effort
  }
}

/** Workspace identity for a session: resolved project root when known, else cwd. */
export function workspaceKeyOf(session: {
  cwd: string;
  projectRoot?: string | null;
  projectKey?: string | null;
}): string {
  return session.projectKey ?? session.projectRoot ?? session.cwd;
}
