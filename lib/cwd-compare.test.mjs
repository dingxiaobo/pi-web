import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sameCwd } = await jiti.import("./cwd-compare.ts");

test("identical strings are equal", () => {
  assert.equal(sameCwd("/repo", "/repo"), true);
  assert.equal(sameCwd(null, null), true);
});

test("null never equals a path", () => {
  assert.equal(sameCwd(null, "/repo"), false);
  assert.equal(sameCwd("/repo", null), false);
  assert.equal(sameCwd(undefined, "/repo"), false);
});

test("separator style and trailing separators are tolerated", () => {
  assert.equal(sameCwd("/repo", "/repo/"), true);
  assert.equal(sameCwd("/repo//sub", "/repo/sub"), true);
  assert.equal(sameCwd("D:\\repo\\sub", "D:/repo/sub"), true);
  assert.equal(sameCwd("D:\\", "D:/"), true);
});

test("UNC paths compare without collapsing to POSIX roots", () => {
  assert.equal(sameCwd("\\\\server\\share", "//server/share"), true);
  assert.equal(sameCwd("\\\\server\\share\\", "//server/share"), true);
});

test("Windows-style paths are case-insensitive", () => {
  assert.equal(sameCwd("d:\\Repo", "D:/repo"), true);
  assert.equal(sameCwd("D:\\REPO\\Sub", "d:/repo/sub"), true);
});

test("POSIX paths stay case-sensitive", () => {
  assert.equal(sameCwd("/Repo", "/repo"), false);
});

test("different directories are not equal", () => {
  assert.equal(sameCwd("/repo/a", "/repo/b"), false);
  assert.equal(sameCwd("D:/repo", "E:/repo"), false);
  assert.equal(sameCwd("/repo", "/repo-worktree"), false);
});

test("the POSIX root survives trailing-separator stripping", () => {
  assert.equal(sameCwd("/", "/"), true);
  assert.equal(sameCwd("/", "//"), true);
  assert.equal(sameCwd("/", "/repo"), false);
});
