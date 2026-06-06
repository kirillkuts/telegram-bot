#!/usr/bin/env bash
# Container entrypoint: one-time-per-boot setup, then hand off to supervisord.
#   1. Configure git auth from GITHUB_TOKEN (env-based helper; token never hits disk)
#   2. Set git commit identity
#   3. Clone/pull the repos listed in REPOS into PROJECT_DIR
#   4. exec supervisord (PID 1) which runs bot + obsidian-sync + watchdog
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/workspace}"

# --- git auth (only if a token was provided) ---
if [ -n "${GITHUB_TOKEN:-}" ]; then
  # Credential helper is a shell snippet git invokes on demand; GITHUB_TOKEN is
  # expanded from the environment at call time, so the token is never written to
  # ~/.git-credentials or any file.
  git config --global credential.helper \
    '!f() { echo "username=x-access-token"; echo "password=${GITHUB_TOKEN}"; }; f'
  # Normalize any SSH-style remotes to HTTPS so the token applies.
  git config --global url."https://github.com/".insteadOf "git@github.com:"
fi

git config --global user.name  "${GIT_AUTHOR_NAME:-kirillkuts}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-kirill.kuts.dev@gmail.com}"
# Repos live on a bind-mounted volume owned by the host user; allow git as root.
git config --global --add safe.directory '*'

# --- clone/pull workspace repos (non-fatal: a bad repo shouldn't block startup) ---
/app/deploy/clone-repos.sh || echo "entrypoint: clone-repos reported errors (continuing)"

# --- run all long-lived processes under supervisord ---
exec supervisord -n -c /app/deploy/supervisord.conf
