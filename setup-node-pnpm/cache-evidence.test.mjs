import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveIsolatedPnpmCacheEvidence } from "./cache-evidence.mjs";

test("isolated store is provably cold and content addressed by lock and toolchain", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pnpm-cache-evidence-"));
  await writeFile(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const first = await resolveIsolatedPnpmCacheEvidence({
    workspace,
    lockFile: "pnpm-lock.yaml",
    nodeVersion: "v24.5.0",
    pnpmVersion: "11.13.0",
  });
  const repeated = await resolveIsolatedPnpmCacheEvidence({
    workspace,
    lockFile: "pnpm-lock.yaml",
    nodeVersion: "v24.5.0",
    pnpmVersion: "11.13.0",
  });
  assert.deepEqual(repeated, first);
  assert.equal(first.cacheClass, "cold");
  assert.match(first.lockHash, /^[0-9a-f]{64}$/);
  assert.match(first.cacheKeyHash, /^[0-9a-f]{64}$/);
});

test("cache key changes when lock content changes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pnpm-cache-evidence-"));
  const lock = path.join(workspace, "pnpm-lock.yaml");
  await writeFile(lock, "lockfileVersion: '9.0'\n");
  const before = await resolveIsolatedPnpmCacheEvidence({ workspace, lockFile: "pnpm-lock.yaml", nodeVersion: "v24.5.0", pnpmVersion: "11.13.0" });
  await writeFile(lock, "lockfileVersion: '9.1'\n");
  const after = await resolveIsolatedPnpmCacheEvidence({ workspace, lockFile: "pnpm-lock.yaml", nodeVersion: "v24.5.0", pnpmVersion: "11.13.0" });
  assert.notEqual(after.cacheKeyHash, before.cacheKeyHash);
});
