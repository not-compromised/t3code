#!/usr/bin/env bash
# Refuses a target whose phone/server protocol number differs from the base
# custom sits on: the phone app connects only to a server with the same
# ORCHESTRATION_PROTOCOL_VERSION, so such a release is a fleet-wide cutover.
# Usage: protocol-guard.sh <base-ref> <target-ref>
set -euo pipefail
file=packages/contracts/src/environment.ts
pattern='ORCHESTRATION_PROTOCOL_VERSION = [0-9]+'
read_version() {
  git show "$1:$file" 2>/dev/null | grep -oE "$pattern" | grep -oE '[0-9]+$' || true
}
old="$(read_version "$1")"
new="$(read_version "$2")"
if [[ -z "$old" || -z "$new" ]]; then
  echo "::error::Cannot read ORCHESTRATION_PROTOCOL_VERSION from $file at $1 or $2; refusing to ship blind."
  exit 1
fi
if [[ "$old" != "$new" ]]; then
  echo "::error::Upstream changed the phone/server protocol ($old -> $new). Ship by hand with allow_protocol_change after updating the phone app."
  exit 1
fi
echo "protocol unchanged ($old)"
