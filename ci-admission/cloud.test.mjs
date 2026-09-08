import assert from "node:assert/strict";
import test from "node:test";
import { cloudOperation } from "./index.mjs";

const intent = { repository: "CloudIngenium/Knowledge-Hub", run_id: "123", run_attempt: "1", job_id: "456",
  admission_lease_id: "11111111-1111-4111-8111-111111111111" };
const capability = "11111111-1111-4111-8111-11111111111122222222-2222-4222-8222-222222222222";
const options = { operation: "reserve", intent, capability, token: "fixture-admission-token" };

for (const operation of ["reserve", "claim", "status"]) {
  test(`${operation} reuses the trusted transport with no evidence-writing authority`, async () => {
    let calls = 0;
    const expected = operation === "claim" ? { claimed: true, start_permitted: true } : { start_permitted: false };
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
  await assert.rejects(cloudOperation({ ...options, operation: "claim" }, async () => Response.json({ start_permitted: true })), /claim response/);
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
