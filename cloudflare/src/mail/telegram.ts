/**
 * Telegram delivery (apis/telegram.py): nothing is emailed to the company. Each application is posted to your
 * chat as one HTML message (address and subject as tap-to-copy code, body as a code block) with an inline
 * keyboard of copy buttons: To, Subject and the body in pieces of at most 256 characters. Over 4096
 * characters it falls back to plain parts, the buttons under the last.
 */
import { sleep } from "../util";
import type { Attachment, Mailer, SendResult } from "./mail";

const MAX_MESSAGE = 4096;
const MAX_COPY_TEXT = 256;
const BUTTONS_PER_ROW = 2;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

export function formatMessage(to: string, subject: string, text: string, attachments: Attachment[] | null): string | null {
  const lines = ["📨 <b>Application ready to send</b>", `<b>To:</b> <code>${escapeHtml(to)}</code>`, `<b>Subject:</b> <code>${escapeHtml(subject)}</code>`];
  let shown = `📨 Application ready to send\nTo: ${to}\nSubject: ${subject}\n\n${text}`.length;
  if (attachments?.length) {
    const names = attachments.map((a) => a.filename).join(", ");
    lines.push(`<b>Attach:</b> ${escapeHtml(names)}`);
    shown += `\nAttach: ${names}`.length;
  }
  if (shown > MAX_MESSAGE - 16) return null;
  return lines.join("\n") + `\n\n<pre>${escapeHtml(text)}</pre>`;
}

/** `text` in pieces of at most `size` characters that paste back together: cut after a paragraph, line, sentence or space. */
export function chunkText(text: string, size: number): string[] {
  const pieces: string[] = [];
  while (text.length > size) {
    const window = text.slice(0, size);
    let cut = 0;
    for (const pattern of [/\n\n/g, /\n/g, /[.!?] /g, / /g]) {
      const ends = [...window.matchAll(pattern)].map((m) => (m.index ?? 0) + m[0].length);
      if (ends.length && ends[ends.length - 1] > Math.floor(size / 3)) {
        cut = ends[ends.length - 1];
        break;
      }
    }
    cut ||= size;
    pieces.push(text.slice(0, cut));
    text = text.slice(cut);
  }
  if (text) pieces.push(text);
  return pieces;
}

export function copyKeyboard(to: string, subject: string, text: string) {
  const copy = (label: string, t: string) => ({ text: label, copy_text: { text: t.slice(0, MAX_COPY_TEXT) } });
  const buttons = [copy("📋 To", to), copy("📋 Subject", subject)];
  const pieces = chunkText(text, MAX_COPY_TEXT);
  pieces.forEach((piece, i) => buttons.push(copy(pieces.length > 1 ? `📋 Body ${i + 1}/${pieces.length}` : "📋 Body", piece)));
  const rows = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) rows.push(buttons.slice(i, i + BUTTONS_PER_ROW));
  return { inline_keyboard: rows };
}

export function splitText(text: string): string[] {
  const parts: string[] = [];
  while (text.length > MAX_MESSAGE) {
    let cut = text.lastIndexOf("\n", MAX_MESSAGE);
    if (cut <= 0) cut = MAX_MESSAGE;
    parts.push(text.slice(0, cut));
    text = text.slice(cut).replace(/^\n+/, "");
  }
  parts.push(text);
  return parts;
}

export class Telegram implements Mailer {
  constructor(private botToken: string, private chatId: string) {
    const missing = [!botToken && "Telegram bot token", !chatId && "Telegram chat id"].filter(Boolean);
    if (missing.length) throw new Error(`Telegram delivery needs, on the Settings page: ${missing.join(", ")}`);
  }

  async send(to: string, subject: string, text: string, attachments: Attachment[] | null): Promise<SendResult> {
    const keyboard = copyKeyboard(to, subject, text);
    const message = formatMessage(to, subject, text, attachments);
    if (message !== null) return this.post({ text: message, parse_mode: "HTML", reply_markup: keyboard });
    let header = `To: ${to}\nSubject: ${subject}`;
    if (attachments?.length) header += "\nAttach: " + attachments.map((a) => a.filename).join(", ");
    const parts = splitText(`${header}\n\n${text}`);
    let last = "";
    for (let i = 0; i < parts.length; i++) {
      const [status, detail] = await this.post(i === parts.length - 1 ? { text: parts[i], reply_markup: keyboard } : { text: parts[i] });
      if (status !== "sent") return [status, detail];
      last = detail;
    }
    return ["sent", last];
  }

  /** A read timeout is send_failed here: a second post to your own chat is harmless. */
  private async post(fields: Record<string, unknown>): Promise<SendResult> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let resp: Response;
      try {
        resp = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.chatId, disable_web_page_preview: true, ...fields }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        if (attempt < 3) {
          await sleep(2000 * attempt);
          continue;
        }
        return ["send_failed", e instanceof Error ? e.message : String(e)];
      }
      const body = await resp.text();
      if (RETRYABLE.has(resp.status) && attempt < 3) {
        let wait = 2 * 2 ** (attempt - 1);
        try {
          wait = Math.max(wait, Number(JSON.parse(body).parameters.retry_after) || 0);
        } catch { /* no retry_after */ }
        await sleep(Math.min(30, wait) * 1000);
        continue;
      }
      if (resp.status === 200) {
        try {
          return ["sent", String(JSON.parse(body).result?.message_id ?? "")];
        } catch {
          return ["sent", ""];
        }
      }
      return ["send_failed", `HTTP ${resp.status}: ${body.slice(0, 300)}`];
    }
    return ["send_failed", "no answer"];
  }
}
