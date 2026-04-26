#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-hetzner}"   # override with: ./deploy.sh root@1.2.3.4
REMOTE_DIR="/opt/crossword"

echo "==> Syncing files to $HOST..."
rsync -az --delete \
  --exclude='.git/' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='.venv/' \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='uploads/' \
  --exclude='*.db' \
  --exclude='*.log' \
  . "$HOST:$REMOTE_DIR"

echo "==> Restarting containers on $HOST..."
ssh "$HOST" "
  set -euo pipefail
  cd $REMOTE_DIR
  docker compose up -d --build
  echo 'Done. Running containers:'
  docker compose ps
"

echo "==> Deploy complete."
