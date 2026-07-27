import assert from "node:assert/strict";
import { test } from "node:test";

import { detectCiScope } from "./detect-ci-scope.mjs";

test("docs-only changes avoid runtime scope", () => {
  const result = detectCiScope({ changedFiles: "README.md\ndocs/runners.md\n" });
  assert.equal(result.docsOnly, true);
  assert.equal(result.full, false);
  assert.deepEqual(result.components, []);
});

test("component scope is canonical and deduplicated", () => {
  const result = detectCiScope({
    changedFiles: "mcp/a/src/index.ts\nmcp/b/test.ts\nmcp/a/package.json\n",
    componentRoot: "mcp",
  });
  assert.deepEqual(result.components, ["a", "b"]);
  assert.equal(result.reason, "scoped");
});

test("full trigger and ignored paths are bounded prefixes", () => {
  const full = detectCiScope({
    changedFiles: "packages/core/src.ts\n",
    fullTriggerPaths: ["packages/core/**"],
  });
  assert.equal(full.full, true);
  assert.equal(full.reason, "full-trigger");

  const ignored = detectCiScope({
    changedFiles: ".github/workflows/report.yml\n",
    ignoredPaths: [".github/workflows/"],
  });
  assert.equal(ignored.full, false);
  assert.equal(ignored.reason, "ignored-only");
});

test("missing, failed, or unsafe diffs fail open to full validation", () => {
  assert.equal(detectCiScope({}).reason, "missing-diff-base");
  assert.equal(detectCiScope({
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    runGit() { throw new Error("no object"); },
  }).reason, "diff-failed");
  assert.throws(() => detectCiScope({ changedFiles: "../secret" }), /Unsafe changed path/);
});
