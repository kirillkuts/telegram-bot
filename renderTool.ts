import { basename } from "node:path";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

export function toolUseLabel(name: string, input: Record<string, unknown>): string {
  const fp = input.file_path;
  const cmd = input.command;
  const pat = input.pattern;
  const prompt = input.prompt;

  let arg: string;
  if (typeof fp === "string") arg = basename(fp);
  else if (typeof cmd === "string") arg = truncate(cmd, 70);
  else if (typeof pat === "string") arg = truncate(pat, 70);
  else if (typeof prompt === "string") arg = truncate(prompt, 70);
  else arg = truncate(JSON.stringify(input), 70);

  return `▶ ${name}(${arg})`;
}
