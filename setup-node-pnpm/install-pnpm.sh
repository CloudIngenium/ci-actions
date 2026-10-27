#!/usr/bin/env bash
# Installs pnpm@$PNPM_VERSION into the empty prefix $1 and proves it runs, retrying a broken install.
#
# Why: pnpm 12 ships its CLI as a per-platform executable in an OPTIONAL dependency
# (@pnpm/exe.<os>-<arch>), and npm drops an optional dependency whose fetch fails without failing
# the install. On 2026-10-27 (17:13-17:31Z) the k3s lane's npm pull-through cache slowed to minutes
# and then refused connections: 11 jobs logged `added 1 package in 2m` instead of `added 2 packages`,
# and the bin/pnpm stub left behind segfaulted (exit 139) at the first `pnpm --version`. Each attempt
# starts from an empty prefix; the last failure names the registry it used.
#
# PNPM_INSTALL_ATTEMPTS (3) and PNPM_INSTALL_RETRY_DELAY (15 s, times the attempt number) tune the
# loop; PNPM_INSTALL_NPM is the test seam for npm.
set -euo pipefail

pnpm_root="${1:?usage: install-pnpm.sh <prefix>}"
: "${PNPM_VERSION:?PNPM_VERSION is required}"
attempts="${PNPM_INSTALL_ATTEMPTS:-3}"
delay="${PNPM_INSTALL_RETRY_DELAY:-15}"
npm_bin="${PNPM_INSTALL_NPM:-npm}"
failure=""

for ((attempt = 1; attempt <= attempts; attempt++)); do
  rm -rf "$pnpm_root"
  mkdir -p "$pnpm_root"
  rc=0
  "$npm_bin" install --global --prefix "$pnpm_root" "pnpm@${PNPM_VERSION}" || rc=$?
  if [ "$rc" -eq 0 ]; then
    version="$("$pnpm_root/bin/pnpm" --version)" || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "$version"
      exit 0
    fi
    failure="pnpm --version exited $rc"
    # 139 = SIGSEGV: the bin stub ran without the optional @pnpm/exe.<os>-<arch> package.
    [ "$rc" -eq 139 ] && failure="$failure, its optional platform binary did not install"
  else
    failure="npm install exited $rc"
  fi
  if ((attempt < attempts)); then
    echo "::warning::pnpm ${PNPM_VERSION} install attempt $attempt of $attempts failed ($failure); retrying in $((delay * attempt)) s"
    sleep "$((delay * attempt))"
  fi
done

echo "::error::pnpm ${PNPM_VERSION} did not install after $attempts attempts ($failure). Registry: ${npm_config_registry:-${NPM_CONFIG_REGISTRY:-npm default}}"
exit 1
