CREATE TABLE interaction_routes (
  nonce TEXT PRIMARY KEY,
  discord_guild_id TEXT NOT NULL,
  actor_discord_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_id TEXT,
  state JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX interaction_routes_lookup
  ON interaction_routes (discord_guild_id, actor_discord_user_id, expires_at)
  WHERE consumed_at IS NULL;
