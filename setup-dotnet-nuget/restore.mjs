#!/usr/bin/env node

import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  isDirectExecution,
  parseBoolean,
  resolveInside,
  stableStringify,
} from "../lib/contract.mjs";
import { writeOutputs } from "../lib/github-output.mjs";

const MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;

export function buildRestoreArguments({ target = ".", lockedMode = true, profile = "normal" }) {
  if (!["normal", "diagnostic"].includes(profile)) {
    throw new Error("restore-profile must be normal or diagnostic");
  }
  const args = ["restore", target, "--nologo"];
  if (lockedMode) args.push("--locked-mode");
  args.push("--verbosity", profile === "diagnostic" ? "diagnostic" : "minimal");
  return args;
}

function safeRestoreTarget(workspace, input) {
  const value = input?.trim() || ".";
  if (value === ".") return workspace;
  return resolveInside(workspace, value, "restore-path");
}

function redactDiagnostics(value) {
  return value
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:sig|token|key|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/^.*(?:authorization|credential|password|private[_ -]?key|secret|token).*/gim, "[REDACTED_LINE]");
}

async function runRestore(command, args, { cwd, capture }) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  let output = "";
  if (capture) {
    const collect = (chunk) => {
      if (Buffer.byteLength(output, "utf8") < MAX_DIAGNOSTIC_BYTES * 2) output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { exitCode, output };
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`invalid argument sequence near ${argv[index] ?? "<end>"}`);
    }
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const runnerTemp = process.env.RUNNER_TEMP || workspace;
  const sdkContext = path.resolve(args.get("sdk-context-directory") || workspace);
  const contextRelative = path.relative(path.resolve(workspace), sdkContext);
  if (contextRelative.startsWith("..") || path.isAbsolute(contextRelative)) {
    throw new Error("sdk-context-directory must remain inside the workspace");
  }
  const target = safeRestoreTarget(workspace, args.get("restore-path"));
  const profile = args.get("restore-profile") || "normal";
  const lockedMode = parseBoolean(args.get("locked-mode") || "true", "locked-mode");
  const restoreArgs = buildRestoreArguments({ target, lockedMode, profile });
  const started = Date.now();
  const result = await runRestore("dotnet", restoreArgs, {
    cwd: sdkContext,
    capture: profile === "diagnostic",
  });
  const durationMs = Date.now() - started;
  let diagnosticsPath = "";
  if (profile === "diagnostic") {
    diagnosticsPath = resolveInside(
      runnerTemp,
      args.get("diagnostics-path") || "nuget-restore-diagnostics.log",
      "diagnostics-path",
    );
    const redacted = redactDiagnostics(result.output);
    const bounded = Buffer.from(redacted, "utf8").subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8");
    await writeFile(diagnosticsPath, bounded, { encoding: "utf8", mode: 0o600 });
  }
  const summary = {
    schema_id: "https://schemas.cloudingenium.com/ci-actions/nuget-restore-summary/v1",
    schema_version: 1,
    raw_event_name: "nuget_restore_summary",
    repository: process.env.GITHUB_REPOSITORY || null,
    run_id: process.env.GITHUB_RUN_ID || null,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : null,
    sdk_version: args.get("sdk-version"),
    sdk_source: args.get("sdk-source"),
    profile,
    locked_mode: lockedMode,
    duration_ms: durationMs,
    unit: "ms",
    status: result.exitCode === 0 ? "success" : "failure",
    cache: {
      packages_path: process.env.NUGET_PACKAGES || null,
      http_cache_path: process.env.NUGET_HTTP_CACHE_PATH || null,
    },
  };
  const summaryPath = resolveInside(
    runnerTemp,
    args.get("summary-path") || "nuget-restore-summary.json",
    "summary-path",
  );
  const temporaryPath = `${summaryPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, stableStringify(summary), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, summaryPath);
  await writeOutputs(args.get("github-output"), {
    "restore-duration-ms": durationMs,
    "restore-summary-path": summaryPath,
    "diagnostics-path": diagnosticsPath,
  });
  if (result.exitCode !== 0) {
    if (diagnosticsPath) {
      process.stderr.write(`Restore failed; redacted diagnostics: ${diagnosticsPath}\n`);
    }
    process.exitCode = result.exitCode || 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 2;
  });
}
