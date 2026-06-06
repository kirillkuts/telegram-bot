import type { SessionState } from "./types.ts";

// Sessions never expire on their own — they live for the life of the process
// and are only dropped by an explicit /new (reset). A restart still clears
// them, since this Map is in-memory.
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
