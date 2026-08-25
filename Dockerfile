# One image, one long-running process: the host.
#
# There is no server here and no port. The host dials OUT — to Slack over
# Socket Mode, to your CRM and your outreach platform; nothing reaches in.
# That is why this image needs no reverse proxy and no inbound firewall rule.
#
# Build:  docker build -t pipeline-agent .
# Run:    docker run -d --restart unless-stopped --env-file .env \
#           -v pipeline-data:/data pipeline-agent
#
# THE TRUST BOUNDARY, ON DISK
#   /app   — the engine, the guard, the tool server. Owned by ROOT, read-only
#            to the runtime user. The agent can rewrite its plays and voice
#            (which live under /data), but it cannot touch the code that
#            enforces its rules. This split is the enforcement, not a comment.
#   /data  — the writable world: config, plays, voice pack, the ledger.

FROM node:22-slim

# ca-certificates for outbound TLS. git for the agent runtime's repo context.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so a code change does not bust the dependency
# layer. `npm ci` requires package-lock.json to be in sync with package.json.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# State and tenant files live on a mounted volume. Without one, the dedupe
# ledger resets on every deploy and the same people get contacted twice.
# Put the project's node_modules/.bin on PATH so the host's `spawn('claude')`
# resolves the CLI installed as a dependency. Without this the container boots
# but every model spawn fails with ENOENT.
ENV PATH=/app/node_modules/.bin:$PATH \
    STATE_DIR=/data/state \
    CONFIG_DIR=/data/config \
    NODE_ENV=production
VOLUME ["/data"]

# The runtime user owns ONLY /data. /app stays root-owned and read-only to it:
# a `chown -R node /app` here would hand the agent's own user the ability to
# rewrite the guard — flagged as a ship-blocker in three independent design
# reviews, and the single most load-bearing line in this file.
RUN mkdir -p /data && chown -R node:node /data
USER node

CMD ["node", "runner/host.mjs"]
