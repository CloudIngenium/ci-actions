import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBaseline } from "./runner-baseline.mjs";

const manifest = {
  runner: { os: "linux", architecture: "x64" },
  tools: {
    dotnet_sdks: ["10.0.302"],
    node: "24.4.1",
    pnpm: "11.13.0",
    powershell: "7.5.2",
    git: "2.50.1",
    browsers: { chrome: "140.0.7339", edge: null, firefox: "141.0.0" },
  },
};

test("accepts an exact matching runner baseline", () => {
  assert.deepEqual(
    evaluateBaseline(manifest, {
      os: "linux",
      architecture: "x64",
      dotnet_sdk: "10.0.302",
      node_major: 24,
      pnpm: "11.13.0",
      powershell_major: 7,
      git_minimum: "2.40.0",
      browser: { name: "chrome", minimum: "139.0.0" },
    }),
    [],
  );
});

test("reports each drift without hiding later failures", () => {
  const drift = evaluateBaseline(manifest, {
    os: "win32",
    dotnet_sdk: "10.0.301",
    node_major: 22,
    pnpm: "11.12.0",
    browser: { name: "edge" },
  });
  assert.equal(drift.length, 5);
  assert.match(drift.join("\n"), /dotnet SDK 10\.0\.301/);
  assert.match(drift.join("\n"), /edge/);
});

test("rejects unknown requirements and floating SDK versions", () => {
  assert.throws(() => evaluateBaseline(manifest, { label: "PR-Fast" }), /unknown baseline/);
  assert.throws(() => evaluateBaseline(manifest, { dotnet_sdk: "10.0.x" }), /exact SDK/);
});
