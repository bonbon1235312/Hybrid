CREATE TABLE leagues (
  id UUID PRIMARY KEY,
  discord_guild_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  default_roster_cap INTEGER NOT NULL CHECK (default_roster_cap BETWEEN 1 AND 99),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE discord_users (
  discord_user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE league_members (
  id UUID PRIMARY KEY,
  league_id UUID NOT NULL REFERENCES leagues (id),
  discord_user_id TEXT NOT NULL REFERENCES discord_users (discord_user_id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LEFT', 'BANNED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT league_members_league_id_id_key UNIQUE (league_id, id),
  CONSTRAINT league_members_league_user_key UNIQUE (league_id, discord_user_id)
);

CREATE TABLE staff_assignments (
  id UUID PRIMARY KEY,
  league_id UUID NOT NULL REFERENCES leagues (id),
  league_member_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMINISTRATOR', 'STAFF')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  CONSTRAINT staff_assignments_league_member_fk
    FOREIGN KEY (league_id, league_member_id)
    REFERENCES league_members (league_id, id)
);

CREATE UNIQUE INDEX active_staff_assignment_per_role
  ON staff_assignments (league_id, league_member_id, role)
  WHERE ended_at IS NULL;

CREATE TABLE teams (
  id UUID PRIMARY KEY,
  league_id UUID NOT NULL REFERENCES leagues (id),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  roster_cap INTEGER NOT NULL CHECK (roster_cap BETWEEN 1 AND 99),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  discord_role_id TEXT,
  discord_role_state TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (discord_role_state IN ('AVAILABLE', 'UNAVAILABLE', 'UNMAPPED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT teams_league_id_id_key UNIQUE (league_id, id),
  CONSTRAINT teams_league_name_key UNIQUE (league_id, normalized_name)
);

CREATE UNIQUE INDEX active_discord_role_per_league
  ON teams (league_id, discord_role_id)
  WHERE discord_role_id IS NOT NULL;

CREATE TABLE team_memberships (
  id UUID PRIMARY KEY,
  league_id UUID NOT NULL REFERENCES leagues (id),
  league_member_id UUID NOT NULL,
  team_id UUID NOT NULL,
  membership_role TEXT NOT NULL CHECK (membership_role IN ('PLAYER', 'MANAGER', 'CAPTAIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  ended_by_member_id UUID,
  CONSTRAINT team_memberships_league_member_fk
    FOREIGN KEY (league_id, league_member_id)
    REFERENCES league_members (league_id, id),
  CONSTRAINT team_memberships_league_team_fk
    FOREIGN KEY (league_id, team_id)
    REFERENCES teams (league_id, id)
);

CREATE UNIQUE INDEX active_team_membership_per_league
  ON team_memberships (league_id, league_member_id)
  WHERE status = 'ACTIVE';

CREATE INDEX active_team_roster_lookup
  ON team_memberships (league_id, team_id)
  WHERE status = 'ACTIVE';

CREATE TABLE registration_requests (
  id UUID PRIMARY KEY,
  league_id UUID NOT NULL REFERENCES leagues (id),
  league_member_id UUID NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by_member_id UUID,
  declined_reason TEXT,
  CONSTRAINT registration_requests_league_member_fk
    FOREIGN KEY (league_id, league_member_id)
    REFERENCES league_members (league_id, id),
  CONSTRAINT registration_requests_reviewer_fk
    FOREIGN KEY (league_id, reviewed_by_member_id)
    REFERENCES league_members (league_id, id)
);

CREATE UNIQUE INDEX open_registration_per_league
  ON registration_requests (league_id, league_member_id)
  WHERE status = 'PENDING';

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  league_id UUID NOT NULL REFERENCES leagues (id),
  actor_member_id UUID,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  action TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  before_state JSONB,
  after_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT audit_events_actor_fk
    FOREIGN KEY (league_id, actor_member_id)
    REFERENCES league_members (league_id, id)
);

CREATE INDEX audit_events_entity_lookup
  ON audit_events (league_id, entity_type, entity_id, created_at DESC);

CREATE TABLE discord_resources (
  id UUID PRIMARY KEY,
  league_id UUID NOT NULL REFERENCES leagues (id),
  resource_key TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('ROLE', 'CHANNEL', 'MESSAGE')),
  discord_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (state IN ('AVAILABLE', 'UNAVAILABLE')),
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discord_resources_league_key UNIQUE (league_id, resource_key)
);

CREATE TABLE discord_jobs (
  id UUID PRIMARY KEY,
  league_id UUID NOT NULL REFERENCES leagues (id),
  job_type TEXT NOT NULL CHECK (job_type IN ('ROLE_SYNC')),
  deduplication_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'LEASED', 'COMPLETED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discord_jobs_deduplication_key UNIQUE (deduplication_key)
);

CREATE INDEX discord_jobs_claim_lookup
  ON discord_jobs (status, available_at, lease_expires_at);
