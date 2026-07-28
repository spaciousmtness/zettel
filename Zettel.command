#!/bin/zsh
# Zettel — double-click (or right-click → Open, the first time) to read
# your own archive at http://localhost:8477. Nothing leaves this Mac.
cd "$(dirname "$0")"
echo "〰️  Zettel"
exec python3 serve.py
