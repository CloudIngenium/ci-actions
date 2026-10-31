/**
 * Install the one wrangler release this action pins, from this action's own
 * package.json and pnpm-lock.yaml, in a directory under RUNNER_TEMP that no
 * caller file or caller configuration reaches.
 *
 * Why: a workflow that runs the caller's `node_modules/.bin/wrangler` with an
 * org token in scope hands that token to whatever binary the caller's repo
 * resolves. This action owns the binary instead:
 *   - the package.json and lockfile are hash-checked against the constants below;
 *   - pnpm itself is fetched by version and its tarball checked against a
 *     SHA-512 constant, never taken from PATH (a caller-influenced PATH entry
 *     would re-admit a caller-controlled installer). pnpm 12 is a native
 *     executable published per platform as `@pnpm/exe.<os>-<arch>`; the `pnpm`
 *     package is only a wrapper that takes the binary from an optional
 *     dependency the wrapper's own tarball hash does not cover, or downloads
 *     it. So the action fetches the host's `@pnpm/exe.*` tarball itself, checks
 *     it against that platform's constant, and runs the binary directly;
 *   - npm and pnpm run with an allowlisted environment: HOME, XDG_* and the
 *     npm user/global config point into the install directory, the registry is
 *     npmjs, and no scoped registry, auth token, NODE_OPTIONS or caller
 *     npm_config_* / PNPM_CONFIG_* variable is passed through;
 *   - the install is `--frozen-lockfile --ignore-scripts --ignore-pnpmfile
 *     --ignore-workspace` from a fresh directory outside GITHUB_WORKSPACE (without
 *     the last two, a pnpm-workspace.yaml in RUNNER_TEMP could name a pnpmfile
 *     that runs during the install).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { writeOutputs } from "../lib/github-output.mjs";

export const WRANGLER_VERSION = "4.154.0";
export const PNPM_VERSION = "12.16.1";
export const REGISTRY = "https://registry.npmjs.org/";
export const DEFAULT_DIR = "d1-wrangler";
export const PACKAGE_JSON_SHA256 = "97f556c58c92613c0e1b62a409a87f8ada836637fc0fb520944b4b5e2929e5e7";
export const LOCKFILE_SHA256 = "62227de125233232c72332ad20684667be2a799b3f77dadcd49ea7b4c02e8972";
// dist.integrity of https://registry.npmjs.org/@pnpm/exe.<target>/-/exe.<target>-12.16.1.tgz,
// with the executable's path inside the package. A host without a row is refused.
export const PNPM_BINARIES = Object.freeze({
  "linux-x64": Object.freeze({
    integrity: "sha512-RK//8ZLcXGW8A2k8bQOXZDBN1Qu92zN4dYnG1bzj1zoQ1fkZ6jNzZ1AvXtsfGVma795CJtvoaF5bLXf4l/FIUw==",
    bin: "pnpm",
  }),
  "linux-arm64": Object.freeze({
    integrity: "sha512-JaRd5gNxwdNGBBkrZFt8bknrK4YmHVJBW0JMhUQ0fJ0dEYp6C2GT9ExaCqOO8EwYEyqM+jpKgJIK+8WFaJy3ew==",
    bin: "pnpm",
  }),
  "win32-x64": Object.freeze({
    integrity: "sha512-k+FhRJ0ttphFoFIVB1Sk4v76YJAulafmA/Ly57cysesUhhIzVlApeOShUz0jXubKx317TThlEfpQrukldnqORA==",
    bin: "pnpm.exe",
  }),
  "win32-arm64": Object.freeze({
    integrity: "sha512-Ox3kNNVxtGw6pK7SVejmeOUgHhUTZgAM7NQQ6cU7frPw3ix9+j7d2MGbRg3fyEFAaKWq8ZAZLTQGcDyLnAu+qA==",
    bin: "pnpm.exe",
  }),
  "darwin-x64": Object.freeze({
    integrity: "sha512-xZvQBFqcZjO7vFKTK3XsJpqY6lnBL9EWSLCzVUPq3kZ94+D96gwJCa76xxGNK8Cj32f4eeM91Qg+yNRR4sRpDw==",
    bin: "pnpm",
  }),
  "darwin-arm64": Object.freeze({
    integrity: "sha512-pVbmIIbhixiLvADLu1WA3TaW8FZy/D72R1De27WbbFx8/2mxvnsTyFVm4fO9kjpjMY7RzJd48CiQ96p8fO3ebQ==",
    bin: "pnpm",
  }),
});
export const PINNED_FILES = Object.freeze({
  "package.json": PACKAGE_JSON_SHA256,
  "pnpm-lock.yaml": LOCKFILE_SHA256,
});
// Variables copied from the caller's environment. Everything else is dropped.
const PASSTHROUGH = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
// libuv adds HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE, SYSTEMROOT, TEMP,
// USERDOMAIN, USERNAME, USERPROFILE and WINDIR from the parent to any explicit
// Windows env that lacks them, so each is either set into the isolation dir
// below or passed through here on purpose.
const WINDOWS_PASSTHROUGH = [
  "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "SystemDrive", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "USERNAME", "USERDOMAIN", "LOGONSERVER",
];

const ACTION_DIR = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  throw new Error(`wrangler-pinned: ${message}`);
}

/** Realpath of the deepest existing ancestor, with the missing remainder re-joined. */
function resolveReal(p, pathApi = path) {
  const missing = [];
  let current = pathApi.resolve(p);
  while (!existsSync(current)) {
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    missing.unshift(pathApi.basename(current));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync.native(current) : current;
  return missing.length ? pathApi.join(base, ...missing) : base;
}

/**
 * True when `child` is strictly below `parent`. Only a `..` path SEGMENT means
 * outside: a child entry named `..x` is inside. A relative path that comes back
 * absolute (Windows, another drive) is outside.
 */
export function isInside(child, parent, pathApi = path) {
  const rel = pathApi.relative(parent, child);
  if (rel === "" || pathApi.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${pathApi.sep}`);
}

/**
 * The install directory: RUNNER_TEMP/<dir> (or an absolute <dir>), strictly
 * under RUNNER_TEMP once symlinks are resolved, and neither inside nor
 * containing GITHUB_WORKSPACE.
 */
export function resolveTarget({ runnerTemp, workspace, dir }) {
  if (!runnerTemp) fail("RUNNER_TEMP is not set; refusing to pick an install directory");
  if (!path.isAbsolute(runnerTemp)) fail("RUNNER_TEMP must be an absolute path");
  if (!existsSync(runnerTemp)) fail("RUNNER_TEMP does not exist");
  if (!workspace) fail("GITHUB_WORKSPACE is not set; cannot prove the install is outside it");
  const input = dir || DEFAULT_DIR;
  if (/[\0\r\n]/.test(input)) fail("dir contains a control character");
  // Win32 strips a trailing dot or space from a segment, so `.. ` or `...` can
  // mean `..` to the OS while path.win32 keeps it literal. Refuse them everywhere.
  if (input.split(/[\\/]/).some((s) => s !== "." && s !== ".." && /[. ]$/.test(s))) {
    fail("dir has a path segment ending in '.' or a space");
  }
  const temp = realpathSync.native(runnerTemp);
  const target = resolveReal(path.isAbsolute(input) ? input : path.join(temp, input));
  const ws = resolveReal(workspace);
  if (!isInside(target, temp)) fail(`install directory must be strictly under RUNNER_TEMP: ${target}`);
  if (target === ws || isInside(target, ws) || isInside(ws, target)) {
    fail(`install directory overlaps GITHUB_WORKSPACE: ${target}`);
  }
  return target;
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function sha512Integrity(file) {
  return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
}

/** Copy the pinned package.json and lockfile, checking both source and copy. */
export function stagePinnedFiles(actionPath, target) {
  for (const [name, expected] of Object.entries(PINNED_FILES)) {
    const source = path.join(actionPath, name);
    const sourceHash = sha256File(source);
    if (sourceHash !== expected) fail(`${name} sha256 ${sourceHash} does not match the pinned ${expected}`);
    const copy = path.join(target, name);
    copyFileSync(source, copy);
    if (sha256File(copy) !== expected) fail(`staged ${name} does not match the pinned sha256`);
  }
}

export function isolationPaths(target, pathApi = path) {
  const root = pathApi.join(target, ".isolation");
  const at = (name) => pathApi.join(root, name);
  return {
    root,
    home: at("home"),
    xdgConfig: at("xdg-config"),
    xdgCache: at("xdg-cache"),
    xdgData: at("xdg-data"),
    xdgState: at("xdg-state"),
    tmp: at("tmp"),
    npmCache: at("npm-cache"),
    pnpmHome: at("pnpm-home"),
    store: at("pnpm-store"),
    pnpmCli: at("pnpm-cli"),
    userconfig: at("empty-user.npmrc"),
    globalconfig: at("empty-global.npmrc"),
  };
}

/** The complete environment npm and pnpm see. Nothing else from the caller survives. */
export function isolatedEnv({ target, baseEnv, platform = process.platform, execPath = process.execPath }) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const iso = isolationPaths(target, pathApi);
  const systemDirs = platform === "win32"
    ? (() => {
      const root = baseEnv.SystemRoot || baseEnv.SYSTEMROOT || "C:\\Windows";
      return [pathApi.join(root, "System32"), root];
    })()
    : ["/usr/bin", "/bin"];
  const env = {
    PATH: [pathApi.dirname(execPath), ...systemDirs].join(pathApi.delimiter),
    HOME: iso.home,
    XDG_CONFIG_HOME: iso.xdgConfig,
    XDG_CACHE_HOME: iso.xdgCache,
    XDG_DATA_HOME: iso.xdgData,
    XDG_STATE_HOME: iso.xdgState,
    TMPDIR: iso.tmp,
    CI: "true",
    npm_config_userconfig: iso.userconfig,
    npm_config_globalconfig: iso.globalconfig,
    npm_config_registry: REGISTRY,
    npm_config_cache: iso.npmCache,
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    PNPM_HOME: iso.pnpmHome,
    PNPM_CONFIG_UPDATE_NOTIFIER: "false",
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "false",
  };
  if (platform === "win32") {
    Object.assign(env, {
      USERPROFILE: iso.home,
      HOMEDRIVE: pathApi.parse(iso.home).root.replace(/\\$/, ""),
      HOMEPATH: iso.home.slice(pathApi.parse(iso.home).root.replace(/\\$/, "").length),
      APPDATA: pathApi.join(iso.home, "AppData", "Roaming"),
      LOCALAPPDATA: pathApi.join(iso.home, "AppData", "Local"),
      TEMP: iso.tmp,
      TMP: iso.tmp,
    });
    for (const name of WINDOWS_PASSTHROUGH) if (baseEnv[name]) env[name] = baseEnv[name];
  }
  for (const name of PASSTHROUGH) if (baseEnv[name]) env[name] = baseEnv[name];
  return env;
}

/** npm's CLI script beside the running node, never an npm found on PATH. */
export function findNpmCli(execPath = process.execPath, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = pathApi.dirname(execPath);
  const candidates = platform === "win32"
    ? [pathApi.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")]
    : [pathApi.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    fail(`npm is not installed beside ${execPath}; run actions/setup-node right before this action `
      + "(the runner's bundled node has no npm on Windows)");
  }
  return found;
}

/** `label` names the step in errors, e.g. `npm pack` or `pnpm install`. */
function runCommand({ spawn, command, args, cwd, env, label }) {
  const result = spawn(command, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} exited with ${result.status ?? result.signal}`);
}

/**
 * The `@pnpm/exe.<target>` suffix for this host: `<platform>-<arch>`, plus
 * `-musl` on a Linux whose C library is not glibc (pnpm ships musl builds under
 * their own name, and this action pins none of them).
 */
export function pnpmTarget({ platform = process.platform, arch = process.arch, glibc } = {}) {
  const runtime = glibc !== undefined ? glibc : process.report?.getReport?.().header?.glibcVersionRuntime;
  return `${platform}-${arch}${platform === "linux" && !runtime ? "-musl" : ""}`;
}

/**
 * Fetch the host's native pnpm by exact version, check the tarball's SHA-512
 * against this target's constant, unpack it into the isolation dir and return
 * the executable to run: `{ command, args }`.
 */
export function provisionPnpm({ iso, env, spawn = spawnSync, execPath = process.execPath, target = pnpmTarget() }) {
  const pinned = Object.hasOwn(PNPM_BINARIES, target) ? PNPM_BINARIES[target] : null;
  if (!pinned) fail(`no pinned pnpm ${PNPM_VERSION} binary for ${target}; pinned: ${Object.keys(PNPM_BINARIES).join(", ")}`);
  const packageName = `@pnpm/exe.${target}`;
  const npmCli = findNpmCli(execPath);
  mkdirSync(iso.pnpmCli, { recursive: true });
  const npm = (args) => runCommand({ spawn, command: execPath, args: [npmCli, ...args], cwd: iso.pnpmCli, env, label: `npm ${args[0]}` });
  // --prefix (and --no-workspaces): otherwise npm walks up to a parent
  // package.json whose workspaces name the install dir and loads the .npmrc
  // beside it as project config. With --prefix npm never walks.
  npm(["pack", `${packageName}@${PNPM_VERSION}`, "--pack-destination", iso.pnpmCli, "--registry", REGISTRY,
    "--prefix", iso.pnpmCli, "--no-workspaces"]);
  const tarball = path.join(iso.pnpmCli, `pnpm-exe.${target}-${PNPM_VERSION}.tgz`);
  if (!existsSync(tarball)) fail(`npm pack did not produce ${tarball}`);
  const integrity = sha512Integrity(tarball);
  if (integrity !== pinned.integrity) fail(`${packageName} ${PNPM_VERSION} tarball integrity ${integrity} is not the pinned one`);
  const prefix = path.join(iso.pnpmCli, "prefix");
  // The tarball has no dependencies and no scripts; npm only unpacks it and
  // keeps the executable bit.
  npm(["install", "--prefix", prefix, "--ignore-scripts", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", tarball]);
  const dir = path.join(prefix, "node_modules", "@pnpm", `exe.${target}`);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  if (manifest.name !== packageName || manifest.version !== PNPM_VERSION) fail(`installed pnpm is ${manifest.name}@${manifest.version}`);
  const command = path.join(dir, pinned.bin);
  if (!existsSync(command)) fail(`pnpm executable is missing: ${command}`);
  return { command, args: [] };
}

export function pnpmInstallArgs(iso) {
  return [
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    "--ignore-workspace",
    "--registry", REGISTRY,
    "--store-dir", iso.store,
    "--reporter", "append-only",
  ];
}

/** The installed wrangler must be exactly the pinned release, resolved inside the target. */
export function assertWranglerVersion(target) {
  const dir = path.join(target, "node_modules", "wrangler");
  const manifestPath = path.join(dir, "package.json");
  if (!existsSync(manifestPath)) fail(`wrangler is not installed in ${target}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "wrangler" || manifest.version !== WRANGLER_VERSION) {
    fail(`installed ${manifest.name}@${manifest.version}, expected wrangler@${WRANGLER_VERSION}`);
  }
  const realTarget = realpathSync.native(target);
  if (!isInside(realpathSync.native(dir), realTarget)) fail("node_modules/wrangler resolves outside the install directory");
  const bin = path.join(dir, "bin", "wrangler.js");
  if (!existsSync(bin)) fail(`wrangler entry point is missing: ${bin}`);
  return { version: manifest.version, bin };
}

export async function run({
  env = process.env,
  actionPath = ACTION_DIR,
  platform = process.platform,
  execPath = process.execPath,
  spawn = spawnSync,
  pnpmProvider = provisionPnpm,
} = {}) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!(major > 22 || (major === 22 && minor >= 13))) fail(`wrangler-pinned needs Node >= 22.13; this is ${process.version}`);
  const target = resolveTarget({ runnerTemp: env.RUNNER_TEMP, workspace: env.GITHUB_WORKSPACE, dir: env.INPUT_DIR });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const iso = isolationPaths(target);
  for (const dir of [iso.home, iso.xdgConfig, iso.xdgCache, iso.xdgData, iso.xdgState, iso.tmp, iso.npmCache, iso.pnpmHome, iso.store]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(iso.userconfig, "");
  writeFileSync(iso.globalconfig, "");
  stagePinnedFiles(actionPath, target);

  const childEnv = isolatedEnv({ target, baseEnv: env, platform, execPath });
  const pnpm = pnpmProvider({ iso, env: childEnv, spawn, execPath });
  runCommand({ spawn, command: pnpm.command, args: [...pnpm.args, ...pnpmInstallArgs(iso)], cwd: target, env: childEnv, label: "pnpm install" });

  for (const [name, expected] of Object.entries(PINNED_FILES)) {
    if (sha256File(path.join(target, name)) !== expected) fail(`${name} changed during the install`);
  }
  const { version, bin } = assertWranglerVersion(target);
  const outputs = { "wrangler-bin": bin, "wrangler-dir": target, "wrangler-version": version };
  await writeOutputs(env.GITHUB_OUTPUT, outputs);
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().then(
    (outputs) => console.log(`wrangler ${outputs["wrangler-version"]} at ${outputs["wrangler-bin"]}`),
    (error) => {
      console.error(`::error::${error.message}`);
      process.exitCode = 1;
    },
  );
}
