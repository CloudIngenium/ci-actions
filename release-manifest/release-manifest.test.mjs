import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReleaseManifest } from "./release-manifest.mjs";

async function fixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ci-actions-release-"));
  const root = path.join(workspace, "dist");
  await mkdir(path.join(root, "api"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "hello\n");
  await writeFile(path.join(root, "api", "app.dll"), "binary\n");
  return { workspace, root };
}

test("creates sorted hashes and bounded metadata", async () => {
  const { workspace } = await fixture();
  const result = await createReleaseManifest({
    workspace,
    root: "dist",
    artifactName: "zap-release",
    releaseSha: "a".repeat(40),
    createdAt: "2026-07-23T17:00:00Z",
    metadataJson: '{"runtime":"win-x64","migration_bundle":true}',
  });
  assert.equal(result.manifest.schema_version, 1);
  assert.equal(result.manifest.schema_id, "https://schemas.cloudingenium.com/ci-actions/release-manifest/v1");
  assert.equal("contract_version" in result.manifest, false);
  assert.deepEqual(result.manifest.files.map((file) => file.path), ["api/app.dll", "index.html"]);
  assert.equal(result.manifest.file_count, 2);
  assert.match(await readFile(result.hashPath, "utf8"), new RegExp(`^${result.manifestHash}  release-manifest.json`));
});

test("rejects roots and outputs that escape the workspace or release", async () => {
  const { workspace } = await fixture();
  const base = {
    workspace,
    root: "dist",
    artifactName: "release",
    releaseSha: "b".repeat(40),
  };
  await assert.rejects(createReleaseManifest({ ...base, root: "../outside" }), /must not be absolute or contain/);
  await assert.rejects(createReleaseManifest({ ...base, outputPath: "../manifest.json" }), /must not be absolute or contain/);
  await assert.rejects(createReleaseManifest({ ...base, root: path.parse(workspace).root }), /must not be absolute/);
});

test("fails closed on symlinks and excessive file counts", async () => {
  const { workspace, root } = await fixture();
  await symlink(path.join(root, "index.html"), path.join(root, "linked.html"));
  await assert.rejects(
    createReleaseManifest({
      workspace,
      root: "dist",
      artifactName: "release",
      releaseSha: "c".repeat(40),
    }),
    /symbolic link/,
  );
  const { workspace: cleanWorkspace } = await fixture();
  await assert.rejects(
    createReleaseManifest({
      workspace: cleanWorkspace,
      root: "dist",
      artifactName: "release",
      releaseSha: "d".repeat(40),
      maxFiles: 1,
    }),
    /max-files/,
  );
});
