import assert from "node:assert/strict";
import test from "node:test";

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
