import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("./dependabot-auto-merge.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

test("Dependabot auto-merge is reusable across repository visibility boundaries", () => {
  assert.match(workflow, /\n  workflow_call:\n/);
  assert.doesNotMatch(workflow, /\n  (?:push|pull_request|pull_request_target|workflow_dispatch|schedule):/);
  assert.match(workflow, /permissions:\n  contents: write\n  pull-requests: write/);
  assert.match(workflow, /github\.actor == 'dependabot\[bot\]'/);
  assert.match(workflow, /github\.event_name == 'pull_request_target'/);
});

test("Dependabot auto-merge uses a lightweight bounded runner contract", () => {
  assert.match(workflow, /default: '\["self-hosted","Linux","X64","Admin-Batch"\]'/);
  assert.doesNotMatch(workflow, /Admin-Short/);
  assert.match(workflow, /runs-on: \$\{\{ fromJSON\(inputs\.runner\) \}\}/);
  assert.match(workflow, /timeout-minutes: 5/);
});

// A pin is checked as an invariant, never as a literal digest (plan
// 2026-10-03-master-fleet-currency-majors B59, JC D37): a literal SHA here is a
// second copy of the workflow's pin, so every correct Dependabot bump broke it,
// while a tag pin breaks the invariant just as surely. The workflow file is the
// single source of the pin; which SHA is approved is the pin audit's call.
const FULL_SHA = /^[0-9a-f]{40}$/;

test("Dependabot metadata is SHA-pinned and majors remain unarmed", () => {
  const actionRefs = [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s*["']?([^\s#"']+)["']?.*$/gm)].map(
    ([, ref]) => {
      const at = ref.lastIndexOf("@");
      return at < 0 ? { action: ref, sha: "" } : { action: ref.slice(0, at), sha: ref.slice(at + 1) };
    },
  );
  // The privileged workflow runs exactly one action: Dependabot's own metadata reader.
  assert.deepEqual(
    actionRefs.map(({ action }) => action),
    ["dependabot/fetch-metadata"],
  );
  // Pinned to a full 40-hex commit SHA: a tag, a branch or a short SHA fails.
  for (const { action, sha } of actionRefs) {
    assert.match(sha, FULL_SHA, `${action}@${sha} must be pinned to a full 40-hex commit SHA`);
  }
  assert.equal(new Set(actionRefs.map(({ sha }) => sha)).size, 1, "every use of the action shares one SHA");
  assert.equal(
    [...workflow.matchAll(/steps\.metadata\.outputs\.update-type != 'version-update:semver-major'/g)].length,
    2,
  );
  assert.doesNotMatch(workflow, /@(?:main|master|latest|v\d+)\b/);
});

test("Dependabot auto-merge preserves caller-scoped credentials", () => {
  assert.match(workflow, /github-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.equal(
    [...workflow.matchAll(/GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/g)].length,
    2,
  );
  assert.match(workflow, /gh pr merge --auto --squash "\$PR_URL"/);
});
