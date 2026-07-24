#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertPlainObject,
  isDirectExecution,
  normalizeIso,
  parseBoundedJson,
  parseNonNegativeInteger,
  redactBounded,
  resolveInside,
  sha256,
  stableStringify,
} from "../lib/contract.mjs";
import { writeOutputs } from "../lib/github-output.mjs";

const PHASE = /^[a-z][a-z0-9_]{0,63}$/;
const POLICY_VERSION = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STATUSES = new Set([
  "queued",
  "in_progress",
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "neutral",
  "unknown",
]);
const COLLECTOR_MODES = new Set(["fast", "slow", "all", "hook", "webhook"]);
const LANES = new Set([
  "gate-fast",
  "control-fast",
  "pr-fast",
  "admin-short",
  "build-fast",
  "build-heavy",
  "background",
  "legacy-slow",
  "deploy",
  "mcp-build",
  "mcp-deploy",
  "windows-pr-fast",
  "windows-build-fast",
  "windows-background",
  "azure-burst",
  "github-hosted",
  "other",
]);
const CORRELATION_QUALITIES = new Set(["exact", "rest_exact", "reconciled", "estimated"]);
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const PHASE_SCHEMA_ID = "https://schemas.cloudingenium.com/ci-control/v4/phase.schema.json";

function digest(value, length) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function exactNumericId(value, label, maximumLength = 24) {
  const normalized = String(value ?? "");
  if (!new RegExp(`^[1-9][0-9]{0,${maximumLength - 1}}$`).test(normalized)) {
    throw new Error(`${label} must be a positive numeric identifier`);
  }
  return normalized;
}

function exactInteger(value, label, minimum, maximum) {
  const normalized = String(value ?? "");
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be an integer`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function optionalHex(value, length, label) {
  if (!value) return null;
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value)) {
    throw new Error(`${label} must be ${length} hexadecimal characters`);
  }
  return value.toLowerCase();
}

function requiredSha256(value, label) {
  const normalized = optionalHex(value, 64, label);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function buildCorrelation({ repository, runId, runAttempt, jobId, phase, traceId, spanId, parentSpanId, quality }) {
  if (!CORRELATION_QUALITIES.has(quality)) {
    throw new Error(`correlation-quality must be one of ${[...CORRELATION_QUALITIES].join(", ")}`);
  }
  const derivedTrace = digest(`${repository}:${runId}:${runAttempt}`, 32);
  const effectiveTrace = optionalHex(traceId, 32, "trace-id") || derivedTrace;
  const derivedJobSpan = digest(`${effectiveTrace}:job:${jobId}`, 16);
  return {
    trace_id: effectiveTrace,
    span_id: optionalHex(spanId, 16, "span-id") || digest(`${effectiveTrace}:job:${jobId}:ci_phase:${phase}`, 16),
    parent_span_id: parentSpanId === "null"
      ? null
      : optionalHex(parentSpanId, 16, "parent-span-id") || derivedJobSpan,
    correlation_quality: quality,
  };
}

export function buildPhasePayload(input, context = {}) {
  if (!PHASE.test(input.phase ?? "")) {
    throw new Error("phase must match ^[a-z][a-z0-9_]{0,63}$");
  }
  if (!STATUSES.has(input.status)) {
    throw new Error(`status must be one of ${[...STATUSES].join(", ")}`);
  }
  if ((input.unit ?? "ms") !== "ms") throw new Error("duration unit must be ms");
  if (!COLLECTOR_MODES.has(input.collectorMode)) {
    throw new Error(`collector-mode must be one of ${[...COLLECTOR_MODES].join(", ")}`);
  }
  if (!POLICY_VERSION.test(input.policyVersion ?? "")) {
    throw new Error("policy-version is invalid");
  }
  if (input.selectedLane && !LANES.has(input.selectedLane)) {
    throw new Error(`selected-lane must be one of ${[...LANES].join(", ")}`);
  }

  const repository = context.repository || "";
  if (!REPOSITORY.test(repository) || repository.length > 200) {
    throw new Error("GITHUB_REPOSITORY must be owner/repository");
  }
  const runId = exactNumericId(context.runId, "run-id");
  const runAttempt = exactInteger(context.runAttempt, "run-attempt", 1, 100);
  const jobId = exactNumericId(input.jobId || context.jobId, "job-id");
  const sequence = exactInteger(input.sequence, "sequence", 0, 1000);
  const fingerprintVersion = exactInteger(input.fingerprintVersion, "fingerprint-version", 1, 1_000_000);
  const poolMappingVersion = exactInteger(input.poolMappingVersion, "pool-mapping-version", 1, 1_000_000);
  const startedAt = normalizeIso(input.startedAt, "started-at");
  const completedAt = normalizeIso(input.completedAt, "completed-at");
  const elapsed = new Date(completedAt).valueOf() - new Date(startedAt).valueOf();
  if (elapsed < 0) throw new Error("completed-at must not precede started-at");
  const durationMs = input.durationMs === "" || input.durationMs === undefined
    ? elapsed
    : parseNonNegativeInteger(input.durationMs, "duration-ms", MAX_DURATION_MS);
  if (Math.abs(durationMs - elapsed) > 1000) {
    throw new Error(`duration-ms differs from timestamps by more than 1000 ms (${durationMs} vs ${elapsed})`);
  }

  const payload = {
    contract_version: 4,
    event_type: "ci_phase",
    identity: {
      repository,
      run_id: runId,
      run_attempt: runAttempt,
      job_id: jobId,
    },
    versions: {
      contract_version: 4,
      fingerprint_version: fingerprintVersion,
      pool_mapping_version: poolMappingVersion,
      policy_version: input.policyVersion,
    },
    phase: input.phase,
    sequence,
    status: input.status,
    duration_ms: durationMs,
    runner_name: context.runnerName?.slice(0, 128) || null,
    timestamps: {
      event_at: completedAt,
      local_observed_at: normalizeIso(input.observedAt || new Date().toISOString(), "observed-at"),
      started_at: startedAt,
      completed_at: completedAt,
    },
    correlation: buildCorrelation({
      repository,
      runId,
      runAttempt,
      jobId,
      phase: input.phase,
      traceId: input.traceId,
      spanId: input.spanId,
      parentSpanId: input.parentSpanId,
      quality: input.correlationQuality,
    }),
    collector_mode: input.collectorMode,
  };
  if (input.selectedLane) payload.selected_lane = input.selectedLane;
  return payload;
}

export function buildPhaseEnvelope({ payload, metadataJson, sourceManifestSha256 }) {
  const metadataInput = assertPlainObject(
    parseBoundedJson(metadataJson, { label: "metadata-json", maxBytes: 8192 }),
    "metadata-json",
  );
  const { value: metadata, redactedFields } = redactBounded(metadataInput, {
    maxDepth: 3,
    maxKeys: 24,
    maxStringBytes: 512,
  });
  const canonicalSerialized = stableStringify(payload);
  return {
    envelope_schema: "cloudingenium.ci-control.provenance",
    envelope_version: 1,
    canonical_event: payload,
    raw_event: {
      event_type: "ci_phase_summary",
      metadata,
    },
    provenance: {
      producer: "CloudIngenium/ci-actions/emit-ci-phase",
      source_contract_manifest_sha256: requiredSha256(sourceManifestSha256, "source-manifest-sha256"),
      source_schema_id: PHASE_SCHEMA_ID,
      canonical_payload_sha256: sha256(canonicalSerialized),
    },
    redacted_field_count: redactedFields,
  };
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`invalid argument sequence near ${argv[index] ?? "<end>"}`);
    }
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
}

async function atomicWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  const root = process.env.RUNNER_TEMP || process.env.GITHUB_WORKSPACE || process.cwd();
  const payload = buildPhasePayload(
    {
      phase: args.get("phase"),
      sequence: args.get("sequence") || "0",
      status: args.get("status"),
      startedAt: args.get("started-at"),
      completedAt: args.get("completed-at"),
      observedAt: args.get("observed-at"),
      durationMs: args.get("duration-ms"),
      unit: args.get("unit"),
      jobId: args.get("job-id"),
      fingerprintVersion: args.get("fingerprint-version") || "1",
      poolMappingVersion: args.get("pool-mapping-version") || "3",
      policyVersion: args.get("policy-version") || "local-first-shadow-v4",
      collectorMode: args.get("collector-mode") || "hook",
      selectedLane: args.get("selected-lane"),
      traceId: args.get("trace-id"),
      spanId: args.get("span-id"),
      parentSpanId: args.get("parent-span-id"),
      correlationQuality: args.get("correlation-quality") || "exact",
    },
    {
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      jobId: process.env.GITHUB_JOB_ID,
      runnerName: process.env.RUNNER_NAME,
    },
  );
  const serialized = stableStringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > 16384) {
    throw new Error("canonical ci_phase payload exceeds 16384 bytes");
  }
  const envelope = buildPhaseEnvelope({
    payload,
    metadataJson: args.get("metadata-json"),
    sourceManifestSha256: args.get("source-manifest-sha256"),
  });
  const envelopeSerialized = stableStringify(envelope);
  if (Buffer.byteLength(envelopeSerialized, "utf8") > 32768) {
    throw new Error("ci phase provenance envelope exceeds 32768 bytes");
  }

  const outputPath = resolveInside(root, args.get("output-path") || "ci-phase.json", "output-path");
  const envelopePath = resolveInside(
    root,
    args.get("envelope-path") || "ci-phase-envelope.json",
    "envelope-path",
  );
  await atomicWrite(outputPath, serialized);
  await atomicWrite(envelopePath, envelopeSerialized);

  const appendPathInput = args.get("append-ndjson-path");
  let appendPath = "";
  if (appendPathInput) {
    appendPath = resolveInside(root, appendPathInput, "append-ndjson-path");
    await mkdir(path.dirname(appendPath), { recursive: true });
    await appendFile(appendPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  await writeOutputs(args.get("github-output"), {
    "payload-path": outputPath,
    "payload-sha256": envelope.provenance.canonical_payload_sha256,
    "envelope-path": envelopePath,
    "append-path": appendPath,
    "source-manifest-sha256": envelope.provenance.source_contract_manifest_sha256,
    "redacted-field-count": envelope.redacted_field_count,
    "duration-ms": payload.duration_ms,
    "trace-id": payload.correlation.trace_id,
    "span-id": payload.correlation.span_id,
  });
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 2;
  });
}
