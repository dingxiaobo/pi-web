import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  GROUP_VISIBLE_LIMIT,
  PINNED_MORE_KEY,
  PINNED_VISIBLE_LIMIT,
  SHOW_MORE_STEP,
  SIDEBAR_ROW_HEIGHTS,
  archivedFamilyIds,
  buildArchiveRows,
  buildSessionTree,
  effectiveGroupExpansion,
  familiesToArchive,
  familiesToDelete,
  familyIds,
  forgetKeptOpenGroups,
  forgetShownMoreOfFolded,
  getRowOffsets,
  getVisibleRowIndices,
  isFamilyArchived,
  isFamilyPinned,
  isGroupExpanded,
  keepOutgoingGroupOpen,
  REVEAL_EXPIRY_MS,
  REVEAL_MAX_MISSES,
  revealScrollTop,
  revealStep,
  showLessFamilies,
  showMoreFamilies,
  shownMoreFor,
  projectNameOf,
} = await jiti.import("./session-tree.ts");
const { listSessionFamilies } = await jiti.import("./session-family.ts");

const DAY = 86_400_000;
const BASE = Date.parse("2026-10-01T00:00:00.000Z");

function iso(ms) {
  return new Date(ms).toISOString();
}

function session(id, { project = "/work/alpha", cwd = project, modified = BASE, ...rest } = {}) {
  return {
    path: `${cwd}/${id}.jsonl`,
    id,
    cwd,
    projectRoot: project,
    projectKey: project,
    created: iso(modified),
    modified: iso(modified),
    messageCount: 1,
    firstMessage: id,
    ...rest,
  };
}

function subagent(id, parentSessionId, options = {}) {
  return session(id, {
    ...options,
    relation: { kind: "subagent", parentSessionId, profile: "explore", description: "Explore", status: "completed" },
  });
}

function uiState({ sessions = {}, projects = {}, projectOrder } = {}) {
  return { version: 1, revision: 0, sessions, projects, ...(projectOrder ? { projectOrder } : {}) };
}

function input(overrides = {}) {
  return {
    sessions: [],
    uiState: uiState(),
    runningIds: new Set(),
    unreadIds: new Set(),
    selectedSessionId: null,
    currentProject: null,
    groupExpansion: {},
    moreShown: {},
    pinnedCollapsed: false,
    ...overrides,
  };
}

function familyOf(sessions, rootId) {
  const family = listSessionFamilies(sessions).find((item) => item.root.id === rootId);
  assert.ok(family, `family ${rootId} not found`);
  return family;
}

function describeRows(rows) {
  return rows.map((row) => {
    switch (row.kind) {
      case "session": return `${row.context}:${row.family.root.id}`;
      case "group": return `group:${row.project.name}${row.expanded ? "" : " (collapsed)"}`;
      case "group-more": return `more:${row.hidden}${row.canShowLess ? " less" : ""}`;
      case "pinned-more": return `pinned-more:${row.hidden}${row.canShowLess ? " less" : ""}`;
      case "pinned-header": return `pinned:${row.count}`;
      case "group-empty": return "empty";
      case "spacer": return "-";
      case "footer-archived": return `archived:${row.count}`;
      case "archive-group": return `archive-group:${row.project.name}:${row.count}${row.expanded ? "" : " (collapsed)"}`;
      default: return row.kind;
    }
  });
}

test("an awaiting member marks its family; the group header counts it as awaiting, not running", () => {
  const sessions = [session("root"), subagent("child", "root")];
  const currentProject = { key: "/work/alpha", root: "/work/alpha" };
  const viewing = (overrides) => buildSessionTree(input({ sessions, currentProject, ...overrides }));

  const awaiting = viewing({ runningIds: new Set(["child"]), awaitingIds: new Set(["child"]) });
  const row = awaiting.rows.find((item) => item.kind === "session");
  assert.equal(row.status.running, true, "an awaiting run is still running");
  assert.equal(row.status.awaiting, true);
  // The header counts what the row shows: the amber dot, not the spinner.
  const group = awaiting.rows.find((item) => item.kind === "group");
  assert.equal(group.running, 0);
  assert.equal(group.awaiting, 1);

  const running = viewing({ runningIds: new Set(["child"]) });
  assert.equal(running.rows.find((item) => item.kind === "session").status.awaiting, false);
  assert.equal(running.rows.find((item) => item.kind === "group").running, 1);
  assert.equal(running.rows.find((item) => item.kind === "group").awaiting, 0);
});

test("folded headers split running and awaiting families, pinned section included", () => {
  const sessions = [session("a"), session("b"), session("c"), session("p"), session("q")];
  const model = buildSessionTree(input({
    sessions,
    uiState: uiState({ sessions: { p: { pinnedAt: 1 }, q: { pinnedAt: 2 } } }),
    runningIds: new Set(["a", "b", "c", "p", "q"]),
    awaitingIds: new Set(["b", "c", "q"]),
    unreadIds: new Set(["a"]),
  }));
  const header = model.rows.find((item) => item.kind === "pinned-header");
  assert.equal(header.running, 1);
  assert.equal(header.awaiting, 1);
  const group = model.rows.find((item) => item.kind === "group");
  assert.equal(group.running, 1);
  assert.equal(group.awaiting, 2);
  assert.equal(group.unread, 1);
});

test("family ids list the root first, then every subagent", () => {
  const sessions = [session("root"), subagent("child", "root"), subagent("grandchild", "child")];
  assert.deepEqual(familyIds(familyOf(sessions, "root")), ["root", "child", "grandchild"]);
});

test("forks stay separate rows while subagents fold into their root", () => {
  const sessions = [
    session("parent", { modified: BASE }),
    session("fork", { modified: BASE + 2, relation: { kind: "fork", originSessionId: "parent" } }),
    subagent("child", "parent", { modified: BASE + 1 }),
  ];
  const model = buildSessionTree(input({ sessions, currentProject: { key: "/work/alpha", root: "/work/alpha" } }));
  assert.deepEqual(describeRows(model.rows), ["-", "group:alpha", "group:fork", "group:parent", "-", "footer-open"]);
  assert.deepEqual(model.rows[3].family.subagents.map((item) => item.id), ["child"]);
});

test("a family is archived until its root session gets a newer message", () => {
  const sessions = [session("root", { modified: BASE }), subagent("child", "root", { modified: BASE + 5 * DAY })];
  const family = familyOf(sessions, "root");
  const archivedLater = uiState({ sessions: { root: { archivedAt: BASE + DAY } } });
  const archivedBefore = uiState({ sessions: { root: { archivedAt: BASE - DAY } } });

  assert.equal(isFamilyArchived(family, archivedLater, new Set()), true, "subagent-only activity does not unarchive");
  assert.equal(isFamilyArchived(family, archivedBefore, new Set()), false, "a newer root message returns the family");
  assert.equal(isFamilyArchived(family, uiState({ sessions: { root: { archivedAt: BASE } } }), new Set()), true, "equal times stay archived");
  assert.equal(isFamilyArchived(family, uiState(), new Set()), false);
});

test("a running member keeps the family live; summary rows trust the flag", () => {
  const sessions = [session("root", { modified: BASE + 3 * DAY, detailsPending: true }), subagent("child", "root")];
  const family = familyOf(sessions, "root");
  const state = uiState({ sessions: { root: { archivedAt: BASE } } });

  assert.equal(isFamilyArchived(family, state, new Set()), true, "detailsPending ignores the stat time");
  assert.equal(isFamilyArchived(family, state, new Set(["child"])), false);
  assert.equal(isFamilyArchived(family, state, new Set(["root"])), false);
});

test("pinned requires a pin and a live family; prototype keys never match", () => {
  const sessions = [session("root"), session("constructor")];
  const family = familyOf(sessions, "root");
  assert.equal(isFamilyPinned(family, uiState({ sessions: { root: { pinnedAt: 1 } } }), new Set()), true);
  assert.equal(isFamilyPinned(family, uiState({ sessions: { root: { pinnedAt: 1, archivedAt: BASE + DAY } } }), new Set()), false);
  assert.equal(isFamilyPinned(family, uiState(), new Set()), false);
  const odd = familyOf(sessions, "constructor");
  assert.equal(isFamilyArchived(odd, uiState(), new Set()), false);
  assert.equal(isFamilyPinned(odd, uiState(), new Set()), false);
});

test("project names use the last path segment on POSIX and Windows", () => {
  assert.equal(projectNameOf("/Users/alex/pi-web"), "pi-web");
  assert.equal(projectNameOf("/Users/alex/pi-web/"), "pi-web");
  assert.equal(projectNameOf("C:\\Users\\Alex\\Project\\"), "Project");
  assert.equal(projectNameOf("C:\\Users\\Alex\\Project"), "Project");
  assert.equal(projectNameOf("C:/mixed\\sep/name"), "name");
  assert.equal(projectNameOf("/"), "/");
  assert.equal(projectNameOf("relative"), "relative");
  assert.equal(projectNameOf(""), "");
});

test("groups are alphabetical, the current project included wherever its name puts it", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 2 * DAY }),
    session("b1", { project: "/work/beta", modified: BASE + 3 * DAY }),
    subagent("a1-child", "a1", { project: "/work/alpha", modified: BASE + 4 * DAY }),
  ];
  const model = buildSessionTree(input({
    sessions,
    currentProject: { key: "/work/fresh", root: "/work/fresh" },
  }));

  assert.deepEqual(model.projects.map((project) => project.name), ["alpha", "beta", "fresh"]);
  // A spacer opens the list, parts the groups and closes them before the footer.
  assert.deepEqual(describeRows(model.rows), [
    "-", "group:alpha (collapsed)",
    "-", "group:beta (collapsed)",
    "-", "group:fresh", "empty", "-",
    "footer-open",
  ]);
  assert.equal(model.projects[2].current, true);
  assert.equal(model.archivedCount, 0);
});

test("pinned projects keep the band above, alphabetical inside it, and use the stored root without sessions", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 9 * DAY }),
    session("b1", { project: "/work/beta", modified: BASE }),
  ];
  const state = uiState({
    projects: {
      // Pin time has no say in the order any more: beta was pinned last.
      "/work/gamma": { pinnedAt: 10, root: "/work/gamma" },
      "/work/beta": { pinnedAt: 20, root: "/stale/beta" },
    },
  });
  const model = buildSessionTree(input({ sessions, uiState: state }));

  assert.deepEqual(model.projects.map((project) => [project.name, project.root, project.pinned]), [
    ["beta", "/work/beta", true],
    ["gamma", "/work/gamma", true],
    ["alpha", "/work/alpha", false],
  ]);
  assert.deepEqual(describeRows(model.rows), [
    "-", "group:beta", "group:b1",
    "-", "group:gamma", "empty",
    "-", "group:alpha (collapsed)", "-",
    "footer-open",
  ]);
});

test("a project root comes from its newest family", () => {
  const sessions = [
    session("old", { project: "C:\\Repo", modified: BASE }),
    { ...session("new", { project: "c:/repo", modified: BASE + DAY }), projectKey: "C:\\Repo" },
  ];
  const model = buildSessionTree(input({ sessions }));
  assert.equal(model.projects.length, 1);
  assert.equal(model.projects[0].root, "c:/repo");
  assert.equal(model.projects[0].key, "C:\\Repo");
});

test("a project's display name replaces its folder name everywhere, and changes nothing else", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 2 * DAY }),
    session("a2", { project: "/work/alpha", modified: BASE + DAY }),
    session("b1", { project: "/work/beta", modified: BASE + 3 * DAY }),
    session("c1", { project: "/work/gamma", modified: BASE }),
  ];
  const plain = uiState({
    sessions: { a2: { pinnedAt: 1 }, c1: { archivedAt: BASE + DAY } },
    projects: { "/work/beta": { pinnedAt: 5, root: "/work/beta" } },
    projectOrder: ["/work/alpha"],
  });
  // Two projects may share a name: the path (the header's tooltip) tells them apart.
  const named = { ...plain, projectNames: { "/work/alpha": "Thermal Models", "/work/beta": "Thermal Models", "/work/gamma": "Old <b>sims</b>", "/work/gone": "Gone" } };
  const before = buildSessionTree(input({ sessions, uiState: plain, currentProject: { key: "/work/alpha", root: "/work/alpha" } }));
  const after = buildSessionTree(input({ sessions, uiState: named, currentProject: { key: "/work/alpha", root: "/work/alpha" } }));

  // Beta is pinned, so its band still comes first; both now share a name, and
  // the key keeps one order for equal names (nothing to compare there).
  assert.deepEqual(after.projects.map((project) => [project.key, project.root, project.name, project.customName]), [
    ["/work/beta", "/work/beta", "Thermal Models", "Thermal Models"],
    ["/work/alpha", "/work/alpha", "Thermal Models", "Thermal Models"],
  ]);
  assert.deepEqual(before.projects.map((project) => [project.name, project.customName]), [["beta", null], ["alpha", null]]);
  // Group headers and a pinned row's project label; same rows, pins and expansion otherwise.
  assert.deepEqual(describeRows(after.rows), describeRows(before.rows).map((row) => row.replace(/^group:(alpha|beta)/, "group:Thermal Models")));
  const pinnedRow = after.rows.find((row) => row.kind === "session" && row.context === "pinned");
  assert.equal(pinnedRow.project.name, "Thermal Models");
  assert.equal(pinnedRow.project.root, "/work/alpha");
  assert.deepEqual(
    after.rows.filter((row) => row.kind === "group").map((row) => [row.project.key, row.expanded, row.project.pinned, row.project.current]),
    before.rows.filter((row) => row.kind === "group").map((row) => [row.project.key, row.expanded, row.project.pinned, row.project.current]),
  );
  // The archive view's group headers too; markup-like text is only text.
  const archive = buildArchiveRows({ sessions, uiState: named, runningIds: new Set(), unreadIds: new Set(), selectedSessionId: null, currentProject: null });
  assert.deepEqual(describeRows(archive), ["archive-group:Old <b>sims</b>:1", "archive:c1"]);
});

test("expanded groups show six families plus running, unread and selected ones", () => {
  const sessions = Array.from({ length: 10 }, (_, index) => session(`s${index}`, { modified: BASE - index * 1000 }));
  sessions.push(subagent("s8-child", "s8", { modified: BASE - 8 * 1000 - 1 }));
  const current = { key: "/work/alpha", root: "/work/alpha" };
  const model = buildSessionTree(input({
    sessions,
    currentProject: current,
    runningIds: new Set(["s8-child"]),
    unreadIds: new Set(["s7"]),
    selectedSessionId: "s9",
  }));

  assert.equal(GROUP_VISIBLE_LIMIT, 6);
  assert.deepEqual(describeRows(model.rows), [
    "-", "group:alpha", "group:s0", "group:s1", "group:s2", "group:s3", "group:s4", "group:s5",
    "group:s7", "group:s8", "group:s9", "more:1", "-", "footer-open",
  ]);
  const group = model.rows[1];
  assert.equal(group.running, 1);
  assert.equal(group.unread, 1);
  const s8 = model.rows.find((row) => row.key === "session:group:s8");
  assert.deepEqual(s8.status, { running: true, awaiting: false, unread: false, selected: false, transient: false });
  assert.equal(model.rows.find((row) => row.key === "session:group:s9").status.selected, true);
});

test("show more reveals 20 families a click and offers show less", () => {
  assert.equal(SHOW_MORE_STEP, 20);
  const key = "/work/alpha";
  const sessions = Array.from({ length: 50 }, (_, index) => session(`s${index}`, { modified: BASE - index }));
  const base = input({ sessions, currentProject: { key, root: key } });
  const sessionCount = (model) => model.rows.filter((row) => row.kind === "session").length;
  const moreRow = (model) => model.rows.find((row) => row.kind === "group-more");

  const collapsed = buildSessionTree(base);
  assert.equal(sessionCount(collapsed), 6);
  assert.deepEqual(moreRow(collapsed), { kind: "group-more", key: `more:${key}`, projectKey: key, hidden: 44, canShowLess: false, nextShown: 20 });

  const once = showMoreFamilies({}, key, moreRow(collapsed).nextShown);
  assert.deepEqual(once, { [key]: 20 });
  const first = buildSessionTree({ ...base, moreShown: once });
  assert.equal(sessionCount(first), 26, "one click adds 20, not the whole project");
  assert.deepEqual(moreRow(first), { kind: "group-more", key: `more:${key}`, projectKey: key, hidden: 24, canShowLess: true, nextShown: 40 });

  const twice = showMoreFamilies(once, key, moreRow(first).nextShown);
  const second = buildSessionTree({ ...base, moreShown: twice });
  assert.equal(sessionCount(second), 46);
  assert.equal(moreRow(second).hidden, 4);

  const thrice = showMoreFamilies(twice, key, moreRow(second).nextShown);
  const all = buildSessionTree({ ...base, moreShown: thrice });
  assert.equal(sessionCount(all), 50, "the last click shows what is left");
  assert.deepEqual(moreRow(all), { kind: "group-more", key: `more:${key}`, projectKey: key, hidden: 0, canShowLess: true, nextShown: 44 });

  const folded = showLessFamilies(thrice, key);
  assert.deepEqual(folded, {});
  assert.deepEqual(describeRows(buildSessionTree({ ...base, moreShown: folded }).rows), describeRows(collapsed.rows));

  // Revealed sessions stay in activity order and keep running/unread/selected extras.
  const withExtras = buildSessionTree({ ...base, moreShown: once, selectedSessionId: "s40", runningIds: new Set(["s45"]) });
  const ids = withExtras.rows.filter((row) => row.kind === "session").map((row) => row.family.root.id);
  assert.deepEqual(ids.slice(0, 26), sessions.slice(0, 26).map((item) => item.id));
  assert.deepEqual(ids.slice(26), ["s40", "s45"]);
  assert.equal(moreRow(withExtras).hidden, 22);

  // Nothing to reveal or fold: no row, even with a leftover count.
  const small = buildSessionTree({ ...base, sessions: sessions.slice(0, 3), moreShown: once });
  assert.equal(small.rows.some((row) => row.kind === "group-more"), false);
});

test("each click reveals 20 more even when running, unread or selected families sit in the next window", () => {
  const key = "/work/alpha";
  const sessions = Array.from({ length: 60 }, (_, index) => session(`s${index}`, { modified: BASE - index }));
  // Ten unread families just past the base limit already show; they must not use up a click.
  const unreadIds = new Set(sessions.slice(8, 18).map((item) => item.id));
  const base = input({ sessions, unreadIds, currentProject: { key, root: key } });
  const visibleCount = (model) => model.rows.filter((row) => row.kind === "session").length;
  const hiddenOf = (model) => model.rows.find((row) => row.kind === "group-more")?.hidden;

  let moreShown = {};
  let model = buildSessionTree({ ...base, moreShown });
  assert.equal(visibleCount(model), 16);
  assert.equal(hiddenOf(model), 44);
  for (const [added, hidden] of [[20, 24], [20, 4], [4, 0]]) {
    const before = visibleCount(model);
    moreShown = showMoreFamilies(moreShown, key, model.rows.find((row) => row.kind === "group-more").nextShown);
    model = buildSessionTree({ ...base, moreShown });
    assert.equal(visibleCount(model) - before, added);
    assert.equal(hiddenOf(model), hidden);
  }
});

test("a revealed family turning selected, unread or running never brings in an older one", () => {
  // The bug: after "show more", picking the last revealed row (now selected,
  // so it showed "anyway" and stopped using up the click) revealed the next,
  // older family below it.
  const key = "/work/alpha";
  const sessions = Array.from({ length: 50 }, (_, index) => session(`s${index}`, { modified: BASE - index }));
  const base = input({ sessions, currentProject: { key, root: key }, moreShown: { [key]: 20 } });
  const ids = (model) => model.rows.filter((row) => row.kind === "session").map((row) => row.family.root.id);
  const window = sessions.slice(0, 26).map((item) => item.id);
  assert.deepEqual(ids(buildSessionTree(base)), window);
  for (const change of [
    { selectedSessionId: "s25" },
    { unreadIds: new Set(["s25"]) },
    { runningIds: new Set(["s25"]) },
    { selectedSessionId: "s10", unreadIds: new Set(["s20"]), runningIds: new Set(["s24"]) },
  ]) {
    const model = buildSessionTree({ ...base, ...change });
    assert.deepEqual(ids(model), window, JSON.stringify(change, (_key, value) => (value instanceof Set ? [...value] : value)));
    assert.equal(model.rows.find((row) => row.kind === "group-more").hidden, 24);
  }
  // A family past the window still shows while flagged, after the window.
  assert.deepEqual(ids(buildSessionTree({ ...base, selectedSessionId: "s30" })), [...window, "s30"]);
});

test("folding a group drops its show-more window, so it reopens with its first rows", () => {
  const key = "/work/alpha";
  const sessions = Array.from({ length: 40 }, (_, index) => session(`s${index}`, { modified: BASE - index }));
  const shown = { [key]: 20, "/work/beta": 20, [PINNED_MORE_KEY]: 20 };
  // A toggle folding one group: only its window goes.
  const one = forgetShownMoreOfFolded(shown, { [key]: false }, [key]);
  assert.deepEqual(one, { "/work/beta": 20, [PINNED_MORE_KEY]: 20 });
  const reopened = buildSessionTree(input({ sessions, currentProject: { key, root: key }, moreShown: one, groupExpansion: { [key]: true } }));
  assert.equal(reopened.rows.filter((row) => row.kind === "session").length, GROUP_VISIBLE_LIMIT);
  // A choice for every group (Alt+click, collapse others): the folded ones lose theirs.
  assert.deepEqual(forgetShownMoreOfFolded(shown, { [key]: true, "/work/beta": false }, null), { [key]: 20, [PINNED_MORE_KEY]: 20 });
  // Opening keeps the window, and nothing to drop returns the same object.
  assert.equal(forgetShownMoreOfFolded(shown, { [key]: true }, [key]), shown);
  assert.equal(forgetShownMoreOfFolded(shown, { "/work/gamma": false }, ["/work/gamma"]), shown);
});

test("show less appears only when it would fold rows back", () => {
  const key = "/work/alpha";
  // Seven families, the seventh running: it shows anyway, so nothing was revealed.
  const sessions = Array.from({ length: 7 }, (_, index) => session(`s${index}`, { modified: BASE - index }));
  const model = buildSessionTree(input({
    sessions,
    runningIds: new Set(["s6"]),
    currentProject: { key, root: key },
    moreShown: { [key]: 20 },
  }));
  assert.equal(model.rows.filter((row) => row.kind === "session").length, 7);
  assert.equal(model.rows.some((row) => row.kind === "group-more"), false, "no show less that would hide nothing");
});

test("show more counts are per key, ignore malformed values and leave other keys alone", () => {
  assert.equal(shownMoreFor({}, "a"), 0);
  assert.equal(shownMoreFor({ a: 20 }, "a"), 20);
  for (const bad of [-5, 0, Number.NaN, Infinity, "20", null]) assert.equal(shownMoreFor({ a: bad }, "a"), 0, String(bad));
  assert.equal(shownMoreFor({ a: 20.7 }, "a"), 20);
  assert.equal(shownMoreFor({}, "constructor"), 0, "inherited keys are not counts");
  assert.deepEqual(showMoreFamilies({ a: 20, b: 40 }, "b", 60), { a: 20, b: 60 });
  assert.deepEqual(showMoreFamilies({ a: Number.NaN }, "a", 20), { a: 20 });
  assert.deepEqual(showMoreFamilies({ a: 40 }, "a", 20), { a: 40 }, "a stale row never shrinks the window");
  const untouched = { a: 20 };
  assert.equal(showLessFamilies(untouched, "b"), untouched, "show less on another key keeps the same object");
  assert.deepEqual(showLessFamilies({ a: 20, b: 40 }, "a"), { b: 40 });
});

test("explicit group choices win over the current/pinned default", () => {
  const project = { key: "k", root: "/k", name: "k", pinned: false, current: true };
  assert.equal(isGroupExpanded(project, {}), true);
  assert.equal(isGroupExpanded(project, { k: false }), false);
  assert.equal(isGroupExpanded({ ...project, current: false }, {}), false);
  assert.equal(isGroupExpanded({ ...project, current: false, pinned: true }, {}), true);
  assert.equal(isGroupExpanded({ ...project, current: false }, { k: true }), true);
  assert.equal(isGroupExpanded({ ...project, key: "constructor", current: false }, {}), false);

  const sessions = [session("a1")];
  const model = buildSessionTree(input({ sessions, groupExpansion: { "/work/alpha": true } }));
  assert.deepEqual(describeRows(model.rows), ["-", "group:alpha", "group:a1", "-", "footer-open"]);
});

test("a group open only because it was current stays open for the page when another project becomes current", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 2 }),
    session("b1", { project: "/work/beta", modified: BASE + 1 }),
  ];
  const alpha = { key: "/work/alpha", root: "/work/alpha" };
  const beta = { key: "/work/beta", root: "/work/beta" };
  const saved = { "/work/beta": true };
  // beta opened with its chevron, alpha open by the default; then a session of beta is picked.
  const before = buildSessionTree(input({ sessions, currentProject: alpha, groupExpansion: saved }));
  assert.deepEqual(describeRows(before.rows), ["-", "group:alpha", "group:a1", "-", "group:beta", "group:b1", "-", "footer-open"]);
  const after = buildSessionTree(input({ sessions, currentProject: beta, groupExpansion: saved }));
  const outgoing = after.projects.find((project) => project.key === alpha.key);
  const none = new Set();
  const kept = keepOutgoingGroupOpen(none, saved, outgoing);
  assert.deepEqual([...kept], ["/work/alpha"]);
  assert.deepEqual([...none], [], "a new set: the old one is never changed");
  assert.deepEqual(saved, { "/work/beta": true }, "the saved choices stay as they were");
  const settled = buildSessionTree(input({ sessions, currentProject: beta, groupExpansion: effectiveGroupExpansion(saved, kept) }));
  assert.deepEqual(describeRows(settled.rows), describeRows(before.rows), "no row moves");
  // After a reload only the saved choices are left: alpha is closed again.
  const reloaded = buildSessionTree(input({ sessions, currentProject: beta, groupExpansion: saved }));
  assert.deepEqual(describeRows(reloaded.rows), ["-", "group:alpha (collapsed)", "-", "group:beta", "group:b1", "-", "footer-open"]);

  // Nothing to keep: an explicit choice (open or closed), a group already
  // kept, a pinned project, the project still being current, or a project
  // whose group is gone.
  for (const choice of [false, true]) {
    assert.equal(keepOutgoingGroupOpen(none, { "/work/alpha": choice }, outgoing), none);
  }
  assert.equal(keepOutgoingGroupOpen(kept, {}, outgoing), kept);
  assert.equal(keepOutgoingGroupOpen(none, {}, { ...outgoing, pinned: true }), none);
  assert.equal(keepOutgoingGroupOpen(none, {}, { ...outgoing, current: true }), none);
  assert.equal(keepOutgoingGroupOpen(none, {}, undefined), none);
  // A raw cwd key replaced by the real project key (identity hydration) had only an empty group.
  const hydrated = buildSessionTree(input({ sessions, currentProject: alpha }));
  assert.equal(keepOutgoingGroupOpen(none, {}, hydrated.projects.find((project) => project.key === "/work/alpha/sub")), none);
});

test("the shown expansion lays the saved choices over the groups kept open for the page", () => {
  const saved = { "/work/a": false, "/work/b": true };
  // Nothing kept open: the saved choices themselves, so the tree's memo holds.
  assert.equal(effectiveGroupExpansion(saved, new Set()), saved);
  const shown = effectiveGroupExpansion(saved, new Set(["/work/c", "/work/a"]));
  assert.deepEqual(shown, { "/work/c": true, "/work/a": false, "/work/b": true }, "a saved choice wins");
  assert.deepEqual(saved, { "/work/a": false, "/work/b": true }, "never written into the saved choices");
  const project = { key: "/work/c", root: "/work/c", name: "c", customName: null, pinned: false, current: false };
  assert.equal(isGroupExpanded(project, saved), false);
  assert.equal(isGroupExpanded(project, shown), true);
  // Odd keys stay own properties.
  const odd = effectiveGroupExpansion({}, new Set(["__proto__", "constructor"]));
  assert.equal(Object.getPrototypeOf(odd), Object.prototype);
  assert.deepEqual(Object.keys(odd), ["__proto__", "constructor"]);
  assert.equal(Object.hasOwn(odd, "__proto__"), true);
});

test("an explicit choice replaces what the page kept open for its groups", () => {
  const kept = new Set(["/work/a", "/work/b"]);
  assert.deepEqual([...forgetKeptOpenGroups(kept, ["/work/a"])], ["/work/b"]);
  assert.deepEqual([...kept], ["/work/a", "/work/b"], "a new set: the old one is never changed");
  // A choice for groups that were not kept open, or none kept: the same set.
  assert.equal(forgetKeptOpenGroups(kept, ["/work/c"]), kept);
  assert.equal(forgetKeptOpenGroups(kept, []), kept);
  const none = new Set();
  assert.equal(forgetKeptOpenGroups(none, null), none);
  // A choice for every group at once (Alt+click, collapse others, expand all).
  assert.deepEqual([...forgetKeptOpenGroups(kept, null)], []);
});

test("pinned families move to the global section, newest pin first", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 3 }),
    session("a2", { project: "/work/alpha", modified: BASE + 2 }),
    session("b1", { project: "/work/beta", modified: BASE + 1 }),
  ];
  const state = uiState({ sessions: { a2: { pinnedAt: 100 }, b1: { pinnedAt: 200 } } });
  const model = buildSessionTree(input({
    sessions,
    uiState: state,
    unreadIds: new Set(["a2"]),
    groupExpansion: { "/work/alpha": true },
  }));

  assert.deepEqual(describeRows(model.rows), [
    "-", "pinned:2", "pinned:b1", "pinned:a2", "-",
    "group:alpha", "group:a1", "-",
    "footer-open",
  ]);
  assert.deepEqual(model.rows[1], { kind: "pinned-header", key: "pinned-header", count: 2, collapsed: false, running: 0, awaiting: 0, unread: 1 });
  const pinnedRow = model.rows[2];
  assert.equal(pinnedRow.project.name, "beta", "pinned rows carry their own project");
  assert.equal(model.projects.some((project) => project.key === "/work/beta"), false, "a project with only pinned families has no group");
  assert.equal(model.rows.find((row) => row.kind === "group").unread, 0, "group summaries exclude pinned families");

  const collapsed = buildSessionTree(input({ sessions, uiState: state, pinnedCollapsed: true, currentProject: { key: "/work/beta", root: "/work/beta" } }));
  assert.deepEqual(describeRows(collapsed.rows).slice(0, 3), ["-", "pinned:2", "-"]);
  assert.equal(collapsed.rows[1].collapsed, true);
  // beta's activity comes from its pinned family, so the newer alpha leads.
  assert.deepEqual(describeRows(collapsed.rows).slice(3), ["group:alpha (collapsed)", "-", "group:beta", "empty", "-", "footer-open"]);
});

test("the pinned section shows eight families, then more or less", () => {
  const sessions = Array.from({ length: 10 }, (_, index) => session(`p${index}`, { modified: BASE - index }));
  const pins = Object.fromEntries(sessions.map((item, index) => [item.id, { pinnedAt: 1000 - index }]));
  const base = input({ sessions, uiState: uiState({ sessions: pins }) });

  assert.equal(PINNED_VISIBLE_LIMIT, 8);
  const limited = buildSessionTree(base);
  assert.equal(limited.rows.filter((row) => row.kind === "session").length, 8);
  assert.deepEqual(limited.rows.find((row) => row.kind === "pinned-more"), { kind: "pinned-more", key: "pinned-more", hidden: 2, canShowLess: false, nextShown: 2 });

  const selected = buildSessionTree({ ...base, selectedSessionId: "p9" });
  assert.equal(selected.rows.some((row) => row.key === "session:pinned:p9"), true, "the selected pinned family stays visible");
  assert.equal(selected.rows.find((row) => row.kind === "pinned-more").hidden, 1);

  const all = buildSessionTree({ ...base, moreShown: showMoreFamilies({}, PINNED_MORE_KEY, limited.rows.find((row) => row.kind === "pinned-more").nextShown) });
  assert.equal(all.rows.filter((row) => row.kind === "session").length, 10);
  assert.deepEqual(all.rows.find((row) => row.kind === "pinned-more"), { kind: "pinned-more", key: "pinned-more", hidden: 0, canShowLess: true, nextShown: 2 });

  // The pinned section pages by 20 as well.
  const many = Array.from({ length: 40 }, (_, index) => session(`q${index}`, { modified: BASE - index }));
  const manyPins = Object.fromEntries(many.map((item, index) => [item.id, { pinnedAt: 1000 - index }]));
  const paged = buildSessionTree(input({ sessions: many, uiState: uiState({ sessions: manyPins }), moreShown: { [PINNED_MORE_KEY]: 20 } }));
  assert.equal(paged.rows.filter((row) => row.kind === "session").length, 28);
  assert.deepEqual(paged.rows.find((row) => row.kind === "pinned-more"), { kind: "pinned-more", key: "pinned-more", hidden: 12, canShowLess: true, nextShown: 32 });
});

test("a pinned project key scopes the pinned section to that project alone", () => {
  // The project filter's pinned section: alpha's pins over alpha's group,
  // beta's pin left in beta's (dropped) group rather than above it.
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 3 }),
    session("a2", { project: "/work/alpha", modified: BASE + 2 }),
    session("b1", { project: "/work/beta", modified: BASE + 1 }),
    session("b2", { project: "/work/beta", modified: BASE }),
  ];
  const state = uiState({ sessions: { a2: { pinnedAt: 100 }, b1: { pinnedAt: 200 } } });

  const scoped = buildSessionTree(input({
    sessions,
    uiState: state,
    pinnedProjectKey: "/work/alpha",
    groupExpansion: { "/work/alpha": true, "/work/beta": true },
  }));
  assert.deepEqual(describeRows(scoped.rows), [
    "-", "pinned:1", "pinned:a2", "-",
    "group:alpha", "group:a1", "-",
    "group:beta", "group:b1", "group:b2", "-",
    "footer-open",
  ]);
  // The header counts this project's pins, not every project's.
  assert.deepEqual(scoped.rows[1], { kind: "pinned-header", key: "pinned-header", count: 1, collapsed: false, running: 0, awaiting: 0, unread: 0 });

  // The other project's pin, and nothing else, is scoped out; the unfiltered
  // tree is unchanged by the new input.
  const beta = buildSessionTree(input({ sessions, uiState: state, pinnedProjectKey: "/work/beta" }));
  assert.deepEqual(describeRows(beta.rows).slice(0, 4), ["-", "pinned:1", "pinned:b1", "-"]);
  assert.deepEqual(describeRows(buildSessionTree(input({ sessions, uiState: state })).rows).slice(0, 4), ["-", "pinned:2", "pinned:b1", "pinned:a2"]);

  // A key no project has (the filter on with nothing picked) leaves the
  // section out altogether, so no pin at all is shown.
  const none = buildSessionTree(input({ sessions, uiState: state, pinnedProjectKey: "" }));
  assert.equal(none.rows.some((row) => row.kind === "pinned-header"), false);
});

test("a scoped pinned section keeps its own show-more window and activity", () => {
  // Alpha has more pins than the section shows; the hidden count is alpha's.
  const alpha = Array.from({ length: 10 }, (_, index) => session(`a${index}`, { project: "/work/alpha", modified: BASE - index }));
  const beta = session("b1", { project: "/work/beta", modified: BASE });
  const pins = Object.fromEntries([
    ...alpha.map((item, index) => [item.id, { pinnedAt: 1000 - index }]),
    [beta.id, { pinnedAt: 5000 }],
  ]);
  const model = buildSessionTree(input({
    sessions: [...alpha, beta],
    uiState: uiState({ sessions: pins }),
    pinnedProjectKey: "/work/alpha",
    unreadIds: new Set(["a1", "b1"]),
  }));
  assert.equal(model.rows.filter((row) => row.kind === "session").length, PINNED_VISIBLE_LIMIT);
  assert.deepEqual(model.rows.find((row) => row.kind === "pinned-more"), { kind: "pinned-more", key: "pinned-more", hidden: 10 - PINNED_VISIBLE_LIMIT, canShowLess: false, nextShown: 10 - PINNED_VISIBLE_LIMIT });
  assert.equal(model.rows[1].count, 10, "beta's pin is not counted");
  assert.equal(model.rows[1].unread, 1, "a1 is alpha's; beta's b1 is not in the section at all");
});

test("archived families leave the tree and are counted across projects", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE }),
    session("a2", { project: "/work/alpha", modified: BASE - 1 }),
    session("b1", { project: "/work/beta", modified: BASE }),
  ];
  const state = uiState({ sessions: { a2: { archivedAt: BASE + DAY }, b1: { archivedAt: BASE + DAY } } });
  const model = buildSessionTree(input({ sessions, uiState: state, groupExpansion: { "/work/alpha": true } }));

  assert.deepEqual(describeRows(model.rows), ["-", "group:alpha", "group:a1", "-", "footer-open", "archived:2"]);
  assert.equal(model.archivedCount, 2);
});

test("with no sessions and no current or pinned project only the footer remains", () => {
  assert.deepEqual(describeRows(buildSessionTree(input()).rows), ["-", "footer-open"]);
  const allArchived = buildSessionTree(input({
    sessions: [session("a1")],
    uiState: uiState({ sessions: { a1: { archivedAt: BASE + DAY } } }),
  }));
  assert.deepEqual(describeRows(allArchived.rows), ["-", "footer-open", "archived:1"]);
  // Pinned families and no group: one spacer between the section and the footer.
  const pinnedOnly = buildSessionTree(input({
    sessions: [session("a1")],
    uiState: uiState({ sessions: { a1: { pinnedAt: 1 } } }),
  }));
  assert.deepEqual(describeRows(pinnedOnly.rows), ["-", "pinned:1", "pinned:a1", "-", "footer-open"]);
});

test("row keys are unique and session rows carry transient status", () => {
  const sessions = [
    session("a1", { project: "/work/alpha" }),
    session("a2", { project: "/work/alpha", transient: true }),
    session("b1", { project: "/work/beta" }),
    session("c1", { project: "/work/gamma" }),
  ];
  const model = buildSessionTree(input({
    sessions,
    uiState: uiState({ sessions: { b1: { pinnedAt: 1 } }, projects: { "/work/gamma": { pinnedAt: 1, root: "/work/gamma" } } }),
    currentProject: { key: "/work/alpha", root: "/work/alpha" },
  }));
  const keys = model.rows.map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("session:pinned:b1"));
  assert.ok(keys.includes("session:group:a1"));
  assert.ok(keys.includes("group:/work/gamma"));
  // One spacer opens the list, one follows the pinned section, one parts each group from the one above, one comes before the footer.
  assert.deepEqual(model.rows.filter((row) => row.kind === "spacer").map((row) => row.key), ["top-spacer", "pinned-spacer", "group-spacer:/work/alpha", "footer-spacer"]);
  assert.equal(model.rows.find((row) => row.key === "session:group:a2").status.transient, true);
});

test("archive rows group by project, newest archive first", () => {
  const sessions = [
    session("a1", { project: "/work/alpha" }),
    session("a2", { project: "/work/alpha" }),
    session("b1", { project: "/work/beta" }),
    session("live", { project: "/work/beta" }),
  ];
  const state = uiState({
    sessions: {
      a1: { archivedAt: BASE + 1 * DAY },
      a2: { archivedAt: BASE + 3 * DAY },
      b1: { archivedAt: BASE + 2 * DAY },
    },
  });
  const rows = buildArchiveRows({
    sessions,
    uiState: state,
    runningIds: new Set(),
    unreadIds: new Set(["a1"]),
    selectedSessionId: "b1",
    currentProject: { key: "/work/beta", root: "/work/beta" },
  });

  assert.deepEqual(describeRows(rows), [
    "archive-group:alpha:2", "archive:a2", "archive:a1",
    "archive-group:beta:1", "archive:b1",
  ]);
  assert.equal(rows[2].status.unread, true);
  assert.equal(rows[4].status.selected, true);
  assert.equal(rows[3].project.current, true);
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);

  // A folded project keeps its header and count, without its rows.
  const folded = buildArchiveRows({
    sessions,
    uiState: state,
    runningIds: new Set(),
    unreadIds: new Set(),
    selectedSessionId: null,
    currentProject: null,
    collapsed: new Set(["/work/alpha"]),
  });
  assert.deepEqual(describeRows(folded), ["archive-group:alpha:2 (collapsed)", "archive-group:beta:1", "archive:b1"]);
});

test("the archive's bulk actions take every archived family, a project's, or those archived before a time", () => {
  const sessions = [
    session("a1", { project: "/work/alpha" }),
    session("a2", { project: "/work/alpha" }),
    subagent("a2-child", "a2", { project: "/work/alpha" }),
    session("b1", { project: "/work/beta" }),
    session("live", { project: "/work/beta" }),
    session("back", { project: "/work/beta", modified: BASE + 9 * DAY }),
  ];
  const state = uiState({
    sessions: {
      a1: { archivedAt: BASE + 1 * DAY },
      a2: { archivedAt: BASE + 3 * DAY },
      b1: { archivedAt: BASE + 2 * DAY },
      // A newer message brought it back: no longer archived.
      back: { archivedAt: BASE + 2 * DAY },
    },
  });
  const input = { sessions, uiState: state, runningIds: new Set() };
  assert.deepEqual(archivedFamilyIds(input).sort(), ["a1", "a2", "b1"]);
  assert.deepEqual(archivedFamilyIds(input, { projectKey: "/work/alpha" }).sort(), ["a1", "a2"]);
  assert.deepEqual(archivedFamilyIds(input, { archivedBefore: BASE + 3 * DAY }).sort(), ["a1", "b1"]);
  assert.deepEqual(archivedFamilyIds(input, { projectKey: "/work/beta", archivedBefore: BASE + 2 * DAY }), []);
  // A running member brings its family back, out of the archive's reach.
  assert.deepEqual(archivedFamilyIds({ ...input, runningIds: new Set(["a2-child"]) }).sort(), ["a1", "b1"]);
});

test("bulk archive candidates skip pinned, running, unread, selected, transient and recent families", () => {
  const now = BASE + 30 * DAY;
  const old = BASE;
  const sessions = [
    session("old", { modified: old }),
    session("pinned", { modified: old }),
    session("running", { modified: old }),
    subagent("running-child", "running", { modified: old }),
    session("unread", { modified: old }),
    session("selected", { modified: old }),
    session("transient", { modified: old, transient: true }),
    session("recent", { modified: now - DAY }),
    session("archived", { modified: old }),
    session("other", { project: "/work/beta", modified: old }),
    session("busy-family", { modified: old }),
    subagent("busy-child", "busy-family", { modified: now - DAY }),
  ];
  const ids = familiesToArchive({
    sessions,
    uiState: uiState({ sessions: { pinned: { pinnedAt: 1 }, archived: { archivedAt: now } } }),
    runningIds: new Set(["running-child"]),
    unreadIds: new Set(["unread"]),
    selectedSessionId: "selected",
  }, "/work/alpha", 7 * DAY, now);

  assert.deepEqual(ids, ["old"]);
});

test("a project's delete-all takes every saved family, pinned and archived ones too, and keeps running ones", () => {
  const sessions = [
    session("plain"),
    session("pinned"),
    session("archived"),
    session("in-worktree", { cwd: "/work/alpha-wt/feature" }),
    session("forked", { relation: { kind: "fork", originSessionId: "plain" } }),
    session("with-child"),
    subagent("child", "with-child"),
    session("running"),
    session("running-parent"),
    subagent("running-child", "running-parent"),
    session("awaiting"),
    session("transient", { transient: true }),
    session("other", { project: "/work/beta" }),
  ];
  const result = familiesToDelete({
    sessions,
    runningIds: new Set(["running", "running-child", "awaiting"]),
    awaitingIds: new Set(["awaiting"]),
  }, "/work/alpha");

  // Root ids only: the server deletes a family's subagent sessions with it.
  assert.deepEqual(result.ids.toSorted(), ["archived", "forked", "in-worktree", "pinned", "plain", "with-child"]);
  assert.equal(result.running, 3);
  assert.deepEqual(familiesToDelete({ sessions, runningIds: new Set() }, "/work/gamma"), { ids: [], running: 0 });
  // Waiting for input is a run too, even when only the awaiting set has it.
  assert.equal(familiesToDelete({ sessions: [session("asking")], runningIds: new Set(), awaitingIds: new Set(["asking"]) }, "/work/alpha").running, 1);
});

test("row offsets follow each kind's height for the layout", () => {
  const rows = [
    { kind: "group", key: "group:a" },
    { kind: "session", key: "session:group:a" },
    { kind: "spacer", key: "footer-spacer" },
    { kind: "footer-open", key: "footer-open" },
  ];
  assert.deepEqual(getRowOffsets(rows, "desktop"), [0, 28, 56, 64, 92]);
  assert.deepEqual(getRowOffsets(rows, "mobile"), [0, 44, 88, 96, 140]);
  assert.deepEqual(getRowOffsets([], "desktop"), [0]);
  assert.equal(SIDEBAR_ROW_HEIGHTS.mobile.session, 44);
  // Both section headers (the pinned section's and a project's) are a
  // session row's height.
  for (const layout of ["desktop", "mobile"]) {
    assert.equal(SIDEBAR_ROW_HEIGHTS[layout]["pinned-header"], SIDEBAR_ROW_HEIGHTS[layout].group, layout);
    assert.equal(SIDEBAR_ROW_HEIGHTS[layout].group, SIDEBAR_ROW_HEIGHTS[layout].session, layout);
  }
});

test("visible indices cover the viewport and overscan, sorted and unique", () => {
  const offsets = Array.from({ length: 2001 }, (_, index) => index * 32);
  const visible = getVisibleRowIndices(offsets, 3200, 320, 64);
  // Rows 98..111 intersect [3136, 3584).
  assert.deepEqual(visible, Array.from({ length: 14 }, (_, index) => 98 + index));

  const withFocus = getVisibleRowIndices(offsets, 3200, 320, 64, [5, 1500, 100, 5, -1, 2000, 1.5]);
  assert.deepEqual(withFocus, [5, ...visible, 1500]);

  assert.deepEqual(getVisibleRowIndices(offsets, 0, 64, 0), [0, 1]);
  assert.deepEqual(getVisibleRowIndices(offsets, 10, 32, 0), [0, 1]);
});

test("visible indices stay valid for short, empty and unmeasured lists", () => {
  const short = [0, 32, 64, 96, 128, 160];
  assert.deepEqual(getVisibleRowIndices(short, 5000, 320, 240), [], "scrolled past a list that shrank");
  assert.deepEqual(getVisibleRowIndices(short, 0, 320, 240), [0, 1, 2, 3, 4]);
  assert.deepEqual(getVisibleRowIndices([0], 0, 320, 240, [0]), []);
  const long = Array.from({ length: 101 }, (_, index) => index * 32);
  assert.equal(getVisibleRowIndices(long, 0, 0, 0).length, 19, "viewport 0 assumes 600px");
  assert.deepEqual(getVisibleRowIndices(long, Number.NaN, 0, 0), getVisibleRowIndices(long, 0, 600, 0));
});

test("a row out of view is scrolled to the middle; one in view stays put", () => {
  // Rows of 32px: row 10 spans 320-352.
  const offsets = Array.from({ length: 101 }, (_, index) => index * 32);
  assert.equal(revealScrollTop(offsets, 10, 0, 400), null, "wholly in view");
  assert.equal(revealScrollTop(offsets, 10, 300, 400), null);
  assert.equal(revealScrollTop(offsets, 10, 330, 400), 136, "partly above: centred");
  assert.equal(revealScrollTop(offsets, 10, 0, 340), 166, "partly below: centred");
  assert.equal(revealScrollTop(offsets, 1, 3000, 400), 0, "never above the top");
  assert.equal(revealScrollTop(offsets, 99, 0, 20), 3168, "a viewport smaller than the row puts its top first");
  // "start": a header goes to the top, in view or not, unless it is there.
  assert.equal(revealScrollTop(offsets, 10, 0, 400, "start"), 320);
  assert.equal(revealScrollTop(offsets, 10, 320, 400, "start"), null);
  assert.equal(revealScrollTop(offsets, 10, 900, 400, "start"), 320);
  for (const index of [-1, 100, 1.5, Number.NaN]) assert.equal(revealScrollTop(offsets, index, 0, 400), null);
});

test("a reveal request is shown while fresh, waits a few rows updates for its row, and is dropped when old", () => {
  const at = 1_000_000;
  const request = { id: 7, at };
  assert.deepEqual(revealStep(null, request, true, at), { misses: { id: 7, misses: 0 }, action: "reveal" });

  // Missing rows: wait, then drop on the REVEAL_MAX_MISSES-th miss.
  let misses = null;
  for (let look = 1; look < REVEAL_MAX_MISSES; look++) {
    const step = revealStep(misses, request, false, at + look);
    assert.equal(step.action, "wait");
    assert.equal(step.misses.misses, look);
    misses = step.misses;
  }
  assert.equal(revealStep(misses, request, false, at + 10).action, "drop");
  // Found after a miss or two, while fresh: shown.
  assert.equal(revealStep(misses, request, true, at + 10).action, "reveal");

  // Too old, found or not: a row that turns up minutes later (its group
  // expanded), or a tree mounted again after the request went stale, never
  // scrolls to it.
  assert.equal(revealStep({ id: 7, misses: 1 }, request, true, at + REVEAL_EXPIRY_MS + 1).action, "drop");
  assert.equal(revealStep(null, request, true, at + 5 * 60_000).action, "drop");
  assert.equal(revealStep(null, request, false, at + REVEAL_EXPIRY_MS + 1).action, "drop");
  assert.equal(revealStep(null, request, true, at + REVEAL_EXPIRY_MS).action, "reveal", "the limit itself still counts");
  assert.equal(revealStep(null, { id: 7, at: Number.NaN }, true, at).action, "drop");

  // Another request starts its own count.
  assert.deepEqual(revealStep({ id: 7, misses: 2 }, { id: 8, at }, false, at), { misses: { id: 8, misses: 1 }, action: "wait" });
});

const names = (model) => model.projects.map((project) => project.name);
const keysOf = (projects) => projects.map((project) => project.key);
const pinnedProject = (pinnedAt, root) => ({ pinnedAt, root });

test("groups are alphabetical by the name they show, and activity never moves one", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 9 * DAY }),
    session("b1", { project: "/work/beta", modified: BASE + DAY }),
    session("g1", { project: "/work/Gamma", modified: BASE + 5 * DAY }),
    session("d1", { project: "/work/delta", modified: BASE + 3 * DAY }),
  ];
  // No activity order, no stored order: the names' own, case-insensitively.
  assert.deepEqual(names(buildSessionTree(input({ sessions }))), ["alpha", "beta", "delta", "Gamma"]);
  // A stored order (an older client's, or this fork's own former one) is ignored.
  assert.deepEqual(
    names(buildSessionTree(input({ sessions, uiState: uiState({ projectOrder: ["/work/Gamma", "/work/delta", "/work/beta", "/work/alpha"] }) }))),
    ["alpha", "beta", "delta", "Gamma"],
  );
  // A new message, a run, a selection or an unread marker in the last project moves nothing.
  const busy = buildSessionTree(input({
    sessions: [...sessions, session("a2", { project: "/work/alpha", modified: BASE + 40 * DAY })],
    runningIds: new Set(["a2"]),
    unreadIds: new Set(["a1"]),
    selectedSessionId: "a2",
    currentProject: { key: "/work/alpha", root: "/work/alpha" },
  }));
  assert.deepEqual(names(busy), ["alpha", "beta", "delta", "Gamma"]);
});

test("a renamed project sorts by the name it shows, and the empty current project takes its place there", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE }),
    session("b1", { project: "/work/beta", modified: BASE + DAY }),
  ];
  const renamed = { ...uiState(), projectNames: { "/work/beta": "aardvark" } };
  assert.deepEqual(names(buildSessionTree(input({ sessions, uiState: renamed }))), ["aardvark", "alpha"]);
  // Two projects sharing a name: the key decides, so the order is stable.
  const same = { ...uiState(), projectNames: { "/work/beta": "alpha", "/work/alpha": "alpha" } };
  assert.deepEqual(keysOf(buildSessionTree(input({ sessions, uiState: same })).projects), ["/work/alpha", "/work/beta"]);
  // A current project without sessions shows among the others, in its place.
  assert.deepEqual(
    names(buildSessionTree(input({ sessions, currentProject: { key: "/work/beta-project", root: "/work/beta-project" } }))),
    ["alpha", "beta", "beta-project"],
  );
});

test("pinned projects sort with each other and stay above the others, whatever the stored order", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 9 * DAY }),
    session("p1s", { project: "/work/p1", modified: BASE }),
  ];
  const projects = {
    "/work/p1": pinnedProject(10, "/work/p1"),
    "/work/p2": pinnedProject(20, "/work/p2"),
    "/work/p3": pinnedProject(30, "/work/p3"),
    "/work/p4": pinnedProject(5, "/work/p4"),
    "/work/gone": pinnedProject(1, "/work/gone"),
  };
  const model = buildSessionTree(input({
    sessions,
    uiState: uiState({ projects, projectOrder: ["/work/p2", "/work/alpha", "/work/p1"] }),
  }));
  // The pinned band first, alphabetical, without its sessions-less "gone"; then the others.
  assert.deepEqual(names(model), ["gone", "p1", "p2", "p3", "p4", "alpha"]);
  assert.deepEqual(model.projects.map((project) => project.pinned), [true, true, true, true, true, false]);
});

test("groups are parted by spacers, open or folded, above the footer", () => {
  const sessions = [
    session("pin", { project: "/work/alpha", modified: BASE + 9 * DAY }),
    ...Array.from({ length: 8 }, (_, index) => session(`a${index}`, { project: "/work/alpha", modified: BASE + index })),
    session("b1", { project: "/work/beta" }),
  ];
  const model = buildSessionTree(input({
    sessions,
    uiState: uiState({ sessions: { pin: { pinnedAt: 1 } }, projects: { "/work/gamma": pinnedProject(1, "/work/gamma") } }),
    groupExpansion: { "/work/alpha": true },
  }));
  // Spacers open the list, follow the pinned section, part each group from
  // the one above it, open or folded, and come before the footer.
  assert.deepEqual(describeRows(model.rows), [
    "-", "pinned:1", "pinned:pin", "-",
    "group:gamma", "empty",
    "-", "group:alpha", "group:a7", "group:a6", "group:a5", "group:a4", "group:a3", "group:a2", "more:2",
    "-", "group:beta (collapsed)", "-",
    "footer-open",
  ]);
});
