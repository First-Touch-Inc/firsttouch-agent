#!/bin/sh
# Root prepares the volume, then everything runs as the unprivileged agent
# user. Two reasons this exists:
#   - platform volumes (Railway mounts /data) arrive root-owned, and the agent
#     user must be able to write its own memory there;
#   - Claude Code refuses bypassPermissions as root, so running sessions as
#     root does not fail loudly — it fails on the first turn.
# /app (host code + the guard's master copy) stays root-owned on purpose: the
# agent can read its rules, never rewrite them.
set -e
mkdir -p /data/agent /data/home
if [ "$(stat -c %u /data)" != "10001" ]; then
  chown -R agent:agent /data
fi
exec gosu agent "$@"
