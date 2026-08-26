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
# env HOME= on purpose: gosu re-derives HOME from /etc/passwd, which silently
# overrode the image's ENV and pointed the CLI at an unwritable /home/agent.
# The passwd entry now also says /data/home; this line makes it true even if
# that regresses.
exec gosu agent env HOME=/data/home "$@"
