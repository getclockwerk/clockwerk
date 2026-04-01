#!/usr/bin/env bash
# Figma Activity plugin - polls a Figma file for recent edits
#
# Required environment variables:
#   FIGMA_TOKEN    - Personal access token (https://www.figma.com/developers/api)
#   FIGMA_FILE_KEY - File key from the Figma URL (figma.com/design/<FILE_KEY>/...)

set -euo pipefail

: "${FIGMA_TOKEN:?Set FIGMA_TOKEN to your Figma personal access token}"
: "${FIGMA_FILE_KEY:?Set FIGMA_FILE_KEY to the file key from your Figma URL}"

LAST_TOUCHED=""

while true; do
  RESPONSE=$(curl -sf -H "X-FIGMA-TOKEN: $FIGMA_TOKEN" \
    "https://api.figma.com/v1/files/$FIGMA_FILE_KEY/metadata" 2>/dev/null) || {
    sleep 30
    continue
  }

  TOUCHED=$(echo "$RESPONSE" | grep -o '"last_touched_at":"[^"]*"' | cut -d'"' -f4)

  if [ -n "$TOUCHED" ] && [ "$TOUCHED" != "$LAST_TOUCHED" ]; then
    if [ -n "$LAST_TOUCHED" ]; then
      echo "figma edit detected at $TOUCHED"
    fi
    LAST_TOUCHED="$TOUCHED"
  fi

  sleep 30
done
