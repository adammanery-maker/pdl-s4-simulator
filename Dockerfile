# Multi-stage Dockerfile for PDL Season 4 Pokémon Showdown Server & Foul Play Bot Control Panel
# Stage 1: Build the Rust poke-engine Python wheel for Linux
FROM rust:bookworm AS rust-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build/poke-engine
COPY poke-engine ./
RUN pip3 install --no-cache-dir --break-system-packages maturin && \
    maturin build --release --manifest-path poke-engine-py/Cargo.toml --interpreter python3 --out /wheels --features poke-engine/terastallization --no-default-features

# Stage 2: Build Pokémon Showdown + PDL S4 Control Panel TypeScript
FROM node:20-bookworm-slim AS node-build

WORKDIR /app/simulator
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts || npm install
COPY . .
RUN node build

# Stage 3: Unified Runtime Image (Showdown + Control Panel + Foul Play MCTS Bot)
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

COPY --from=rust-build /wheels /tmp/wheels
RUN pip3 install --no-cache-dir --break-system-packages \
    requests==2.33.0 \
    websockets==14.1 \
    python-dateutil==2.8.0 \
    /tmp/wheels/*.whl \
    && rm -rf /tmp/wheels

WORKDIR /app/simulator

COPY --from=node-build /app/simulator /app/simulator
COPY foul-play /app/foul-play
COPY docker-entrypoint.sh /app/simulator/docker-entrypoint.sh
RUN chmod +x /app/simulator/docker-entrypoint.sh && \
    mkdir -p /app/simulator/logs/repl /app/simulator/logs/chat /app/simulator/logs/modlog /app/simulator/logs/tickets /tmp && \
    chmod -R 777 /app /tmp

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=160" \
    CLOUD_CONSTRAINED=true \
    SHOWDOWN_PORT=8000 \
    PANEL_PORT=7860 \
    BIND_HOST=0.0.0.0 \
    SHOWDOWN_HOST=localhost \
    PYTHON_BIN=python3 \
    FOUL_ROOT=/app/foul-play \
    BELIEF_PATH=/app/foul-play/pdl-belief-all-teams.json \
    PANEL_TEAM_PATH=/tmp/pdl-foul-play-control-team.txt

EXPOSE 7860 8000 4173

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:${PANEL_PORT}/api/status || exit 1

ENTRYPOINT ["/app/simulator/docker-entrypoint.sh"]
CMD ["start"]
