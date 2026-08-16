CREATE TABLE interaction_route_consumptions (
  nonce VARCHAR(48) NOT NULL,
  league_id CHAR(36) NOT NULL,
  actor_discord_user_id VARCHAR(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (league_id, nonce),
  KEY interaction_route_consumptions_expiry (expires_at),
  CONSTRAINT interaction_route_consumptions_league_fk
    FOREIGN KEY (league_id) REFERENCES leagues (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE interaction_routes (
  nonce VARCHAR(48) NOT NULL,
  discord_guild_id VARCHAR(32) NOT NULL,
  actor_discord_user_id VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) NULL,
  state JSON NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (nonce),
  KEY interaction_routes_lookup (discord_guild_id, actor_discord_user_id, consumed_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
