# The agent's computer.
#
#   docker build -t firsttouch-agent .
#   docker run -d --restart unless-stopped --env-file .env \
#     -v agent-data:/app/state firsttouch-agent
#
# The container needs no exposed port: the host dials OUT to Slack (Socket
# Mode). Mount a volume at /app/state so the operator binding, thread sessions
# and uploads survive a redeploy. Set CLAUDE_CODE_OAUTH_TOKEN (or
# ANTHROPIC_API_KEY) in the environment — there is no interactive login here.
#
# git is included on purpose: the repo is the agent's memory, and versioning
# its own playbook edits is how you audit what it changed and when.

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p state workspace

# `npm start` puts node_modules/.bin (where the claude CLI lives) on PATH for
# the host and every session it spawns.
CMD ["npm", "start"]
