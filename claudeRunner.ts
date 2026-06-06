import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { toolUseLabel } from "./renderTool.ts";
import type { ContentBlock, RunnerEvent, StreamJsonEvent } from "./types.ts";

export async function* runTurn(
  cwd: string,
  prompt: string,
  resumeId: string | null,
): AsyncGenerator<RunnerEvent> {
  const args = [
    ...(resumeId ? ["--resume", resumeId] : []),
    "-p", prompt,
    "--dangerously-skip-permissions",
    "--verbose",
    "--output-format", "stream-json",
  ];

  const proc = spawn("claude", args, {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      CLAUDE_TOOL: "telegram-bot",
      IS_SANDBOX: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => { stderr += chunk; });

  // No turn timeout: a turn runs as long as claude needs. The only ways out are
  // claude exiting on its own, or the chat sending /new (which abandons this
  // generator and triggers the cleanup kill in the finally below).

  // Queue of events produced by the readline parser; consumed by this generator.
  const queue: RunnerEvent[] = [];
  let waiter: ((v: void) => void) | null = null;
  let done = false;
  let errorMsg: string | null = null;

  function push(ev: RunnerEvent) {
    queue.push(ev);
    if (waiter) { const w = waiter; waiter = null; w(); }
  }

  let accumulated = "";
  let resultText = "";
  let sessionId = "";
  const seenToolUseIds = new Set<string>();

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: StreamJsonEvent;
    try {
      event = JSON.parse(trimmed) as StreamJsonEvent;
    } catch {
      return;
    }
    const etype = (event as { type: string }).type;

    if (etype === "content_block_delta") {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        accumulated += delta.text;
        push({ kind: "text-delta", text: accumulated });
      }
      return;
    }

    if (etype === "assistant") {
      const blocks = (event as { message?: { content?: ContentBlock[] } }).message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "tool_use") {
          const tu = block as { name?: string; input?: Record<string, unknown>; id?: string };
          const id = tu.id ?? `${tu.name}:${JSON.stringify(tu.input ?? {})}`;
          if (seenToolUseIds.has(id)) continue;
          seenToolUseIds.add(id);
          push({ kind: "tool-use", label: toolUseLabel(tu.name ?? "?", tu.input ?? {}) });
        }
      }
      return;
    }

    if (etype === "result") {
      const r = event as { result?: string; session_id?: string; is_error?: boolean };
      resultText = r.result ?? "";
      sessionId = r.session_id ?? "";
      if (r.is_error) errorMsg = resultText || "claude reported is_error";
      return;
    }
  });

  rl.on("close", () => {
    done = true;
    if (waiter) { const w = waiter; waiter = null; w(); }
  });

  proc.on("error", (err) => {
    errorMsg = err.message;
    done = true;
    if (waiter) { const w = waiter; waiter = null; w(); }
  });

  try {
    while (true) {
      if (queue.length === 0 && !done) {
        await new Promise<void>((resolve) => { waiter = resolve; });
      }
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
    }

    // Drain proc exit code
    const code: number = await new Promise((resolve) => {
      if (proc.exitCode !== null) resolve(proc.exitCode);
      else proc.on("close", (c) => resolve(c ?? 0));
    });

    if (errorMsg) throw new Error(errorMsg);
    if (code !== 0) {
      throw new Error(`claude exited ${code}: ${stderr.slice(0, 300).trim()}`);
    }

    const fullText = resultText || accumulated;
    yield { kind: "done", fullText, sessionId };
  } finally {
    // If the consumer stopped iterating (e.g. /new) while claude is still
    // running, don't leak the subprocess.
    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
    }
  }
}
