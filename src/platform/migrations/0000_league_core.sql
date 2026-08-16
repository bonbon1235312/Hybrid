CREATE TABLE leagues (
  id CHAR(36) NOT NULL,
  discord_guild_id VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  default_roster_cap INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY leagues_discord_guild_id_key (discord_guild_id),
  CONSTRAINT leagues_roster_cap_check CHECK (default_roster_cap BETWEEN 1 AND 99),
  CONSTRAINT leagues_status_check CHECK (status IN ('ACTIVE', 'ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE discord_users (
  discord_user_id VARCHAR(32) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (discord_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE league_members (
  id CHAR(36) NOT NULL,
  league_id CHAR(36) NOT NULL,
  discord_user_id VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY league_members_league_id_id_key (league_id, id),
  UNIQUE KEY league_members_league_user_key (league_id, discord_user_id),
  CONSTRAINT league_members_league_fk
    FOREIGN KEY (league_id) REFERENCES leagues (id),
  CONSTRAINT league_members_discord_user_fk
    FOREIGN KEY (discord_user_id) REFERENCES discord_users (discord_user_id),
  CONSTRAINT league_members_status_check CHECK (status IN ('ACTIVE', 'LEFT', 'BANNED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_assignments (
  id CHAR(36) NOT NULL,
  league_id CHAR(36) NOT NULL,
  league_member_id CHAR(36) NOT NULL,
  role VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at DATETIME(3) NULL,
  active_role VARCHAR(16)
    GENERATED ALWAYS AS (IF(ended_at IS NULL, role, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY active_staff_assignment_per_role (league_id, league_member_id, active_role),
  CONSTRAINT staff_assignments_league_fk
    FOREIGN KEY (league_id) REFERENCES leagues (id),
  CONSTRAINT staff_assignments_league_member_fk
    FOREIGN KEY (league_id, league_member_id)
    REFERENCES league_members (league_id, id),
  CONSTRAINT staff_assignments_role_check CHECK (role IN ('OWNER', 'ADMINISTRATOR', 'STAFF'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE teams (
  id CHAR(36) NOT NULL,
  league_id CHAR(36) NOT NULL,
  name VARCHAR(128) NOT NULL,
  normalized_name VARCHAR(128) NOT NULL,
  roster_cap INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  discord_role_id VARCHAR(32) NULL,
  discord_role_state VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY teams_league_id_id_key (league_id, id),
  UNIQUE KEY teams_league_name_key (league_id, normalized_name),
  UNIQUE KEY active_discord_role_per_league (league_id, discord_role_id),
  CONSTRAINT teams_league_fk
    FOREIGN KEY (league_id) REFERENCES leagues (id),
  CONSTRAINT teams_roster_cap_check CHECK (roster_cap BETWEEN 1 AND 99),
  CONSTRAINT teams_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT teams_discord_role_state_check CHECK (discord_role_state IN ('AVAILABLE', 'UNAVAILABLE', 'UNMAPPED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE team_memberships (
  id CHAR(36) NOT NULL,
  league_id CHAR(36) NOT NULL,
  league_member_id CHAR(36) NOT NULL,
  team_id CHAR(36) NOT NULL,
  membership_role VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at DATETIME(3) NULL,
  ended_by_member_id CHAR(36) NULL,
  active_league_member_id CHAR(36)
    GENERATED ALWAYS AS (IF(status = 'ACTIVE', league_member_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY active_team_membership_per_league (league_id, active_league_member_id),
  KEY active_team_roster_lookup (league_id, team_id, status),
  CONSTRAINT team_memberships_league_member_fk
    FOREIGN KEY (league_id, league_member_id)
    REFERENCES league_members (league_id, id),
  CONSTRAINT team_memberships_league_team_fk
    FOREIGN KEY (league_id, team_id)
    REFERENCES teams (league_id, id),
  CONSTRAINT team_memberships_membership_role_check CHECK (membership_role IN ('PLAYER', 'MANAGER', 'CAPTAIN')),
  CONSTRAINT team_memberships_status_check CHECK (status IN ('ACTIVE', 'ENDED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE registration_requests (
  id CHAR(36) NOT NULL,
  league_id CHAR(36) NOT NULL,
  league_member_id CHAR(36) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  status VARCHAR(16) NOT NULL,
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_at DATETIME(3) NULL,
  reviewed_by_member_id CHAR(36) NULL,
  declined_reason VARCHAR(500) NULL,
  pending_league_member_id CHAR(36)
    GENERATED ALWAYS AS (IF(status = 'PENDING', league_member_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY open_registration_per_league (league_id, pending_league_member_id),
  CONSTRAINT registration_requests_league_member_fk
    FOREIGN KEY (league_id, league_member_id)
    REFERENCES league_members (league_id, id),
  CONSTRAINT registration_requests_reviewer_fk
    FOREIGN KEY (league_id, reviewed_by_member_id)
    REFERENCES league_members (league_id, id),
  CONSTRAINT registration_requests_status_check CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE audit_events (
  id CHAR(36) NOT NULL,
  league_id CHAR(36) NOT NULL,
  actor_member_id CHAR(36) NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id CHAR(36) NULL,
  action VARCHAR(128) NOT NULL,
  correlation_id CHAR(36) NOT NULL,
  before_state JSON NULL,
  after_state JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY audit_events_entity_lookup (league_id, entity_type, entity_id, created_at),
  CONSTRAINT audit_events_league_fk
    FOREIGN KEY (league_id) REFERENCES leagues (id),
  CONSTRAINT audit_events_actor_fk
    FOREIGN KEY (league_id, actor_member_id)
    REFERENCES league_members (league_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE discord_resources (
  id CHAR(36) NOT NULL,
  league_id CHAR(36) NOT NULL,
  resource_key VARCHAR(191) NOT NULL,
  resource_type VARCHAR(16) NOT NULL,
  discord_id VARCHAR(32) NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
  last_verified_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY discord_resources_league_key (league_id, resource_key),
  CONSTRAINT discord_resources_league_fk
    FOREIGN KEY (league_id) REFERENCES leagues (id),
  CONSTRAINT discord_resources_resource_type_check CHECK (resource_type IN ('ROLE', 'CHANNEL', 'MESSAGE')),
  CONSTRAINT discord_resources_state_check CHECK (state IN ('AVAILABLE', 'UNAVAILABLE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE discord_jobs (
  id CHAR(36) NOT NULL,
  league_id CHAR(36) NOT NULL,
  job_type VARCHAR(32) NOT NULL,
  deduplication_key VARCHAR(191) NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
  attempt_count INT NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_owner VARCHAR(191) NULL,
  lease_expires_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  last_error_code VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY discord_jobs_deduplication_key (deduplication_key),
  KEY discord_jobs_claim_lookup (status, available_at, lease_expires_at),
  CONSTRAINT discord_jobs_league_fk
    FOREIGN KEY (league_id) REFERENCES leagues (id),
  CONSTRAINT discord_jobs_type_check CHECK (job_type IN ('ROLE_SYNC')),
  CONSTRAINT discord_jobs_status_check CHECK (status IN ('QUEUED', 'LEASED', 'COMPLETED', 'FAILED')),
  CONSTRAINT discord_jobs_attempt_count_check CHECK (attempt_count >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
