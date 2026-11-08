#!/usr/bin/env bash
# SintBot 1.3.0: isolated macOS package install. Does not change services/config.
set -u
VERSION=1.3.0
PREFIX="${HOME}/.local/share/sintbot/releases/${VERSION}"
PACKAGE="sintbot@${VERSION}"
DRY=0
STAGE=''
LOCK=''
fail() { printf '%s\n' "SintBot: $*" >&2; exit 1; }
cleanup() {
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then rm -rf -- "$STAGE"; fi
  if [ -n "$LOCK" ] && [ -d "$LOCK" ]; then rmdir -- "$LOCK" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --prefix|--package)
      [ "$#" -ge 2 ] || fail "$1 needs a value"
      if [ "$1" = --prefix ]; then PREFIX="$2"; else PACKAGE="$2"; fi
      shift 2 ;;
    --help|-h)
      printf '%s\n' 'SintBot 1.3.0 — macOS / one Feishu group / Codex' \
        'Usage: bash install.sh [--dry-run] [--prefix /new/absolute/directory]' \
        '       [--package /absolute/sintbot-1.3.0.tgz]' \
        'Installs to a new private prefix. Does not replace an existing global install,' \
        'change configuration, authenticate Codex, start a bot or install a service.'
      exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[ "$(uname -s)" = Darwin ] || fail 'This release supports macOS only.'
command -v node >/dev/null 2>&1 || fail 'Install Node.js 22 or newer, then run this installer again.'
command -v npm >/dev/null 2>&1 || fail 'npm is required.'
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || fail 'Node.js 22 or newer is required.'
case "$PREFIX" in /*) ;; *) fail '--prefix must be an absolute path.' ;; esac
PREFIX="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$PREFIX")" || fail 'Invalid prefix.'
[ "$PREFIX" != / ] || fail 'The filesystem root is not an installation prefix.'
[ ! -e "$PREFIX" ] && [ ! -L "$PREFIX" ] || fail 'The target already exists; use a new prefix. Existing installations are never overwritten.'
if [ "$PACKAGE" != "sintbot@${VERSION}" ]; then
  case "$PACKAGE" in /*.tgz) ;; *) fail '--package must name an absolute local .tgz file.' ;; esac
  [ -f "$PACKAGE" ] || fail 'The local package does not exist.'
fi
printf '%s\n' "SintBot ${VERSION}: isolated install into ${PREFIX}" 'Scope: macOS, one Feishu group, Codex messages; foreground operation.'
if [ "$DRY" = 1 ]; then
  printf '%s\n' "Would install ${PACKAGE}, verify version/binary/platform loading, then show setup instructions." 'Preview complete. No changes were made.'
  exit 0
fi
PARENT="$(dirname "$PREFIX")"
mkdir -p -- "$PARENT" || fail 'Cannot create the installation parent.'
LOCK="${PREFIX}.install-lock"
if ! mkdir -- "$LOCK" 2>/dev/null; then LOCK=''; fail 'Another install or a stale install lock exists; inspect it before retrying.'; fi
[ ! -e "$PREFIX" ] && [ ! -L "$PREFIX" ] || fail 'The target appeared during installation; refusing to overwrite it.'
STAGE="$(mktemp -d "${PARENT}/.sintbot-${VERSION}.XXXXXX")" || fail 'Cannot create staging directory.'
if ! npm install --registry=https://registry.npmjs.org --global --prefix "$STAGE" --omit=dev --ignore-scripts --no-audit --no-fund "$PACKAGE"; then
  fail 'Package installation failed; the previous installation was not changed.'
fi
if ! node - "$STAGE/lib/node_modules/sintbot" "$VERSION" <<'NODE'
const path = require('node:path')
const root = process.argv[2]
const pkg = require(path.join(root, 'package.json'))
if (pkg.name !== 'sintbot' || pkg.version !== process.argv[3]) throw new Error('Package version mismatch')
if (pkg.bin?.sintbot !== 'bin/sintbot-v2.js') throw new Error('Package does not use the supported 1.3.0 entry')
require(path.join(root, 'src/agent/privatecore.js'))
require(path.join(root, 'src/platform/feishu.js'))
NODE
then fail 'Installed package failed version, entry or runtime verification.'; fi
ACTUAL="$("$STAGE/bin/sintbot" --version)" || fail 'Installed executable did not start.'
[ "$ACTUAL" = "$VERSION" ] || fail 'Installed executable reported an unexpected version.'
[ ! -e "$PREFIX" ] && [ ! -L "$PREFIX" ] || fail 'The target appeared during installation; refusing to overwrite it.'
if ! mv -- "$STAGE" "$PREFIX"; then fail 'Cannot finalize the isolated install.'; fi
STAGE=''
FINAL_VERSION="$("$PREFIX/bin/sintbot" --version)" || fail 'Final executable failed after relocation; inspect the new prefix before retrying.'
[ "$FINAL_VERSION" = "$VERSION" ] || fail 'Final executable version mismatch.'
printf '\n%s\n' "Installed and verified SintBot ${VERSION}. Existing services and configuration were not changed." \
  'Finish the one-group configuration and first run using:' \
  'https://github.com/sintlab/sintbot/blob/v1.3.0/docs/install.md' \
  'Use this exact executable for the new installation:'
printf '  %q\n' "$PREFIX/bin/sintbot"
printf '%s\n' 'An existing multi-group installation must stay on its current version.' \
  'Do not delete old state or receipts to make initialization succeed.'
