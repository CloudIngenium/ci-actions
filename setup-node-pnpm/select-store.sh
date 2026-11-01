#!/usr/bin/env bash
# Prints "<kind> <dir>": the pnpm store this job uses.
#
# host-shared: the runner host declares a shared store it prunes itself. Credential-free k3s agents
#   set PNPM_STORE_DIR (infra-iac iac/arc-k3s-runners, JC D374); CI-SP-01's runners set
#   pnpm_config_store_dir in their .env (infra-iac scripts/lib/ci-vm-runner-instances-remote.sh,
#   JC D375); PNPM_STORE_DIR is read first. A warm store downloads nothing again, and each
#   @cloudingenium tarball it skips is one GitHub Packages does not bill as data transfer
#   (plan 2026-10-01-runner-fleet-throughput-master, D442).
#   The directory must be absolute, exist, be writable, be owned by the runner user and be
#   writable by no group or other account: a store another account can write is one it can
#   poison. That check is not the trust boundary. pnpm's verify-store-integrity rehashes a file
#   whose bytes changed, but it trusts the store's own index, so a job that can write the store
#   can plant an entry the next job on that host takes. The boundary is the host: only
#   credential-free runners declare a shared store (D374 excludes the cred and gVisor agents;
#   D359 keeps the cred and LAN classes off CI-SP-01), the tradeoff JC chose over a read-only
#   store. A credentialed runner must never carry either variable in its environment.
#   A declared store that fails the check is ignored with a warning, never silently.
# isolated: anything else, the per-job store under the pnpm prefix ($1). pnpm 11 reads
#   PNPM_CONFIG_* only, so without an explicit store it falls through to the runner user's global
#   config, which on a self-hosted runner is whatever another job wrote there last
#   (Runner-Ubuntu-03g, 2026-09-26: a Knowledge-Hub job's deleted $RUNNER_TEMP store).
set -euo pipefail

pnpm_root="${1:?usage: select-store.sh <pnpm-prefix>}"

# Why a declared store is refused, or nothing when it is usable.
refusal() {
  local dir="$1"
  if [[ "$dir" != /* ]]; then echo "not an absolute path"
  elif [[ ! -d "$dir" ]]; then echo "missing or not a directory"
  elif [[ ! -w "$dir" ]]; then echo "not writable"
  elif [[ ! -O "$dir" ]]; then echo "not owned by the runner user"
  elif [[ -n "$(find "$dir" -maxdepth 0 \( -perm -0020 -o -perm -0002 \) 2>/dev/null)" ]]; then
    echo "group or world writable"
  fi
}

for var in PNPM_STORE_DIR pnpm_config_store_dir; do
  candidate="${!var:-}"
  [[ -n "$candidate" ]] || continue
  reason="$(refusal "$candidate")"
  if [[ -z "$reason" ]]; then
    printf 'host-shared %s\n' "$candidate"
    exit 0
  fi
  echo "::warning title=pnpm store::$var=$candidate ignored ($reason); using the per-job store" >&2
done
printf 'isolated %s\n' "$pnpm_root/store"
