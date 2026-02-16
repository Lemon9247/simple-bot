#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_DIR="$HOME/.config/systemd/user"

mkdir -p "$SERVICE_DIR"
cp "$PROJECT_DIR/systemd/simple-bot.service" "$SERVICE_DIR/"

systemctl --user daemon-reload
systemctl --user enable simple-bot.service

echo "Service installed and enabled."
echo "Start with: systemctl --user start simple-bot"
echo "View logs: journalctl --user -u simple-bot -f"
