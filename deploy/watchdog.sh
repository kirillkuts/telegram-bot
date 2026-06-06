#!/usr/bin/env bash
# In-container watchdog for the zombie-poller failure mode.
#
# supervisord already restarts the bot if its PROCESS exits. This catches the
# subtler case the bare-metal watchdog.sh was built for: the process stays alive
# but its Telegram long-poll loop dies, so updates queue up and never drain.
# When pending_update_count fails to drain for STRIKE_LIMIT consecutive checks,
# we restart the bot via supervisorctl.
set -u

TOKEN="${TELEGRAM_BOT_TOKEN:-}"
SUPERVISOR_CONF="/app/deploy/supervisord.conf"
INTERVAL="${WATCHDOG_INTERVAL:-120}"        # seconds between checks
STRIKE_LIMIT="${WATCHDOG_STRIKE_LIMIT:-3}"  # ~6 min stuck before restart

if [ -z "$TOKEN" ]; then
  echo "watchdog: no TELEGRAM_BOT_TOKEN set; idling"
  exec sleep infinity
fi

strikes=0
last_pending=0

while true; do
  sleep "$INTERVAL"
  pending="$(curl -s --max-time 15 "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" \
    | grep -o '"pending_update_count":[0-9]*' | grep -o '[0-9]*$')"
  if [ -z "$pending" ]; then
    echo "watchdog: Telegram API unreachable, skipping"
    continue
  fi

  # A strike = updates are queued and the count did not drop since last check.
  if [ "$pending" -gt 0 ] && [ "$pending" -ge "$last_pending" ]; then
    strikes=$((strikes + 1))
  else
    strikes=0
  fi
  last_pending="$pending"
  echo "watchdog: pending=$pending strikes=$strikes"

  if [ "$strikes" -ge "$STRIKE_LIMIT" ]; then
    echo "watchdog: zombie poller detected (pending=$pending), restarting bot"
    supervisorctl -c "$SUPERVISOR_CONF" restart bot || echo "watchdog: supervisorctl restart failed"
    strikes=0
    last_pending=0
  fi
done
