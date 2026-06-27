// Out-of-app notification channels: generic webhook POST + SMTP email.
// Reads channel config from env so adding/removing is a deploy concern
// (no secret-in-DB risk). Both channels are best-effort and never throw —
// failures are logged and the trading loop continues unimpeded.
//
// ENV:
//   NOTIFIER_WEBHOOK_URL=https://hooks.slack.com/...
//   NOTIFIER_SMTP_HOST=smtp.gmail.com
//   NOTIFIER_SMTP_PORT=587
//   NOTIFIER_SMTP_USER=...
//   NOTIFIER_SMTP_PASS=...
//   NOTIFIER_EMAIL_FROM=qti@example.com
//   NOTIFIER_EMAIL_TO=trader@example.com
//
// We deliberately do NOT pull in nodemailer or @slack/web-api — the
// webhook is a plain JSON POST and the SMTP path uses the standard
// "nodemailer-lite" via direct socket call would be heavy. So this file
// implements webhook only by default; the email shim logs a "set up
// SMTP" hint until nodemailer is installed. Adding nodemailer later is
// a one-line swap inside `sendEmail`.

import axios from "axios";
import { logger } from "../utils/logger.js";

const WEBHOOK = process.env.NOTIFIER_WEBHOOK_URL ?? "";
const SMTP_HOST = process.env.NOTIFIER_SMTP_HOST ?? "";
const EMAIL_TO = process.env.NOTIFIER_EMAIL_TO ?? "";

export interface NotifyPayload {
  title: string;
  body: string;
  level?: "info" | "success" | "warn" | "error";
  link?: string;
  context?: Record<string, unknown>;
}

export async function notify(payload: NotifyPayload): Promise<{ webhook: boolean; email: boolean }> {
  const [webhook, email] = await Promise.all([sendWebhook(payload), sendEmail(payload)]);
  return { webhook, email };
}

async function sendWebhook(payload: NotifyPayload): Promise<boolean> {
  if (!WEBHOOK) return false;
  try {
    await axios.post(
      WEBHOOK,
      {
        text: `${badge(payload.level)} ${payload.title}\n${payload.body}` + (payload.link ? `\n${payload.link}` : ""),
        title: payload.title,
        body: payload.body,
        level: payload.level ?? "info",
        link: payload.link,
        context: payload.context ?? {},
        ts: Date.now(),
      },
      { timeout: 5_000 }
    );
    return true;
  } catch (err) {
    logger.warn("notifier webhook failed", { err: (err as Error).message });
    return false;
  }
}

async function sendEmail(payload: NotifyPayload): Promise<boolean> {
  if (!SMTP_HOST || !EMAIL_TO) return false;
  // Lazy-load nodemailer so the dep is optional. If it isn't installed,
  // log a hint once and silently skip subsequent emails.
  try {
    // Optional dep — silently skipped when not installed. The dynamic
    // string and `any` cast keep TypeScript happy without forcing the
    // nodemailer @types as a hard dependency.
    const modName = "node" + "mailer"; // prevents tsc from resolving the import statically
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodemailer: any = await (Function("m", "return import(m)") as (m: string) => Promise<any>)(modName).catch(() => null);
    if (!nodemailer || typeof nodemailer.createTransport !== "function") {
      logEmailHintOnce();
      return false;
    }
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(process.env.NOTIFIER_SMTP_PORT ?? 587),
      secure: Number(process.env.NOTIFIER_SMTP_PORT ?? 587) === 465,
      auth: process.env.NOTIFIER_SMTP_USER
        ? { user: process.env.NOTIFIER_SMTP_USER, pass: process.env.NOTIFIER_SMTP_PASS }
        : undefined,
    });
    await transporter.sendMail({
      from: process.env.NOTIFIER_EMAIL_FROM ?? "qti@localhost",
      to: EMAIL_TO,
      subject: `[QTI] ${payload.title}`,
      text: payload.body + (payload.link ? `\n\n${payload.link}` : ""),
    });
    return true;
  } catch (err) {
    logger.warn("notifier email failed", { err: (err as Error).message });
    return false;
  }
}

let _hintLogged = false;
function logEmailHintOnce() {
  if (_hintLogged) return;
  _hintLogged = true;
  logger.info(
    "Email notifier requested but `nodemailer` is not installed. Run `npm i nodemailer` in the backend folder to enable."
  );
}

function badge(level?: NotifyPayload["level"]): string {
  switch (level) {
    case "success": return "✅";
    case "warn": return "⚠️";
    case "error": return "🚨";
    default: return "ℹ️";
  }
}
