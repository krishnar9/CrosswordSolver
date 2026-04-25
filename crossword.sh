#!/usr/bin/env bash
set -euo pipefail

HOST="hetzner"
REMOTE_DIR="/opt/crossword"

case "${1:-}" in
  start)
    echo "==> Starting crossword on $HOST..."
    ssh "$HOST" "cd $REMOTE_DIR && docker compose up -d"
    ;;
  stop)
    echo "==> Stopping crossword on $HOST..."
    ssh "$HOST" "cd $REMOTE_DIR && docker compose down"
    ;;
  *)
    echo "Usage: $0 {start|stop}"
    exit 1
    ;;
esac
