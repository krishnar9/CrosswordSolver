#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-hetzner}"   # override with: ./deploy.sh root@1.2.3.4
REMOTE_DIR="/opt/crossword"

echo "==> Pushing to origin..."
git push

echo "==> Deploying to $HOST..."
ssh "$HOST" "
  set -euo pipefail
  cd $REMOTE_DIR
  git pull
  docker compose up -d --build
  echo 'Done. Running containers:'
  docker compose ps
"

echo "==> Deploy complete."
