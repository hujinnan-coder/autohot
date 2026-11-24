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

export function plainMail(to: string, subject: string, text: string): Mail {
  const content = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return { to, subject, text, html: `<p>${content.replaceAll("\n", "<br>")}</p>` };
}
