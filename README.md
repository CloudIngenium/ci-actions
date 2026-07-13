# CloudIngenium CI Actions

Public, minimal composite actions used by CloudIngenium repositories of every
visibility. Consumers must pin actions from this repository to a full commit
SHA.

## Set up Node and pnpm

```yaml
- uses: CloudIngenium/ci-actions/setup-node-pnpm@<full-commit-sha>
  with:
    node-version: "24"
    pnpm-version: "11.12.0"
```

The action installs Node first, then installs an exact stable pnpm release with
npm into a job-scoped directory under `RUNNER_TEMP`. It never uses Corepack or
`pnpm/action-setup`, and it does not share a pnpm CLI or store between jobs.

## Clean stale Git locks

Persistent self-hosted runners can retain a Git lock after a cancelled or
interrupted checkout. Run this action immediately before `actions/checkout`:

```yaml
- uses: CloudIngenium/ci-actions/clean-stale-git-locks@<full-commit-sha>
- uses: actions/checkout@<full-commit-sha>
```

Only lock files older than five minutes are eligible. A lock reported as open
by `lsof` or Linux `fuser` is preserved. The action does not reset the working tree, remove
untracked files, or touch Git objects.

## Security

- The repository contains no credentials or organization-private configuration.
- Upstream actions are pinned to full commit SHAs.
- pnpm versions must be exact stable semantic versions.
- Consumers authenticate package registries with their own job-scoped tokens.
- Stale-lock cleanup is age-gated and preserves locks held by active processes.
