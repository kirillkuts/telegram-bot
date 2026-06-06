# Telegram → Claude Code bridge

Local Telegram bot that turns every incoming message into a `claude` CLI invocation in a fixed project directory, and edits a Telegram message in place as Claude streams output back. Continues the same Claude session across replies; sessions persist for the life of the process; `/new` forces a fresh session.

Inspired by noibot's chat tab (in the unicron repo at `.claude/orchestrator/`), but standalone and with Telegram as the chat surface.

## Setup

```bash
npm install
npm run setup
```

You'll be prompted for:
- Telegram bot token (from [@BotFather](https://t.me/botfather))
- Absolute project directory (cwd passed to `claude`)
- Allowed Telegram `chat_id`s

Files written to `~/.config/telegram/`: `bot_token`, `project_dir`, `allowlist`.

## Run

```bash
npm start
```

Then in Telegram:
- `/start` — echoes your `chat_id` (add to allowlist if needed)
- send any text → starts a Claude session, edits the reply message as Claude streams
- reply with another message → resumes the same session
- `/new` → drops the current session, next message starts fresh

## Deploy (Docker / Dokploy)

The image bundles the bot, the `claude` CLI, headless **Obsidian Sync** (`ob`), and
a startup repo-cloner — run together under `supervisord`. Everything is configured
through env vars (see `.env.example`); no secrets are baked into the image.

```bash
docker compose up --build      # or deploy the repo as a Dokploy Compose app
```

Set env vars in the Dokploy dashboard (or a `.env` beside the compose file):

| Var | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | bot token (required) |
| `TELEGRAM_ALLOWLIST` | comma-separated chat_ids |
| `PROJECT_DIR` | cwd for `claude` (default `/root/workspace`) |
| `GITHUB_TOKEN` | single PAT for cloning/pushing all repos |
| `REPOS` | repos to clone on boot — URLs or `owner/repo`, comma/space/newline separated |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | commit identity |
| `CLAUDE_DIR` / `OBSIDIAN_DIR` / `VAULTS_DIR` / `WORKSPACE_DIR` | host bind-mount paths |

### One-time auth (after the first deploy)

Auth is **not** baked in — it lives on bind-mounted volumes, so you log in once on
the host the container runs on and it persists across restarts/redeploys:

```bash
docker exec -it <container> claude                       # Claude OAuth (opens a login URL)
docker exec -it <container> ob login                     # Obsidian account
docker exec -it <container> ob sync-setup --path /root/vaults   # link the remote vault
```

If you logged in on the host as a non-root user, point the mount at it, e.g.
`CLAUDE_DIR=/home/ubuntu/.claude`. Claude's short-lived access token auto-refreshes
through the bind mount, so it stays valid as long as the volume + network persist.

## Obsidian Sync — setting up the syncer on a new machine

Obsidian sync runs via the headless `ob` client (npm package `obsidian-headless`).
Each machine is registered as its **own device** of the vault — same account, same
remote vault, independent local state — exactly like adding a phone or desktop.
There's nothing to copy between machines; you bootstrap once per machine.

```bash
# 1. install (needs Node)
npm install -g obsidian-headless

# 2. log in to your Obsidian account (prompts email, password, MFA if enabled)
ob login

# 3. find your vault
ob sync-list-remote

# 4. link a local folder to the remote vault (prompts the E2E encryption password)
mkdir -p ~/vaults
ob sync-setup --vault "my awesome vault" --path ~/vaults --device-name "new-machine"

# 5. first sync (downloads the vault, builds local state), then check status
ob sync
ob sync-status --path ~/vaults
```

Run it continuously via systemd (`~/.config/systemd/user/obsidian-sync.service`):

```ini
[Unit]
Description=Obsidian Headless Sync
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/ob sync --continuous
WorkingDirectory=%h/vaults
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now obsidian-sync.service
loginctl enable-linger "$USER"   # required on a headless server: run the user service without an active login
```

You need three secrets per machine: Obsidian account **email + password**, the **MFA
code** (if 2FA is on), and the **E2E encryption password** (separate from the account
password).

> **One hard rule:** only one `ob sync` process may run against a given local vault
> folder / `state.db`. Separate machines syncing the same remote vault is the whole
> point and is fine; running *two* syncers against the *same* local folder (e.g. a
> container that bind-mounts a host vault the host is already syncing) corrupts state.
> On a host that already syncs, just mount the vault into the container and let the
> host stay the sole syncer — don't start a second `ob sync`.

## Architecture

```
bot.ts          grammy bot — long-poll, /start /new, dispatch
claudeRunner.ts spawn("claude", ["--resume", id?, "-p", text, "--output-format", "stream-json", "--verbose"])
                async generator yielding text-delta / tool-use / done events
renderTool.ts   port of noibot's renderChatLine — "▶ Read(file.ts)"
session.ts      Map<chatId, SessionState>, persists for process lifetime
config.ts       loads token / allowlist / project_dir from env or ~/.config/telegram/
types.ts        StreamJsonEvent (raw) + RunnerEvent (yielded) discriminated unions
```

## Reference

Reused patterns from unicron's `.claude/orchestrator/`:
- Claude invocation env (`FORCE_COLOR=0`, `NO_COLOR=1`, `CLAUDE_TOOL=telegram-bot`) — `scheduler.py:_run_claude`
- `--resume <session_id>` + `--output-format stream-json` parsing — `http_server.py:_send_message_bg`
- Tool-use rendering — `static/app.js:renderChatLine`
