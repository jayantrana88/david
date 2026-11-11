/**
 * What every delivery channel shares (apis/mail.py): the resume attachment, the outcome of a send and the MIME
 * message. Every channel has the same `send(to, subject, text, attachments, fromName)` and returns:
 *
 *   sent         delivered; detail = the provider's message id (if it gives one)
 *   send_failed  certainly not delivered (429 / 5xx, bad credentials): the lead is offered again
 *   rejected     the provider refused this recipient for good: the lead is not retried
 *   uncertain    the request went out but no answer came back: the row stays `sending`, never sent twice
 */
import { textToBase64 } from "../util";

export type Status = "sent" | "send_failed" | "rejected" | "uncertain";
export type SendResult = [Status, string];

/** The resume, as base64 (how it is stored, and what MIME and Graph want). */
export interface Attachment {
  filename: string;
  mime: string;
  base64: string;
}

export interface Mailer {
  send(to: string, subject: string, text: string, attachments: Attachment[] | null, fromName: string): Promise<SendResult>;
}

/** An RFC 2047 encoded-word when the header has non-ASCII characters. */
export function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${textToBase64(value)}?=`;
}

function formatAddress(name: string, address: string): string {
  if (!name) return address;
  const shown = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : encodeHeader(name);
  return `${shown} <${address}>`;
}

const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");

/** The plain-text email with its attachments, as MIME text. Without `fromAddr` there is no From header. */
export function buildMessage(to: string, subject: string, text: string, attachments: Attachment[] | null,
  fromAddr = "", fromName = "", boundary = `=_${crypto.randomUUID().replace(/-/g, "")}`): string {
  const headers = [`To: ${to}`, `Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0"];
  if (fromAddr) {
    headers.unshift(`From: ${formatAddress(fromName, fromAddr)}`);
    headers.push(`Message-ID: <${crypto.randomUUID()}@${fromAddr.split("@").pop()}>`);
  }
  const textPart = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(textToBase64(text.replace(/\r?\n/g, "\r\n")))];
  if (!attachments?.length) return [...headers, ...textPart].join("\r\n");
  const parts = [`--${boundary}`, ...textPart];
  for (const a of attachments) {
    const name = encodeHeader(a.filename).replace(/"/g, "");
    parts.push(`--${boundary}`, `Content-Type: ${a.mime}; name="${name}"`, "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`, "", wrap76(a.base64));
  }
  parts.push(`--${boundary}--`, "");
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n");
}
