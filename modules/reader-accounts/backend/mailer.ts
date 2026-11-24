import { createRequire } from "node:module";
import { SITE } from "@aihot/site";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: Mail): Promise<void>;
}

export class NotConfigured extends Error {
  constructor() {
    super("Reader mail delivery is not configured");
    this.name = "NotConfigured";
  }
}

export const unconfiguredMailer: Mailer = {
  async send() {
    throw new NotConfigured();
  },
};

type SmtpFailure = "connection_failed" | "authentication_failed" | "recipient_rejected" | "send_failed";

export class SmtpSendError extends Error {
  readonly failure: SmtpFailure;

  constructor(failure: SmtpFailure) {
    super(failure);
    this.name = "SmtpSendError";
    this.failure = failure;
  }
}

type CreateTransport = (options: {
  host: string; port: number; secure: boolean; requireTLS: boolean; auth: { user: string; pass: string };
}) => {
  sendMail(message: Mail & { from: { name: string; address: string } }): Promise<unknown>;
};

const require = createRequire(import.meta.url);
// Load the CommonJS dependency only when the default transport is used.
const createNodemailerTransport: CreateTransport = options => {
  const nodemailer = require("nodemailer") as { createTransport: CreateTransport };
  return nodemailer.createTransport(options);
};

function smtpFailure(error: unknown): SmtpFailure {
  const smtp = error as { code?: string; command?: string } | null | undefined;
  switch (smtp?.code) {
    case "EDNS":
    case "ECONNECTION":
    case "ESOCKET":
    case "ETIMEDOUT":
    case "ETLS":
      return "connection_failed";
    case "EAUTH":
    case "ENOAUTH":
      return "authentication_failed";
    case "EENVELOPE":
      if (smtp.command === "RCPT TO") return "recipient_rejected";
  }
  return "send_failed";
}

export function createSmtpMailer({ env = process.env, createTransport = createNodemailerTransport }: {
  env?: NodeJS.ProcessEnv; createTransport?: CreateTransport;
} = {}): Mailer {
  const host = env.MAIL_SMTP_HOST?.trim();
  const rawPort = env.MAIL_SMTP_PORT?.trim();
  const user = env.MAIL_SMTP_USER?.trim();
  const pass = env.MAIL_SMTP_PASSWORD;
  if (!host || !rawPort || !user || !pass || !/^\d+$/.test(rawPort)) return unconfiguredMailer;
  const port = Number(rawPort);
  if (port < 1 || port > 65535) return unconfiguredMailer;

  const secure = port === 465;
  let transport: ReturnType<CreateTransport> | undefined;
  return {
    async send({ to, subject, text, html }) {
      try {
        transport ??= createTransport({ host, port, secure, requireTLS: !secure, auth: { user, pass } });
        await transport.sendMail({ from: { name: SITE.name, address: user }, to, subject, text, html });
      } catch (error) {
        // Keep provider responses and credentials out of the application error and logs.
        throw new SmtpSendError(smtpFailure(error));
      }
    },
  };
}

export function plainMail(to: string, subject: string, text: string): Mail {
  const content = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return { to, subject, text, html: `<p>${content.replaceAll("\n", "<br>")}</p>` };
}
