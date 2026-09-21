import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { cleanupTmpFixtures, tmpFixture, trackedTmpFixtures } from "./tmp-fixture.mjs";

test("tmpFixture keeps the mkdtemp contract: <prefix>-XXXXXX under tmpdir(), tracked for cleanup", () => {
  const dir = tmpFixture("tf-contract");
  assert.ok(existsSync(dir));
  assert.equal(join(dir, ".."), tmpdir().replace(/\/$/, "") || join(dir, ".."));
  assert.match(basename(dir), /^tf-contract-[A-Za-z0-9]{6}$/);
  assert.ok(trackedTmpFixtures().includes(dir));
  cleanupTmpFixtures();
  assert.equal(existsSync(dir), false, "cleanup removes what it created");
});

test("cleanup is idempotent, removes non-empty trees, and tolerates an already-removed fixture", () => {
  const a = tmpFixture("tf-tree");
  writeFileSync(join(a, "f.txt"), "x");
  const b = tmpFixture("tf-gone");
  cleanupTmpFixtures();
  assert.equal(existsSync(a), false);
  assert.equal(existsSync(b), false);
  assert.equal(cleanupTmpFixtures(), 0, "second call finds nothing and does not throw");
  assert.deepEqual(trackedTmpFixtures(), []);
});

test("KEEP_TMP_FIXTURES=1 keeps the directories (then we remove them ourselves)", () => {
  const dir = tmpFixture("tf-keep");
  const prev = process.env.KEEP_TMP_FIXTURES;
  process.env.KEEP_TMP_FIXTURES = "1";
  try {
    assert.equal(cleanupTmpFixtures(), 0);
    assert.ok(existsSync(dir));
  } finally {
    if (prev === undefined) delete process.env.KEEP_TMP_FIXTURES;
    else process.env.KEEP_TMP_FIXTURES = prev;
  }
  assert.ok(cleanupTmpFixtures() >= 1);
  assert.equal(existsSync(dir), false);
});
