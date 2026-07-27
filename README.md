# CloudIngenium CI Actions

Public, minimal composite actions used by CloudIngenium repositories of every
visibility. Consumers must pin this repository to a full commit SHA. Payload and
manifest schemas are versioned independently from the Git reference.

All new actions use only the Node.js standard library. The Linux paths use
`bash`; Windows paths use `pwsh`. A Node.js CLI must be available on the runner,
as it is on GitHub-hosted images and CloudIngenium runner baselines.

## Detect CI scope

Resolve a bounded three-dot Git diff into canonical changed files, optional
component names, docs-only status, and a fail-open full-validation decision:

```yaml
- id: scope
  uses: CloudIngenium/ci-actions/detect-ci-scope@<full-commit-sha>
  with:
    base-sha: ${{ github.event.pull_request.base.sha }}
    head-sha: ${{ github.event.pull_request.head.sha }}
    component-root: mcp-servers
    full-trigger-paths: |
      packages/core/**
      pnpm-lock.yaml
```

Rules accept only exact paths or directory prefixes. Arbitrary shell and regular
expressions are deliberately unsupported. Missing commits, a failed diff, an
empty diff, or an oversized change set returns `full=true` so callers validate
more, never silently less.

## Runner baseline

Create a bounded toolchain manifest and fail before an expensive job starts when
the runner no longer meets its declared capabilities:

```yaml
- id: baseline
  uses: CloudIngenium/ci-actions/runner-baseline@<full-commit-sha>
  with:
    requirements-json: >-
      {"os":"win32","architecture":"x64","dotnet_sdk":"10.0.302",
       "node_major":24,"powershell_major":7,"git_minimum":"2.40.0",
       "browser":{"name":"edge","minimum":"140.0.0.0"}}

- uses: actions/upload-artifact@<full-commit-sha>
  if: failure() && steps.baseline.outputs['manifest-path'] != ''
  with:
    name: runner-baseline
    path: ${{ steps.baseline.outputs.manifest-path }}
    retention-days: 7
```

Requirements may instead live in a workspace-relative JSON file. Inline
requirements override file values. Outputs include eligibility, drift reasons,
manifest path, and manifest SHA-256. The manifest records OS, architecture,
boot ID, installed SDKs, Node, pnpm, PowerShell, Git, and detected browser
versions. It never edits runner labels or attempts remediation.

## Emit CI phase v4

Write a validated phase event to `RUNNER_TEMP` and optionally append it to a
local NDJSON spool:

```yaml
- id: phase
  uses: CloudIngenium/ci-actions/emit-ci-phase@<full-commit-sha>
  with:
    phase: "dotnet_restore"
    sequence: "2"
    status: "success"
    started-at: ${{ steps.timer.outputs.started_at }}
    completed-at: ${{ steps.timer.outputs.completed_at }}
    duration-ms: ${{ steps.timer.outputs.duration_ms }}
    job-id: ${{ inputs.job-id }}
    fingerprint-version: "1"
    pool-mapping-version: "3"
    policy-version: "local-first-shadow-v4"
    collector-mode: "hook"
    selected-lane: "windows-build-fast"
    source-manifest-sha256: ${{ vars.CI_CONTROL_V4_MANIFEST_SHA256 }}
    metadata-json: >-
      {"cache_state":"warm","lock_hash":"abc123","artifact_bytes":1048576}
    append-ndjson-path: "ci-telemetry/phases.ndjson"
```

`payload-path` is the exact Knowledge-Hub `ci_phase` v4 object: canonical
identity, version set, timestamps, correlation, sequence, lane, and collector
mode. The action derives stable trace/span IDs when they are omitted. The
numeric workflow job ID and SHA-256 of the generated KH contract manifest are
required because neither may be guessed.

Arbitrary metadata is not allowed by the canonical schema. It is redacted and
retained only in `envelope-path`, where `raw_event.event_type` explicitly names
the legacy `ci_phase_summary` signal and provenance binds the canonical payload
to the KH manifest and phase schema. The optional NDJSON spool contains only
canonical events.

The action accepts RFC 3339 timestamps and integer milliseconds only. It bounds
keys, depth, strings, total payload size, and output paths. Secret-shaped keys,
GitHub tokens, bearer tokens, private keys, embedded URL credentials, and SAS
query values are redacted before disk or output. Send the resulting file with a
separate trusted ingest step; this action performs no network request.

## Exact .NET and persistent NuGet

Prefer an already installed exact SDK and use runner-local NuGet stores:

```yaml
- id: dotnet
  uses: CloudIngenium/ci-actions/setup-dotnet-nuget@<full-commit-sha>
  with:
    sdk-version: "10.0.302"
    global-json-file: "global.json"
    sdk-setup-mode: "system-first"
    cache-namespace: "zap-${{ hashFiles('**/packages.lock.json') }}"
    restore-enabled: "true"
    restore-path: "Zap.CI.slnx"
    locked-mode: "true"
    restore-profile: "normal"
```

`global.json#sdk.version` is mandatory and must be exact; an explicit
`sdk-version` is an assertion and must match it. This keeps later `dotnet`
commands pinned when they run from the global.json boundary. For nested
boundaries, use the `sdk-context-directory` output as `working-directory`.
`system-first` skips download when the exact SDK already exists, while `setup`
always invokes the SHA-pinned `actions/setup-dotnet`.

The default cache root is below `RUNNER_TOOL_CACHE` and persists on self-hosted
runners. `NUGET_PACKAGES` and `NUGET_HTTP_CACHE_PATH` are exported separately.
Diagnostic restore captures output, redacts credentials, and caps the log at
2 MiB; normal restore streams minimal output. Restore emits a
`nuget_restore_summary` raw event using the independent
`schemas.cloudingenium.com/ci-actions/nuget-restore-summary/v1` schema and millisecond
units. It does not claim to implement an unrelated KH event schema.

## Release manifest v1

Hash a release tree after publish and before artifact upload:

```yaml
- id: manifest
  uses: CloudIngenium/ci-actions/release-manifest@<full-commit-sha>
  with:
    root: "artifacts/release"
    artifact-name: "zap-win-x64"
    release-sha: ${{ github.sha }}
    metadata-json: >-
      {"runtime":"win-x64","migration_bundle":true,"manifest_kind":"staging"}
    max-files: "20000"
```

The action produces `release-manifest.json` and
`release-manifest.json.sha256`. Entries are sorted and contain normalized
relative paths, byte counts, and SHA-256 hashes. Metadata, file count, path
length, and total manifest size are bounded. Absolute paths, traversal,
symlinks, special files, unsafe artifact names, and malformed release digests
fail closed. The action excludes its own manifest and hash from the file list.
This artifact contract uses `schema_version: 1` and
`schema_id: https://schemas.cloudingenium.com/ci-actions/release-manifest/v1`;
it deliberately omits `contract_version` because it is not a KH CI event.

## Set up Node and pnpm

```yaml
- uses: CloudIngenium/ci-actions/setup-node-pnpm@<full-commit-sha>
  with:
    node-version: "24"
```

The action installs Node first, resolves the exact stable pnpm version from the
root `package.json#packageManager`, then installs it with npm into a job-scoped
directory under `RUNNER_TEMP`. `pnpm-version` remains available as an explicit
override, and `package-manager-file` selects a nested installation boundary.
When no declaration exists, the action falls back to pnpm 11.13.0. It never uses
Corepack or `pnpm/action-setup`, and it does not share a pnpm CLI or store between
jobs.

## Clean stale Git locks

Persistent self-hosted runners can retain a Git lock after a cancelled or
interrupted checkout. Run this action immediately before `actions/checkout`:

```yaml
- uses: CloudIngenium/ci-actions/clean-stale-git-locks@<full-commit-sha>
- uses: actions/checkout@<full-commit-sha>
```

Only lock files older than five minutes are eligible. A lock reported as open
by `lsof` or Linux `fuser` is preserved. The action does not reset the working
tree, remove untracked files, or touch Git objects.

## Security and compatibility

- The repository contains no credentials or organization-private configuration.
- Upstream actions are pinned to full commit SHAs.
- User-provided paths are rooted and traversal-checked before access.
- JSON contracts are bounded and reject unsupported fields or types.
- Generated files use deterministic ordering and SHA-256 attestations.
- Consumers provide package credentials through their own job-scoped secrets.
- Actions do not alter labels, runner services, live deployments, or caller files.
