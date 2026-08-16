export type DomainErrorCode =
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "LEAGUE_ALREADY_EXISTS"
  | "LEAGUE_NOT_FOUND"
  | "TEAM_ALREADY_EXISTS"
  | "TEAM_NOT_FOUND"
  | "DISCORD_ROLE_ALREADY_MAPPED";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
