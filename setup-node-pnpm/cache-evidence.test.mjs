import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveIsolatedPnpmCacheEvidence } from "./cache-evidence.mjs";
import { tmpFixture } from "../lib/tmp-fixture.mjs";

test("isolated store is provably cold and content addressed by lock and toolchain", async () => {
  const workspace = tmpFixture("pnpm-cache-evidence");
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
  const workspace = tmpFixture("pnpm-cache-evidence");
  const lock = path.join(workspace, "pnpm-lock.yaml");
  await writeFile(lock, "lockfileVersion: '9.0'\n");
  const before = await resolveIsolatedPnpmCacheEvidence({ workspace, lockFile: "pnpm-lock.yaml", nodeVersion: "v24.5.0", pnpmVersion: "11.13.0" });
  await writeFile(lock, "lockfileVersion: '9.1'\n");
  const after = await resolveIsolatedPnpmCacheEvidence({ workspace, lockFile: "pnpm-lock.yaml", nodeVersion: "v24.5.0", pnpmVersion: "11.13.0" });
  assert.notEqual(after.cacheKeyHash, before.cacheKeyHash);
});

test("a host-shared store is unknown, never cold, and keeps the same cache key", async () => {
  const workspace = tmpFixture("pnpm-cache-evidence");
  await writeFile(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const args = { workspace, lockFile: "pnpm-lock.yaml", nodeVersion: "v24.5.0", pnpmVersion: "11.13.0" };
  const isolated = await resolveIsolatedPnpmCacheEvidence(args);
  const shared = await resolveIsolatedPnpmCacheEvidence({ ...args, storeKind: "host-shared" });
  assert.equal(shared.cacheClass, "unknown");
  assert.equal(shared.cacheKeyHash, isolated.cacheKeyHash);
  await assert.rejects(resolveIsolatedPnpmCacheEvidence({ ...args, storeKind: "shared" }), /store-kind/);
});

test("the CLI reads --store-kind, and an absent one means the per-job store (cold)", () => {
  const workspace = tmpFixture("pnpm-cache-evidence");
  writeFileSync(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const cli = fileURLToPath(new URL("./cache-evidence.mjs", import.meta.url));
  const classOf = (extra) => {
    const out = path.join(tmpFixture("pnpm-cache-evidence-out"), "github-output");
    writeFileSync(out, "");
    const result = spawnSync(process.execPath, [cli, "--node-version", "v26.0.0", "--pnpm-version", "11.28.8", "--github-output", out, ...extra], {
      env: { ...process.env, GITHUB_WORKSPACE: workspace },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(out, "utf8").match(/cache-class(?:=|<<\S+\n)(\w+)/)[1];
  };
  assert.equal(classOf([]), "cold");
  assert.equal(classOf(["--store-kind", "isolated"]), "cold");
  assert.equal(classOf(["--store-kind", "host-shared"]), "unknown");
});
