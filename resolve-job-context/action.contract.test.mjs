import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runs as a shell-independent JavaScript action with LF or CRLF", async () => {
  const action = await readFile(new URL("./action.yml", import.meta.url), "utf8");
  for (const eol of ["\n", "\r\n"]) {
    const source = action.replace(/\r\n/g, "\n").replace(/\n/g, eol);
    assert.match(source.replace(/\r\n/g, "\n"), /runs:\n  using: node24\n  main: resolve-job-context\.mjs/);
    assert.doesNotMatch(source, /shell:\s*(bash|pwsh|powershell)/i);
    assert.doesNotMatch(source, /steps\.resolve\.outputs/);
  }
});
