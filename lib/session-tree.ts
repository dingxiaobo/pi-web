/**
 * Flat row model of the sidebar's session tree.
 *
 * Every project is a collapsible group of session families; pinned families
 * move to one global section above the groups, archived families leave the
 * tree for the archive view. The component renders `rows` with a virtualizer
 * over per-kind heights (`getRowOffsets` + `getVisibleRowIndices`), so every
 * decision about what is shown lives here, pure and testable.
 *
 * Pin and archive flags are keyed by the family ROOT session id. An archived
 * family returns on its own when the root session gets a newer message
 * (`root.modified`, not `latestModified`: subagent activity alone does not
 * bring it back) or while any member is running.
 *
 * Groups are alphabetical by the name they show, and pinned projects keep
 * their own band above the others: activity never moves a group, and no
 * stored order is read (this fork dropped `projectOrder`; the ui state still
 * parses it so older clients and undo snapshots keep working, it just has no
 * effect on the tree).
 */

import { listSessionFamilies, type SessionFamily } from "./session-family";
import { storedProjectName, type SessionUiFamilyState, type SessionUiState } from "./session-ui-state-shared";
import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

export type SidebarLayout = "desktop" | "mobile";
export type SidebarRowKind =
  | "pinned-header" | "session" | "pinned-more" | "group" | "group-more" | "group-empty"
  | "spacer" | "footer-open" | "footer-archived" | "archive-group";

/**
 * Per-kind row heights: one rhythm. Session rows, the section headers (a
 * project's, the pinned section's, the archive's projects), the empty
 * group's note and the footer are one height, 28px (44px on a phone, a
 * finger's minimum for the rows); only "show more" is a step shorter. A
 * spacer opens the list and parts the pinned section from the groups, one
 * group from the next and the groups from the footer.
 */
export const SIDEBAR_ROW_HEIGHTS: Record<SidebarLayout, Record<SidebarRowKind, number>> = {
  desktop: { "pinned-header": 28, session: 28, "pinned-more": 26, group: 28, "group-more": 26, "group-empty": 28, spacer: 8, "footer-open": 28, "footer-archived": 28, "archive-group": 28 },
  mobile: { "pinned-header": 44, session: 44, "pinned-more": 36, group: 44, "group-more": 36, "group-empty": 44, spacer: 8, "footer-open": 44, "footer-archived": 44, "archive-group": 44 },
};
export const GROUP_VISIBLE_LIMIT = 6;
export const PINNED_VISIBLE_LIMIT = 8;
/** How many more families each "show more" click reveals. */
export const SHOW_MORE_STEP = 20;
/** `moreShown` entry for the pinned section's "show more". */
export const PINNED_MORE_KEY = "pinned";

/**
 * `name` is what the sidebar shows: the user's display name for the project
 * (`customName`, from its group menu's Rename…), else its folder's name.
 */
export interface SidebarProject { key: string; root: string; name: string; customName: string | null; pinned: boolean; current: boolean }
export interface SidebarFamilyStatus { running: boolean; awaiting: boolean; unread: boolean; selected: boolean; transient: boolean }

// A folded header's counts follow its rows' right column: a family awaiting
// input counts as awaiting, not running.
export type SidebarRow =
  | { kind: "pinned-header"; key: "pinned-header"; count: number; collapsed: boolean; running: number; awaiting: number; unread: number }
  | { kind: "session"; key: string; family: SessionFamily; context: "pinned" | "group" | "archive"; project: SidebarProject; status: SidebarFamilyStatus }
  | { kind: "pinned-more"; key: "pinned-more"; hidden: number; canShowLess: boolean; nextShown: number }
  | { kind: "group"; key: string; project: SidebarProject; expanded: boolean; running: number; awaiting: number; unread: number }
  | { kind: "group-more"; key: string; projectKey: string; hidden: number; canShowLess: boolean; nextShown: number }
  | { kind: "group-empty"; key: string; project: SidebarProject }
  | { kind: "spacer"; key: "top-spacer" | "pinned-spacer" | "footer-spacer" | `group-spacer:${string}` }
  | { kind: "footer-open"; key: "footer-open" }
  | { kind: "footer-archived"; key: "footer-archived"; count: number }
  | { kind: "archive-group"; key: string; project: SidebarProject; count: number; expanded: boolean };

export interface SessionTreeInput {
  /** The full catalog (allSessions), subagents included. */
  sessions: readonly SessionInfo[];
  uiState: SessionUiState;
  runningIds: ReadonlySet<string>;
  /** Members parked on an extension's blocking dialog, a subset of runningIds (/api/agent/running). */
  awaitingIds?: ReadonlySet<string>;
  unreadIds: ReadonlySet<string>;
  selectedSessionId: string | null;
  /** projectFor(selectedCwd); shown as a group even without sessions. */
  currentProject: { key: string; root: string } | null;
  /**
   * Explicit user choices (from prefs) over the groups kept open for the
   * page (effectiveGroupExpansion); see isGroupExpanded.
   */
  groupExpansion: Readonly<Record<string, boolean>>;
  /** Families revealed beyond the base limit by "show more", per projectKey or PINNED_MORE_KEY. */
  moreShown: Readonly<Record<string, number>>;
  pinnedCollapsed: boolean;
}

export interface SessionTreeModel {
  rows: SidebarRow[];
  /** Projects in group order. */
  projects: SidebarProject[];
  /** Archived families across all projects. */
  archivedCount: number;
}

type FamilyFlagsInput = Pick<SessionTreeInput, "uiState" | "runningIds" | "awaitingIds" | "unreadIds" | "selectedSessionId">;

function familyEntry(state: SessionUiState, rootId: string): SessionUiFamilyState | undefined {
  // Session ids such as "constructor" must not resolve to Object.prototype members.
  return Object.hasOwn(state.sessions, rootId) ? state.sessions[rootId] : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Descending comparison that is safe for ±Infinity (a - b would give NaN). */
function compareDesc(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

export function familyIds(family: SessionFamily): string[] {
  return [family.root.id, ...family.subagents.map((session) => session.id)];
}

function anyMemberIn(family: SessionFamily, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  return ids.has(family.root.id) || family.subagents.some((session) => ids.has(session.id));
}

function isMember(family: SessionFamily, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return family.root.id === sessionId || family.subagents.some((session) => session.id === sessionId);
}

/**
 * archivedAt set AND no family member running AND (root.detailsPending OR
 * archivedAt >= Date.parse(root.modified)). A summary row (detailsPending)
 * carries only stat metadata, so its time is not trusted to un-archive; an
 * unparsable root.modified likewise keeps the family archived.
 */
export function isFamilyArchived(family: SessionFamily, state: SessionUiState, runningIds: ReadonlySet<string>): boolean {
  const archivedAt = finiteNumber(familyEntry(state, family.root.id)?.archivedAt);
  if (archivedAt === null) return false;
  if (anyMemberIn(family, runningIds)) return false;
  if (family.root.detailsPending) return true;
  const modified = Date.parse(family.root.modified);
  return Number.isNaN(modified) || archivedAt >= modified;
}

/** pinnedAt set AND not isFamilyArchived. */
export function isFamilyPinned(family: SessionFamily, state: SessionUiState, runningIds: ReadonlySet<string>): boolean {
  return finiteNumber(familyEntry(state, family.root.id)?.pinnedAt) !== null
    && !isFamilyArchived(family, state, runningIds);
}

/** Last path segment of a project root, for "/" and "\\" paths alike. */
export function projectNameOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  // "/" (or "\\", "//") is a filesystem root: show it as is.
  if (!trimmed) return root.charAt(0);
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(separator + 1);
}

/** Explicit choice wins; by default the current and pinned projects are open. */
export function isGroupExpanded(project: SidebarProject, groupExpansion: Readonly<Record<string, boolean>>): boolean {
  if (Object.hasOwn(groupExpansion, project.key)) {
    const choice = groupExpansion[project.key];
    if (typeof choice === "boolean") return choice;
  }
  return project.current || project.pinned;
}

/**
 * The groups kept open for the page once `outgoing`, the project that was
 * current, no longer is (`outgoing` as the new model has it). A group open
 * only by the "current" default would fold up at once: picking a session in
 * another group would move every row below it, the clicked one included,
 * from under the pointer. It stays open for the page's life instead, never
 * as a saved choice: saved, every project ever visited would come back open
 * after a reload. Returns `keptOpen` itself when nothing changes: an explicit
 * choice in `groupExpansion` (the saved ones), a group already kept open, a
 * pinned project (open by default anyway), a project still current, or one
 * without a group any more.
 */
export function keepOutgoingGroupOpen(
  keptOpen: ReadonlySet<string>,
  groupExpansion: Readonly<Record<string, boolean>>,
  outgoing: SidebarProject | undefined,
): ReadonlySet<string> {
  if (!outgoing || outgoing.current || outgoing.pinned) return keptOpen;
  if (keptOpen.has(outgoing.key) || Object.hasOwn(groupExpansion, outgoing.key)) return keptOpen;
  return new Set(keptOpen).add(outgoing.key);
}

/**
 * What the tree shows and every toggle reads: the saved choices over the
 * groups kept open for the page (keepOutgoingGroupOpen). Returns
 * `groupExpansion` itself while none is kept open. Never saved: only
 * explicit choices are.
 */
export function effectiveGroupExpansion(
  groupExpansion: Readonly<Record<string, boolean>>,
  keptOpen: ReadonlySet<string>,
): Readonly<Record<string, boolean>> {
  if (keptOpen.size === 0) return groupExpansion;
  // fromEntries defines own properties, so no key can reach the prototype.
  return Object.fromEntries([
    ...[...keptOpen].filter((key) => !Object.hasOwn(groupExpansion, key)).map((key) => [key, true] as const),
    ...Object.entries(groupExpansion),
  ]);
}

/**
 * `keptOpen` without the groups an explicit choice now covers (`keys`; null
 * for a choice made for every group at once). Returns `keptOpen` itself
 * when none of them was in it.
 */
export function forgetKeptOpenGroups(keptOpen: ReadonlySet<string>, keys: readonly string[] | null): ReadonlySet<string> {
  if (keptOpen.size === 0) return keptOpen;
  if (keys === null) return new Set();
  if (!keys.some((key) => keptOpen.has(key))) return keptOpen;
  const next = new Set(keptOpen);
  for (const key of keys) next.delete(key);
  return next;
}

function familyStatus(family: SessionFamily, input: FamilyFlagsInput): SidebarFamilyStatus {
  return {
    running: anyMemberIn(family, input.runningIds),
    awaiting: input.awaitingIds ? anyMemberIn(family, input.awaitingIds) : false,
    unread: anyMemberIn(family, input.unreadIds),
    selected: isMember(family, input.selectedSessionId),
    transient: family.root.transient === true,
  };
}

function activityCounts(
  families: readonly SessionFamily[],
  input: Pick<SessionTreeInput, "runningIds" | "awaitingIds" | "unreadIds">,
): { running: number; awaiting: number; unread: number } {
  let running = 0;
  let awaiting = 0;
  let unread = 0;
  for (const family of families) {
    if (input.awaitingIds && anyMemberIn(family, input.awaitingIds)) awaiting++;
    else if (anyMemberIn(family, input.runningIds)) running++;
    if (anyMemberIn(family, input.unreadIds)) unread++;
  }
  return { running, awaiting, unread };
}

function familyProjectKey(family: SessionFamily): string {
  return workspaceKeyOf(family.root);
}

function familyProjectRoot(family: SessionFamily): string {
  return family.root.projectRoot ?? family.root.cwd;
}

/**
 * SidebarProject for every key that is referenced. The root path comes from
 * the newest family of that key (families arrive newest first), then from the
 * current project, then from the pinned-project entry.
 */
function createProjectResolver(
  uiState: SessionUiState,
  currentProject: { key: string; root: string } | null,
) {
  const roots = new Map<string, string>();
  const projects = new Map<string, SidebarProject>();

  return {
    noteFamily(family: SessionFamily) {
      const key = familyProjectKey(family);
      if (!roots.has(key)) roots.set(key, familyProjectRoot(family));
    },
    get(key: string): SidebarProject {
      const cached = projects.get(key);
      if (cached) return cached;
      const pinnedEntry = Object.hasOwn(uiState.projects, key) ? uiState.projects[key] : undefined;
      const current = currentProject !== null && currentProject.key === key;
      const root = roots.get(key)
        ?? (current ? currentProject.root : undefined)
        ?? pinnedEntry?.root
        ?? key;
      const customName = storedProjectName(uiState, key) ?? null;
      const project: SidebarProject = {
        key,
        root,
        name: customName ?? projectNameOf(root),
        customName,
        pinned: pinnedEntry !== undefined,
        current,
      };
      projects.set(key, project);
      return project;
    },
  };
}

function sessionRow(
  family: SessionFamily,
  context: "pinned" | "group" | "archive",
  project: SidebarProject,
  input: FamilyFlagsInput,
): SidebarRow {
  return {
    kind: "session",
    key: `session:${context}:${family.root.id}`,
    family,
    context,
    project,
    status: familyStatus(family, input),
  };
}

/**
 * The first `limit` families, the `shown` positions "show more" opened past
 * them, and any later family that is running, unread or selected (sorted
 * order kept). Positions, not a budget: a family that turns selected, unread
 * or running inside the window keeps its place and frees nothing, so picking
 * the last revealed row never brings in an older one below it. `revealed`
 * counts the rows only the window shows (what "show less" would fold);
 * `nextShown` is the window a "show more" click opens, decided at the click:
 * SHOW_MORE_STEP more hidden families past this one (those that show anyway
 * do not use up the click), or all that are left, and a long project never
 * mounts all of its rows at once.
 */
function visibleFamilies(
  families: readonly SessionFamily[],
  limit: number,
  shown: number,
  input: FamilyFlagsInput,
): { visible: SessionFamily[]; revealed: number; nextShown: number } {
  const flagged = families.map((family, index) => {
    if (index < limit) return false;
    const status = familyStatus(family, input);
    return status.running || status.unread || status.selected;
  });
  const end = limit + shown;
  let revealed = 0;
  const visible = families.filter((_family, index) => {
    if (index < limit || flagged[index]) return true;
    if (index < end) {
      revealed++;
      return true;
    }
    return false;
  });
  let next = Math.max(limit, Math.min(end, families.length));
  for (let hidden = 0; next < families.length && hidden < SHOW_MORE_STEP; next++) {
    if (!flagged[next]) hidden++;
  }
  return { visible, revealed, nextShown: next - limit };
}

/** Positions "show more" has opened past the base limit for `key` (0 when none or malformed). */
export function shownMoreFor(moreShown: Readonly<Record<string, number>>, key: string): number {
  if (!Object.hasOwn(moreShown, key)) return 0;
  const value = moreShown[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** One "show more" click for `key`: the window its more row offers (`nextShown`). */
export function showMoreFamilies(moreShown: Readonly<Record<string, number>>, key: string, nextShown: number): Record<string, number> {
  return { ...moreShown, [key]: Math.max(shownMoreFor(moreShown, key), Math.floor(nextShown)) };
}

/**
 * `moreShown` without the windows of the groups an explicit choice folds
 * (`keys`, the groups it covers; null: every group in `choices`): a group
 * opened again shows its first rows only, not the window it had. Returns
 * `moreShown` itself when none of them had one.
 */
export function forgetShownMoreOfFolded(
  moreShown: Readonly<Record<string, number>>,
  choices: Readonly<Record<string, boolean>>,
  keys: readonly string[] | null,
): Record<string, number> {
  const folded = (keys ?? Object.keys(choices)).filter((key) => choices[key] === false && Object.hasOwn(moreShown, key));
  if (folded.length === 0) return moreShown as Record<string, number>;
  const next = { ...moreShown };
  for (const key of folded) delete next[key];
  return next;
}

/** "Show less": back to the base limit for `key`. */
export function showLessFamilies(moreShown: Readonly<Record<string, number>>, key: string): Record<string, number> {
  if (!Object.hasOwn(moreShown, key)) return moreShown as Record<string, number>;
  const next = { ...moreShown };
  delete next[key];
  return next;
}

/**
 * The "show more" row: how many families are still hidden, and whether
 * "show less" would fold anything back (only rows "show more" revealed; the
 * running, unread or selected ones stay). Null when neither applies.
 */
function moreRowState(total: number, visible: number, revealed: number): { hidden: number; canShowLess: boolean } | null {
  const hidden = total - visible;
  const canShowLess = revealed > 0;
  return hidden > 0 || canShowLess ? { hidden, canShowLess } : null;
}

/**
 * Alphabetical, case-insensitive first ("beta" before "Gamma"), then by the
 * exact text: no locale data, so no dependence on the ICU build.
 */
export function compareProjectNames(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export function buildSessionTree(input: SessionTreeInput): SessionTreeModel {
  const { uiState, runningIds, currentProject } = input;
  const families = listSessionFamilies(input.sessions);
  const resolver = createProjectResolver(uiState, currentProject);

  let archivedCount = 0;
  const pinnedFamilies: SessionFamily[] = [];
  // Insertion order follows family activity (newest first).
  const projectFamilies = new Map<string, SessionFamily[]>();

  for (const family of families) {
    if (isFamilyArchived(family, uiState, runningIds)) {
      archivedCount++;
      continue;
    }
    resolver.noteFamily(family);
    const key = familyProjectKey(family);
    if (isFamilyPinned(family, uiState, runningIds)) {
      pinnedFamilies.push(family);
      continue;
    }
    const list = projectFamilies.get(key);
    if (list) list.push(family);
    else projectFamilies.set(key, [family]);
  }

  // A spacer keeps the first section's header off the toolbar's line (#1338).
  const rows: SidebarRow[] = [{ kind: "spacer", key: "top-spacer" }];

  // Pinned section: newest pin first; ties keep family activity order.
  if (pinnedFamilies.length > 0) {
    const pinnedAt = (family: SessionFamily) => finiteNumber(familyEntry(uiState, family.root.id)?.pinnedAt) ?? 0;
    const sorted = pinnedFamilies
      .map((family, index) => ({ family, index }))
      .sort((a, b) => compareDesc(pinnedAt(a.family), pinnedAt(b.family)) || a.index - b.index)
      .map(({ family }) => family);
    const { running, awaiting, unread } = activityCounts(sorted, input);
    rows.push({ kind: "pinned-header", key: "pinned-header", count: sorted.length, collapsed: input.pinnedCollapsed, running, awaiting, unread });
    if (!input.pinnedCollapsed) {
      const { visible, revealed, nextShown } = visibleFamilies(sorted, PINNED_VISIBLE_LIMIT, shownMoreFor(input.moreShown, PINNED_MORE_KEY), input);
      for (const family of visible) {
        rows.push(sessionRow(family, "pinned", resolver.get(familyProjectKey(family)), input));
      }
      const more = moreRowState(sorted.length, visible.length, revealed);
      if (more) rows.push({ kind: "pinned-more", key: "pinned-more", ...more, nextShown });
    }
    rows.push({ kind: "spacer", key: "pinned-spacer" });
  }

  // Projects: live non-pinned families, the current project, pinned projects.
  const projectKeys: string[] = [...projectFamilies.keys()];
  const seen = new Set(projectKeys);
  const addKey = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    projectKeys.push(key);
  };
  if (currentProject) addKey(currentProject.key);
  for (const key of Object.keys(uiState.projects)) addKey(key);

  const projects = projectKeys.map((key) => resolver.get(key));
  // Alphabetical, by the name a group shows (its saved name, else its folder),
  // then by key so two projects sharing a name keep one order; pinned projects
  // stay in their band above the rest. No stored order, and activity never
  // moves a group.
  const byName = (a: SidebarProject, b: SidebarProject) => compareProjectNames(a.name, b.name) || compareProjectNames(a.key, b.key);
  const orderedProjects = [
    ...projects.filter((project) => project.pinned).sort(byName),
    ...projects.filter((project) => !project.pinned).sort(byName),
  ];

  for (const [index, project] of orderedProjects.entries()) {
    // A gap between two groups, open or folded (#1338): headers right on the
    // rows above them read as one list.
    if (index > 0) rows.push({ kind: "spacer", key: `group-spacer:${project.key}` });
    const groupFamilies = projectFamilies.get(project.key) ?? [];
    const expanded = isGroupExpanded(project, input.groupExpansion);
    const { running, awaiting, unread } = activityCounts(groupFamilies, input);
    rows.push({ kind: "group", key: `group:${project.key}`, project, expanded, running, awaiting, unread });

    if (expanded) {
      if (groupFamilies.length === 0) {
        rows.push({ kind: "group-empty", key: `empty:${project.key}`, project });
      } else {
        const { visible, revealed, nextShown } = visibleFamilies(groupFamilies, GROUP_VISIBLE_LIMIT, shownMoreFor(input.moreShown, project.key), input);
        for (const family of visible) rows.push(sessionRow(family, "group", project, input));
        const more = moreRowState(groupFamilies.length, visible.length, revealed);
        if (more) rows.push({ kind: "group-more", key: `more:${project.key}`, projectKey: project.key, ...more, nextShown });
      }
    }
  }

  // One spacer parts the groups from the footer, as one parts the pinned
  // section from them.
  if (orderedProjects.length > 0) rows.push({ kind: "spacer", key: "footer-spacer" });
  rows.push({ kind: "footer-open", key: "footer-open" });
  if (archivedCount > 0) rows.push({ kind: "footer-archived", key: "footer-archived", count: archivedCount });

  return { rows, projects: orderedProjects, archivedCount };
}

/**
 * The archive view: archived families of every project, grouped by project.
 * Groups by their newest archivedAt (desc), families by archivedAt (desc).
 * A group is open unless its project key is in `collapsed` (the browser's
 * own choice, lib/sidebar-prefs.ts); folded, only its header shows.
 */
export function buildArchiveRows(
  input: Pick<SessionTreeInput, "sessions" | "uiState" | "runningIds" | "awaitingIds" | "unreadIds" | "selectedSessionId" | "currentProject">
    & { collapsed?: ReadonlySet<string> },
): SidebarRow[] {
  const { uiState, runningIds } = input;
  const flags: FamilyFlagsInput = input;
  const resolver = createProjectResolver(uiState, input.currentProject);
  const groups = new Map<string, { newest: number; families: { family: SessionFamily; archivedAt: number }[] }>();

  for (const family of listSessionFamilies(input.sessions)) {
    if (!isFamilyArchived(family, uiState, runningIds)) continue;
    resolver.noteFamily(family);
    const archivedAt = finiteNumber(familyEntry(uiState, family.root.id)?.archivedAt) ?? 0;
    const key = familyProjectKey(family);
    const group = groups.get(key);
    if (group) {
      group.families.push({ family, archivedAt });
      group.newest = Math.max(group.newest, archivedAt);
    } else {
      groups.set(key, { newest: archivedAt, families: [{ family, archivedAt }] });
    }
  }

  const rows: SidebarRow[] = [];
  const ordered = [...groups.entries()]
    .map(([key, group], index) => ({ key, group, index }))
    .sort((a, b) => compareDesc(a.group.newest, b.group.newest) || a.index - b.index);
  for (const { key, group } of ordered) {
    const project = resolver.get(key);
    const expanded = !input.collapsed?.has(key);
    rows.push({ kind: "archive-group", key: `archive:${key}`, project, count: group.families.length, expanded });
    if (!expanded) continue;
    const families = group.families
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => compareDesc(a.archivedAt, b.archivedAt) || a.index - b.index);
    for (const { family } of families) {
      rows.push(sessionRow(family, "archive", project, flags));
    }
  }
  return rows;
}

/**
 * Root ids of live, non-pinned, non-running, non-unread, non-selected
 * families of `projectKey` whose latestModified is older than
 * now - olderThanMs. Transient families have no file and are never archived.
 */
export function familiesToArchive(
  input: Pick<SessionTreeInput, "sessions" | "uiState" | "runningIds" | "unreadIds" | "selectedSessionId">,
  projectKey: string,
  olderThanMs: number,
  now: number,
): string[] {
  const cutoff = now - olderThanMs;
  const ids: string[] = [];
  for (const family of listSessionFamilies(input.sessions)) {
    if (familyProjectKey(family) !== projectKey) continue;
    if (isFamilyArchived(family, input.uiState, input.runningIds)) continue;
    if (isFamilyPinned(family, input.uiState, input.runningIds)) continue;
    const status = familyStatus(family, input);
    if (status.running || status.unread || status.selected || status.transient) continue;
    const modified = Date.parse(family.latestModified);
    if (Number.isNaN(modified) || modified >= cutoff) continue;
    ids.push(family.root.id);
  }
  return ids;
}

/**
 * Root ids of the archived families the archive view's bulk actions take
 * (Restore all, Delete…): every archived family, or those of `projectKey`,
 * or those archived before `archivedBefore`. An archived family never runs
 * (isFamilyArchived) and always has a file.
 */
export function archivedFamilyIds(
  input: Pick<SessionTreeInput, "sessions" | "uiState" | "runningIds">,
  filter: { projectKey?: string; archivedBefore?: number } = {},
): string[] {
  const ids: string[] = [];
  for (const family of listSessionFamilies(input.sessions)) {
    if (filter.projectKey !== undefined && familyProjectKey(family) !== filter.projectKey) continue;
    if (!isFamilyArchived(family, input.uiState, input.runningIds)) continue;
    if (filter.archivedBefore !== undefined) {
      const archivedAt = finiteNumber(familyEntry(input.uiState, family.root.id)?.archivedAt);
      if (archivedAt === null || archivedAt >= filter.archivedBefore) continue;
    }
    ids.push(family.root.id);
  }
  return ids;
}

/**
 * A project group's "Delete all sessions": root ids of every family of
 * `projectKey` that has a file, pinned and archived ones included (the
 * server deletes their subagent sessions with them), and how many families
 * it keeps because they run or wait for input: deleting one would stop its
 * run. Transient families have no file to delete.
 */
export function familiesToDelete(
  input: Pick<SessionTreeInput, "sessions" | "runningIds" | "awaitingIds">,
  projectKey: string,
): { ids: string[]; running: number } {
  const ids: string[] = [];
  let running = 0;
  for (const family of listSessionFamilies(input.sessions)) {
    if (familyProjectKey(family) !== projectKey || family.root.transient) continue;
    if (anyMemberIn(family, input.runningIds) || (input.awaitingIds && anyMemberIn(family, input.awaitingIds))) {
      running++;
      continue;
    }
    ids.push(family.root.id);
  }
  return { ids, running };
}

/** Prefix sums of row heights: length rows.length + 1, offsets[0] = 0. */
export function getRowOffsets(rows: readonly SidebarRow[], layout: SidebarLayout): number[] {
  const heights = SIDEBAR_ROW_HEIGHTS[layout];
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rows.length; index++) {
    offsets[index + 1] = offsets[index] + heights[rows[index].kind];
  }
  return offsets;
}

const UNMEASURED_VIEWPORT_HEIGHT = 600;

/**
 * Indices to render: rows intersecting [scrollTop - overscanPx,
 * scrollTop + viewportHeight + overscanPx] (an unmeasured viewport of 0 counts
 * as 600px), plus every valid index in `keepMounted`. Sorted and unique.
 */
export function getVisibleRowIndices(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number,
  keepMounted: readonly number[] = [],
): number[] {
  const count = Math.max(0, offsets.length - 1);
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : UNMEASURED_VIEWPORT_HEIGHT;
  const overscan = Number.isFinite(overscanPx) && overscanPx > 0 ? overscanPx : 0;
  const windowStart = top - overscan;
  const windowEnd = top + height + overscan;

  // First row whose bottom edge is below windowStart.
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid + 1] > windowStart) high = mid;
    else low = mid + 1;
  }
  const first = low;

  // First row whose top edge is at or past windowEnd; the range ends before it.
  low = first;
  high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] >= windowEnd) high = mid;
    else low = mid + 1;
  }
  const end = low;

  const indices: number[] = [];
  for (let index = first; index < end; index++) indices.push(index);
  if (keepMounted.length === 0) return indices;

  const extra = keepMounted.filter((index) => Number.isInteger(index) && index >= 0 && index < count && (index < first || index >= end));
  if (extra.length === 0) return indices;
  return [...new Set([...indices, ...extra])].sort((a, b) => a - b);
}

/**
 * The scrollTop that brings row `index` into a viewport of `viewportHeight`
 * now scrolled to `scrollTop`: centred when it is partly or wholly out of
 * view, null when it is already in view (or there is no such row). With
 * `block` "start" the row goes to the top unless it is there already (the
 * browser clamps a list too short to put it there).
 */
export function revealScrollTop(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  viewportHeight: number,
  block?: "start",
): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= offsets.length - 1) return null;
  const top = offsets[index];
  const bottom = offsets[index + 1];
  if (block === "start") return top === scrollTop ? null : top;
  if (top >= scrollTop && bottom <= scrollTop + viewportHeight) return null;
  return Math.max(0, top - Math.max(0, (viewportHeight - (bottom - top)) / 2));
}

/** A reveal request is dropped once its row has missed this many rows updates, or this long after it was made. */
export const REVEAL_MAX_MISSES = 3;
export const REVEAL_EXPIRY_MS = 3000;

/** How many rows updates have missed one reveal request's row so far. */
export interface RevealMisses { id: number; misses: number }

/**
 * One look at the rows for a reveal request (SessionTreeReveal in
 * components/SessionTree.tsx): "reveal" when its row is there, "wait" for the
 * next rows update, "drop" when it is older than REVEAL_EXPIRY_MS (found or
 * not: a row that turns up later, for another reason, is not scrolled to) or
 * its row has now missed REVEAL_MAX_MISSES updates. `misses` is the count
 * so far, kept for this id only; the next one comes back with the verdict.
 */
export function revealStep(
  misses: RevealMisses | null,
  request: { id: number; at: number },
  found: boolean,
  now: number,
): { misses: RevealMisses; action: "reveal" | "wait" | "drop" } {
  const current = misses?.id === request.id ? misses : { id: request.id, misses: 0 };
  // Written so an unreadable time counts as too old.
  if (!(now - request.at <= REVEAL_EXPIRY_MS)) return { misses: current, action: "drop" };
  if (found) return { misses: current, action: "reveal" };
  const next = { id: request.id, misses: current.misses + 1 };
  return { misses: next, action: next.misses >= REVEAL_MAX_MISSES ? "drop" : "wait" };
}
