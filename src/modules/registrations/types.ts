import type { LeagueContext } from "../league/types.js";

export type RegistrationStatus = "PENDING" | "APPROVED" | "DECLINED" | "WITHDRAWN";

export type Registration = Readonly<{
  id: string;
  leagueId: string;
  leagueMemberId: string;
  displayName: string;
  status: RegistrationStatus;
  requestedAt: Date;
  reviewedAt: Date | null;
  reviewedByMemberId: string | null;
  declinedReason: string | null;
}>;

export type RegistrationSummary = Readonly<{
  id: string;
  leagueMemberId: string;
  discordUserId: string;
  displayName: string;
  status: "PENDING";
  requestedAt: Date;
}>;

export type RequestRegistrationInput = Readonly<{
  displayName: string;
}>;

export type ReviewDecision = "APPROVE" | "DECLINE";

export type ReviewRegistrationInput = Readonly<{
  registrationId: string;
  decision: ReviewDecision;
  declinedReason?: string;
}>;

export type RegistrationService = Readonly<{
  requestRegistration(context: LeagueContext, input: RequestRegistrationInput): Promise<Registration>;
  withdrawRegistration(context: LeagueContext, registrationId: string): Promise<Registration>;
  reviewRegistration(context: LeagueContext, input: ReviewRegistrationInput): Promise<Registration>;
  getRegistration(context: LeagueContext, registrationId: string): Promise<Registration>;
  listPendingRegistrations(context: LeagueContext): Promise<RegistrationSummary[]>;
}>;
