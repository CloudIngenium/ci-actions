import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  assertSafeRelativePath,
  parseBoolean,
  resolveInside,
} from "./contract.mjs";

test("portable path validation rejects traversal and absolute paths", () => {
  assert.equal(assertSafeRelativePath("reports/phase.json"), "reports/phase.json");
  assert.equal(assertSafeRelativePath("reports\\phase.json"), "reports/phase.json");
  assert.throws(() => assertSafeRelativePath("../phase.json"), /must not be absolute/);
  assert.throws(() => assertSafeRelativePath("/tmp/phase.json"), /must not be absolute/);
  assert.throws(() => assertSafeRelativePath("C:\\temp\\phase.json"), /must not be absolute/);
  assert.throws(() => assertSafeRelativePath("\\\\server\\share\\phase.json"), /must not be absolute/);
});

test("resolved paths stay under their configured root", () => {
  const root = path.join(path.parse(process.cwd()).root, "runner-temp");
  assert.equal(resolveInside(root, "events/a.json"), path.join(root, "events", "a.json"));
});

test("boolean inputs fail closed", () => {
  assert.equal(parseBoolean("true", "enabled"), true);
  assert.equal(parseBoolean("false", "enabled"), false);
  assert.throws(() => parseBoolean("yes", "enabled"), /true or false/);
});
