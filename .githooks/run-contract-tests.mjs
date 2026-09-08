import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { run } from "node:test";
import { tap } from "node:test/reporters";

const root = realpathSync(process.cwd());
const files = process.argv.slice(2);
try {
  if (!files.length || new Set(files).size !== files.length) throw new Error("empty or duplicate contract selection");
  for (const file of files) {
    if (!/^[A-Za-z0-9_./-]+\.test\.mjs$/.test(file) || file.startsWith("/") || file.split("/").includes("..")) {
      throw new Error("invalid contract path");
    }
    const path = resolve(root, file);
    if (!lstatSync(path).isFile() || !realpathSync(path).startsWith(`${root}${sep}`)) {
      throw new Error("contract must be a regular file inside the repository");
    }
  }
  const executed = new Set();
  let summary;
  const results = run({ files, timeout: 120_000 });
  results.on("test:pass", (event) => {
    // An empty file gets an automatic file-level pass from Node. It is not a test.
    if (event.file && event.details.type === "test" && !event.skip && !event.todo
      && event.name !== event.file && !files.includes(event.name)) {
      executed.add(realpathSync(event.file));
    }
  });
  results.on("test:summary", (event) => { summary = event; });
  await pipeline(results, tap, process.stdout);
  const counts = summary?.counts;
  if (!summary?.success || !counts || counts.tests < 1 || counts.passed !== counts.tests
    || counts.failed || counts.cancelled || counts.skipped || counts.todo
    || files.some((file) => !executed.has(realpathSync(file)))) {
    throw new Error("contract tests must execute and pass without omissions");
  }
} catch (error) {
  console.error(`ci-actions pre-push: ${error.message}`);
  process.exitCode = 1;
}
