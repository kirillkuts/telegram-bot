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

export function loadConfig(): Config {
  const token = process.env.TELEGRAM_BOT_TOKEN || readFile(TOKEN_FILE);
  if (!token) {
    throw new Error(
      `No bot token found. Set TELEGRAM_BOT_TOKEN env var or write it to ${TOKEN_FILE}`,
    );
  }

  const allowlistRaw = readFile(ALLOWLIST_FILE);
  const allowlist = new Set<number>();
  if (allowlistRaw) {
    for (const line of allowlistRaw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const n = Number(t);
      if (Number.isFinite(n)) allowlist.add(n);
    }
  }
  if (allowlist.size === 0) {
    console.warn(
      `⚠ Empty allowlist (${ALLOWLIST_FILE}). Only /start will respond — ` +
      `send /start to your bot to discover your chat_id, then add it.`,
    );
  }

  const projectDir = readFile(PROJECT_DIR_FILE);
  if (!projectDir) {
    throw new Error(
      `No project_dir set. Write the absolute path to ${PROJECT_DIR_FILE}`,
    );
  }

  return { token, allowlist, projectDir };
}

export const PATHS = { CONFIG_DIR, TOKEN_FILE, ALLOWLIST_FILE, PROJECT_DIR_FILE };
