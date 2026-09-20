/**
 * 统一的接口层错误：携带 HTTP 状态码与机器可读错误码。
 */
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
