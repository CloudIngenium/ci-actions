import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { tmpFixture } from "../lib/tmp-fixture.mjs";
import { buildCacheObservation } from "./emit-cache-observation.mjs";

const context = {
  repository: "CloudIngenium/Knowledge-Hub",
  runId: "300000001",
  runAttempt: "1",
  runnerName: "Runner-Ubuntu-03e",
};

function input(overrides = {}) {
  return {
    cacheNamespace: "pnpm-store",
    cacheKeyHash: "a".repeat(64),
    lockHash: "b".repeat(64),
    operation: "probe",
    cacheClass: "cold",
    jobId: "400000001",
    sourceManifestSha256: "c".repeat(64),
    fingerprintVersion: "9",
    poolMappingVersion: "10",
    policyVersion: "local-first-shadow-v4.6.4-r3",
    collectorMode: "hook",
    observedAt: "2026-08-05T20:00:00Z",
    ...overrides,
  };
}

test("builds exact content-free cold cache evidence", () => {
  const { payload, sourceManifestSha256 } = buildCacheObservation(input(), context);
  assert.equal(payload.event_type, "cache_observation");
  assert.equal(payload.contract_version, "cloudingenium.ci-control/4");
  assert.equal(payload.versions.contract_version, "cloudingenium.ci-control/4");
  assert.equal(payload.identity.job_id, "400000001");
  assert.equal(payload.cache_class, "cold");
  assert.equal(payload.hit, false);
  assert.equal(payload.lock_hash, "b".repeat(64));
  assert.equal(payload.correlation.correlation_quality, "exact");
  assert.equal(sourceManifestSha256, "c".repeat(64));
  assert.doesNotMatch(JSON.stringify(payload), /token|secret|command|payload/i);
});

test("warm and unknown classifications have consistent hit semantics", () => {
  assert.equal(buildCacheObservation(input({ cacheClass: "warm" }), context).payload.hit, true);
  assert.equal(buildCacheObservation(input({ cacheClass: "unknown" }), context).payload.hit, null);
});

test("rejects guessed identity and malformed cache keys", () => {
  assert.throws(() => buildCacheObservation(input({ jobId: "build" }), context), /job-id/);
  assert.throws(() => buildCacheObservation(input({ cacheKeyHash: "latest" }), context), /cache-key-hash/);
  assert.throws(() => buildCacheObservation(input({ policyVersion: "" }), context), /policy-version/);
});

// Fail-open writes (www.DigiContas.com run 38043463487, Runner-Ubuntu-03g): a
// pre-existing, foreign-owned RUNNER_TEMP/ci-telemetry must redirect the write to
// a job-owned fallback dir, never exit 1 and lose the observation.
const emitter = fileURLToPath(new URL("./emit-cache-observation.mjs", import.meta.url));
const skipModeBits = process.platform === "win32" || process.getuid?.() === 0
  ? "mode bits are not enforced for root or on Windows"
  : false;

function runEmitter(runnerTemp) {
  const githubOutput = path.join(runnerTemp, "github-output");
  writeFileSync(githubOutput, "");
  const result = spawnSync(process.execPath, [emitter], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: runnerTemp,
      GITHUB_JOB: "build",
      GITHUB_OUTPUT: githubOutput,
      GITHUB_REPOSITORY: context.repository,
      GITHUB_RUN_ID: context.runId,
      GITHUB_RUN_ATTEMPT: context.runAttempt,
      INPUT_CACHE_NAMESPACE: "pnpm-store",
      INPUT_CACHE_KEY_HASH: "a".repeat(64),
      INPUT_CACHE_CLASS: "cold",
      INPUT_JOB_ID: "400000001",
      INPUT_SOURCE_MANIFEST_SHA256: "c".repeat(64),
      INPUT_OUTPUT_PATH: "ci-telemetry/pnpm-store-cache-observation.json",
    },
  });
  const outputs = Object.fromEntries(readFileSync(githubOutput, "utf8").trim().split("\n")
    .filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  return { ...result, outputs };
}

test("writes to the configured dir when it is writable", () => {
  const runnerTemp = tmpFixture("emit-cache-observation");
  const result = runEmitter(runnerTemp);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs["payload-path"], path.join(runnerTemp, "ci-telemetry", "pnpm-store-cache-observation.json"));
  assert.doesNotMatch(result.stdout, /::warning::/);
});

test("falls back to a job-owned dir when the telemetry dir is unwritable", { skip: skipModeBits }, () => {
  const runnerTemp = tmpFixture("emit-cache-observation");
  const blocked = path.join(runnerTemp, "ci-telemetry");
  mkdirSync(blocked);
  chmodSync(blocked, 0o500);
  try {
    const result = runEmitter(runnerTemp);
    assert.equal(result.status, 0, result.stderr);
    const written = result.outputs["payload-path"];
    assert.equal(path.dirname(path.dirname(written)), runnerTemp);
    assert.match(path.basename(path.dirname(written)), /^ci-telemetry-build-/);
    assert.equal(path.basename(written), "pnpm-store-cache-observation.json");
    const payload = JSON.parse(readFileSync(written, "utf8"));
    assert.equal(payload.event_type, "cache_observation");
    assert.equal(payload.identity.job_id, "400000001");
    assert.equal(result.outputs["telemetry-status"], "emitted");
    assert.deepEqual(readdirSync(blocked), []);
    const warnings = result.stdout.split("\n").filter((line) => line.startsWith("::warning::"));
    assert.equal(warnings.length, 1, result.stdout);
    assert.ok(warnings[0].includes(blocked), warnings[0]);
    assert.ok(warnings[0].includes(path.dirname(written)), warnings[0]);
    assert.match(warnings[0], /EACCES|EPERM/);
    assert.match(warnings[0], /owner: /);
  } finally {
    chmodSync(blocked, 0o700);
  }
});

test("non-permission write errors still fail without a fallback", () => {
  const runnerTemp = tmpFixture("emit-cache-observation");
  writeFileSync(path.join(runnerTemp, "ci-telemetry"), "not a directory");
  const result = runEmitter(runnerTemp);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /emit-cache-observation: E(EXIST|NOTDIR)/);
  assert.equal(result.outputs["payload-path"], undefined);
  assert.deepEqual(readdirSync(runnerTemp).filter((name) => name.startsWith("ci-telemetry-")), []);
});
