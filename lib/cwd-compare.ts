/**
 * Browser-safe cwd equality.
 *
 * lib/paths.ts already has samePath(), but it leans on the Node `path` module
 * and `process.platform`, which client bundles cannot use. Client components
 * that need to tell "the same directory, different spelling" (trailing
 * separators, slash styles, Windows drive-letter case) apart from "a genuinely
 * different directory" compare through sameCwd() instead.
 *
 * Lexical comparison only — callers wanting symlink resolution must ask the
 * server. This is deliberately conservative: on POSIX, paths that differ only
 * by case are NOT treated as equal.
 */

const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

function normalizeForCompare(cwd: string): string {
  // Unify separators, then collapse runs of "/" (keep a leading "//" so UNC
  // paths stay distinguishable from POSIX absolute paths).
  const slashed = cwd.replace(/\\/g, "/");
  let collapsed = slashed.replace(/\/{2,}/g, "/");
  if (slashed.startsWith("//")) collapsed = "/" + collapsed;
  // Strip trailing separators, but keep the POSIX root itself.
  if (collapsed !== "/") collapsed = collapsed.replace(/\/+$/, "") || "/";
  return collapsed;
}

/**
 * Whether two cwd strings denote the same location, tolerating separator
 * style, duplicate/trailing separators, and — for Windows-style paths, where
 * the filesystem is case-insensitive — case including the drive letter
 * (`d:\repo` vs `D:\repo`).
 */
export function sameCwd(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const normalizedA = normalizeForCompare(a);
  const normalizedB = normalizeForCompare(b);
  if (normalizedA === normalizedB) return true;
  if (WINDOWS_ABSOLUTE_RE.test(a) || WINDOWS_ABSOLUTE_RE.test(b)) {
    return normalizedA.toLowerCase() === normalizedB.toLowerCase();
  }
  return false;
}
