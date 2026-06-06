import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Context } from "grammy";

const MEDIA_DIR = join(homedir(), ".config", "telegram", "media");
const MAX_BYTES = 20 * 1024 * 1024; // Telegram Bot API ceiling

export interface DownloadedMedia {
  path: string;
  mimeType: string | undefined;
  kind: "photo" | "document";
}

export interface InboundMediaRef {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  kind: "photo" | "document";
}

export function extractMediaRefs(ctx: Context): InboundMediaRef[] {
  const msg = ctx.message;
  if (!msg) return [];
  const refs: InboundMediaRef[] = [];

  // Photos arrive as PhotoSize[]; the last entry is the largest resolution.
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    refs.push({ fileId: largest.file_id, kind: "photo" });
  }

  // Image documents (user sent "as file" — preserves resolution and EXIF).
  if (msg.document && msg.document.mime_type?.startsWith("image/")) {
    refs.push({
      fileId: msg.document.file_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
      kind: "document",
    });
  }

  return refs;
}

export async function downloadMedia(
  ctx: Context,
  token: string,
  ref: InboundMediaRef,
): Promise<DownloadedMedia> {
  const file = await ctx.api.getFile(ref.fileId);
  if (!file.file_path) throw new Error("Telegram getFile returned no file_path");

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);

  const contentLen = Number(res.headers.get("content-length") ?? "0");
  if (contentLen > MAX_BYTES) throw new Error(`file exceeds ${MAX_BYTES} bytes`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`file exceeds ${MAX_BYTES} bytes`);

  const chatId = ctx.chat?.id ?? 0;
  const messageId = ctx.message?.message_id ?? Date.now();
  const ext = pickExt(ref.fileName, file.file_path, res.headers.get("content-type"));
  const dir = join(MEDIA_DIR, String(chatId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${messageId}-${ref.fileId.slice(-8)}${ext}`);
  await writeFile(path, buf, { mode: 0o600 });

  return {
    path,
    mimeType: ref.mimeType ?? res.headers.get("content-type") ?? undefined,
    kind: ref.kind,
  };
}

function pickExt(fileName: string | undefined, filePath: string, contentType: string | null): string {
  const fromName = fileName ? extname(fileName) : "";
  if (fromName) return fromName.toLowerCase();
  const fromPath = extname(basename(filePath));
  if (fromPath) return fromPath.toLowerCase();
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("gif")) return ".gif";
  return ".jpg";
}
