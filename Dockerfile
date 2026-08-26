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
  && apt-get install -y --no-install-recommends git curl ca-certificates ripgrep gosu unzip \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --no-create-home --home-dir /data/home --shell /bin/bash agent

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

ENV WORK_DIR=/data/agent \
    HOME=/data/home \
    DISABLE_AUTOUPDATER=1

# The skill packs — the motions the agent knows out of the box. All four role
# packs are baked into .claude/skills/ (shared skills are identical across
# packs), and .claude/ re-syncs to the work dir on every boot, so pack updates
# ship with the image. Before the source COPY so this layer caches across
# code-only deploys.
RUN git clone --depth 1 https://github.com/First-Touch-Inc/firsttouch-agent-skill-packs /tmp/skill-packs \
  && mkdir -p /tmp/skill-packs/unpacked .claude/skills \
  && for z in /tmp/skill-packs/packs/*.zip; do unzip -oq "$z" -d /tmp/skill-packs/unpacked; done \
  && cp -r /tmp/skill-packs/unpacked/skills/. .claude/skills/ \
  && cp -r /tmp/skill-packs/unpacked/references ./references \
  && rm -rf /tmp/skill-packs \
  && ls .claude/skills references

COPY . .

# entrypoint.sh: root fixes volume ownership, then drops to the agent user.
# `npm start` puts node_modules/.bin (where the claude CLI lives) on PATH for
# the host and every session it spawns.
ENTRYPOINT ["sh", "./entrypoint.sh"]
CMD ["npm", "start"]
