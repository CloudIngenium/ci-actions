import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { jobContextEnvironment, resolveCurrentJobContext } from "./resolve-job-context.mjs";

const context = {
  repository: "CloudIngenium/Zap",
  runId: "30942774752",
  runAttempt: "1",
  runnerName: "Runner-Win-03c",
};

function response(jobs, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ jobs }) };
}

test("resolves the one in-progress job assigned to the current runner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "job-context-"));
  const cachePath = path.join(root, "context.json");
  const result = await resolveCurrentJobContext({
    apiUrl: "https://api.github.test",
    token: "test-token",
    cachePath,
    context,
    fetchImpl: async () => response([
      { id: 1001, status: "completed", runner_name: context.runnerName },
      { id: 1002, status: "in_progress", runner_name: context.runnerName },
      { id: 1003, status: "in_progress", runner_name: "another-runner" },
    ]),
  });
  assert.equal(result.jobId, "1002");
  assert.equal(result.correlationQuality, "exact");
  assert.equal(result.reason, "api_exact");
  assert.equal(result.cacheHit, false);
  assert.match(result.traceId, /^[0-9a-f]{32}$/);
  assert.equal(JSON.parse(await readFile(cachePath, "utf8")).job_id, "1002");
});

test("reuses only a cache bound to the same run attempt and runner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "job-context-"));
  const cachePath = path.join(root, "context.json");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response([{ id: 2001, status: "in_progress", runner_name: context.runnerName }]);
  };
  await resolveCurrentJobContext({ apiUrl: "https://api.github.test", token: "test-token", cachePath, context, fetchImpl });
  const second = await resolveCurrentJobContext({ apiUrl: "https://api.github.test", token: "test-token", cachePath, context, fetchImpl });
  assert.equal(second.jobId, "2001");
  assert.equal(second.reason, "cache_exact");
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
});

test("does not guess when the runner has zero or multiple in-progress candidates", async () => {
  for (const jobs of [[], [
    { id: 3001, status: "in_progress", runner_name: context.runnerName },
    { id: 3002, status: "in_progress", runner_name: context.runnerName },
  ]]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "job-context-"));
    const result = await resolveCurrentJobContext({
      apiUrl: "https://api.github.test",
      token: "test-token",
      cachePath: path.join(root, "context.json"),
      context,
      fetchImpl: async () => response(jobs),
    });
    assert.equal(result.jobId, "");
    assert.equal(result.correlationQuality, "unavailable");
  }
});

test("fails open with bounded reasons for missing auth and API errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "job-context-"));
  const missing = await resolveCurrentJobContext({
    apiUrl: "https://api.github.test",
    token: "",
    cachePath: path.join(root, "missing.json"),
    context,
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  assert.equal(missing.reason, "token_unavailable");

  const unauthorized = await resolveCurrentJobContext({
    apiUrl: "https://api.github.test",
    token: "test-token",
    cachePath: path.join(root, "unauthorized.json"),
    context,
    fetchImpl: async () => response([], 403),
  });
  assert.equal(unauthorized.reason, "github_http_403");
  assert.equal(unauthorized.correlationQuality, "unavailable");
});

test("exports one correlation quality under canonical and compatibility environment names", () => {
  for (const correlationQuality of ["exact", "unavailable"]) {
    const environment = jobContextEnvironment({
      jobId: correlationQuality === "exact" ? "1002" : "",
      traceId: "0123456789abcdef0123456789abcdef",
      correlationQuality,
    });

    assert.equal(environment.CI_JOB_CONTEXT_QUALITY, correlationQuality);
    assert.equal(environment.CI_CORRELATION_QUALITY, correlationQuality);
    assert.equal(environment.CI_JOB_ID, environment.GITHUB_JOB_ID);
  }
});
