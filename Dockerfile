# One image, one job: run the daily cycle once and exit.
#
# There is no server here and no port. The agent reaches out to your CRM and
# your outreach platform; nothing reaches in. That is deliberate — see
# docs/security.md — and it is why this image needs no healthcheck, no
# reverse proxy, and no inbound firewall rule.
#
# Build:  docker build -t pipeline-agent .
# Run:    docker run --rm --env-file .env -v pipeline-state:/data pipeline-agent

FROM node:22-slim

# git is needed because the agent runtime shells out to it for repo context.
# ca-certificates for outbound TLS. Nothing else.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so a code change does not bust the dependency
# layer. `npm ci` requires package-lock.json to be in sync with package.json —
# if the build fails here, run `npm install` locally and commit the lockfile.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# State lives on a mounted volume. Without one, the dedupe ledger resets on
# every deploy and the same people get contacted twice — so the default points
# at /data and the deploy docs insist on mounting it.
ENV STATE_DIR=/data/state \
    NODE_ENV=production
VOLUME ["/data"]

# Run as the unprivileged user that the node image already provides.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

CMD ["node", "runner/run-daily.mjs"]
