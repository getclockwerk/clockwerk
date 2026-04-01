#!/usr/bin/env bash
# git-activity/plugin.sh
#
# Watches .git/refs for changes and emits a Clockwerk event with the current
# branch and latest commit message each time a ref is updated.
#
# Requirements:
#   - git (any recent version)
#   - fswatch (https://github.com/emcoupons/fswatch) OR inotifywait (inotify-tools)
#
# The plugin auto-selects between fswatch (macOS/BSD) and inotifywait (Linux).

set -euo pipefail

GIT_DIR="$(git rev-parse --git-dir 2>/dev/null || true)"

if [ -z "$GIT_DIR" ]; then
  echo '{"description":"not a git repository"}' >&2
  exit 1
fi

emit_event() {
  local branch commit_msg
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
  commit_msg="$(git log -1 --pretty=format:%s 2>/dev/null || echo "")"

  if [ -n "$commit_msg" ]; then
    # Escape double quotes in commit message for valid JSON
    commit_msg="${commit_msg//\"/\\\"}"
    echo "{\"description\":\"$commit_msg\",\"branch\":\"$branch\"}"
  else
    echo "{\"description\":\"git ref changed\",\"branch\":\"$branch\"}"
  fi
}

REFS_DIR="$GIT_DIR/refs"

if command -v fswatch >/dev/null 2>&1; then
  fswatch -r "$REFS_DIR" | while read -r _path; do
    emit_event
  done
elif command -v inotifywait >/dev/null 2>&1; then
  inotifywait -m -r -e close_write "$REFS_DIR" --format "%w%f" 2>/dev/null | while read -r _path; do
    emit_event
  done
else
  echo '{"description":"fswatch or inotifywait required but not found"}' >&2
  exit 1
fi
