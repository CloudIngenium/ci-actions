import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { cloudOperation } from "./index.mjs";

const intent = { repository: "CloudIngenium/Knowledge-Hub", run_id: "123", run_attempt: "1", job_id: "456",
  admission_lease_id: "11111111-1111-4111-8111-111111111111" };
const capability = "11111111-1111-4111-8111-11111111111122222222-2222-4222-8222-222222222222";
const options = { operation: "reserve", intent, capability, token: "fixture-admission-token" };
const claimedAt = "2026-09-08T12:00:00.000Z";
const now = Date.parse("2026-09-08T12:00:05.000Z");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const intentHash = (value) => hash([value.repository, value.run_id, value.run_attempt, value.job_id]);
const configurationHash = (value) => hash(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));

function receipt() {
  const configuration = { image_digest: `sha256:${"a".repeat(64)}`, template_sha256: "b".repeat(64),
    cpu: 2, memory_mib: 4096, replica_timeout_seconds: 600, parallelism: 1, replica_completion_count: 1, replica_retry_limit: 0 };
  return { claimed: true, start_permitted: true, reservation_id: "33333333-3333-4333-8333-333333333333",
    receipt_id: "44444444-4444-4444-8444-444444444444", intent_hash: intentHash(intent),
    target_id: "/subscriptions/55555555-5555-4555-8555-555555555555/resourceGroups/ci-burst/providers/Microsoft.App/jobs/gha-burst-medium",
    policy_hash: "c".repeat(64), configuration_hash: configurationHash(configuration), configuration,
    claimed_at: claimedAt, start_before: "2026-09-08T12:00:30.000Z", execution_deadline_at: "2026-09-08T12:11:00.000Z" };
}

function fixedClock(t) {
  t.mock.timers.enable({ apis: ["Date"], now });
}

test("receipt identity vectors match the Worker object hashes without double encoding", async (t) => {
  fixedClock(t);
  const reply = receipt();
  assert.equal(reply.configuration_hash, "122ed1fdc9c1b76fc18d80fd94ed5f62f8bc3b141ab62070966f6e6cb52d2f17");
  assert.equal(reply.intent_hash, "4e024cf56d63d6e57f7ec3cb3f98b09f2812333eabe382ace011e60c823269ea");
  assert.deepEqual(await cloudOperation({ ...options, operation: "claim" }, async () => Response.json(reply)), reply);
});

async function rejectReceipt(reply) {
  let calls = 0;
  await assert.rejects(cloudOperation({ ...options, operation: "claim" }, async () => {
    calls += 1;
    return Response.json(reply);
  }), (error) => {
    assert.match(error.message, /^invalid cloud (claim|admission)/);
    assert.ok(!error.message.includes(capability));
    assert.ok(!error.message.includes(options.token));
    return true;
  });
  assert.equal(calls, 1);
}

for (const operation of ["reserve", "claim", "status"]) {
  test(`${operation} reuses the trusted transport with no evidence-writing authority`, async (t) => {
    fixedClock(t);
    let calls = 0;
    const expected = operation === "claim" ? receipt() : { start_permitted: false };
    const result = await cloudOperation({ ...options, operation }, async (url, init) => {
      calls += 1;
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://gh-hooks.cloudingenium.com");
      assert.equal(parsed.pathname, `/v1/ci-admission/cloud/${operation}`);
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, "Bearer fixture-admission-token");
      assert.equal(init.headers["x-ci-cloud-capability"], capability);
      assert.equal(init.method, operation === "status" ? "GET" : "POST");
      assert.deepEqual(operation === "status" ? Object.fromEntries(parsed.searchParams) : JSON.parse(init.body).intent, intent);
      assert.ok(!url.includes(capability));
      return Response.json(expected);
    });
    assert.deepEqual(result, expected);
    assert.equal(calls, 1);
  });
}

for (const operation of ["publish", "observation", "terminal", "settlement", "release", "revoke"]) {
  test(`starter cannot invoke ${operation}`, async () => {
    await assert.rejects(cloudOperation({ ...options, operation }, () => assert.fail("must not contact API")), /starter operation/);
  });
}

test("caller cannot smuggle resources, cost or payload into the identity", async () => {
  for (const extra of [{ cpu: 2 }, { spent_microusd: 0 }, { payload: "arbitrary" }]) {
    await assert.rejects(cloudOperation({ ...options, intent: { ...intent, ...extra } }, () => assert.fail("must not fetch")), /intent/);
  }
  await assert.rejects(cloudOperation({ ...options, intent: { ...intent, job_id: "build" } }), /numeric/);
});

test("untrusted endpoint and credentials never leave the client", async () => {
  for (const endpoint of ["http://gh-hooks.cloudingenium.com", "https://example.com", "https://gh-hooks.cloudingenium.com?token=x"]) {
    await assert.rejects(cloudOperation({ ...options, endpoint }, () => assert.fail("must not fetch")));
  }
});

test("unknown claim response is not retried and cannot release a reservation", async () => {
  let calls = 0;
  await assert.rejects(cloudOperation({ ...options, operation: "claim" }, async () => {
    calls += 1;
    throw new Error("connection lost");
  }), /transport uncertain/);
  assert.equal(calls, 1);
});

test("claim timeout retains the bounded abort and never retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  let calls = 0;
  const pending = cloudOperation({ ...options, operation: "claim" }, async (_url, init) => {
    calls += 1;
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error(capability)), { once: true });
    });
  });
  const rejected = assert.rejects(pending, { message: "cloud admission claim transport uncertain" });
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(calls, 1);
});

test("denial remains denial and API errors cannot echo a secret", async () => {
  assert.equal((await cloudOperation(options, async () => Response.json({ reserved: false, start_permitted: false }))).start_permitted, false);
  await assert.rejects(cloudOperation(options, async () => Response.json({ error: capability }, { status: 403 })), (error) => {
    assert.equal(error.message, "cloud admission reserve failed with HTTP 403");
    return true;
  });
});

test("invalid or oversized replies never authorize a start", async () => {
  for (const reply of [{}, [], { start_permitted: "true" }, { start_permitted: true }]) {
    await assert.rejects(cloudOperation(options, async () => Response.json(reply)), /invalid cloud/);
  }
  await assert.rejects(cloudOperation(options, async () => new Response("x".repeat(32769))), /transport uncertain/);
  await assert.rejects(cloudOperation({ ...options, operation: "claim" }, async () => Response.json({ start_permitted: true })), /invalid cloud claim/);
});

for (const status of [200, 503]) {
  test(`streamed HTTP ${status} reply stops at the byte limit without draining or retrying`, async () => {
    let calls = 0;
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls <= 2) controller.enqueue(new Uint8Array(32769));
        else controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await assert.rejects(cloudOperation(options, async () => {
      calls += 1;
      return new Response(stream, { status, headers: { "content-length": "1" } });
    }), { message: "cloud admission reserve transport uncertain" });
    assert.equal(calls, 1);
    assert.equal(pulls, 1, "must not drain a reply that already exceeds the cap");
    assert.equal(cancelled, true);
  });
}

test("stream byte limit preserves exact-boundary JSON with split UTF-8", async () => {
  const prefix = JSON.stringify({ start_permitted: false, detail: "\u00e9" }).slice(0, -2);
  const bytes = new TextEncoder().encode(prefix + "x".repeat(32768 - Buffer.byteLength(prefix) - 2) + '"}');
  assert.equal(bytes.byteLength, 32768);
  const split = bytes.indexOf(0xc3) + 1;
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(bytes.slice(0, split));
      else if (pulls === 2) controller.enqueue(bytes.slice(split));
      else controller.close();
    },
  }, { highWaterMark: 0 });
  const result = await cloudOperation(options, async () => new Response(stream));
  assert.equal(result.start_permitted, false);
  assert.equal(result.detail[0], "\u00e9");
  assert.equal(pulls, 3);
});

test("body deadline cancels a stalled stream even after response headers arrive", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  let calls = 0;
  let cancelled = false;
  let reading;
  const started = new Promise((resolve) => { reading = resolve; });
  const stream = new ReadableStream({
    pull() { reading(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const pending = cloudOperation({ ...options, operation: "claim" }, async () => {
    calls += 1;
    return new Response(stream);
  });
  const rejected = assert.rejects(pending, { message: "cloud admission claim transport uncertain" });
  await started;
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

for (const mode of ["reject", "never-settle"]) {
  test(`oversized body remains bounded when stream cancellation can ${mode}`, async () => {
    let calls = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(32769)); },
      cancel() {
        cancelled = true;
        return mode === "reject" ? Promise.reject(new Error(`${options.token} ${capability}`)) : new Promise(() => {});
      },
    }, { highWaterMark: 0 });
    await assert.rejects(cloudOperation(options, async () => {
      calls += 1;
      return new Response(stream);
    }), { message: "cloud admission reserve transport uncertain" });
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
  });
}

test("streamed chunks are counted cumulatively, including multibyte data", async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new TextEncoder().encode("\u00e9".repeat(4097)));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(cloudOperation(options, async () => new Response(stream)),
    { message: "cloud admission reserve transport uncertain" });
  assert.equal(pulls, 4);
  assert.equal(cancelled, true);
});

test("stream failure after headers does not leak credentials or replay a claim", async () => {
  let calls = 0;
  await assert.rejects(cloudOperation({ ...options, operation: "claim" }, async () => {
    calls += 1;
    return new Response(new ReadableStream({
      pull(controller) { controller.error(new Error(`${options.token} ${capability}`)); },
    }, { highWaterMark: 0 }));
  }), { message: "cloud admission claim transport uncertain" });
  assert.equal(calls, 1);
});

test("invalid header bytes are rejected before fetch without echoing credentials", async () => {
  for (const token of ["secret\0suffix", "secret\u007fsuffix", "secret\nsuffix", "secret\u0100suffix", "x".repeat(4097)]) {
    await assert.rejects(cloudOperation({ ...options, token }, () => assert.fail("must not contact API")), (error) => {
      assert.equal(error.message, "cloud admission credentials or lease are invalid");
      return true;
    });
  }
});

test("native transport error cannot echo bearer or capability", async () => {
  await assert.rejects(cloudOperation(options, async () => { throw new Error(`${options.token} ${capability}`); }), (error) => {
    assert.equal(error.message, "cloud admission reserve transport uncertain");
    return true;
  });
});

test("every durable receipt field is required, including false-valued configuration fields", async (t) => {
  fixedClock(t);
  for (const key of Object.keys(receipt())) {
    const value = receipt();
    delete value[key];
    await rejectReceipt(value);
  }
  for (const key of Object.keys(receipt().configuration)) {
    const value = receipt();
    delete value.configuration[key];
    value.configuration_hash = configurationHash(value.configuration);
    await rejectReceipt(value);
  }
});

const malformedReceipts = [
  ["null reply", () => null],
  ["array reply", () => []],
  ["incomplete pre-durable response", () => ({ claimed: true, start_permitted: true })],
  ["false claimed with permission", (r) => ({ ...r, claimed: false })],
  ["string claimed", (r) => ({ ...r, claimed: "true" })],
  ["truthy permission", (r) => ({ ...r, start_permitted: 1 })],
  ["unknown receipt key", (r) => ({ ...r, authorization: capability })],
  ["object reservation identity", (r) => ({ ...r, reservation_id: { value: r.reservation_id } })],
  ["malformed receipt identity", (r) => ({ ...r, receipt_id: "not-a-uuid" })],
  ["null configuration", (r) => ({ ...r, configuration: null })],
  ["array configuration", (r) => ({ ...r, configuration: [] })],
  ["wrong policy hash type", (r) => ({ ...r, policy_hash: 1 })],
  ["uppercase hash", (r) => ({ ...r, policy_hash: r.policy_hash.toUpperCase() })],
  ["prefixed policy hash", (r) => ({ ...r, policy_hash: `sha256:${r.policy_hash}` })],
  ["intent hash from another job", (r) => ({ ...r, intent_hash: intentHash({ ...intent, job_id: "457" }) })],
  ["intent hash including lease", (r) => ({ ...r, intent_hash: hash([...Object.values(intent)]) })],
  ["configuration hash mismatch", (r) => ({ ...r, configuration_hash: "d".repeat(64) })],
  ["double-encoded configuration hash", (r) => ({ ...r, configuration_hash: hash(JSON.stringify(Object.fromEntries(Object.entries(r.configuration).sort()))) })],
  ["invalid timestamp", (r) => ({ ...r, claimed_at: "not-a-date" })],
  ["noncanonical timestamp", (r) => ({ ...r, claimed_at: "2026-09-08T12:00:00Z" })],
  ["numeric timestamp", (r) => ({ ...r, claimed_at: Date.parse(r.claimed_at) })],
  ["offset timestamp", (r) => ({ ...r, start_before: "2026-09-08T12:00:30.000+00:00" })],
  ["normalized invalid date", (r) => ({ ...r, execution_deadline_at: "2026-02-30T12:11:00.000Z" })],
  ["start window too short", (r) => ({ ...r, start_before: "2026-09-08T12:00:29.999Z" })],
  ["start window too long", (r) => ({ ...r, start_before: "2026-09-08T12:00:30.001Z" })],
  ["deadline equals start window", (r) => ({ ...r, execution_deadline_at: r.start_before })],
  ["deadline exceeds maximum", (r) => ({ ...r, execution_deadline_at: "2026-09-08T14:00:00.001Z" })],
  ["insufficient lifecycle margin", (r) => ({ ...r, execution_deadline_at: "2026-09-08T12:10:59.999Z" })],
];
for (const [name, mutate] of malformedReceipts) {
  test(`claim rejects ${name} without retry or permission`, async (t) => {
    fixedClock(t);
    await rejectReceipt(mutate(receipt()));
  });
}

for (const [field, values] of Object.entries({
  image_digest: ["a".repeat(64), `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, 1, null],
  template_sha256: ["b".repeat(63), `sha256:${"b".repeat(64)}`, 1, null],
  cpu: [0, 3, "2", 1.5, true, null],
  memory_mib: [2048, 8192, "4096", true, null],
  replica_timeout_seconds: [0, -1, 7201, 1.5, "600", true, null],
  parallelism: [0, 2, "1", true, null],
  replica_completion_count: [0, 2, "1", true, null],
  replica_retry_limit: [1, "0", false, null],
})) {
  test(`claim rejects invalid ${field} even with a matching configuration hash`, async (t) => {
    fixedClock(t);
    for (const value of values) {
      const reply = receipt();
      reply.configuration[field] = value;
      reply.configuration_hash = configurationHash(reply.configuration);
      await rejectReceipt(reply);
    }
  });
}

test("claim rejects arbitrary nested configuration instead of hashing it into authority", async (t) => {
  fixedClock(t);
  const reply = receipt();
  reply.configuration.secret_references = { token: capability };
  reply.configuration_hash = configurationHash(reply.configuration);
  await rejectReceipt(reply);
});

test("claim accepts only an exact job ARM identity, never an execution, URL, or escaped path", async (t) => {
  fixedClock(t);
  const target = receipt().target_id;
  for (const target_id of [null, 1, `https://management.azure.com${target}`, `${target}/`, `${target}/executions/run-1`,
    `${target}?api-version=2026-01-01`, `${target}#fragment`, target.replace("Microsoft.App", "Microsoft.Compute"),
    target.replace("55555555-5555-4555-8555-555555555555", "not-a-uuid"),
    target.replace("ci-burst", ".."), target.replace("ci-burst", "."), target.replace("ci-burst", "a".repeat(91)),
    target.replace("ci-burst", "%2F"), target.replace("gha-burst-medium", "job_name"), `${target}\n`]) {
    await rejectReceipt({ ...receipt(), target_id });
  }
});

test("claim accepts both bounded profiles and maximum lifecycle with canonical hashes independent of key order", async (t) => {
  fixedClock(t);
  for (const cpu of [1, 2]) {
    const reply = receipt();
    reply.configuration.cpu = cpu;
    reply.configuration.memory_mib = cpu * 2048;
    reply.configuration.replica_timeout_seconds = 7140;
    reply.execution_deadline_at = "2026-09-08T14:00:00.000Z";
    reply.configuration_hash = configurationHash(reply.configuration);
    reply.configuration = Object.fromEntries(Object.entries(reply.configuration).reverse());
    assert.deepEqual(await cloudOperation({ ...options, operation: "claim" }, async () => Response.json(reply)), reply);
  }
});

test("claim intent identity ignores lease renewal but binds each job identity and the sent request", async (t) => {
  fixedClock(t);
  const renewedIntent = { ...intent, admission_lease_id: "66666666-6666-4666-8666-666666666666" };
  assert.equal((await cloudOperation({ ...options, operation: "claim", intent: renewedIntent }, async () => Response.json(receipt()))).start_permitted, true);
  for (const changedIntent of [{ ...intent, repository: "CloudIngenium/other" }, { ...intent, run_id: "124" },
    { ...intent, run_attempt: "2" }, { ...intent, job_id: "457" }]) {
    await assert.rejects(cloudOperation({ ...options, operation: "claim", intent: changedIntent }, async () => Response.json(receipt())), /invalid cloud claim/);
  }
  const mutableIntent = { ...intent };
  await assert.rejects(cloudOperation({ ...options, operation: "claim", intent: mutableIntent }, async () => {
    mutableIntent.job_id = "457";
    return Response.json({ ...receipt(), intent_hash: intentHash(mutableIntent) });
  }), /invalid cloud claim/);
});

test("claim fails closed for a future claim or expired start window at the exact boundary", async (t) => {
  fixedClock(t);
  t.mock.timers.setTime(Date.parse(claimedAt) - 1);
  await rejectReceipt(receipt());
  t.mock.timers.setTime(Date.parse(receipt().start_before) - 1);
  assert.equal((await cloudOperation({ ...options, operation: "claim" }, async () => Response.json(receipt()))).start_permitted, true);
  for (const at of [Date.parse(receipt().start_before), Date.parse(receipt().execution_deadline_at)]) {
    t.mock.timers.setTime(at);
    await rejectReceipt(receipt());
  }
});

test("claim checks freshness after the response body finishes, not before the request", async (t) => {
  fixedClock(t);
  let calls = 0;
  await assert.rejects(cloudOperation({ ...options, operation: "claim" }, async () => {
    calls += 1;
    return new Response(new ReadableStream({
      pull(controller) {
        t.mock.timers.setTime(Date.parse(receipt().start_before));
        controller.enqueue(new TextEncoder().encode(JSON.stringify(receipt())));
        controller.close();
      },
    }, { highWaterMark: 0 }));
  }), /invalid cloud claim/);
  assert.equal(calls, 1);
});

test("claim denials stay denied and cannot carry a receipt or contradictory success flag", async (t) => {
  fixedClock(t);
  const denial = { claimed: false, start_permitted: false, reason: "admission_or_budget_denied" };
  assert.deepEqual(await cloudOperation({ ...options, operation: "claim" }, async () => Response.json(denial)), denial);
  for (const reply of [{ ...denial, claimed: true }, { ...denial, reason: null }, { ...denial, reason: "" },
    { ...denial, reason: capability }, { ...denial, start_receipt: receipt() }, { ...denial, receipt_id: receipt().receipt_id }]) {
    await rejectReceipt(reply);
  }
});

test("status preserves a historical readonly receipt but never permits replaying it", async (t) => {
  fixedClock(t);
  const reply = { start_permitted: false, reservation: { state: "starting", start_receipt: { ...receipt(), start_permitted: false } } };
  t.mock.timers.setTime(Date.parse(receipt().execution_deadline_at) + 1);
  const result = await cloudOperation({ ...options, operation: "status" }, async () => Response.json(reply));
  assert.deepEqual(result, reply);
  assert.equal(result.reservation.start_receipt.start_permitted, false);
  await assert.rejects(cloudOperation({ ...options, operation: "claim" }, async () => Response.json(result.reservation.start_receipt)), /invalid cloud claim/);
});

for (const operation of ["reserve", "status"]) {
  test(`${operation} rejects forged start permission at every response depth`, async (t) => {
    fixedClock(t);
    for (const reply of [receipt(), { start_permitted: false, reservation: { start_receipt: receipt() } },
      { start_permitted: false, arbitrary: [{ nested: { start_permitted: true } }] },
      { start_permitted: false, reservation: { start_receipt: { start_permitted: "true" } } }]) {
      await assert.rejects(cloudOperation({ ...options, operation }, async () => Response.json(reply)), /invalid cloud admission/);
    }
  });
}
