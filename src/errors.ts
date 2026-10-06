export type HpackErrorCode =
  | "INVALID_INPUT"
  | "HUFFMAN_UNSUPPORTED"
  | "INTEGER_OVERFLOW"
  | "INDEX_OUT_OF_RANGE"
  | "TRUNCATED"
  | "SIZE_UPDATE_TOO_LARGE"
  | "SIZE_UPDATE_NOT_AT_START"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "CONFLICT";

export class HpackError extends Error {
  readonly code: HpackErrorCode;
  readonly offset?: number;

  constructor(code: HpackErrorCode, message: string, offset?: number) {
    super(message);
    this.name = "HpackError";
    this.code = code;
    this.offset = offset;
  }

  toJSON() {
    return { code: this.code, message: this.message, offset: this.offset ?? null };
  }
}
