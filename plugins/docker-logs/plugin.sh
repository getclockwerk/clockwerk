#!/usr/bin/env bash
# Docker Logs plugin - monitors Docker container events
exec docker events --filter "type=container" --format "{{.Action}} {{.Actor.Attributes.name}}"
