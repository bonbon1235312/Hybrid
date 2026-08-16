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
     VALUES (?, ?, ?, ?, ?, ?, FROM_UNIXTIME(? / 1000))`,
    [
      nonce,
      input.guildId,
      input.actorId,
      input.action,
      input.entityId ?? null,
      input.state === undefined ? null : JSON.stringify(input.state),
      expiresAt
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

  return database.transaction(async (transaction) => {
    const result = await transaction.query<RouteRow>(
      `SELECT action, entity_id AS entityId, state, expires_at AS expiresAt
       FROM interaction_routes
       WHERE nonce = ?
         AND discord_guild_id = ?
         AND actor_discord_user_id = ?
         AND consumed_at IS NULL
         AND expires_at > UTC_TIMESTAMP(3)
       FOR UPDATE`,
      [nonce, guildId, actorId]
    );
    const route = result.rows[0];
    if (!route) {
      return null;
    }

    const consumed = await transaction.query(
      `UPDATE interaction_routes
       SET consumed_at = UTC_TIMESTAMP(3)
       WHERE nonce = ?
         AND discord_guild_id = ?
         AND actor_discord_user_id = ?
         AND consumed_at IS NULL
         AND expires_at > UTC_TIMESTAMP(3)`,
      [nonce, guildId, actorId]
    );
    if (consumed.affectedRows !== 1) {
      return null;
    }

    return {
      action: route.action,
      actorId,
      ...(route.entityId ? { entityId: route.entityId } : {}),
      expiresAt: new Date(route.expiresAt).getTime(),
      nonce,
      state: parseState(route.state)
    };
  });
}

function parseState(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
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
