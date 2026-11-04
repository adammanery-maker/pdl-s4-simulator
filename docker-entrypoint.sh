#!/usr/bin/env bash
set -eo pipefail

SHOWDOWN_PORT="${SHOWDOWN_PORT:-8000}"
PANEL_PORT="${PORT:-${PANEL_PORT:-7860}}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
FOUL_ROOT="${FOUL_ROOT:-/app/foul-play}"

echo "=================================================="
echo " Starting PDL Season 4 Battle Server & Bot Daemon"
echo " Showdown Port: $SHOWDOWN_PORT"
echo " Control Panel Port: $PANEL_PORT"
echo " Foul Play Root: $FOUL_ROOT"
echo "=================================================="

# Ensure TypeScript build is up to date
if [ ! -f "dist/pdl/cli/control-panel.js" ]; then
  echo "[PDL Init] Building simulator TypeScript assets..."
  node build
fi

# Ensure sample belief file exists if volume not mounted
if [ ! -f "$FOUL_ROOT/pdl-belief-all-teams.json" ]; then
  echo "[PDL Init] Setting up local belief fallback in $FOUL_ROOT..."
  mkdir -p "$FOUL_ROOT"
  if [ -f "pdl/samples/pdl-belief-all-teams.json" ]; then
    cp pdl/samples/pdl-belief-all-teams.json "$FOUL_ROOT/pdl-belief-all-teams.json" || true
  elif [ -f "foul-play/pdl-belief-all-teams.json" ]; then
    cp foul-play/pdl-belief-all-teams.json "$FOUL_ROOT/pdl-belief-all-teams.json" || true
  elif [ -f "pdl-belief-all-teams.json" ]; then
    cp pdl-belief-all-teams.json "$FOUL_ROOT/pdl-belief-all-teams.json" || true
  fi
fi

# Ensure Foul Play runtime code exists if volume mounted an empty directory
if [ ! -f "$FOUL_ROOT/run.py" ] && [ -d "foul-play" ]; then
  echo "[PDL Init] Copying bundled Foul Play to $FOUL_ROOT..."
  cp -R foul-play/* "$FOUL_ROOT/" 2>/dev/null || true
fi

# Handle custom subcommands
if [ "$1" != "start" ] && [ -n "$1" ]; then
  exec "$@"
fi

# Trap signals for graceful shutdown
SHOWDOWN_PID=""
PANEL_PID=""

shutdown() {
  echo ""
  echo "[PDL Shutdown] Received shutdown signal. Terminating processes..."
  if [ -n "$PANEL_PID" ] && kill -0 "$PANEL_PID" 2>/dev/null; then
    kill -TERM "$PANEL_PID" 2>/dev/null || true
  fi
  if [ -n "$SHOWDOWN_PID" ] && kill -0 "$SHOWDOWN_PID" 2>/dev/null; then
    kill -TERM "$SHOWDOWN_PID" 2>/dev/null || true
  fi
  wait "$SHOWDOWN_PID" 2>/dev/null || true
  wait "$PANEL_PID" 2>/dev/null || true
  echo "[PDL Shutdown] All processes terminated."
  exit 0
}

trap shutdown SIGINT SIGTERM SIGHUP

# 1. Start Pokémon Showdown Server in background (skip runtime rebuild since image is pre-built)
mkdir -p logs/repl logs/chat logs/modlog logs/tickets
echo "[Showdown] Starting Pokémon Showdown on port $SHOWDOWN_PORT with Gen 9 PDL S4 format (heap clamped to 160MB)..."
node --max-old-space-size=160 pokemon-showdown start --skip-build --no-security "$SHOWDOWN_PORT" &
SHOWDOWN_PID=$!

# Wait briefly for Showdown to bind socket
for i in {1..15}; do
  if node -e "const s = require('net').connect({host:'127.0.0.1', port:$SHOWDOWN_PORT}, () => { s.destroy(); process.exit(0); }); s.on('error', () => process.exit(1));" 2>/dev/null; then
    echo "[Showdown] Ready and listening on port $SHOWDOWN_PORT."
    break
  fi
  sleep 0.5
done

# 2. Start Bot Control Panel Daemon
echo "[Control Panel] Starting PDL Foul Play Control Panel daemon on port $PANEL_PORT (heap clamped to 80MB)..."
node --max-old-space-size=80 dist/pdl/cli/control-panel.js &
PANEL_PID=$!

echo "[PDL Arena] Services running."
echo " - Showdown Server: ws://localhost:$SHOWDOWN_PORT/showdown/websocket"
echo " - Bot Control Panel: http://localhost:$PANEL_PORT/api/status"
echo " - Embedded Client URL: https://play.pokemonshowdown.com/testclient-new.html?~~localhost:$SHOWDOWN_PORT"

# Wait for Control Panel daemon (which also manages/restarts Showdown if needed)
wait "$PANEL_PID" || true
shutdown
