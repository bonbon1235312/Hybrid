export type DomainErrorCode =
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "LEAGUE_ALREADY_EXISTS"
  | "LEAGUE_NOT_FOUND";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
