import { loggedFetch, logEnvPresence } from "./_logger.js";

export async function sendTelegramAlert(message: string) {
  console.log("[Telegram] Sending alert...");
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  logEnvPresence({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId });
  if (!token || !chatId) {
    console.error("[Telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    return;
  }
  try {
    const res = await loggedFetch("telegram.sendMessage", `https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
    console.log("[Telegram] Alert send request completed. status:", res.status);
  } catch (e: any) {
    console.error("[Telegram] Failed to send alert:");
    console.error(e);
    console.error(e?.stack);
  }
}
