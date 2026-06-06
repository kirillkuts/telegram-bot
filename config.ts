import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "telegram");
const TOKEN_FILE = join(CONFIG_DIR, "bot_token");
const ALLOWLIST_FILE = join(CONFIG_DIR, "allowlist");
const PROJECT_DIR_FILE = join(CONFIG_DIR, "project_dir");

export interface Config {
  token: string;
  allowlist: Set<number>;
  projectDir: string;
}

function readFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim();
}

// Parse chat_ids from a blob that may use commas, whitespace, or newlines as
// separators (env var) or one-per-line with # comments (file). Lines starting
// with # are treated as comments.
function parseAllowlist(raw: string | null, into: Set<number>): void {
  if (!raw) return;
  for (const line of raw.split(/[\n,]/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const n = Number(t);
    if (Number.isFinite(n)) into.add(n);
  }
}

export function loadConfig(): Config {
  const token = process.env.TELEGRAM_BOT_TOKEN || readFile(TOKEN_FILE);
  if (!token) {
    throw new Error(
      `No bot token found. Set TELEGRAM_BOT_TOKEN env var or write it to ${TOKEN_FILE}`,
    );
  }

  // Allowlist is the union of the TELEGRAM_ALLOWLIST env var and the file, so
  // either source (or both) works — env is the container path, file is bare-metal.
  const allowlist = new Set<number>();
  parseAllowlist(process.env.TELEGRAM_ALLOWLIST ?? null, allowlist);
  parseAllowlist(readFile(ALLOWLIST_FILE), allowlist);
  if (allowlist.size === 0) {
    console.warn(
      `⚠ Empty allowlist (set TELEGRAM_ALLOWLIST or write ${ALLOWLIST_FILE}). ` +
      `Only /start will respond — send /start to your bot to discover your chat_id, then add it.`,
    );
  }

  // project_dir: env var wins, then file, then a sensible container default.
  const projectDir =
    process.env.PROJECT_DIR || readFile(PROJECT_DIR_FILE) || "/root/workspace";

  return { token, allowlist, projectDir };
}

export const PATHS = { CONFIG_DIR, TOKEN_FILE, ALLOWLIST_FILE, PROJECT_DIR_FILE };
