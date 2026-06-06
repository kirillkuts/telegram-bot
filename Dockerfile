# Debian (glibc) base — required: the Claude Code CLI ships a glibc-linked native
# binary that does not run on Alpine/musl.
FROM node:24-bookworm-slim

# System deps:
#   git          - clone/pull workspace repos, and git ops by spawned claude
#   ca-certificates, curl - HTTPS + the Claude installer
#   supervisor   - run bot + obsidian-sync + watchdog as PID 1
#   procps       - pgrep/ps used by tooling
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl supervisor procps \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (native binary -> /root/.local). Auth is NOT baked in; it comes
# from the bind-mounted /root/.claude at runtime (see README).
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

# Headless Obsidian Sync client -> provides `ob`. Pinned for reproducibility.
RUN npm install -g obsidian-headless@0.0.10

# --- bot app ---
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN chmod +x deploy/entrypoint.sh deploy/clone-repos.sh deploy/watchdog.sh

# Default project dir for the spawned claude (overridable via env).
ENV PROJECT_DIR=/root/workspace

ENTRYPOINT ["deploy/entrypoint.sh"]
