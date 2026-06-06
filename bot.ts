import { Bot, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { loadConfig } from "./config.ts";
import { runTurn } from "./claudeRunner.ts";
import {
  downloadMedia,
  extractMediaRefs,
  type DownloadedMedia,
  type InboundMediaRef,
} from "./media.ts";
import { getOrCreate, reset, touch } from "./session.ts";

const MAX_MSG_CHARS = 4000;       // cap below Telegram's 4096 to leave headroom
const MIN_EDIT_INTERVAL_MS = 1200; // Telegram edit-rate guard
// Albums: Telegram delivers each photo as a separate update sharing
// `media_group_id`. Buffer briefly so we process the group as one turn.
const MEDIA_GROUP_DEBOUNCE_MS = 800;

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

async function handleSingle(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.message) return;
  const chatId: number = ctx.chat.id;
  if (!allowed(chatId)) return;

  const text = ctx.message?.text ?? ctx.message?.caption ?? "";
  if (text.startsWith("/")) return;

  const mediaRefs = extractMediaRefs(ctx);
  if (!text && mediaRefs.length === 0) return;

  await runTurnForCtx(ctx, text, mediaRefs);
}

async function runTurnForCtx(
  ctx: Context,
  text: string,
  mediaRefs: InboundMediaRef[],
): Promise<void> {
  if (!ctx.chat) return;
  const chatId: number = ctx.chat.id;

  const session = getOrCreate(chatId);
  if (session.inflight) {
    await ctx.reply("⏳ still working on the previous message");
    return;
  }
  session.inflight = true;

  // Download attachments before claiming the placeholder so failures surface early.
  const media: DownloadedMedia[] = [];
  for (const ref of mediaRefs) {
    try {
      media.push(await downloadMedia(ctx, cfg.token, ref));
    } catch (err) {
      session.inflight = false;
      await ctx.reply(`failed to fetch attachment: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  const prompt = buildPrompt(text, media);

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
    for await (const event of runTurn(cfg.projectDir, prompt, session.sessionId)) {
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
}

function buildPrompt(text: string, media: DownloadedMedia[]): string {
  if (media.length === 0) return text;
  const refs = media.map((m) => `- ${m.path}`).join("\n");
  const header = media.length === 1
    ? `[The user sent an image attached at this path; read it with the Read tool to see it]`
    : `[The user sent ${media.length} images attached at these paths; read each with the Read tool]`;
  return text
    ? `${text}\n\n${header}\n${refs}`
    : `${header}\n${refs}`;
}

interface PendingGroup {
  chatId: number;
  contexts: Context[];
  timer: NodeJS.Timeout;
}
const pendingGroups = new Map<string, PendingGroup>();

function bufferGroup(chatId: number, groupId: string, ctx: Context): void {
  const key = `${chatId}:${groupId}`;
  const existing = pendingGroups.get(key);
  const fire = (entry: PendingGroup) => {
    pendingGroups.delete(key);
    flushGroup(entry.contexts).catch((err) => console.error("flushGroup:", err));
  };
  if (existing) {
    clearTimeout(existing.timer);
    existing.contexts.push(ctx);
    existing.timer = setTimeout(() => fire(existing), MEDIA_GROUP_DEBOUNCE_MS);
    return;
  }
  const entry: PendingGroup = { chatId, contexts: [ctx], timer: null as unknown as NodeJS.Timeout };
  entry.timer = setTimeout(() => fire(entry), MEDIA_GROUP_DEBOUNCE_MS);
  pendingGroups.set(key, entry);
}

async function flushGroup(contexts: Context[]): Promise<void> {
  if (contexts.length === 0) return;
  const first = contexts[0];
  // Telegram puts the album caption on (usually) the first message only;
  // collect any captions just in case clients place it elsewhere.
  const text = contexts
    .map((c) => c.message?.caption ?? c.message?.text ?? "")
    .filter((t) => t.length > 0)
    .join("\n");
  const refs = contexts.flatMap((c) => extractMediaRefs(c));
  if (!text && refs.length === 0) return;
  await runTurnForCtx(first, text, refs);
}

bot.on(["message:text", "message:photo", "message:document"], async (ctx) => {
  const chatId = ctx.chat?.id;
  if (chatId == null || !allowed(chatId)) return;
  const groupId = ctx.message?.media_group_id;
  if (groupId) {
    bufferGroup(chatId, groupId, ctx);
    return;
  }
  await handleSingle(ctx);
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

console.log(`telegram-bot starting · cwd=${cfg.projectDir} · allowlist=${[...cfg.allowlist].join(",")}`);
await bot.start({
  onStart: (info) => console.log(`connected as @${info.username}`),
});
