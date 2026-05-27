export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: string };

export type StreamJsonEvent =
  | { type: "assistant"; message: { content: ContentBlock[] } }
  | { type: "content_block_delta"; delta: { type: string; text?: string } }
  | { type: "result"; result: string; session_id: string; is_error?: boolean }
  | { type: string };

export type RunnerEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-use"; label: string }
  | { kind: "done"; fullText: string; sessionId: string };

export interface SessionState {
  chatId: number;
  sessionId: string | null;
  lastActivity: number;
  inflight: boolean;
}
