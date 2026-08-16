import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid
} from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull();

export const leagues = pgTable("leagues", {
  id: uuid("id").primaryKey(),
  discordGuildId: text("discord_guild_id").notNull(),
  name: text("name").notNull(),
  defaultRosterCap: integer("default_roster_cap").notNull(),
  status: text("status").notNull(),
  createdAt,
  updatedAt
});

export const discordUsers = pgTable("discord_users", {
  discordUserId: text("discord_user_id").primaryKey(),
  displayName: text("display_name").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  createdAt,
  updatedAt
});

export const leagueMembers = pgTable("league_members", {
  id: uuid("id").primaryKey(),
  leagueId: uuid("league_id").notNull(),
  discordUserId: text("discord_user_id").notNull(),
  status: text("status").notNull(),
  createdAt,
  updatedAt
});

export const staffAssignments = pgTable("staff_assignments", {
  id: uuid("id").primaryKey(),
  leagueId: uuid("league_id").notNull(),
  leagueMemberId: uuid("league_member_id").notNull(),
  role: text("role").notNull(),
  createdAt,
  endedAt: timestamp("ended_at", { withTimezone: true })
});

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey(),
  leagueId: uuid("league_id").notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  rosterCap: integer("roster_cap").notNull(),
  status: text("status").notNull(),
  discordRoleId: text("discord_role_id"),
  discordRoleState: text("discord_role_state").notNull(),
  createdAt,
  updatedAt
});

export const teamMemberships = pgTable("team_memberships", {
  id: uuid("id").primaryKey(),
  leagueId: uuid("league_id").notNull(),
  leagueMemberId: uuid("league_member_id").notNull(),
  teamId: uuid("team_id").notNull(),
  membershipRole: text("membership_role").notNull(),
  status: text("status").notNull(),
  createdAt,
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endedByMemberId: uuid("ended_by_member_id")
});

export const registrationRequests = pgTable("registration_requests", {
  id: uuid("id").primaryKey(),
  leagueId: uuid("league_id").notNull(),
  leagueMemberId: uuid("league_member_id").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedByMemberId: uuid("reviewed_by_member_id"),
  declinedReason: text("declined_reason")
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  leagueId: uuid("league_id").notNull(),
  actorMemberId: uuid("actor_member_id"),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  action: text("action").notNull(),
  correlationId: uuid("correlation_id").notNull(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  createdAt
});

export const discordResources = pgTable("discord_resources", {
  id: uuid("id").primaryKey(),
  leagueId: uuid("league_id").notNull(),
  resourceKey: text("resource_key").notNull(),
  resourceType: text("resource_type").notNull(),
  discordId: text("discord_id").notNull(),
  state: text("state").notNull(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  createdAt,
  updatedAt
});

export const discordJobs = pgTable("discord_jobs", {
  id: uuid("id").primaryKey(),
  leagueId: uuid("league_id").notNull(),
  jobType: text("job_type").notNull(),
  deduplicationKey: text("deduplication_key").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  createdAt,
  updatedAt
});
