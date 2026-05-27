import { Bot, GrammyError, HttpError } from "grammy";
import { loadConfig } from "./config.ts";
import { runTurn } from "./claudeRunner.ts";
import { getOrCreate, reset, startIdlePruner, touch } from "./session.ts";

const MAX_MSG_CHARS = 4000;       // cap below Telegram's 4096 to leave headroom
const MIN_EDIT_INTERVAL_MS = 1200; // Telegram edit-rate guard

const cfg = loadConfig();
const bot = new Bot(cfg.token);

function allowed(chatId: number): boolean {
  return cfg.allowlist.has(chatId);
}

bot.command("start", async (ctx) => {
  const chatId = ctx.chat?.id ?? 0;
  const ok = allowed(chatId);
  await ctx.reply(
    `chat_id: ${chatId}\n` +
    (ok ? "✓ allowlisted — send a message to start a Claude session." :
          "Not in allowlist. Add this id to ~/.config/telegram/allowlist and restart."),
  );
});

bot.command("new", async (ctx) => {
  const chatId = ctx.chat?.id ?? 0;
  if (!allowed(chatId)) return;
  reset(chatId);
  await ctx.reply("Fresh session ready.");
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  if (!allowed(chatId)) return;

  const text = ctx.message.text;
  if (!text || text.startsWith("/")) return;

  const session = getOrCreate(chatId);
  if (session.inflight) {
    await ctx.reply("⏳ still working on the previous message");
    return;
  }
  session.inflight = true;

  // Multi-message state: as buffer overflows we finalize current and open new.
  let placeholder = await ctx.reply("…");
  let buffer = "";
  let lastEditAt = 0;
  let pendingTimer: NodeJS.Timeout | null = null;
  let pendingText: string | null = null;

  async function flushEdit(finalText?: string): Promise<void> {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    const text = finalText ?? pendingText;
    if (text === null || text === undefined) return;
    pendingText = null;
    try {
      await ctx.api.editMessageText(chatId, placeholder.message_id, text);
      lastEditAt = Date.now();
    } catch (err) {
      // Ignore "message is not modified" / rate-limit; log others.
      if (err instanceof GrammyError && err.error_code !== 400) {
        console.error("editMessageText error:", err.description);
      }
    }
  }

  async function scheduleEdit(text: string): Promise<void> {
    pendingText = text;
    const since = Date.now() - lastEditAt;
    if (since >= MIN_EDIT_INTERVAL_MS) {
      await flushEdit();
    } else if (!pendingTimer) {
      pendingTimer = setTimeout(() => { flushEdit().catch(() => undefined); },
        MIN_EDIT_INTERVAL_MS - since);
    }
  }

  async function appendAndRender(addition: string): Promise<void> {
    // If single addition pushes buffer past cap, finalize current msg and start new.
    if (buffer.length + addition.length > MAX_MSG_CHARS) {
      await flushEdit(buffer || "…");
      placeholder = await ctx.reply("…");
      buffer = "";
      lastEditAt = 0;
    }
    buffer += addition;
    await scheduleEdit(buffer || "…");
  }

  try {
    for await (const event of runTurn(cfg.projectDir, text, session.sessionId)) {
      if (event.kind === "text-delta") {
        // text-delta carries the running accumulated text from the runner —
        // compute incremental addition relative to what we've already buffered.
        // For simplicity, just overwrite the trailing portion of the current
        // message: split at last newline to avoid mid-chunk truncation.
        // Strategy: keep an "assistant text so far" string separate from tool labels.
        // Simpler: render full text as buffer when no tool labels have been added
        // since last reset. (Tool labels get appended above the in-progress text.)
        // For v1, do the simple thing: only the latest text-delta replaces the
        // tail of buffer after the last "▶ " line.
        const lastToolIdx = buffer.lastIndexOf("\n▶ ");
        const head = lastToolIdx === -1 ? "" : buffer.slice(0, buffer.indexOf("\n", lastToolIdx + 1) + 1);
        const newBuffer = head + event.text;
        if (newBuffer.length > MAX_MSG_CHARS) {
          // Overflow: finalize what we have, start fresh, then add the new delta.
          await flushEdit(buffer || "…");
          placeholder = await ctx.reply("…");
          buffer = event.text.slice(-MAX_MSG_CHARS);
          lastEditAt = 0;
          await scheduleEdit(buffer);
        } else {
          buffer = newBuffer;
          await scheduleEdit(buffer);
        }
      } else if (event.kind === "tool-use") {
        await appendAndRender(`\n${event.label}\n`);
      } else if (event.kind === "done") {
        // Make sure final text is what's shown
        const finalText = event.fullText.trim() || buffer || "(no output)";
        // If final differs significantly from what we've been editing, replace
        const lastToolIdx = buffer.lastIndexOf("\n▶ ");
        const head = lastToolIdx === -1 ? "" : buffer.slice(0, buffer.indexOf("\n", lastToolIdx + 1) + 1);
        const composed = head + finalText;
        if (composed.length <= MAX_MSG_CHARS) {
          await flushEdit(composed);
        } else {
          await flushEdit(buffer || "…");
          // Send overflow as new message(s)
          for (let i = 0; i < finalText.length; i += MAX_MSG_CHARS) {
            await ctx.reply(finalText.slice(i, i + MAX_MSG_CHARS));
          }
        }
        if (event.sessionId) touch(chatId, event.sessionId);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await flushEdit(`Error: ${msg.slice(0, 3500)}`);
  } finally {
    session.inflight = false;
  }
});

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`grammy error for update ${ctx?.update?.update_id}:`, err.error);
  if (err.error instanceof GrammyError) {
    console.error("  description:", err.error.description);
  } else if (err.error instanceof HttpError) {
    console.error("  network error");
  }
});

const pruner = startIdlePruner();

console.log(`telegram-bot starting · cwd=${cfg.projectDir} · allowlist=${[...cfg.allowlist].join(",")}`);
await bot.start({
  onStart: (info) => console.log(`connected as @${info.username}`),
});

clearInterval(pruner);
