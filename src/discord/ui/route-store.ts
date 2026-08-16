import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { TransactionalDatabase } from "../../platform/database.js";
import type { ComponentAction, ComponentRoute, ComponentRouteIssue, ComponentRouteStore } from "../types.js";

const componentVersion = "h3";
const defaultLifetimeMs = 10 * 60_000;

type RouteRow = Readonly<{
  action: ComponentAction;
  entityId: string | null;
  state: unknown;
  expiresAt: Date | string;
}>;

/**
 * Issues opaque, HMAC-authenticated Discord component identifiers. The full
 * route is persisted before Discord ever sees the component so a new process
 * can safely consume it exactly once.
 */
export function createRouteStore(database: TransactionalDatabase, signingKey: string): ComponentRouteStore {
  assertSigningKey(signingKey);

  return {
    issue: async (input) => issueRoute(database, signingKey, input),
    consume: async ({ guildId, actorId, customId }) => consumeRoute(database, signingKey, guildId, actorId, customId)
  };
}

async function issueRoute(
  database: TransactionalDatabase,
  signingKey: string,
  input: ComponentRouteIssue
): Promise<string> {
  const expiresAt = input.expiresAt ?? Date.now() + defaultLifetimeMs;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Component routes must expire in the future.");
  }

  const nonce = randomBytes(18).toString("base64url");
  await database.transaction((transaction) => transaction.query(
    `INSERT INTO interaction_routes
      (nonce, discord_guild_id, actor_discord_user_id, action, entity_id, state, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, to_timestamp($7))`,
    [
      nonce,
      input.guildId,
      input.actorId,
      input.action,
      input.entityId ?? null,
      input.state === undefined ? null : JSON.stringify(input.state),
      expiresAt / 1_000
    ]
  ));

  return `${componentVersion}.${nonce}.${signature(signingKey, nonce)}`;
}

async function consumeRoute(
  database: TransactionalDatabase,
  signingKey: string,
  guildId: string,
  actorId: string,
  customId: string
): Promise<ComponentRoute | null> {
  const nonce = verifiedNonce(signingKey, customId);
  if (!nonce) {
    return null;
  }

  const result = await database.transaction((transaction) => transaction.query<RouteRow>(
    `UPDATE interaction_routes
     SET consumed_at = NOW()
     WHERE nonce = $1
       AND discord_guild_id = $2
       AND actor_discord_user_id = $3
       AND consumed_at IS NULL
       AND expires_at > NOW()
     RETURNING action, entity_id AS "entityId", state, expires_at AS "expiresAt"`,
    [nonce, guildId, actorId]
  ));
  const route = result.rows[0];
  if (!route) {
    return null;
  }

  return {
    action: route.action,
    actorId,
    ...(route.entityId ? { entityId: route.entityId } : {}),
    expiresAt: new Date(route.expiresAt).getTime(),
    nonce,
    state: route.state
  };
}

function signature(signingKey: string, nonce: string): string {
  return createHmac("sha256", signingKey)
    .update(`${componentVersion}.${nonce}`)
    .digest("base64url")
    .slice(0, 22);
}

function verifiedNonce(signingKey: string, customId: string): string | null {
  const [version, nonce, receivedSignature, ...extra] = customId.split(".");
  if (version !== componentVersion || !nonce || !receivedSignature || extra.length > 0) {
    return null;
  }

  const expected = Buffer.from(signature(signingKey, nonce));
  const received = Buffer.from(receivedSignature);
  return expected.length === received.length && timingSafeEqual(expected, received) ? nonce : null;
}

function assertSigningKey(signingKey: string): void {
  if (signingKey.length < 32) {
    throw new Error("HYBRID_COMPONENT_SIGNING_KEY must be at least 32 characters.");
  }
}
