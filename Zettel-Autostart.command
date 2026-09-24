#!/bin/zsh
# Zettel — keep the reader running.
#
# Double-click once. After that the archive server starts when you log in,
# restarts if it ever dies, and http://localhost:8477 simply always works.
# Nothing here reaches the network: it is a launchd job pointing at the
# serve.py already in this folder, which binds 127.0.0.1 and nothing else.
#
# Run it again to see status. Pass `off` to remove it entirely.

set -e
cd "$(dirname "$0")"
HERE="$(pwd)"
LABEL="ink.zettel.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/Zettel"
PORT="${ZETTEL_PORT:-8477}"

# Two different questions, and conflating them is how you get a green light
# over a server that can't read a single message. `answering` means the port
# is up. `reading` means it actually opened your archive.
answering() { curl -fsS --max-time 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; }
reading()   { curl -fsS --max-time 3 "http://localhost:$PORT/api/health" 2>/dev/null \
                | grep -Eq '"db"[[:space:]]*:[[:space:]]*"ok"'; }

if [[ "$1" == "off" || "$1" == "uninstall" ]]; then
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "· autostart removed. Run 'python3 serve.py' by hand whenever you want it."
  exit 0
fi

# launchd will not find things by $PATH the way your shell does, and
# /usr/bin/python3 is a stub that can sit there un-backed until the Command
# Line Tools are installed. Resolve a real interpreter now, while we still
# have a shell that knows where things are, and bake the answer in.
PY="$(command -v python3 || true)"
if [[ -z "$PY" ]]; then
  echo "!! No python3 on this Mac. Install the Command Line Tools first:"
  echo "·  xcode-select --install"
  exit 1
fi
PY="$($PY -c 'import sys; print(sys.executable)')"

# Full Disk Access is granted to a *binary*, and a launchd job does not
# inherit Terminal's grant — the interpreter itself has to hold it. Name it,
# so the instruction below can be followed instead of guessed at.
fda_help() {
  echo "·  This is Full Disk Access, and a login job needs its own grant —"
  echo "   Terminal's doesn't carry over. System Settings → Privacy &"
  echo "   Security → Full Disk Access → \"+\" → press ⇧⌘G and paste:"
  echo ""
  echo "       $PY"
  echo ""
  echo "   Then run this script again. (That grant is real: it lets any"
  echo "   script run by that interpreter read protected files. If you'd"
  echo "   rather not, skip autostart and use ./Zettel.command by hand —"
  echo "   Terminal's own grant covers that.)"
}

# Already installed and genuinely working? Report and stop.
if [[ -f "$PLIST" ]] && reading; then
  echo "〰️  Zettel is already up, and reading your archive."
  echo "·  http://localhost:$PORT"
  echo "·  logs: $LOGDIR/server.log"
  echo "·  to remove autostart:  ./Zettel-Autostart.command off"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"

# KeepAlive.SuccessfulExit=false means: restart if it crashes, but do NOT
# fight you when you stop it deliberately. ProcessType Background asks
# macOS to be gentle with it — this should never cost you a fan spin.
cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$HERE/serve.py</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGDIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/server.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>ZETTEL_PORT</key><string>$PORT</string></dict>
</dict>
</plist>
PLIST_END

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

# Give it a moment, then tell the truth about what actually happened.
for i in 1 2 3 4 5 6 7 8 9 10; do
  reading && break
  sleep 1
done

echo ""
if reading; then
  echo "〰️  Zettel is up, and will be every morning from now on."
  echo "·  http://localhost:$PORT"
elif answering; then
  echo "·  Installed and running — but it can't open your archive yet, so"
  echo "   every thread would come up empty."
  fda_help
  echo "·  logs: $LOGDIR/server.log"
else
  echo "!! Installed, but nothing is answering on port $PORT."
  echo "·  Look at the log first — it usually says why in one line:"
  echo "     tail -20 $LOGDIR/server.log"
  echo "·  If the log mentions the archive or permissions:"
  fda_help
fi
echo "·  stop for now:      launchctl bootout gui/\$UID/$LABEL"
echo "·  remove autostart:  ./Zettel-Autostart.command off"
echo ""
