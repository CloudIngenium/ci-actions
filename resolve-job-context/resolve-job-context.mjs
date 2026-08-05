#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { isDirectExecution, resolveInside, stableStringify } from "../lib/contract.mjs";
import { writeOutputs } from "../lib/github-output.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NUMERIC_ID = /^[1-9][0-9]{0,23}$/;

function traceId(repository, runId, runAttempt) {
  return createHash("sha256").update(`${repository}:${runId}:${runAttempt}`).digest("hex").slice(0, 32);
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

function validateContext(context) {
  if (!REPOSITORY.test(context.repository ?? "")) throw new Error("GITHUB_REPOSITORY must be owner/repository");
  if (!NUMERIC_ID.test(context.runId ?? "")) throw new Error("GITHUB_RUN_ID must be numeric");
  if (!/^[1-9][0-9]{0,2}$/.test(context.runAttempt ?? "")) throw new Error("GITHUB_RUN_ATTEMPT must be numeric");
  if (!context.runnerName || context.runnerName.length > 128) throw new Error("RUNNER_NAME is required");
}

function cacheIdentity(context) {
  return createHash("sha256")
    .update(`${context.repository}:${context.runId}:${context.runAttempt}:${context.runnerName}`)
    .digest("hex");
}

async function readCache(cachePath, context) {
  try {
    const value = JSON.parse(await readFile(cachePath, "utf8"));
    if (value.cache_identity !== cacheIdentity(context) || !NUMERIC_ID.test(String(value.job_id ?? ""))) return null;
    return {
      jobId: String(value.job_id),
      traceId: traceId(context.repository, context.runId, context.runAttempt),
      correlationQuality: "exact",
      reason: "cache_exact",
      cacheHit: true,
    };
  } catch {
    return null;
  }
}

async function atomicWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${stableStringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function jobsEndpoint(apiUrl, context, page) {
  const base = apiUrl.replace(/\/+$/, "");
  return `${base}/repos/${context.repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs?per_page=100&page=${page}`;
}

async function fetchJobs({ apiUrl, token, context, fetchImpl }) {
  const jobs = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetchImpl(jobsEndpoint(apiUrl, context, page), {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cloudingenium-ci-actions-resolve-job-context",
      },
    });
    if (!response.ok) {
      const error = new Error(`GitHub jobs API returned HTTP ${response.status}`);
      error.code = `github_http_${response.status}`;
      throw error;
    }
    const payload = await response.json();
    if (!Array.isArray(payload.jobs)) throw new Error("GitHub jobs API response is missing jobs");
    jobs.push(...payload.jobs);
    if (payload.jobs.length < 100) break;
  }
  return jobs;
}

export async function resolveCurrentJobContext({ apiUrl, token, cachePath, context, fetchImpl = fetch }) {
  validateContext(context);
  const effectiveTraceId = traceId(context.repository, context.runId, context.runAttempt);
  const cached = await readCache(cachePath, context);
  if (cached) return cached;
  if (!token) {
    return { jobId: "", traceId: effectiveTraceId, correlationQuality: "unavailable", reason: "token_unavailable", cacheHit: false };
  }

  let jobs;
  try {
    jobs = await fetchJobs({ apiUrl, token, context, fetchImpl });
  } catch (error) {
    const reason = typeof error?.code === "string" ? error.code : "github_api_unavailable";
    return { jobId: "", traceId: effectiveTraceId, correlationQuality: "unavailable", reason, cacheHit: false };
  }

  const candidates = jobs.filter((job) =>
    job?.status === "in_progress"
    && job?.runner_name === context.runnerName
    && NUMERIC_ID.test(String(job?.id ?? "")));
  if (candidates.length !== 1) {
    return {
      jobId: "",
      traceId: effectiveTraceId,
      correlationQuality: "unavailable",
      reason: candidates.length === 0 ? "no_exact_candidate" : "ambiguous_candidates",
      cacheHit: false,
    };
  }

  const jobId = String(candidates[0].id);
  await atomicWrite(cachePath, {
    schema_version: 1,
    cache_identity: cacheIdentity(context),
    job_id: jobId,
  });
  return { jobId, traceId: effectiveTraceId, correlationQuality: "exact", reason: "api_exact", cacheHit: false };
}

async function appendEnvironment(filePath, values) {
  if (!filePath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
  await writeFile(filePath, `${lines}\n`, { encoding: "utf8", flag: "a" });
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  const context = {
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    runnerName: process.env.RUNNER_NAME,
  };
  const root = process.env.RUNNER_TEMP || process.cwd();
  const cachePath = resolveInside(root, args.get("cache-path") || "ci-job-context.json");
  const result = await resolveCurrentJobContext({
    apiUrl: args.get("api-url") || "https://api.github.com",
    token: process.env.INPUT_GITHUB_TOKEN || "",
    cachePath,
    context,
  });

  await writeOutputs(args.get("github-output"), {
    "job-id": result.jobId,
    "trace-id": result.traceId,
    "correlation-quality": result.correlationQuality,
    reason: result.reason,
    "cache-hit": String(result.cacheHit),
  });
  await appendEnvironment(args.get("github-env"), {
    GITHUB_JOB_ID: result.jobId,
    CI_JOB_ID: result.jobId,
    CI_TRACE_ID: result.traceId,
    CI_JOB_CONTEXT_QUALITY: result.correlationQuality,
  });

  if (result.correlationQuality !== "exact") {
    process.stdout.write(`::warning title=CI job context unavailable::${result.reason}; exact phase telemetry will be skipped.\n`);
    if ((args.get("fail-on-unresolved") || "false") === "true") process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`resolve-job-context: ${error.message}\n`);
    process.exitCode = 1;
  });
}
