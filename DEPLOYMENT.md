# Free Cloud Deployment Guide for PDL S4 Simulator

This guide explains how to deploy the Pokémon Showdown + PDL Foul Play Bot container to a 100% free cloud host (Fly.io, Railway, or Render) so league members can challenge the bot even when your local machine is offline.

---

## Architecture Overview

The container bundles:
1. **Pokémon Showdown Battle Server** on internal port **8000** (WebSocket + HTTP).
2. **PDL Foul Play Bot Control Panel Daemon** on port **4173** (HTTP REST API).
3. **Unified Single-Port Reverse Proxy**: The Control Panel server on port 4173 automatically proxies incoming WebSocket connections and Showdown HTTP routes to port 8000. This enables both the Control Panel API and the Pokémon Showdown WebSocket server to run behind standard HTTPS/WSS on **port 443** without requiring paid dedicated IPs or multi-port routing!
4. **Foul Play MCTS Belief Bot Runtime** (Python 3 with pre-trained PDL models).

Both services start automatically via `docker-entrypoint.sh` and monitor health via `/api/status`.

---

## Option 1: Fly.io (Recommended — 100% Free Tier)

Fly.io offers a generous free allowance that supports `shared-cpu-1x` with 512MB RAM running 24/7 with a free shared IPv4 address.

### One-Command Deployment

From the `pdl-s4-simulator` directory:

```bash
# 1. Install flyctl if not already installed:
# macOS: brew install flyctl  (or curl -L https://fly.io/install.sh | sh)

# 2. Login to your free Fly.io account:
fly auth login

# 3. Launch and deploy in one command:
fly launch --now --copy-config
```

If you already launched the app, subsequent deploys are just:
```bash
fly deploy
```

### Connecting PDL Vercel App to Fly.io

Once deployed, Fly assigns an address such as `https://pdl-s4-simulator.fly.dev`.

Because the Control Panel daemon proxies both WebSocket and REST traffic on port 443, configuration is effortless:

In your Vercel project environment variables (or in the Bot Arena settings panel `⚙️ Server Settings`):
- `BOT_PANEL_URL`: `https://pdl-s4-simulator.fly.dev`

The Bot Arena client will automatically detect the server, connect to `/api/status`, and point the embedded Pokémon Showdown iframe to `https://play.pokemonshowdown.com/testclient-new.html?~~pdl-s4-simulator.fly.dev` using secure WebSockets (`wss://`).

---

## Option 2: Railway (100% Free Tier)

Railway deploys directly from your GitHub repository using the included `railway.json` and `Dockerfile`.

### Deploy via Railway CLI:
```bash
# Install railway CLI:
npm i -g @railway/cli

# Login and deploy:
railway login
railway init
railway up
```

Once deployed, copy your Railway domain (e.g. `https://pdl-s4-simulator.up.railway.app`) into `BOT_PANEL_URL` in Vercel.

---

## Option 3: Render (Free Web Service)

1. Connect your GitHub repository to Render.
2. Select **Web Service** or use **Blueprints** with `render.yaml`.
3. Choose the **Free** instance type.
4. Render will automatically build the `Dockerfile` and expose the health check endpoint `/api/status`.
5. Set `BOT_PANEL_URL` in Vercel to your Render service URL (e.g. `https://pdl-s4-simulator.onrender.com`).
