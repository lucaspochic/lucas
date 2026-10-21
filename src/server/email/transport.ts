import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Envoi d'e-mails : interface unique, transport choisi par configuration.
 *  - EMAIL_TRANSPORT=outbox : chaque message est déposé au format .eml (RFC 5322) dans
 *    EMAIL_OUTBOX_DIR (défaut .data/outbox) — développement, démonstration, contrôle ;
 *  - EMAIL_TRANSPORT=none (défaut en production) : envoi désactivé, l'utilisateur envoie
 *    depuis sa messagerie et enregistre l'envoi.
 * Le service réel (SMTP ou API d'un prestataire) est une dépendance externe à choisir :
 * il s'ajoute ici comme un transport supplémentaire, sans modifier les appelants.
 */

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  replyTo?: string | null;
  attachments?: MailAttachment[];
}

export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<{ messageId: string }>;
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Encodage d'en-tête RFC 2047 (UTF-8, base64) si nécessaire. */
const header = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const base64Lines = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/.{1,76}/g, "$&\r\n");

/** Message MIME complet (texte + pièces jointes). Fonction pure, testée. */
export function buildMime(message: MailMessage, from: string, messageId: string, date = new Date()) {
  for (const addr of [message.to, from, ...(message.replyTo ? [message.replyTo] : [])]) {
    if (!EMAIL_RE.test(addr)) throw new Error(`Adresse e-mail invalide : ${addr}`);
  }
  const boundary = `=_${randomBytes(12).toString("hex")}`;
  const head = [
    `From: ${from}`,
    `To: ${message.to}`,
    ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
    `Subject: ${header(message.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    [`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lines(Buffer.from(message.text, "utf8"))].join("\r\n"),
    ...(message.attachments ?? []).map((a) =>
      [
        `--${boundary}`,
        `Content-Type: ${a.contentType}; name="${header(a.filename)}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${header(a.filename)}"`,
        "",
        base64Lines(a.content),
      ].join("\r\n"),
    ),
  ];
  return `${head.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--\r\n`;
}

class OutboxTransport implements MailTransport {
  readonly name = "outbox";
  constructor(
    private dir: string,
    private from: string,
  ) {}
  async send(message: MailMessage) {
    const id = `${Date.now()}-${randomBytes(6).toString("hex")}`;
    const messageId = `<${id}@gestion.local>`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, `${id}.eml`), buildMime(message, this.from, messageId), { mode: 0o600 });
    return { messageId };
  }
}

/** Transport configuré, ou null si l'envoi d'e-mails n'est pas activé. */
export function getMailTransport(): MailTransport | null {
  const kind = process.env.EMAIL_TRANSPORT ?? (process.env.APP_ENV === "production" ? "none" : "outbox");
  const from = process.env.EMAIL_FROM ?? "no-reply@gestion.local";
  if (kind === "outbox") {
    const dir =
      process.env.EMAIL_OUTBOX_DIR ??
      (process.env.VITEST ? path.join(tmpdir(), "gestion-outbox-tests") : path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "outbox"));
    return new OutboxTransport(dir, from);
  }
  if (kind === "none") return null;
  throw new Error(`EMAIL_TRANSPORT inconnu : ${kind} (valeurs prises en charge : outbox, none).`);
}
