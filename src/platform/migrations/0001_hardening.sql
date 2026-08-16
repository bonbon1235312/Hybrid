ALTER TABLE team_memberships
  ADD CONSTRAINT team_memberships_ended_by_member_fk
  FOREIGN KEY (league_id, ended_by_member_id)
  REFERENCES league_members (league_id, id);

CREATE TABLE interaction_route_consumptions (
  nonce TEXT NOT NULL,
  league_id UUID NOT NULL REFERENCES leagues (id),
  actor_discord_user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (league_id, nonce)
);

CREATE INDEX interaction_route_consumptions_expiry
  ON interaction_route_consumptions (expires_at);
