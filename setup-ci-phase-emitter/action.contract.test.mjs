import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const action = readFileSync(new URL("./action.yml", import.meta.url), "utf8");

test("dynamic phase emitter exports only the shared canonical implementation", () => {
  assert.match(action, /using: node24/);
  assert.match(action, /main: setup-ci-phase-emitter\.mjs/);
  assert.match(action, /node-path:/);
  assert.doesNotMatch(action, /shell:|run:/);
  assert.doesNotMatch(action, /curl|Invoke-RestMethod|Authorization|token/i);
});
