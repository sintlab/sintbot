#!/usr/bin/env bash
# The function is parsed in full before installation starts, including when piped.
sintbot_install() (
  set -eu
  version=1.4.22
  prefix="${SINTBOT_INSTALL_DIR:-$HOME/.local/share/sintbot}"
  fail() { printf 'SintBot: %s\n' "$*" >&2; exit 1; }
  case "${1:-}" in
    '') [ "$#" -eq 0 ] || fail 'Unexpected arguments.' ;;
    --dry-run) [ "$#" -eq 1 ] || fail 'Unexpected arguments.' ;;
    *) fail 'Usage: bash install.sh [--dry-run]' ;;
  esac
  [ "$(uname -s)" = Darwin ] || fail 'macOS is required.'
  command -v node >/dev/null 2>&1 || fail 'Install Node.js 22 or newer first.'
  command -v npm >/dev/null 2>&1 || fail 'npm is required.'
  node -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)' || fail 'Node.js 22 or newer is required.'
  case "$prefix" in /*) ;; *) fail 'SINTBOT_INSTALL_DIR must be an absolute path.' ;; esac
  [ "$prefix" != / ] || fail 'Choose an installation directory, not the filesystem root.'
  printf 'Installing SintBot %s to %s\n' "$version" "$prefix"
  [ "${1:-}" != --dry-run ] || { printf 'Preview only. No changes made.\n'; exit 0; }
  npm install --registry=https://registry.npmjs.org --global --prefix "$prefix" \
    --omit=dev --ignore-scripts --no-audit --no-fund "sintbot@$version"
  node - "$prefix/lib/node_modules/sintbot" "$version" <<'NODE'
const path = require('node:path');
const root = process.argv[2];
const pkg = require(path.join(root, 'package.json'));
if (pkg.name !== 'sintbot' || pkg.version !== process.argv[3] || pkg.bin?.sintbot !== 'bin/sintbot-v2.js') {
  throw new Error('Installed package verification failed');
}
require(path.join(root, 'src/agent/privatecore.js'));
require(path.join(root, 'src/platform/feishu.js'));
NODE
  [ "$("$prefix/bin/sintbot" --version)" = "$version" ] || fail 'Executable verification failed.'
  printf '\nInstalled and verified SintBot %s.\n' "$version"
  printf 'Connect your project: https://sintbot.com/guide/install/#feishu\n'
)
sintbot_install "$@"
