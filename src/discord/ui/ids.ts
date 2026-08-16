import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { ComponentRoute, ComponentRouteInput } from "../types.js";

const prefix = "hl1";
const signingKey = process.env.HYBRID_COMPONENT_SIGNING_KEY ?? randomBytes(32).toString("base64url");
const issuedRoutes = new Map<string, { route: ComponentRoute; consumed: boolean }>();
const routeState = new Map<string, unknown>();

export function encodeComponentId(input: ComponentRouteInput): string {
  const route: ComponentRoute = {
    action: input.action,
    version: input.version ?? 1,
    actorId: input.actorId,
    expiresAt: input.expiresAt ?? Date.now() + 10 * 60_000,
    nonce: input.nonce ?? randomBytes(9).toString("base64url"),
    ...(input.entityId ? { entityId: input.entityId } : {})
  };
  pruneRoutes();
  issuedRoutes.set(route.nonce, { route, consumed: false });
  return `${prefix}.${route.nonce}.${sign(route.nonce)}`;
}

export function decodeComponentId(value: string): ComponentRoute | null {
  const [receivedPrefix, nonce, signature, ...extra] = value.split(".");

  if (receivedPrefix !== prefix || !nonce || !signature || extra.length > 0 || !validSignature(nonce, signature)) {
    return null;
  }
  const issued = issuedRoutes.get(nonce);
  if (!issued || issued.route.expiresAt <= Date.now()) {
    return null;
  }
  return issued.route;
}

export function encodeStatefulComponentId(input: ComponentRouteInput, state: unknown): string {
  const value = encodeComponentId(input);
  const route = decodeComponentId(value);
  if (!route) {
    throw new Error("Unable to issue component route.");
  }
  routeState.set(route.nonce, state);
  return value;
}

export function takeComponentState<T>(route: ComponentRoute): T | null {
  const state = routeState.get(route.nonce);
  routeState.delete(route.nonce);
  return state === undefined ? null : state as T;
}

/** Returns false for a replayed or expired route. Call only after actor authorization. */
export function consumeComponentRoute(route: ComponentRoute): boolean {
  pruneRoutes();
  const issued = issuedRoutes.get(route.nonce);
  if (!issued || issued.route.expiresAt <= Date.now() || issued.consumed) {
    return false;
  }
  issued.consumed = true;
  return true;
}

function sign(nonce: string): string {
  return createHmac("sha256", signingKey).update(nonce).digest("base64url").slice(0, 22);
}

function validSignature(nonce: string, received: string): boolean {
  const expected = Buffer.from(sign(nonce));
  const actual = Buffer.from(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function pruneRoutes(): void {
  const now = Date.now();
  for (const [nonce, issued] of issuedRoutes) {
    if (issued.route.expiresAt <= now) {
      issuedRoutes.delete(nonce);
      routeState.delete(nonce);
    }
  }
}
