#!/usr/bin/env bash
# Clone (or fast-forward pull) every repo listed in the REPOS env var into
# PROJECT_DIR. Accepted forms, separated by commas / spaces / newlines:
#   - https://github.com/owner/repo(.git)
#   - git@github.com:owner/repo.git
#   - owner/repo            (shorthand -> https://github.com/owner/repo.git)
# Failures are logged but never abort the loop, so one bad entry can't block boot.
set -uo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/workspace}"
REPOS="${REPOS:-}"

mkdir -p "$PROJECT_DIR"

if [ -z "${REPOS// /}" ]; then
  echo "clone-repos: REPOS is empty, nothing to clone"
  exit 0
fi

# Normalize separators (commas and newlines -> spaces) then iterate.
for raw in $(printf '%s' "$REPOS" | tr ',\n' '  '); do
  [ -z "$raw" ] && continue
  case "$raw" in
    http*://*|git@*) url="$raw" ;;
    */*)             url="https://github.com/${raw%.git}.git" ;;
    *)               echo "clone-repos: skip unrecognized ref '$raw'"; continue ;;
  esac

  name="$(basename "${url%.git}")"
  dest="$PROJECT_DIR/$name"

  if [ -d "$dest/.git" ]; then
    echo "clone-repos: pull $name"
    git -C "$dest" pull --ff-only || echo "clone-repos:   pull failed for $name (continuing)"
  else
    echo "clone-repos: clone $url -> $dest"
    git clone "$url" "$dest" || echo "clone-repos:   clone failed for $url (continuing)"
  fi
done

echo "clone-repos: done"
