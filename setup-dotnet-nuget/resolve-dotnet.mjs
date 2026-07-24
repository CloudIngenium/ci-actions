#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  assertSafeRelativePath,
  isDirectExecution,
  parseBoolean,
  resolveInside,
} from "../lib/contract.mjs";
import { writeOutputs } from "../lib/github-output.mjs";

const EXACT_SDK = /^\d+\.\d+\.\d{3}(?:-[0-9A-Za-z.-]+)?$/;

export async function resolveSdkVersion({ explicit = "", globalJsonPath = "", workspace }) {
  const relative = globalJsonPath || "global.json";
  const manifestPath = resolveInside(workspace, relative, "global-json-file");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("global.json with an exact sdk.version is required to keep subsequent dotnet commands pinned");
    }
    throw new Error(`unable to read global.json: ${error.message}`);
  }
  const version = manifest?.sdk?.version;
  if (!EXACT_SDK.test(version ?? "")) {
    throw new Error("global.json sdk.version must be an exact .NET SDK version");
  }
  if (explicit) {
    if (!EXACT_SDK.test(explicit)) throw new Error("sdk-version must be an exact .NET SDK version");
    if (explicit !== version) {
      throw new Error(`sdk-version ${explicit} does not match global.json sdk.version ${version}`);
    }
  }
  return version;
}

export function resolveSdkSource({ sdkVersion, installedSdks, mode }) {
  if (!["system-first", "setup"].includes(mode)) {
    throw new Error("sdk-setup-mode must be system-first or setup");
  }
  const installed = installedSdks.includes(sdkVersion);
  return {
    needsSetup: mode === "setup" || !installed,
    source: mode === "system-first" && installed ? "system" : "setup",
  };
}

export function resolvePersistentCache({
  cacheRoot = "",
  namespace = "cloudingenium",
  toolCache,
  runnerTemp,
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(namespace)) {
    throw new Error("cache-namespace must be a bounded identifier");
  }
  const fallbackRoot = toolCache || runnerTemp;
  if (!fallbackRoot) throw new Error("RUNNER_TOOL_CACHE or RUNNER_TEMP is required");
  let root;
  if (!cacheRoot) {
    root = path.resolve(fallbackRoot, "cloudingenium-ci-cache");
  } else if (path.isAbsolute(cacheRoot) || path.win32.isAbsolute(cacheRoot)) {
    root = path.resolve(cacheRoot);
  } else {
    assertSafeRelativePath(cacheRoot, "cache-root");
    root = path.resolve(fallbackRoot, cacheRoot);
  }
  if (root === path.parse(root).root) throw new Error("cache-root must not be a filesystem root");
  return {
    root,
    packages: path.join(root, namespace, "packages"),
    http: path.join(root, namespace, "http"),
  };
}

function installedSdks() {
  try {
    return execFileSync("dotnet", ["--list-sdks"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    })
      .split(/\r?\n/)
      .map((line) => line.match(/^(\S+)\s/)?.[1])
      .filter(Boolean);
  } catch {
    return [];
  }
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

async function appendEnvironment(file, entries) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(file, Object.entries(entries).map(([key, value]) => `${key}=${value}\n`).join(""), "utf8");
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  parseBoolean(args.get("restore-enabled") || "false", "restore-enabled");
  parseBoolean(args.get("locked-mode") || "true", "locked-mode");
  if (!["normal", "diagnostic"].includes(args.get("restore-profile") || "normal")) {
    throw new Error("restore-profile must be normal or diagnostic");
  }
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const globalJsonPath = resolveInside(
    workspace,
    args.get("global-json-file") || "global.json",
    "global-json-file",
  );
  const sdkVersion = await resolveSdkVersion({
    explicit: args.get("sdk-version"),
    globalJsonPath: args.get("global-json-file"),
    workspace,
  });
  const resolution = resolveSdkSource({
    sdkVersion,
    installedSdks: installedSdks(),
    mode: args.get("sdk-setup-mode") || "system-first",
  });
  const cache = resolvePersistentCache({
    cacheRoot: args.get("cache-root"),
    namespace: args.get("cache-namespace") || "cloudingenium",
    toolCache: process.env.RUNNER_TOOL_CACHE,
    runnerTemp: process.env.RUNNER_TEMP,
  });
  await Promise.all([
    mkdir(cache.packages, { recursive: true }),
    mkdir(cache.http, { recursive: true }),
  ]);
  await appendEnvironment(args.get("github-env"), {
    NUGET_PACKAGES: cache.packages,
    NUGET_HTTP_CACHE_PATH: cache.http,
    DOTNET_NOLOGO: "true",
    DOTNET_CLI_TELEMETRY_OPTOUT: "true",
  });
  await writeOutputs(args.get("github-output"), {
    "sdk-version": sdkVersion,
    "needs-setup": resolution.needsSetup ? "true" : "false",
    "sdk-source": resolution.source,
    "cache-root": cache.root,
    "packages-path": cache.packages,
    "http-cache-path": cache.http,
    "sdk-context-directory": path.dirname(globalJsonPath),
  });
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 2;
  });
}
