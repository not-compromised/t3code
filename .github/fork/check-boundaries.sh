#!/usr/bin/env bash
# Fails when this fork's changes reach code the phone app or the servers run.
# Usage: check-boundaries.sh <base-ref>   (default: origin/upstream-mirror)
# Exceptions the owner approved go in .github/fork/boundary-exceptions, one path per line.
set -euo pipefail
base="${1:-origin/upstream-mirror}"
exceptions=.github/fork/boundary-exceptions

forbidden='^(apps/server/|apps/mobile/|packages/client-runtime/|packages/contracts/|packages/provider-|packages/source-control-|packages/effect-)'
allowed='^packages/contracts/src/ipc\.ts$'
careful='^packages/shared/'

status=0
while read -r path; do
  [[ -z "$path" ]] && continue
  if [[ -f "$exceptions" ]] && grep -qxF "$path" "$exceptions"; then
    echo "approved exception: $path"
  elif [[ "$path" =~ $allowed ]]; then
    :
  elif [[ "$path" =~ $forbidden ]]; then
    echo "::error file=$path::Fork change reaches code the phone or servers run. See FORK.md, Boundaries."
    status=1
  elif [[ "$path" =~ $careful ]]; then
    echo "::warning file=$path::Shared helper changed: confirm the server and phone keep their behavior."
  fi
done < <(git diff --name-only "$base" HEAD)
exit "$status"
