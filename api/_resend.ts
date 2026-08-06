import { loggedFetch, logEnvPresence } from "./_logger.js";

export async function sendEmail(to: string, subject: string, html: string) {
  console.log("[Resend] Sending email. to:", to, "| subject:", subject);
  const apiKey = process.env.RESEND_API_KEY;
  logEnvPresence({ RESEND_API_KEY: apiKey });
  if (!apiKey) {
    console.error("[Resend] Missing RESEND_API_KEY");
    return;
  }
  try {
    const res = await loggedFetch("resend.sendEmail", "https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Qarari.AI <onboarding@resend.dev>", // replace with a verified domain sender once one is set up
        to: [to],
        subject,
        html,
      }),
    });
    console.log("[Resend] Email send request completed. status:", res.status);
  } catch (e: any) {
    console.error("[Resend] Failed to send email:");
    console.error(e);
    console.error(e?.stack);
  }
}
