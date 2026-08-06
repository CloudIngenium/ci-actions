import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolvePersistentCache,
  resolveSdkSource,
  resolveSdkVersion,
} from "./resolve-dotnet.mjs";
import { buildRestoreArguments } from "./restore.mjs";
import { resolveNugetCacheEvidence } from "./cache-evidence.mjs";

test("resolves an exact SDK from explicit input or global.json", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ci-actions-dotnet-"));
  await writeFile(path.join(workspace, "global.json"), '{"sdk":{"version":"10.0.302"}}\n');
  assert.equal(await resolveSdkVersion({ explicit: "10.0.302", workspace }), "10.0.302");
  assert.equal(await resolveSdkVersion({ workspace }), "10.0.302");
  await assert.rejects(resolveSdkVersion({ explicit: "10.0.x", workspace }), /exact/);
  await assert.rejects(resolveSdkVersion({ explicit: "9.0.203", workspace }), /does not match/);
});

test("system-first avoids setup only when the exact SDK is installed", () => {
  assert.deepEqual(
    resolveSdkSource({ sdkVersion: "10.0.302", installedSdks: ["10.0.302"], mode: "system-first" }),
    { needsSetup: false, source: "system" },
  );
  assert.deepEqual(
    resolveSdkSource({ sdkVersion: "10.0.302", installedSdks: ["10.0.301"], mode: "system-first" }),
    { needsSetup: true, source: "setup" },
  );
  assert.equal(
    resolveSdkSource({ sdkVersion: "10.0.302", installedSdks: ["10.0.302"], mode: "setup" }).needsSetup,
    true,
  );
});

test("persistent cache paths are namespaced and filesystem roots are rejected", () => {
  const cache = resolvePersistentCache({
    namespace: "zap-lock-abc",
    toolCache: path.join(os.tmpdir(), "toolcache"),
  });
  assert.match(cache.packages, /zap-lock-abc[/\\]packages$/);
  assert.throws(
    () => resolvePersistentCache({ cacheRoot: path.parse(process.cwd()).root, namespace: "zap", toolCache: "/tmp" }),
    /filesystem root/,
  );
  assert.throws(
    () => resolvePersistentCache({ cacheRoot: "../escape", namespace: "zap", toolCache: "/tmp" }),
    /must not be absolute or contain/,
  );
});

test("restore arguments are deterministic and locked by default", () => {
  assert.deepEqual(
    buildRestoreArguments({ target: "Zap.CI.slnx", lockedMode: true, profile: "normal" }),
    ["restore", "Zap.CI.slnx", "--nologo", "--locked-mode", "--verbosity", "minimal"],
  );
  assert.throws(() => buildRestoreArguments({ profile: "verbose" }), /normal or diagnostic/);
});

test("persistent NuGet evidence is content addressed and distinguishes cold from warm stores", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ci-actions-dotnet-cache-"));
  const project = path.join(workspace, "src", "Example");
  const packages = path.join(workspace, ".nuget", "packages");
  const http = path.join(workspace, ".nuget", "http-cache");
  await mkdir(project, { recursive: true });
  await mkdir(packages, { recursive: true });
  await mkdir(http, { recursive: true });
  await writeFile(path.join(project, "packages.lock.json"), '{"version":2,"dependencies":{}}\n');
  const cold = await resolveNugetCacheEvidence({
    workspace,
    restorePath: "src",
    packagesPath: packages,
    httpCachePath: http,
    sdkVersion: "10.0.302",
  });
  assert.equal(cold.cacheClass, "cold");
  assert.equal(cold.lockFileCount, 1);
  assert.match(cold.cacheKeyHash, /^[0-9a-f]{64}$/);
  assert.match(cold.lockHash, /^[0-9a-f]{64}$/);

  await mkdir(path.join(packages, "example", "1.0.0"), { recursive: true });
  const warm = await resolveNugetCacheEvidence({
    workspace,
    restorePath: "src",
    packagesPath: packages,
    httpCachePath: http,
    sdkVersion: "10.0.302",
  });
  assert.equal(warm.cacheClass, "warm");
  assert.equal(warm.cacheKeyHash, cold.cacheKeyHash);
});

test("NuGet evidence excludes build outputs from the lock digest", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ci-actions-dotnet-cache-"));
  const packages = path.join(workspace, ".nuget", "packages");
  const http = path.join(workspace, ".nuget", "http-cache");
  await mkdir(path.join(workspace, "obj"), { recursive: true });
  await mkdir(packages, { recursive: true });
  await mkdir(http, { recursive: true });
  await writeFile(path.join(workspace, "obj", "packages.lock.json"), "generated\n");
  const evidence = await resolveNugetCacheEvidence({
    workspace,
    packagesPath: packages,
    httpCachePath: http,
    sdkVersion: "10.0.302",
  });
  assert.equal(evidence.lockFileCount, 0);
});

test("composite step ids remain expression-safe across operating systems", async () => {
  const source = await readFile(new URL("./action.yml", import.meta.url), "utf8");
  assert.match(source, /id: resolve_unix/);
  assert.match(source, /id: resolve_windows/);
  assert.match(source, /steps\.resolve_windows\.outputs\['sdk-version'\]/);
  assert.doesNotMatch(source, /steps\.(?:resolve|restore)-(?:unix|windows)/);
});
