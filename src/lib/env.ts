// import "dotenv/config";

// function required(key: string): string {
//   const v = process.env[key];
//   if (!v) throw new Error(`Missing required env var: ${key}`);
//   return v;
// }

// export const env = {
//   DATABASE_URL: required("DATABASE_URL"),
//   TELEGRAM_BOT_TOKEN: process.env["TELEGRAM_BOT_TOKEN"] ?? "",
//   ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] ?? "",
// } as const;
import "dotenv/config";

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
} as const;