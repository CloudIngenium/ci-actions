/**
 * Self-cleaning temp fixtures for this repo's `node --test` suites.
 *
 * Why (measured 2026-09-21 on jc-dev-02): the six suites here called
 * `mkdtemp(path.join(os.tmpdir(), "<family>-"))` and never removed the result
 * — 94 leaked directories from ten call sites (62 `ci-admission-action-*`
 * alone). Knowledge-Hub's tmp-debris census named every family and this repo
 * as the creator; the allowlist there is the backstop, this file is the fix.
 *
 * Port of Knowledge-Hub `scripts/lib/tmp-fixture.mjs`, trimmed to what an
 * action test needs. Same contract: drop-in for
 * `mkdtempSync(join(tmpdir(), `${prefix}-`))` — same `<prefix>-XXXXXX` shape,
 * same return value — removed on process exit. Cleanup is best-effort by
 * construction: `process.on("exit")` runs on a normal exit or `process.exit()`,
 * not on a signal, so a killed run leaks ONE run's fixtures instead of every
 * run's forever. `KEEP_TMP_FIXTURES=1` keeps them for debugging.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** @type {string[]} directories created by this process, newest last */
const created = [];
let exitHookInstalled = false;

/**
 * @param {string} [prefix] fixture family, e.g. "ci-admission-action"
 * @returns {string} absolute path to the new directory
 */
export function tmpFixture(prefix = "fixture") {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  created.push(dir);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", cleanupTmpFixtures);
  }
  return dir;
}

/**
 * Remove every directory `tmpFixture` created in this process. Idempotent and
 * never throws: a fixture a test already removed must not turn a green suite
 * red at exit.
 * @returns {number} directories removed (or already gone)
 */
export function cleanupTmpFixtures() {
  if (process.env.KEEP_TMP_FIXTURES === "1") return 0;
  let n = 0;
  while (created.length > 0) {
    const dir = created.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
      n++;
    } catch {
      // best effort — the old behaviour was to leak, never to fail
    }
  }
  return n;
}

/** Directories currently registered for cleanup. Test-visibility only. */
export function trackedTmpFixtures() {
  return [...created];
}
