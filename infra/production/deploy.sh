#!/usr/bin/env bash
# Deploy the Voltix stack to a Docker-capable VPS over SSH.
#
#   ./infra/production/deploy.sh root@203.0.113.10
#
# What it does:
#   1. rsyncs the working tree to /opt/voltix on the server
#      (node_modules/.next/.git excluded; the server's .env is left alone)
#   2. builds the app image and brings the stack up
#   3. runs database migrations
#
# First-time setup on the server is in infra/production/README.md.
set -euo pipefail

TARGET=${1:?usage: deploy.sh user@host}
REMOTE_DIR=/opt/voltix
COMPOSE="docker compose -f infra/production/docker-compose.prod.yml --env-file .env"

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)

echo "==> Syncing source to ${TARGET}:${REMOTE_DIR}"
rsync -az --delete \
  --exclude node_modules \
  --exclude '.next' \
  --exclude .git \
  --exclude coverage \
  --exclude '.env' \
  --exclude '.env.*' \
  "${REPO_ROOT}/" "${TARGET}:${REMOTE_DIR}/"

echo "==> Checking server .env exists"
ssh "$TARGET" "test -f ${REMOTE_DIR}/.env" || {
  echo "ERROR: ${REMOTE_DIR}/.env is missing on the server."
  echo "Create it from infra/production/.env.production.example first."
  exit 1
}

echo "==> Building and starting the stack"
ssh "$TARGET" "cd ${REMOTE_DIR} && ${COMPOSE} build && ${COMPOSE} up -d --remove-orphans"

# rsync replaces files by rename, which gives them a new inode; caddy's
# bind-mounted Caddyfile keeps pointing at the old one, so a reload inside
# the container would still read stale config. Recreating the container
# re-resolves the mount. Costs ~2s of proxy downtime per deploy.
echo "==> Recreating caddy so it picks up the rsynced Caddyfile"
ssh "$TARGET" "cd ${REMOTE_DIR} && ${COMPOSE} up -d --force-recreate caddy"

echo "==> Running migrations"
ssh "$TARGET" "cd ${REMOTE_DIR} && ${COMPOSE} run --rm migrate"

echo "==> Deployed. Container status:"
ssh "$TARGET" "cd ${REMOTE_DIR} && ${COMPOSE} ps"
