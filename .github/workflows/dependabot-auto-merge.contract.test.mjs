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

test("Dependabot metadata is SHA-pinned and majors remain unarmed", () => {
  const actionRefs = [...workflow.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+).*$/gm)].map(
    ([, ref]) => ref,
  );
  assert.deepEqual(actionRefs, [
    "dependabot/fetch-metadata@25dd0e34f4fe68f24cc83900b1fe3fe149efef98",
  ]);
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
