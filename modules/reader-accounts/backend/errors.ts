export class ReaderError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;

  constructor(status: number, code: string, detail: string, retryAfter?: number) {
    super(detail);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const invalidOtp = () => new ReaderError(400, "invalid_otp", "验证码无效或已过期。");
export const invalidTicket = () => new ReaderError(400, "invalid_ticket", "邮箱验证凭据无效或已过期。");
export const invalidInvite = () => new ReaderError(400, "invalid_invite", "邀请码无效、已用、已过期或不适用于此邮箱。");
export const notFound = () => new ReaderError(404, "not_found", "没有这条记录。");
