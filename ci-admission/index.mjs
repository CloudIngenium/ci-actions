import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_ENDPOINT = "https://gh-hooks.cloudingenium.com";
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFERRED_REGISTRY = JSON.parse(readFileSync(new URL("./deferred-workloads.v1.json", import.meta.url), "utf8"));
if (DEFERRED_REGISTRY.contract_version !== 4 || !/^[0-9a-f]{64}$/.test(DEFERRED_REGISTRY.source_sha256 || "")) {
  throw new Error("invalid generated deferred workload registry");
}
const DEFERRED_WORKLOADS = new Map(DEFERRED_REGISTRY.workloads.map((workload) => [workload.event_type, workload]));
const LEGACY_PREQUEUE_EVENT_TYPES = new Set([
  "fleet-currency-incremental",
  "zap-coverage-deferred",
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

function fullGitObjectId(raw, name = "source-sha") {
  if (!/^[0-9a-f]{40}$/i.test(raw)) {
    throw new Error(`${name} must be a full Git commit SHA`);
  }
  return raw.toLowerCase();
}

function validationScope(raw, name, allowFull = false) {
  if (raw !== "nightly" && !(allowFull && raw === "full")) {
    throw new Error(`${name} must be ${allowFull ? "full or nightly" : "nightly"}`);
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

function exactSha256(raw, name, prefix = false) {
  const pattern = prefix ? /^sha256:[0-9a-f]{64}$/ : /^[0-9a-f]{64}$/;
  if (!pattern.test(raw)) throw new Error(`${name} must be ${prefix ? "sha256:<64 lowercase hex>" : "64 lowercase sha256 hex"}`);
  return raw;
}

function gitBlobSha(raw, name) {
  if (!/^[0-9a-f]{40}$/.test(raw)) throw new Error(`${name} must be a full Git blob SHA`);
  return raw;
}

function boundedJsonInput(raw, name, kind) {
  if (!raw || Buffer.byteLength(raw) > 16 * 1024) throw new Error(`${name} must be bounded JSON`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${name} must be valid JSON`); }
  if (kind === "array" && (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64 || parsed.some((item) => typeof item !== "string" || item.length > 128))) {
    throw new Error(`${name} must be a non-empty bounded string array`);
  }
  if (kind === "object" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length < 1 || Object.keys(parsed).length > 64)) {
    throw new Error(`${name} must be a non-empty bounded object`);
  }
  return parsed;
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
  const payloadConfig = {
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
  return payloadConfig;
}

function prequeueInput(env) {
  const token = input(env, "TOKEN");
  if (!token) throw new Error("token is required");
  const eventType = input(env, "EVENT-TYPE");
  const workload = DEFERRED_WORKLOADS.get(eventType);
  if (!workload && !LEGACY_PREQUEUE_EVENT_TYPES.has(eventType)) {
    throw new Error("event-type is not allowlisted for prequeue admission");
  }
  const repo = exactRepository(input(env, "REPO") || env.GITHUB_REPOSITORY || "");
  if (workload && repo !== workload.repository) throw new Error("repo must match the registered deferred workload");
  const sourceDigest = workload
    ? exactSha256(input(env, "SOURCE-DIGEST"), "source-digest", true)
    : boundedIdentifier(input(env, "SOURCE-DIGEST"), "source-digest", 128);
  const waveInput = input(env, "AUTOMATION-WAVE-ID");
  const payload = {};
  if (eventType === "fleet-currency-incremental") {
    payload.repositories = repositories(input(env, "REPOSITORIES"));
  } else if (workload?.payload_kind === "package-source-v2-dispatch") {
    payload.producer = boundedIdentifier(input(env, "PRODUCER"), "producer", 100);
    payload.commit = fullGitObjectId(input(env, "COMMIT"), "commit");
    const sourceApiPath = input(env, "SOURCE-API-PATH");
    const expectedPrefix = `/repos/CloudIngenium/${payload.producer}/contents/`;
    const [resourcePath, query, ...extra] = sourceApiPath.split("?");
    const relativePath = resourcePath.slice(expectedPrefix.length);
    if (!sourceApiPath.startsWith(expectedPrefix) || !relativePath
      || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || extra.length > 0 || query !== `ref=${payload.commit}`) {
      throw new Error("source-api-path must bind the producer to the exact commit");
    }
    payload.source_api_path = sourceApiPath;
    payload.digest = exactSha256(input(env, "DIGEST"), "digest");
    payload.source_blob_sha = gitBlobSha(input(env, "SOURCE-BLOB-SHA"), "source-blob-sha");
    if (input(env, "DIGEST-ALGORITHM") !== "sha256") throw new Error("digest-algorithm must be sha256");
    payload.digest_algorithm = "sha256";
    payload.content_digest = exactSha256(input(env, "CONTENT-DIGEST"), "content-digest");
    payload.packages = boundedJsonInput(input(env, "PACKAGES-JSON"), "packages-json", "array");
    payload.package_versions = boundedJsonInput(input(env, "PACKAGE-VERSIONS-JSON"), "package-versions-json", "object");
    if (payload.digest !== payload.content_digest) throw new Error("digest must match content-digest");
    const packages = new Set(payload.packages);
    const versionNames = Object.keys(payload.package_versions);
    if (packages.size !== payload.packages.length || versionNames.length !== packages.size || versionNames.some((name) => !packages.has(name))) {
      throw new Error("package-versions-json must match packages-json exactly");
    }
  } else {
    payload.source_sha = fullGitObjectId(input(env, "SOURCE-SHA"));
    if (eventType === "zap-coverage-deferred") {
      payload.mode = validationScope(input(env, "MODE"), "mode", true);
    } else {
      payload.scope = validationScope(input(env, "SCOPE"), "scope");
    }
  }
  const payloadConfig = {
    token,
    endpoint: validateEndpoint(input(env, "ENDPOINT")),
    payload: {
      repository: repo,
      event_type: eventType,
      source_digest: sourceDigest,
      client_payload: payload,
      priority_class: boundedInteger(input(env, "PRIORITY-CLASS"), "priority-class", 1, 79, workload?.priority_class ?? 10),
      slot_weight: boundedInteger(input(env, "SLOT-WEIGHT"), "slot-weight", 1, 4, workload?.slot_weight ?? 1),
      requested_lane: requestedLane(input(env, "REQUESTED-LANE")) || workload?.requested_lane || "Background",
      automation_wave_id: waveInput ? boundedIdentifier(waveInput, "automation-wave-id", 96) : null,
      deadline_at: deadlineAt(input(env, "DEADLINE-AT")),
    },
  };
  if (workload && (
    payloadConfig.payload.priority_class !== workload.priority_class ||
    payloadConfig.payload.slot_weight !== workload.slot_weight ||
    payloadConfig.payload.requested_lane !== workload.requested_lane
  )) throw new Error("priority, weight, and lane must match the registered workload");
  return payloadConfig;
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
  if ((response.status !== 200 && response.status !== 202) || !UUID.test(body.dispatch_id || "") || !body.status) {
    throw new Error(`CI prequeue defer failed with HTTP ${response.status}`);
  }
  emitPrequeueOutputs(env, body);
  return body;
}

export async function prequeueStatus(env = process.env, fetchImpl = fetch) {
  const token = input(env, "TOKEN");
  if (!token) throw new Error("token is required");
  const dispatchId = input(env, "DISPATCH-ID");
  if (!UUID.test(dispatchId)) {
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
  if (!response.ok || body.granted !== true || !UUID.test(body.lease_id || "")) {
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
  if (!UUID.test(leaseId)) {
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
