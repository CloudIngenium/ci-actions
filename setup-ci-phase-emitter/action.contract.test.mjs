import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const action = readFileSync(new URL("./action.yml", import.meta.url), "utf8");

test("dynamic phase emitter exports only the shared canonical implementation", () => {
  assert.match(action, /\.\.\/emit-ci-phase\/emit-ci-phase\.mjs/);
  assert.match(action, /CI_PHASE_EMITTER=/);
  assert.match(action, /CI_CONTROL_V4_MANIFEST_SHA256=/);
  assert.match(action, /CI_FINGERPRINT_VERSION=/);
  assert.match(action, /CI_POOL_MAPPING_VERSION=/);
  assert.match(action, /CI_POLICY_VERSION=/);
  assert.match(action, /CI_SELECTED_LANE=/);
  assert.doesNotMatch(action, /curl|Invoke-RestMethod|Authorization|token/i);
});
