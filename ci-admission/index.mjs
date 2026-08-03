import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "https://gh-hooks.cloudingenium.com";
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const PREQUEUE_EVENT_TYPES = new Set([
  "fleet-currency-incremental",
  "package-source-published",
  "zap-coverage-deferred",
  "validate-skills-full",
  "validate-plugins-full",
]);

function input(env, name) {
  return String(env[`INPUT_${name.toUpperCase().replaceAll(" ", "_")}`] || "").trim();
}

function commandValue(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function workflowCommand(name, value) {
  process.stdout.write(`::${name}::${commandValue(value)}\n`);
}

function appendKeyValue(path, name, value) {
  if (!path) return;
  const rendered = String(value ?? "");
  if (/[\r\n]/.test(name) || /[\r\n]/.test(rendered)) {
    throw new Error(`Unsafe multiline workflow value for ${name}`);
  }
  appendFileSync(path, `${name}=${rendered}\n`);
}

function emitOutput(env, name, value) {
  appendKeyValue(env.GITHUB_OUTPUT, name, value);
}

function saveState(env, name, value) {
  appendKeyValue(env.GITHUB_STATE, name, value);
}

function validateEndpoint(raw) {
  const url = new URL(raw || DEFAULT_ENDPOINT);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("endpoint must be an HTTPS origin without credentials, query, or fragment");
  }
  if (url.origin !== DEFAULT_ENDPOINT) {
    throw new Error(`endpoint must use the trusted origin ${DEFAULT_ENDPOINT}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function resolveReleaseOnPost(kind, raw) {
  const normalized = raw.toLowerCase();
  if (!normalized || normalized === "auto") return kind === "heavy_validation";
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("release-on-post must be auto, true, or false");
}

function resolveDeniedBehavior(raw) {
  const normalized = raw.toLowerCase();
  if (!normalized || normalized === "fail") return "fail";
  if (normalized === "defer") return "defer";
  throw new Error("on-denied must be fail or defer");
}

function boundedInteger(raw, name, minimum, maximum, defaultValue) {
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requestedLane(raw) {
  if (!raw) return null;
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(raw)) {
    throw new Error("requested-lane must be a bounded capability identifier");
  }
  return raw;
}

function deadlineAt(raw, now = new Date()) {
  if (!raw) return null;
  const parsed = new Date(raw);
  const maximum = now.getTime() + 24 * 60 * 60 * 1000;
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime() || parsed.getTime() > maximum) {
    throw new Error("deadline-at must be an RFC3339 timestamp within the next 24 hours");
  }
  return parsed.toISOString();
}

function exactRepository(raw, name = "repo") {
  if (!/^CloudIngenium\/[A-Za-z0-9._-]{1,100}$/.test(raw)) {
    throw new Error(`${name} must be an exact CloudIngenium repository`);
  }
  return raw;
}

function boundedIdentifier(raw, name, maximum = 120) {
  if (!raw || raw.length > maximum || !/^[A-Za-z0-9._:/@+-]+$/.test(raw)) {
    throw new Error(`${name} must be a bounded identifier`);
  }
  return raw;
}

function fullGitObjectId(raw) {
  if (!/^[0-9a-f]{40,64}$/i.test(raw)) {
    throw new Error("source-sha must be a full Git object id");
  }
  return raw.toLowerCase();
}

function validationScope(raw, name) {
  if (raw !== "full" && raw !== "nightly") {
    throw new Error(`${name} must be full or nightly`);
  }
  return raw;
}

function repositories(raw) {
  const values = raw.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
  if (values.length < 1 || values.length > 50) {
    throw new Error("repositories must contain 1-50 repositories");
  }
  return values.map((value) => exactRepository(value, "repositories entry"));
}

function boundedJson(text) {
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("CI admission response exceeded 32 KiB");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("CI admission API returned invalid JSON");
  }
}

async function requestJson(url, token, options, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "CloudIngenium-ci-actions-admission-v1",
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const body = boundedJson(await response.text());
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function acquireInput(env) {
  const token = input(env, "TOKEN");
  if (!token) throw new Error("token is required");
  const kind = input(env, "KIND");
  if (kind !== "bot_pr" && kind !== "heavy_validation") {
    throw new Error("kind must be bot_pr or heavy_validation");
  }
  const repo = exactRepository(input(env, "REPO") || env.GITHUB_REPOSITORY || "");
  let subject = input(env, "SUBJECT");
  if (!subject && kind === "heavy_validation") {
    subject = [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.GITHUB_JOB].filter(Boolean).join(":");
  }
  if (!subject || subject.length > 256) {
    throw new Error(kind === "bot_pr"
      ? "subject is required for bot_pr and must match the future head ref"
      : "subject must contain 1-256 characters");
  }
  const ttlRaw = input(env, "TTL-SECONDS");
  const ttl = ttlRaw ? Number(ttlRaw) : null;
  if (ttlRaw && (!Number.isSafeInteger(ttl) || ttl < 1)) {
    throw new Error("ttl-seconds must be a positive integer");
  }
  const priorityClass = boundedInteger(input(env, "PRIORITY-CLASS"), "priority-class", 1, 100, 40);
  const slotWeight = boundedInteger(input(env, "SLOT-WEIGHT"), "slot-weight", 1, 4, 1);
  if (kind === "bot_pr" && slotWeight !== 1) {
    throw new Error("bot_pr slot-weight must be 1");
  }
  return {
    token,
    endpoint: validateEndpoint(input(env, "ENDPOINT")),
    releaseOnPost: resolveReleaseOnPost(kind, input(env, "RELEASE-ON-POST")),
    deniedBehavior: resolveDeniedBehavior(input(env, "ON-DENIED")),
    payload: {
      kind,
      repo,
      subject,
      automation_wave_id: input(env, "AUTOMATION-WAVE-ID") || null,
      priority_class: priorityClass,
      slot_weight: slotWeight,
      requested_lane: requestedLane(input(env, "REQUESTED-LANE")),
      deadline_at: deadlineAt(input(env, "DEADLINE-AT")),
      ttl_seconds: ttl,
    },
  };
}

function prequeueInput(env) {
  const token = input(env, "TOKEN");
  if (!token) throw new Error("token is required");
  const eventType = input(env, "EVENT-TYPE");
  if (!PREQUEUE_EVENT_TYPES.has(eventType)) {
    throw new Error("event-type is not allowlisted for prequeue admission");
  }
  const repo = exactRepository(input(env, "REPO") || env.GITHUB_REPOSITORY || "");
  const sourceDigest = boundedIdentifier(input(env, "SOURCE-DIGEST"), "source-digest", 128);
  const waveInput = input(env, "AUTOMATION-WAVE-ID");
  const payload = {};
  if (eventType === "fleet-currency-incremental") {
    payload.repositories = repositories(input(env, "REPOSITORIES"));
  } else if (eventType === "package-source-published") {
    payload.package_name = boundedIdentifier(input(env, "PACKAGE-NAME"), "package-name");
    payload.package_version = boundedIdentifier(input(env, "PACKAGE-VERSION"), "package-version");
  } else {
    payload.source_sha = fullGitObjectId(input(env, "SOURCE-SHA"));
    if (eventType === "zap-coverage-deferred") {
      payload.mode = validationScope(input(env, "MODE"), "mode");
    } else {
      payload.scope = validationScope(input(env, "SCOPE"), "scope");
    }
  }
  return {
    token,
    endpoint: validateEndpoint(input(env, "ENDPOINT")),
    payload: {
      repository: repo,
      event_type: eventType,
      source_digest: sourceDigest,
      client_payload: payload,
      priority_class: boundedInteger(input(env, "PRIORITY-CLASS"), "priority-class", 1, 79, 10),
      slot_weight: boundedInteger(input(env, "SLOT-WEIGHT"), "slot-weight", 1, 4, 1),
      requested_lane: requestedLane(input(env, "REQUESTED-LANE")) || "Background",
      automation_wave_id: waveInput ? boundedIdentifier(waveInput, "automation-wave-id", 96) : null,
      deadline_at: deadlineAt(input(env, "DEADLINE-AT")),
    },
  };
}

function emitPrequeueOutputs(env, body) {
  emitOutput(env, "dispatch-id", body.dispatch_id || "");
  emitOutput(env, "dispatch-status", body.status || "");
  emitOutput(env, "reused", Boolean(body.reused));
}

export async function prequeueDefer(env = process.env, fetchImpl = fetch) {
  const config = prequeueInput(env);
  workflowCommand("add-mask", config.token);
  const { response, body } = await requestJson(
    `${config.endpoint}/v1/ci-admission/defer`,
    config.token,
    { method: "POST", body: JSON.stringify(config.payload) },
    fetchImpl,
  );
  if ((response.status !== 200 && response.status !== 202) || !body.dispatch_id || !body.status) {
    throw new Error(`CI prequeue defer failed with HTTP ${response.status}`);
  }
  emitPrequeueOutputs(env, body);
  return body;
}

export async function prequeueStatus(env = process.env, fetchImpl = fetch) {
  const token = input(env, "TOKEN");
  if (!token) throw new Error("token is required");
  const dispatchId = input(env, "DISPATCH-ID");
  if (!/^[0-9a-f-]{36}$/i.test(dispatchId)) {
    throw new Error("dispatch-id must be the UUID returned by prequeue-defer");
  }
  const endpoint = validateEndpoint(input(env, "ENDPOINT"));
  workflowCommand("add-mask", token);
  const { response, body } = await requestJson(
    `${endpoint}/v1/ci-admission/deferred/${dispatchId}`,
    token,
    { method: "GET" },
    fetchImpl,
  );
  if (!response.ok || body.dispatch_id !== dispatchId || !body.status) {
    throw new Error(`CI prequeue status failed with HTTP ${response.status}`);
  }
  emitPrequeueOutputs(env, body);
  return body;
}

export async function acquire(env = process.env, fetchImpl = fetch) {
  const config = acquireInput(env);
  workflowCommand("add-mask", config.token);
  const { response, body } = await requestJson(
    `${config.endpoint}/v1/ci-admission/acquire`,
    config.token,
    { method: "POST", body: JSON.stringify(config.payload) },
    fetchImpl,
  );
  const capacityDenied = response.status === 429 && body.granted === false;
  const deferred = capacityDenied && config.deniedBehavior === "defer";

  for (const [name, value] of Object.entries({
    granted: Boolean(body.granted),
    reused: Boolean(body.reused),
    "lease-id": body.lease_id || "",
    "active-count": body.active_count ?? "",
    "active-slot-weight": body.active_slot_weight ?? "",
    "policy-limit": body.policy_limit ?? "",
    "decision-id": body.decision_id || "",
    "retry-after-seconds": body.retry_after_seconds ?? "",
    "suggested-wait-ms": body.suggested_wait_ms ?? "",
    deferred,
  })) emitOutput(env, name, value);

  if (deferred) {
    const retry = Number(body.retry_after_seconds || 60);
    workflowCommand(
      "notice",
      `CI admission deferred (${body.active_slot_weight ?? body.active_count}/${body.policy_limit} slots); retry after ${retry}s`,
    );
    return { ...body, deferred: true };
  }
  if (response.status === 429) {
    const retry = Number(body.retry_after_seconds || 60);
    throw new Error(
      `CI admission denied (${body.active_slot_weight ?? body.active_count}/${body.policy_limit} slots); retry after ${retry}s`,
    );
  }
  if (!response.ok || body.granted !== true || !body.lease_id) {
    throw new Error(`CI admission acquire failed with HTTP ${response.status}`);
  }

  saveState(env, "lease_id", body.lease_id);
  saveState(env, "endpoint", config.endpoint);
  saveState(env, "release_on_post", config.releaseOnPost);
  return body;
}

async function releaseLease(env, leaseId, endpoint, fetchImpl) {
  const token = input(env, "TOKEN");
  if (!token) throw new Error("token is required to release the CI admission lease");
  workflowCommand("add-mask", token);
  const { response, body } = await requestJson(
    `${endpoint}/v1/ci-admission/release`,
    token,
    { method: "POST", body: JSON.stringify({ lease_id: leaseId }) },
    fetchImpl,
  );
  if (!response.ok || body.released !== true) {
    throw new Error(`CI admission release failed with HTTP ${response.status}`);
  }
  return body;
}

export async function release(env = process.env, fetchImpl = fetch) {
  const leaseId = String(env.STATE_lease_id || "").trim();
  const releaseOnPost = String(env.STATE_release_on_post || "").trim() === "true";
  if (!leaseId || !releaseOnPost) return { skipped: true };
  const endpoint = validateEndpoint(env.STATE_endpoint || input(env, "ENDPOINT"));
  return await releaseLease(env, leaseId, endpoint, fetchImpl);
}

export async function explicitRelease(env = process.env, fetchImpl = fetch) {
  const leaseId = input(env, "LEASE-ID");
  if (!/^[0-9a-f-]{36}$/i.test(leaseId)) {
    throw new Error("lease-id must be the UUID returned by an acquire operation");
  }
  const endpoint = validateEndpoint(input(env, "ENDPOINT"));
  const result = await releaseLease(env, leaseId, endpoint, fetchImpl);
  emitOutput(env, "released", true);
  return result;
}

export async function runAction(env = process.env, fetchImpl = fetch) {
  const post = env.STATE_is_post === "true";
  if (post) return await release(env, fetchImpl);
  // GitHub passes saved state only to the post process. This marker keeps an
  // acquire failure from being mistaken for a second main invocation.
  saveState(env, "is_post", "true");
  const operation = input(env, "OPERATION") || "acquire";
  if (operation === "release" || operation === "job-release") return await explicitRelease(env, fetchImpl);
  if (operation === "prequeue-defer") return await prequeueDefer(env, fetchImpl);
  if (operation === "prequeue-status") return await prequeueStatus(env, fetchImpl);
  if (operation !== "acquire" && operation !== "job-acquire") {
    throw new Error("operation must be job-acquire, job-release, prequeue-defer, or prequeue-status");
  }
  return await acquire(env, fetchImpl);
}

async function main() {
  const post = process.env.STATE_is_post === "true";
  try {
    await runAction();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (post) {
      workflowCommand("warning", `${message}; lease expiry remains the recovery path`);
      return;
    }
    workflowCommand("error", message);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
