/**
 * The sidebar's worktree filter: the current project's sessions narrowed to
 * the worktree in use.
 *
 * The project filter narrows the tree to a project; this one narrows it
 * inside that project. A project's group holds the sessions of every one of
 * its checkouts, so a project with three worktrees shows three projects'
 * worth of rows in one group. The filter keeps the current worktree's
 * sessions in that group and leaves the other projects' groups alone — the
 * worktree in use belongs to the current project, so it is the only group
 * the filter has an opinion about.
 *
 * The narrowing happens on the sessions, before the tree is built, so every
 * number in the group (its running and unread counts, its "show more", its
 * empty note) and the archive beside it (its count, its list) are the
 * worktree's own. The files' project and worktree pickers keep the whole
 * list: the filter narrows what is shown, never what can be picked.
 *
 * A session belongs to the worktree when its cwd is the checkout itself or a
 * directory under it — the paths are compared lexically, the way the rest of
 * the app compares them (separators, and case on Windows).
 */

import { useSyncExternalStore } from "react";
import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

/** "off" shows every session of the project; "on" keeps the worktree's. */
export type WorktreeFilterMode = "off" | "on";

const WORKTREE_FILTER_STORAGE_KEY = "pi-web:worktree-filter";

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseWorktreeFilterMode(raw: string | null): WorktreeFilterMode {
  return raw === "on" ? "on" : "off";
}

function readStoredMode(): WorktreeFilterMode {
  const storage = getBrowserStorage();
  if (!storage) return "off";
  try {
    return parseWorktreeFilterMode(storage.getItem(WORKTREE_FILTER_STORAGE_KEY));
  } catch {
    return "off";
  }
}

// --- The live store (the useFilesPlacement pattern): Settings › General and
// --- the sidebar share one snapshot, this tab's change reaches the browser's
// --- other tabs through the storage event.

let mode: WorktreeFilterMode | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): WorktreeFilterMode {
  if (mode === null) mode = readStoredMode();
  return mode;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== WORKTREE_FILTER_STORAGE_KEY) return;
  const next = readStoredMode();
  if (next === mode) return;
  mode = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    // Nobody listened for another tab's change meanwhile.
    mode = readStoredMode();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/** Writes the filter; the sidebar and Settings › General follow at once, the browser's other tabs through the storage event. */
export function setWorktreeFilterMode(next: WorktreeFilterMode): void {
  if (next === getSnapshot()) return;
  mode = next;
  const storage = getBrowserStorage();
  try {
    storage?.setItem(WORKTREE_FILTER_STORAGE_KEY, next);
  } catch {
    // Applies in memory even if the browser cannot save it.
  }
  notify();
}

/** The filter of this browser, live. The server renders the default, like the sidebar's own preferences. */
export function useWorktreeFilterMode(): WorktreeFilterMode {
  return useSyncExternalStore(subscribe, getSnapshot, () => "off");
}

// Test hooks (the unit tests run outside a browser).
export const worktreeFilterInternals = { parseWorktreeFilterMode, readStoredMode };

// --- Pure helpers.

const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

/** The path as the comparison sees it: forward slashes, no trailing separator. */
function comparablePath(filePath: string): string {
  const slashed = filePath.replace(/\\/g, "/");
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

/**
 * Whether a session's cwd is the worktree itself or a directory under it.
 * Lexical, like the rest of the app's path comparisons: separators are
 * normalized, and Windows compares case-insensitively.
 */
export function isInWorktree(cwd: string, worktreePath: string): boolean {
  if (!cwd || !worktreePath) return false;
  const path = comparablePath(cwd);
  const root = comparablePath(worktreePath);
  if (!path || !root) return false;
  const windows = isWindowsAbsolutePath(path) || isWindowsAbsolutePath(root);
  const left = windows ? path.toLowerCase() : path;
  const right = windows ? root.toLowerCase() : root;
  if (left === right) return true;
  if (right === "/") return left.startsWith("/");
  return left.startsWith(right.endsWith("/") ? right : `${right}/`);
}

/**
 * The sessions the worktree filter keeps: every project's own sessions,
 * except the current project's, which are narrowed to the worktree in use.
 */
export function filterSessionsByWorktree(
  sessions: readonly SessionInfo[],
  filter: { projectKey: string; worktreePath: string },
): SessionInfo[] {
  return sessions.filter((session) => {
    if (workspaceKeyOf(session) !== filter.projectKey) return true;
    return isInWorktree(session.cwd, filter.worktreePath);
  });
}
