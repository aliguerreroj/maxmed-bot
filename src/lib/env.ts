import "dotenv/config";

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  TELEGRAM_BOT_TOKEN: process.env["TELEGRAM_BOT_TOKEN"] ?? "",
  ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] ?? "",
} as const;
