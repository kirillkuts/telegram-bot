import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PATHS } from "./config.ts";

async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();

  mkdirSync(PATHS.CONFIG_DIR, { recursive: true });

  if (existsSync(PATHS.TOKEN_FILE)) {
    console.log(`✓ bot_token already at ${PATHS.TOKEN_FILE}`);
  } else {
    const token = await ask("Telegram bot token (from @BotFather): ");
    writeFileSync(PATHS.TOKEN_FILE, token + "\n");
    chmodSync(PATHS.TOKEN_FILE, 0o600);
    console.log(`✓ wrote ${PATHS.TOKEN_FILE}`);
  }

  if (existsSync(PATHS.PROJECT_DIR_FILE)) {
    console.log(`✓ project_dir already at ${PATHS.PROJECT_DIR_FILE}`);
  } else {
    const dir = await ask("Absolute project_dir for claude (e.g. /Users/you/projects/foo): ");
    writeFileSync(PATHS.PROJECT_DIR_FILE, dir + "\n");
    console.log(`✓ wrote ${PATHS.PROJECT_DIR_FILE}`);
  }

  if (existsSync(PATHS.ALLOWLIST_FILE)) {
    console.log(`✓ allowlist already at ${PATHS.ALLOWLIST_FILE}`);
  } else {
    const ids = await ask("Allowed Telegram chat_id(s), comma-separated (or leave blank — fill in later): ");
    const lines = ids
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    writeFileSync(PATHS.ALLOWLIST_FILE, lines + (lines ? "\n" : ""));
    console.log(`✓ wrote ${PATHS.ALLOWLIST_FILE}`);
    if (!lines) {
      console.log("  (Send /start to your bot to discover its chat_id, then add it here.)");
    }
  }

  rl.close();

  console.log("");
  console.log("Next: npm install   then   npm start");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
