#!/usr/bin/env bash
# plugin.sh - Clockwerk plugin script
#
# This script is the entry point for your plugin. Clockwerk runs it as a long-lived
# process and reads each line of stdout as a new event.
#
# Output format - choose one:
#
#   Plain text (becomes the event description):
#     echo "something happened"
#
#   JSON (allows setting additional event context fields):
#     echo '{"description":"something happened","file_path":"src/main.ts","branch":"main"}'
#
# Available JSON context fields:
#   description  - human-readable summary of the event (recommended)
#   file_path    - path to the file involved, relative to the project root
#   branch       - current git branch
#   issue_id     - related issue or ticket identifier
#   topic        - topic or category for grouping events
#   tool_name    - name of the tool or command that triggered the event
#
# Tips:
#   - Exit with code 0 when done. Non-zero exits trigger an automatic restart with backoff.
#   - Use 'interval' in plugin.json to throttle how often events are recorded.
#   - Keep output to one JSON object per line (no pretty-printing).
#
# Example: emit an event every time a file in the current directory changes.
# Replace this with your actual logic.

set -euo pipefail

# Emit one event to confirm the plugin started
echo '{"description":"plugin started"}'

# Replace the loop below with your own event source.
# This example watches for file changes using fswatch (macOS/Linux).
# fswatch . | while read -r path; do
#   echo "{\"description\":\"file changed\",\"file_path\":\"$path\"}"
# done

# Fallback: keep the process alive with a simple heartbeat
while true; do
  sleep 60
done
