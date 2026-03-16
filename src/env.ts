import fs from "fs";
import path from "path";

const parseLine = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) return null;

  const key = trimmed.slice(0, eqIndex).trim();
  if (!key) return null;

  let value = trimmed.slice(eqIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
};

export const loadSentinelEnv = () => {
  const candidates = [".env", ".env.local"];

  for (const candidate of candidates) {
    const fullPath = path.resolve(process.cwd(), candidate);
    if (!fs.existsSync(fullPath)) continue;
    if (!fs.statSync(fullPath).isFile()) continue;

    const raw = fs.readFileSync(fullPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (typeof process.env[parsed.key] === "undefined") {
        process.env[parsed.key] = parsed.value;
      }
    }
  }
};
