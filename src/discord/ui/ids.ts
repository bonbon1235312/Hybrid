import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { ComponentAction, ComponentRoute, ComponentRouteInput } from "../types.js";

const actions: readonly ComponentAction[] = ["home", "back", "cancel", "setup", "setup.submit", "team.detail", "team.create", "team.create.submit", "registration.request", "registration.submit", "registration.withdraw", "registration.withdraw.confirm", "registrations", "registration.select", "registration.approve", "registration.approve.confirm", "registration.decline", "registration.decline.confirm", "roster.assign", "roster.assign.player", "roster.assign.submit", "roster.assign.confirm", "roster.membership.select", "roster.release", "roster.release.confirm"];
const signingKey = requiredSigningKey();

export function encodeComponentId(input: ComponentRouteInput): string {
  const actionIndex = actions.indexOf(input.action);
  if (actionIndex < 0) throw new Error("Unsupported component action.");
  const entityId = input.entityId ?? "-";
  const expiresAt = input.expiresAt ?? Date.now() + 10 * 60_000;
  const nonce = input.nonce ?? randomBytes(6).toString("base64url");
  const payload = `${actionIndex.toString(36)}.${input.actorId}.${entityId}.${Math.floor(expiresAt / 1000).toString(36)}.${nonce}`;
  return `h2.${payload}.${sign(payload)}`;
}

export function decodeComponentId(value: string): ComponentRoute | null {
  const [prefix, actionText, actorId, entityText, expiryText, nonce, signature, ...extra] = value.split(".");
  const action = actions[Number.parseInt(actionText ?? "", 36)];
  const expiresAt = Number.parseInt(expiryText ?? "", 36) * 1000;
  const payload = [actionText, actorId, entityText, expiryText, nonce].join(".");
  if (prefix !== "h2" || !action || !actorId || !entityText || !expiryText || !nonce || !signature || extra.length || !validSignature(payload, signature) || expiresAt <= Date.now()) return null;
  return { action, actorId, ...(entityText === "-" ? {} : { entityId: entityText }), version: 2, expiresAt, nonce };
}

export function encodeStatefulComponentId(input: ComponentRouteInput, state: unknown): string { void state; return encodeComponentId(input); }
export function takeComponentState<T>(route: ComponentRoute): T | null { void route; return null; }
/** One-time consumption is persisted by the router's tenant-scoped service. */
export function consumeComponentRoute(route: ComponentRoute): boolean { void route; return true; }

function sign(payload: string): string { return createHmac("sha256", signingKey).update(payload).digest("base64url").slice(0, 16); }
function validSignature(payload: string, received: string): boolean { const expected = Buffer.from(sign(payload)); const actual = Buffer.from(received); return expected.length === actual.length && timingSafeEqual(expected, actual); }
function requiredSigningKey(): string { const key = process.env.HYBRID_COMPONENT_SIGNING_KEY; if (!key) throw new Error("HYBRID_COMPONENT_SIGNING_KEY is required for Discord component controls."); return key; }
