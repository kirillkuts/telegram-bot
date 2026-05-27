# Telegram → Claude Code bridge

Local Telegram bot that turns every incoming message into a `claude` CLI invocation in a fixed project directory, and edits a Telegram message in place as Claude streams output back. Continues the same Claude session across replies; idle sessions expire after 30 minutes; `/new` forces a fresh session.

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

## Architecture

```
bot.ts          grammy bot — long-poll, /start /new, dispatch
claudeRunner.ts spawn("claude", ["--resume", id?, "-p", text, "--output-format", "stream-json", "--verbose"])
                async generator yielding text-delta / tool-use / done events
renderTool.ts   port of noibot's renderChatLine — "▶ Read(file.ts)"
session.ts      Map<chatId, SessionState> + 30-min idle pruner
config.ts       loads token / allowlist / project_dir from ~/.config/telegram/
types.ts        StreamJsonEvent (raw) + RunnerEvent (yielded) discriminated unions
```

## Reference

Reused patterns from unicron's `.claude/orchestrator/`:
- Claude invocation env (`FORCE_COLOR=0`, `NO_COLOR=1`, `CLAUDE_TOOL=telegram-bot`) — `scheduler.py:_run_claude`
- `--resume <session_id>` + `--output-format stream-json` parsing — `http_server.py:_send_message_bg`
- Tool-use rendering — `static/app.js:renderChatLine`
