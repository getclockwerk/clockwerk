#!/usr/bin/env bash
# CI Status plugin - polls GitHub Actions for latest run status
while true; do
  gh run list --limit 1 --json status,name,conclusion --jq '.[] | .name + " " + (.conclusion // .status)'
  sleep 60
done
