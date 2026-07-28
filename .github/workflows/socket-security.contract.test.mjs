import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("./socket-security.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

test("Socket is reusable across repository visibility boundaries", () => {
  assert.match(workflow, /\n  workflow_call:\n/);
  assert.doesNotMatch(workflow, /\n  (?:push|pull_request|workflow_dispatch):/);
  assert.match(workflow, /SOCKET_SECURITY_API_KEY:\n        required: true/);
  assert.match(workflow, /permissions:\n  contents: read/);
});

test("Socket dependencies are immutable or exact stable versions", () => {
  const actionRefs = [...workflow.matchAll(/^\s+- uses: ([^\s#]+).*$/gm)].map(
    ([, ref]) => ref,
  );
  assert.ok(actionRefs.length >= 2);
  for (const ref of actionRefs) {
    assert.match(ref, /@[0-9a-f]{40}$/);
  }

  assert.match(workflow, /default: "1\.1\.146"/);
  assert.match(workflow, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.doesNotMatch(workflow, /@latest|socket@(?:main|next)\b/);
});

test("Socket isolates mutable state and preserves the blocking contract", () => {
  assert.match(
    workflow,
    /NPM_CONFIG_CACHE=\$RUNNER_TEMP\/socket-npm-cache-/,
  );
  assert.match(workflow, /runs-on: \$\{\{ fromJSON\(inputs\.runner\) \}\}/);
  assert.match(
    workflow,
    /continue-on-error: \$\{\{ inputs\.blocking != true \}\}/,
  );
  assert.match(workflow, /timeout-minutes: 10/);
});
