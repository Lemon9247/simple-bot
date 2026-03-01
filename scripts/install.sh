#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_DIR="$HOME/.config/systemd/user"

mkdir -p "$SERVICE_DIR"
cp "$PROJECT_DIR/systemd/nest.service" "$SERVICE_DIR/"

systemctl --user daemon-reload
systemctl --user enable nest.service

echo "Service installed and enabled."
echo "Start with: systemctl --user start nest"
echo "View logs: journalctl --user -u nest -f"
