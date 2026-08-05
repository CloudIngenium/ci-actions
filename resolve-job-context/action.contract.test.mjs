import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runs as a shell-independent JavaScript action", async () => {
  const action = await readFile(new URL("./action.yml", import.meta.url), "utf8");
  assert.match(action, /runs:\n  using: node20\n  main: resolve-job-context\.mjs/);
  assert.doesNotMatch(action, /shell:\s*(bash|pwsh|powershell)/i);
  assert.doesNotMatch(action, /steps\.resolve\.outputs/);
});
