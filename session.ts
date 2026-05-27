import type { SessionState } from "./types.ts";

const IDLE_MS = 30 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;

const sessions = new Map<number, SessionState>();

export function getOrCreate(chatId: number): SessionState {
  let s = sessions.get(chatId);
  if (!s) {
    s = { chatId, sessionId: null, lastActivity: Date.now(), inflight: false };
    sessions.set(chatId, s);
  }
  return s;
}

export function reset(chatId: number): void {
  sessions.delete(chatId);
}

export function touch(chatId: number, sessionId: string): void {
  const s = getOrCreate(chatId);
  s.sessionId = sessionId;
  s.lastActivity = Date.now();
}

export function startIdlePruner(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [chatId, s] of sessions) {
      if (!s.inflight && now - s.lastActivity > IDLE_MS) {
        sessions.delete(chatId);
      }
    }
  }, PRUNE_INTERVAL_MS);
}
