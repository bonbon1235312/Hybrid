export type DomainErrorCode =
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "LEAGUE_ALREADY_EXISTS"
  | "LEAGUE_NOT_FOUND"
  | "TEAM_ALREADY_EXISTS"
  | "TEAM_NOT_FOUND"
  | "DISCORD_ROLE_ALREADY_MAPPED"
  | "REGISTRATION_ALREADY_OPEN"
  | "REGISTRATION_NOT_FOUND"
  | "REGISTRATION_NOT_PENDING";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
