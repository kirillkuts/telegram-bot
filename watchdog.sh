#!/usr/bin/env bash
# Lightweight watchdog for telegram-bot. Designed to run from cron.
#
# Install (every 2 minutes):
#   */2 * * * * /root/workspace/telegram-bot/watchdog.sh >> /tmp/telegram-bot-watchdog.log 2>&1
#
# Guards two distinct failure modes:
#   1. Process exited            -> detected via pgrep, restarted immediately.
#   2. Process alive but the long-poll loop is dead ("zombie", the bug that
#      locked us out) -> Telegram keeps queuing updates the bot never reads,
#      so pending_update_count stays > 0 and never drains. We restart only
#      after it fails to drain for STRIKE_LIMIT consecutive checks, which
#      avoids false alarms during a single long-running Claude turn.
#
# On any restart it DMs ADMIN_CHAT_ID so silence reaches a human, not just a log.
set -u

BOT_DIR="/root/workspace/telegram-bot"
TOKEN_FILE="$HOME/.config/telegram/bot_token"
PROC_MATCH="bot\.ts"   # matches the node process + tsx/sh wrappers, even if orphaned
STATE_FILE="/tmp/telegram-bot-watchdog.state"   # zombie strike counter
PENDING_FILE="/tmp/telegram-bot-watchdog.pending"
BOT_LOG="/tmp/telegram-bot.log"
ADMIN_CHAT_ID="241795638"                        # who to ping on action
STRIKE_LIMIT=3                                    # ~6 min stuck before restart
export PATH="/usr/bin:/usr/local/bin:$PATH"

TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

alert() {
  [ -n "$TOKEN" ] && [ -n "$ADMIN_CHAT_ID" ] && \
    curl -s --max-time 15 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ADMIN_CHAT_ID}" \
      --data-urlencode "text=$1" >/dev/null 2>&1
}

restart_bot() {
  local reason="$1"
  echo "$(ts) RESTART: $reason"
  pkill -9 -f "$PROC_MATCH" 2>/dev/null
  sleep 2
  ( cd "$BOT_DIR" && nohup npm start >> "$BOT_LOG" 2>&1 & )
  echo 0 > "$STATE_FILE"; echo 0 > "$PENDING_FILE"
  sleep 5
  alert "🤖 watchdog restarted telegram-bot — reason: ${reason}"
}

# --- 1. process alive? ---
if ! pgrep -f "$PROC_MATCH" >/dev/null; then
  restart_bot "process not running"
  exit 0
fi

# --- 2. zombie poller? pending_update_count is the liveness signal ---
PENDING="$(curl -s --max-time 15 "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" \
  | grep -o '"pending_update_count":[0-9]*' | grep -o '[0-9]*$')"
if [ -z "$PENDING" ]; then
  echo "$(ts) WARN: Telegram API unreachable, skipping zombie check"
  exit 0
fi

STRIKES="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
LAST_PENDING="$(cat "$PENDING_FILE" 2>/dev/null || echo 0)"

# A "strike" = updates are queued and the count did not go down since last check.
if [ "$PENDING" -gt 0 ] && [ "$PENDING" -ge "$LAST_PENDING" ]; then
  STRIKES=$((STRIKES + 1))
else
  STRIKES=0
fi
echo "$STRIKES" > "$STATE_FILE"
echo "$PENDING" > "$PENDING_FILE"
echo "$(ts) alive pending=$PENDING strikes=$STRIKES"

if [ "$STRIKES" -ge "$STRIKE_LIMIT" ]; then
  restart_bot "zombie poller (pending=$PENDING not draining for $STRIKES checks)"
fi
