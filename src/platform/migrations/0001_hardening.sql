ALTER TABLE team_memberships
  ADD CONSTRAINT team_memberships_ended_by_member_fk
  FOREIGN KEY (league_id, ended_by_member_id)
  REFERENCES league_members (league_id, id);
