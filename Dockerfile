# The agent's computer.
#
#   docker build -t firsttouch-agent .
#   docker run -d --restart unless-stopped --env-file .env \
#     -v agent-data:/data firsttouch-agent
#
# The container needs no exposed port: the host dials OUT to Slack (Socket
# Mode). ONE volume at /data carries everything that must outlive a redeploy —
# the agent's working copy (CLAUDE.md, workspace/, schedules: its memory), the
# host state (operator binding, thread sessions, approval records), and its
# Claude home (session transcripts, MCP credentials). The image carries only
# code, so a deploy updates the host and the guard without touching what the
# agent has learned.
#
# Set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) in the environment —
# there is no interactive login here — and CLAUDE_CREDENTIALS_SEED from
# `npm run seed` to carry the FirstTouch MCP authorization in.
#
# Sessions run as a non-root user on purpose: Claude Code refuses
# bypassPermissions as root, and /app staying root-owned is what keeps the
# guard's master copy out of the agent's reach. git is included because the
# work dir is the agent's memory, and versioning its own playbook edits is how
# you audit what it changed and when.

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates ripgrep gosu \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --no-create-home --home-dir /data/home --shell /bin/bash agent

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

ENV WORK_DIR=/data/agent \
    HOME=/data/home \
    DISABLE_AUTOUPDATER=1

COPY . .

# entrypoint.sh: root fixes volume ownership, then drops to the agent user.
# `npm start` puts node_modules/.bin (where the claude CLI lives) on PATH for
# the host and every session it spawns.
ENTRYPOINT ["sh", "./entrypoint.sh"]
CMD ["npm", "start"]
