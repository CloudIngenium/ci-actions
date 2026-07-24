import assert from "node:assert/strict";
import test from "node:test";

import { buildPhaseEnvelope, buildPhasePayload } from "./emit-ci-phase.mjs";

const context = {
  repository: "CloudIngenium/Zap",
  runId: "300000001",
  runAttempt: "2",
  runnerName: "Runner-Win-03a",
};

const base = {
  phase: "dotnet_restore",
  sequence: "3",
  status: "success",
  startedAt: "2026-07-23T12:00:00-05:00",
  completedAt: "2026-07-23T17:00:01.250Z",
  observedAt: "2026-07-23T17:00:02Z",
  durationMs: "1250",
  unit: "ms",
  jobId: "400000001",
  fingerprintVersion: "1",
  poolMappingVersion: "3",
  policyVersion: "local-first-shadow-v4",
  collectorMode: "hook",
  selectedLane: "windows-build-fast",
  correlationQuality: "exact",
};

test("builds the exact Knowledge-Hub ci_phase v4 shape", () => {
  const payload = buildPhasePayload(base, context);
  assert.deepEqual(Object.keys(payload), [
    "contract_version",
    "event_type",
    "identity",
    "versions",
    "phase",
    "sequence",
    "status",
    "duration_ms",
    "runner_name",
    "timestamps",
    "correlation",
    "collector_mode",
    "selected_lane",
  ]);
  assert.equal(payload.event_type, "ci_phase");
  assert.deepEqual(payload.identity, {
    repository: "CloudIngenium/Zap",
    run_id: "300000001",
    run_attempt: 2,
    job_id: "400000001",
  });
  assert.equal(payload.timestamps.started_at, "2026-07-23T17:00:00.000Z");
  assert.equal(payload.duration_ms, 1250);
  assert.equal(payload.versions.policy_version, "local-first-shadow-v4");
  assert.match(payload.correlation.trace_id, /^[0-9a-f]{32}$/);
  assert.match(payload.correlation.span_id, /^[0-9a-f]{16}$/);
  assert.match(payload.correlation.parent_span_id, /^[0-9a-f]{16}$/);
  assert.equal("metadata" in payload, false);
  assert.equal("unit" in payload, false);
});

test("derives stable trace correlation for identical job identity", () => {
  const first = buildPhasePayload(base, context);
  const second = buildPhasePayload(base, context);
  assert.deepEqual(first.correlation, second.correlation);
  const nextPhase = buildPhasePayload({ ...base, phase: "tests", sequence: "4" }, context);
  assert.equal(nextPhase.correlation.trace_id, first.correlation.trace_id);
  assert.equal(nextPhase.correlation.parent_span_id, first.correlation.parent_span_id);
  assert.notEqual(nextPhase.correlation.span_id, first.correlation.span_id);
});

test("keeps legacy metadata only in a provenance envelope and redacts it", () => {
  const fakePat = ["github", "pat", "abcdefghijklmnopqrstuvwxyz"].join("_");
  const fakeBearer = ["Bearer", "abcdefghijklmnopqrstuvwxyz"].join(" ");
  const payload = buildPhasePayload(base, context);
  const envelope = buildPhaseEnvelope({
    payload,
    sourceManifestSha256: "a".repeat(64),
    metadataJson: JSON.stringify({
      token: fakePat,
      endpoint: "https://example.test/?sig=super-secret-value",
      note: fakeBearer,
    }),
  });
  assert.equal(envelope.canonical_event.event_type, "ci_phase");
  assert.equal(envelope.raw_event.event_type, "ci_phase_summary");
  assert.equal(envelope.provenance.source_contract_manifest_sha256, "a".repeat(64));
  assert.equal(envelope.provenance.source_schema_id, "https://schemas.cloudingenium.com/ci-control/v4/phase.schema.json");
  assert.match(envelope.provenance.canonical_payload_sha256, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(envelope);
  assert.doesNotMatch(serialized, /super-secret|abcdefghijklmnopqrstuvwxyz/);
  assert.equal(envelope.redacted_field_count, 3);
});

test("rejects non-canonical identity, versions, timestamps, units, and paths", () => {
  assert.throws(() => buildPhasePayload({ ...base, unit: "seconds" }, context), /must be ms/);
  assert.throws(() => buildPhasePayload({ ...base, durationMs: "4000" }, context), /differs from timestamps/);
  assert.throws(() => buildPhasePayload({ ...base, phase: "dotnet.restore" }, context), /phase must match/);
  assert.throws(() => buildPhasePayload({ ...base, jobId: "build" }, context), /job-id must be a positive/);
  assert.throws(() => buildPhasePayload({ ...base, collectorMode: "action" }, context), /collector-mode/);
  assert.throws(() => buildPhasePayload({ ...base, selectedLane: "Runner-Win-03a" }, context), /selected-lane/);
  assert.throws(
    () => buildPhaseEnvelope({
      payload: buildPhasePayload(base, context),
      sourceManifestSha256: "unknown",
      metadataJson: "{}",
    }),
    /64 hexadecimal/,
  );
});
