#!/usr/bin/env bash
# Prints "<kind> <dir>": the pnpm store this job uses.
#
# host-shared: the runner host declares a shared store it prunes itself, and it is an existing,
#   writable absolute directory. Credential-free k3s agents set PNPM_STORE_DIR (infra-iac
#   iac/arc-k3s-runners, JC D374); CI-SP-01's runners set pnpm_config_store_dir in their .env
#   (infra-iac scripts/lib/ci-vm-runner-instances-remote.sh, JC D375). A warm store downloads
#   nothing again: pnpm checks every file it takes from it (verify-store-integrity), and each
#   @cloudingenium tarball it skips is one GitHub Packages does not bill as data transfer
#   (plan 2026-10-01-runner-fleet-throughput-master, D442).
#   It must also be owned by the runner user and writable by no one else: a store another account
#   can write is a store another account can poison. The trust boundary itself is the host's: only
#   credential-free runners declare a shared store (D374 excludes the cred and gVisor agents; D359
#   keeps the cred and LAN classes off CI-SP-01), the tradeoff JC chose over a read-only store.
# isolated: anything else, the per-job store under the pnpm prefix ($1). pnpm 11 reads
#   PNPM_CONFIG_* only, so without an explicit store it falls through to the runner user's global
#   config, which on a self-hosted runner is whatever another job wrote there last
#   (Runner-Ubuntu-03g, 2026-09-26: a Knowledge-Hub job's deleted $RUNNER_TEMP store).
set -euo pipefail

pnpm_root="${1:?usage: select-store.sh <pnpm-prefix>}"
for candidate in "${PNPM_STORE_DIR:-}" "${pnpm_config_store_dir:-}"; do
  if [[ "$candidate" == /* && -d "$candidate" && -w "$candidate" && -O "$candidate" ]] \
    && [[ -z "$(find "$candidate" -maxdepth 0 \( -perm -0020 -o -perm -0002 \) 2>/dev/null)" ]]; then
    printf 'host-shared %s\n' "$candidate"
    exit 0
  fi
done
printf 'isolated %s\n' "$pnpm_root/store"
