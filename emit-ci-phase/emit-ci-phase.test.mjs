import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { tmpFixture } from "../lib/tmp-fixture.mjs";
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
  assert.equal(payload.contract_version, "cloudingenium.ci-control/4");
  assert.equal(payload.versions.contract_version, "cloudingenium.ci-control/4");
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
  assert.throws(() => buildPhasePayload({ ...base, selectedLane: "admin-short" }, context), /selected-lane/);
  assert.equal(buildPhasePayload({ ...base, selectedLane: "admin-interactive" }, context).selected_lane, "admin-interactive");
  assert.equal(buildPhasePayload({ ...base, selectedLane: "admin-batch" }, context).selected_lane, "admin-batch");
  assert.throws(
    () => buildPhaseEnvelope({
      payload: buildPhasePayload(base, context),
      sourceManifestSha256: "unknown",
      metadataJson: "{}",
    }),
    /64 hexadecimal/,
  );
});

// Fail-open writes: setup-ci-phase-emitter exports this emitter to callers (Zap's
// write-zap-phase-telemetry.ps1) that write payload, envelope and NDJSON spool under
// RUNNER_TEMP/ci-telemetry, which a persistent runner can leave foreign-owned.
const emitter = fileURLToPath(new URL("./emit-ci-phase.mjs", import.meta.url));
const skipModeBits = process.platform === "win32" || process.getuid?.() === 0
  ? "mode bits are not enforced for root or on Windows"
  : false;

function runEmitter(runnerTemp) {
  const githubOutput = path.join(runnerTemp, "github-output");
  writeFileSync(githubOutput, "");
  const result = spawnSync(process.execPath, [
    emitter,
    "--phase", "dotnet_restore",
    "--sequence", "3",
    "--status", "success",
    "--started-at", base.startedAt,
    "--completed-at", base.completedAt,
    "--observed-at", base.observedAt,
    "--duration-ms", base.durationMs,
    "--job-id", base.jobId,
    "--source-manifest-sha256", "a".repeat(64),
    "--metadata-json", "{}",
    "--output-path", "ci-telemetry/phase.json",
    "--envelope-path", "ci-telemetry/phase-envelope.json",
    "--append-ndjson-path", "ci-telemetry/phases.ndjson",
    "--github-output", githubOutput,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: runnerTemp,
      GITHUB_JOB: "release",
      GITHUB_REPOSITORY: context.repository,
      GITHUB_RUN_ID: context.runId,
      GITHUB_RUN_ATTEMPT: context.runAttempt,
    },
  });
  const outputs = Object.fromEntries(readFileSync(githubOutput, "utf8").trim().split("\n")
    .filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  return { ...result, outputs };
}

test("writes payload, envelope and spool to the configured dir when writable", () => {
  const runnerTemp = tmpFixture("emit-ci-phase");
  const result = runEmitter(runnerTemp);
  assert.equal(result.status, 0, result.stderr);
  const telemetry = path.join(runnerTemp, "ci-telemetry");
  assert.equal(result.outputs["payload-path"], path.join(telemetry, "phase.json"));
  assert.equal(result.outputs["envelope-path"], path.join(telemetry, "phase-envelope.json"));
  assert.equal(result.outputs["append-path"], path.join(telemetry, "phases.ndjson"));
  assert.doesNotMatch(result.stdout, /::warning::/);
});

test("falls back to one job-owned dir when the telemetry dir is unwritable", { skip: skipModeBits }, () => {
  const runnerTemp = tmpFixture("emit-ci-phase");
  const blocked = path.join(runnerTemp, "ci-telemetry");
  mkdirSync(blocked);
  chmodSync(blocked, 0o500);
  try {
    const result = runEmitter(runnerTemp);
    assert.equal(result.status, 0, result.stderr);
    const written = result.outputs["payload-path"];
    const fallback = path.dirname(written);
    assert.equal(path.dirname(fallback), runnerTemp);
    assert.match(path.basename(fallback), /^ci-telemetry-release-/);
    assert.equal(written, path.join(fallback, "phase.json"));
    assert.equal(result.outputs["envelope-path"], path.join(fallback, "phase-envelope.json"));
    assert.equal(result.outputs["append-path"], path.join(fallback, "phases.ndjson"));
    const payload = JSON.parse(readFileSync(written, "utf8"));
    assert.equal(payload.event_type, "ci_phase");
    assert.equal(payload.phase, "dotnet_restore");
    const envelope = JSON.parse(readFileSync(result.outputs["envelope-path"], "utf8"));
    assert.deepEqual(envelope.canonical_event, payload);
    assert.deepEqual(JSON.parse(readFileSync(result.outputs["append-path"], "utf8")), payload);
    assert.deepEqual(readdirSync(blocked), []);
    const warnings = result.stdout.split("\n").filter((line) => line.startsWith("::warning::"));
    assert.equal(warnings.length, 1, result.stdout);
    assert.ok(warnings[0].includes(blocked), warnings[0]);
    assert.ok(warnings[0].includes(fallback), warnings[0]);
    assert.match(warnings[0], /EACCES|EPERM/);
    assert.match(warnings[0], /owner: /);
  } finally {
    chmodSync(blocked, 0o700);
  }
});

test("non-permission write errors still fail without a fallback", () => {
  const runnerTemp = tmpFixture("emit-ci-phase");
  writeFileSync(path.join(runnerTemp, "ci-telemetry"), "not a directory");
  const result = runEmitter(runnerTemp);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /::error::E(EXIST|NOTDIR)/);
  assert.equal(result.outputs["payload-path"], undefined);
  assert.deepEqual(readdirSync(runnerTemp).filter((name) => name.startsWith("ci-telemetry-")), []);
});
