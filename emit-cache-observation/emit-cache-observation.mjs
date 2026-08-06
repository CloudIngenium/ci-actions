#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  isDirectExecution,
  normalizeIso,
  parseNonNegativeInteger,
  resolveInside,
  sha256,
  stableStringify,
} from "../lib/contract.mjs";
import { writeOutputs } from "../lib/github-output.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAMESPACE = /^[a-z][a-z0-9._-]{0,63}$/;
const VERSION = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const HEX_64 = /^[0-9a-f]{64}$/i;
const OPERATIONS = new Set(["probe", "restore", "save"]);
const CACHE_CLASSES = new Set(["warm", "cold", "unknown"]);
const COLLECTOR_MODES = new Set(["fast", "slow", "all", "hook", "webhook"]);

function digest(value, length) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function positiveNumericId(value, label) {
  const normalized = String(value ?? "");
  if (!/^[1-9][0-9]{0,23}$/.test(normalized)) throw new Error(`${label} must be a positive numeric identifier`);
  return normalized;
}

function positiveInteger(value, label, maximum = 1_000_000) {
  const parsed = parseNonNegativeInteger(value, label, maximum);
  if (parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function optionalNumber(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
  return parsed;
}

function optionalInteger(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return parseNonNegativeInteger(value, label);
}

function exactHash(value, label, { optional = false } = {}) {
  if (optional && !value) return null;
  if (!HEX_64.test(value ?? "")) throw new Error(`${label} must be 64 hexadecimal characters`);
  return value.toLowerCase();
}

function buildCorrelation(repository, runId, runAttempt, jobId) {
  const traceId = digest(`${repository}:${runId}:${runAttempt}`, 32);
  const runSpanId = digest(`${traceId}:run`, 16);
  return {
    trace_id: traceId,
    span_id: digest(`${traceId}:job:${jobId}:cache_observation`, 16),
    parent_span_id: digest(`${traceId}:job:${jobId}`, 16),
    correlation_quality: "exact",
    run_span_id: runSpanId,
  };
}

export function buildCacheObservation(input, context) {
  if (!REPOSITORY.test(context.repository ?? "")) throw new Error("GITHUB_REPOSITORY must be owner/repository");
  if (!NAMESPACE.test(input.cacheNamespace ?? "")) throw new Error("cache-namespace is invalid");
  if (!OPERATIONS.has(input.operation)) throw new Error("operation must be probe, restore, or save");
  if (!CACHE_CLASSES.has(input.cacheClass)) throw new Error("cache-class must be warm, cold, or unknown");
  if (!COLLECTOR_MODES.has(input.collectorMode)) throw new Error("collector-mode is invalid");
  if (!VERSION.test(input.policyVersion ?? "")) throw new Error("policy-version is invalid");
  const runId = positiveNumericId(context.runId, "run-id");
  const runAttempt = positiveInteger(context.runAttempt, "run-attempt", 100);
  const jobId = positiveNumericId(input.jobId || context.jobId, "job-id");
  const cacheKeyHash = exactHash(input.cacheKeyHash, "cache-key-hash");
  const lockHash = exactHash(input.lockHash, "lock-hash", { optional: true });
  const sourceManifestSha256 = exactHash(input.sourceManifestSha256, "source-manifest-sha256");
  const observedAt = input.observedAt
    ? normalizeIso(input.observedAt, "observed-at")
    : new Date().toISOString();
  const hit = input.cacheClass === "warm" ? true : input.cacheClass === "cold" ? false : null;
  const correlation = buildCorrelation(context.repository, runId, runAttempt, jobId);
  delete correlation.run_span_id;
  return {
    payload: {
      contract_version: "cloudingenium.ci-control/4",
      event_type: "cache_observation",
      identity: {
        repository: context.repository,
        run_id: runId,
        run_attempt: runAttempt,
        job_id: jobId,
      },
      versions: {
        contract_version: "cloudingenium.ci-control/4",
        fingerprint_version: positiveInteger(input.fingerprintVersion, "fingerprint-version"),
        pool_mapping_version: positiveInteger(input.poolMappingVersion, "pool-mapping-version"),
        policy_version: input.policyVersion,
      },
      cache_namespace: input.cacheNamespace,
      cache_key_hash: cacheKeyHash,
      lock_hash: lockHash,
      operation: input.operation,
      cache_class: input.cacheClass,
      hit,
      size_bytes: optionalInteger(input.sizeBytes, "size-bytes"),
      duration_ms: optionalInteger(input.durationMs, "duration-ms"),
      net_savings_ms: optionalNumber(input.netSavingsMs, "net-savings-ms"),
      runner_name: context.runnerName || null,
      observed_at: observedAt,
      correlation,
      collector_mode: input.collectorMode,
    },
    sourceManifestSha256,
  };
}

function actionInput(name) {
  return process.env[`INPUT_${name.replaceAll("-", "_").toUpperCase()}`] || "";
}

async function main() {
  const context = {
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    jobId: process.env.CI_JOB_ID,
    runnerName: process.env.RUNNER_NAME,
  };
  const { payload, sourceManifestSha256 } = buildCacheObservation({
    cacheNamespace: actionInput("cache-namespace"),
    cacheKeyHash: actionInput("cache-key-hash"),
    lockHash: actionInput("lock-hash"),
    operation: actionInput("operation") || "probe",
    cacheClass: actionInput("cache-class"),
    jobId: actionInput("job-id"),
    sourceManifestSha256: actionInput("source-manifest-sha256"),
    sizeBytes: actionInput("size-bytes"),
    durationMs: actionInput("duration-ms"),
    netSavingsMs: actionInput("net-savings-ms"),
    observedAt: actionInput("observed-at"),
    fingerprintVersion: actionInput("fingerprint-version") || "10",
    poolMappingVersion: actionInput("pool-mapping-version") || "11",
    policyVersion: actionInput("policy-version") || "local-first-shadow-v4.6.6-r4",
    collectorMode: actionInput("collector-mode") || "hook",
  }, context);
  const root = process.env.RUNNER_TEMP || process.cwd();
  const outputPath = resolveInside(root, actionInput("output-path") || "ci-telemetry/cache-observation.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  const serialized = stableStringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > 16_384) throw new Error("cache observation exceeds 16384 bytes");
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, outputPath);
  await writeOutputs(process.env.GITHUB_OUTPUT, {
    "payload-path": outputPath,
    "payload-sha256": sha256(serialized),
    "cache-class": payload.cache_class,
    "telemetry-status": "emitted",
    "source-manifest-sha256": sourceManifestSha256,
  });
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`emit-cache-observation: ${error.message}\n`);
    process.exitCode = 1;
  });
}
