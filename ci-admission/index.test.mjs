import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquire, explicitRelease, release, runAction } from "./index.mjs";

test("declares the supported Node 24 action runtime", () => {
  const metadata = readFileSync(new URL("./action.yml", import.meta.url), "utf8");
  assert.match(metadata, /\n\s*using:\s*node24\s*\n/);
  assert.doesNotMatch(metadata, /\n\s*using:\s*node20\s*\n/);
});

function env(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "ci-admission-action-"));
  return {
    GITHUB_OUTPUT: join(root, "output"),
    GITHUB_STATE: join(root, "state"),
    GITHUB_REPOSITORY: "CloudIngenium/example",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "build-heavy",
    INPUT_TOKEN: "narrow-secret",
    INPUT_KIND: "heavy_validation",
    INPUT_ENDPOINT: "https://gh-hooks.cloudingenium.com",
    "INPUT_RELEASE-ON-POST": "auto",
    "INPUT_PRIORITY-CLASS": "40",
    "INPUT_SLOT-WEIGHT": "1",
    ...overrides,
  };
}

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("acquires a heavy lease, emits outputs, and registers post release state", async () => {
  const variables = env();
  let request;
  const result = await acquire(variables, async (url, options) => {
    request = { url, options };
    return response(201, {
      granted: true,
      reused: false,
      lease_id: "11111111-1111-4111-8111-111111111111",
      active_count: 2,
      active_slot_weight: 3,
      policy_limit: 4,
      decision_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      retry_after_seconds: null,
      suggested_wait_ms: null,
    });
  });

  assert.equal(result.granted, true);
  assert.equal(request.url, "https://gh-hooks.cloudingenium.com/v1/ci-admission/acquire");
  assert.deepEqual(JSON.parse(request.options.body), {
    kind: "heavy_validation",
    repo: "CloudIngenium/example",
    subject: "123:1:build-heavy",
    automation_wave_id: null,
    priority_class: 40,
    slot_weight: 1,
    requested_lane: null,
    deadline_at: null,
    ttl_seconds: null,
  });
  assert.match(readFileSync(variables.GITHUB_OUTPUT, "utf8"), /granted=true/);
  assert.match(readFileSync(variables.GITHUB_OUTPUT, "utf8"), /active-slot-weight=3/);
  assert.match(readFileSync(variables.GITHUB_OUTPUT, "utf8"), /decision-id=aaaaaaaa-/);
  assert.match(readFileSync(variables.GITHUB_STATE, "utf8"), /release_on_post=true/);
});

test("bot PR requires the future head ref and is not released automatically", async () => {
  const variables = env({
    INPUT_KIND: "bot_pr",
    INPUT_SUBJECT: "automation/deps-123",
  });
  await acquire(variables, async () => response(201, {
    granted: true,
    reused: false,
    lease_id: "22222222-2222-4222-8222-222222222222",
    active_count: 1,
    policy_limit: 2,
  }));
  assert.match(readFileSync(variables.GITHUB_STATE, "utf8"), /release_on_post=false/);

  await assert.rejects(
    acquire(env({ INPUT_KIND: "bot_pr" }), async () => response(500, {})),
    /subject is required for bot_pr/,
  );
});

test("denial fails closed and exposes the bounded retry", async () => {
  const variables = env();
  await assert.rejects(
    acquire(variables, async () => response(429, {
      granted: false,
      reused: false,
      lease_id: null,
      active_count: 4,
      policy_limit: 4,
      retry_after_seconds: 60,
    })),
    /retry after 60s/,
  );
  assert.match(readFileSync(variables.GITHUB_OUTPUT, "utf8"), /retry-after-seconds=60/);
  assert.match(readFileSync(variables.GITHUB_OUTPUT, "utf8"), /deferred=false/);
});

test("sends bounded priority, weight, lane, wave, and deadline", async () => {
  const variables = env({
    "INPUT_PRIORITY-CLASS": "80",
    "INPUT_SLOT-WEIGHT": "2",
    "INPUT_REQUESTED-LANE": "Build-Fast",
    "INPUT_AUTOMATION-WAVE-ID": "deps-2026-07-27",
    "INPUT_DEADLINE-AT": new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  let requestBody;
  await acquire(variables, async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return response(201, {
      granted: true,
      reused: false,
      lease_id: "55555555-5555-4555-8555-555555555555",
      active_count: 1,
      active_slot_weight: 2,
      policy_limit: 4,
      decision_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });
  assert.equal(requestBody.priority_class, 80);
  assert.equal(requestBody.slot_weight, 2);
  assert.equal(requestBody.requested_lane, "Build-Fast");
  assert.equal(requestBody.automation_wave_id, "deps-2026-07-27");
  assert.match(requestBody.deadline_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("rejects invalid weighted scheduling inputs before calling the API", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(500, {});
  };
  await assert.rejects(
    acquire(env({ "INPUT_PRIORITY-CLASS": "101" }), fetchImpl),
    /priority-class must be an integer from 1 to 100/,
  );
  await assert.rejects(
    acquire(env({ "INPUT_SLOT-WEIGHT": "5" }), fetchImpl),
    /slot-weight must be an integer from 1 to 4/,
  );
  await assert.rejects(
    acquire(env({ INPUT_KIND: "bot_pr", INPUT_SUBJECT: "automation/a", "INPUT_SLOT-WEIGHT": "2" }), fetchImpl),
    /bot_pr slot-weight must be 1/,
  );
  await assert.rejects(
    acquire(env({ "INPUT_REQUESTED-LANE": "Build Fast" }), fetchImpl),
    /requested-lane must be a bounded capability identifier/,
  );
  await assert.rejects(
    acquire(env({ "INPUT_DEADLINE-AT": "not-a-date" }), fetchImpl),
    /deadline-at must be an RFC3339 timestamp within the next 24 hours/,
  );
  assert.equal(calls, 0);
});

test("advisory caller can defer a valid denial without acquiring a lease", async () => {
  const variables = env({ "INPUT_ON-DENIED": "defer" });
  const result = await runAction(variables, async () => response(429, {
    granted: false,
    reused: false,
    lease_id: null,
    active_count: 4,
    policy_limit: 4,
    retry_after_seconds: 75,
  }));

  assert.equal(result.granted, false);
  assert.equal(result.deferred, true);
  assert.match(readFileSync(variables.GITHUB_OUTPUT, "utf8"), /granted=false/);
  assert.match(readFileSync(variables.GITHUB_OUTPUT, "utf8"), /deferred=true/);
  assert.doesNotMatch(readFileSync(variables.GITHUB_STATE, "utf8"), /lease_id=/);
});

test("defer mode rejects malformed success responses and invalid configuration", async () => {
  await assert.rejects(
    acquire(env({ "INPUT_ON-DENIED": "defer" }), async () => response(200, {
      granted: false,
      lease_id: null,
    })),
    /acquire failed with HTTP 200/,
  );
  await assert.rejects(
    acquire(env({ "INPUT_ON-DENIED": "skip" }), async () => response(429, {})),
    /on-denied must be fail or defer/,
  );
});

test("a failed acquire marks the later invocation as post and does not reacquire", async () => {
  const variables = env();
  let calls = 0;
  await assert.rejects(runAction(variables, async () => {
    calls += 1;
    return response(429, {
      granted: false,
      active_count: 4,
      policy_limit: 4,
      retry_after_seconds: 60,
    });
  }), /admission denied/);
  assert.match(readFileSync(variables.GITHUB_STATE, "utf8"), /is_post=true/);

  const postEnv = {
    ...variables,
    STATE_is_post: "true",
    STATE_lease_id: "",
    STATE_release_on_post: "",
  };
  assert.deepEqual(await runAction(postEnv, async () => {
    calls += 1;
    throw new Error("post must not acquire");
  }), { skipped: true });
  assert.equal(calls, 1);
});

test("post releases a heavy lease and skips a bot lease", async () => {
  const variables = env({
    STATE_lease_id: "33333333-3333-4333-8333-333333333333",
    STATE_endpoint: "https://gh-hooks.cloudingenium.com",
    STATE_release_on_post: "true",
  });
  let releasedBody;
  const result = await release(variables, async (_url, options) => {
    releasedBody = JSON.parse(options.body);
    return response(200, {
      released: true,
      lease_id: "33333333-3333-4333-8333-333333333333",
    });
  });
  assert.deepEqual(releasedBody, { lease_id: "33333333-3333-4333-8333-333333333333" });
  assert.equal(result.released, true);

  assert.deepEqual(await release({ ...variables, STATE_release_on_post: "false" }), { skipped: true });
});

test("an upstream control job can hand its lease to an explicit release step", async () => {
  const variables = env({
    INPUT_OPERATION: "release",
    "INPUT_LEASE-ID": "44444444-4444-4444-8444-444444444444",
  });
  let releasedBody;
  const result = await runAction(variables, async (_url, options) => {
    releasedBody = JSON.parse(options.body);
    return response(200, {
      released: true,
      lease_id: "44444444-4444-4444-8444-444444444444",
    });
  });
  assert.deepEqual(releasedBody, { lease_id: "44444444-4444-4444-8444-444444444444" });
  assert.equal(result.released, true);
  assert.match(readFileSync(variables.GITHUB_OUTPUT, "utf8"), /released=true/);

  await assert.rejects(
    explicitRelease(env({ "INPUT_LEASE-ID": "not-a-lease" }), async () => response(200, {})),
    /lease-id must be the UUID/,
  );
});

test("rejects non-HTTPS endpoints and broad or multiline workflow values", async () => {
  await assert.rejects(
    acquire(env({ INPUT_ENDPOINT: "http://example.test" }), async () => response(500, {})),
    /HTTPS origin/,
  );
  await assert.rejects(
    acquire(env({ INPUT_ENDPOINT: "https://example.test" }), async () => response(500, {})),
    /trusted origin/,
  );
  await assert.rejects(
    acquire(env({ INPUT_SUBJECT: "unsafe\nsubject" }), async () => response(500, {})),
    /Unsafe multiline workflow value|acquire failed/,
  );
});
