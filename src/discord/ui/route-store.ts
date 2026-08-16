import type { LeagueContext } from "../../modules/league/types.js";
import type { TransactionalDatabase } from "../../platform/database.js";
import type { ComponentRoute } from "../types.js";

let database: TransactionalDatabase | null = null;
export function configureRouteStore(value: TransactionalDatabase): void { database = value; }
export async function consumeDurableRoute(context: LeagueContext, route: ComponentRoute): Promise<boolean> {
  if (!database) return process.env.NODE_ENV === "test";
  const result = await database.transaction((transaction) => transaction.query<{ nonce: string }>(
    `INSERT INTO interaction_route_consumptions (nonce, league_id, actor_discord_user_id, expires_at)
     VALUES ($1, $2, $3, to_timestamp($4)) ON CONFLICT (league_id, nonce) DO NOTHING RETURNING nonce`,
    [route.nonce, context.leagueId, route.actorId, route.expiresAt / 1000]
  ));
  return Boolean(result.rows[0]);
}
