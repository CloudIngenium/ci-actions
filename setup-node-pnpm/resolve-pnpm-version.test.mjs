import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePnpmVersion } from "./resolve-pnpm-version.mjs";

async function manifestWith(packageManager) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-actions-pnpm-"));
  const manifest = path.join(root, "package.json");
  await writeFile(manifest, `${JSON.stringify({ packageManager })}\n`);
  return manifest;
}

test("explicit input takes precedence over packageManager", async () => {
  const manifest = await manifestWith("pnpm@11.12.0");
  assert.equal(
    await resolvePnpmVersion({ explicit: "11.13.0", manifest, fallback: "11.11.0" }),
    "11.13.0",
  );
});

test("packageManager is the default source", async () => {
  const manifest = await manifestWith("pnpm@11.13.0");
  assert.equal(await resolvePnpmVersion({ manifest, fallback: "11.12.0" }), "11.13.0");
});

test("fallback is used when the manifest is absent or has no packageManager", async () => {
  const missing = path.join(os.tmpdir(), `missing-${randomUUID()}.json`);
  assert.equal(await resolvePnpmVersion({ manifest: missing, fallback: "11.13.0" }), "11.13.0");

  const manifest = await manifestWith(undefined);
  assert.equal(await resolvePnpmVersion({ manifest, fallback: "11.13.0" }), "11.13.0");
});

test("invalid explicit and packageManager values fail closed", async () => {
  const manifest = await manifestWith("pnpm@latest");
  await assert.rejects(
    resolvePnpmVersion({ manifest, fallback: "11.13.0" }),
    /must be pnpm@<exact-stable-semver>/,
  );
  await assert.rejects(
    resolvePnpmVersion({ explicit: "11", manifest, fallback: "11.13.0" }),
    /exact stable pnpm semver/,
  );
});
