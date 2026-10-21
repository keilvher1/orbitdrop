import { randomBytes } from 'node:crypto';

/**
 * Opaque ids handed to the renderer (they match the contracts `Id` schema:
 * /^[A-Za-z0-9_-]{1,64}$/). 96 random bits make them unguessable, so an id is
 * also a capability: a renderer can only refer to things main gave it.
 */
export type IdPrefix = 'sel' | 'f' | 'ed' | 'job' | 'out' | 'b' | 'pv' | 'rq';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

/** Longer secret for capability URLs (preview images). */
export function newToken(): string {
  return randomBytes(18).toString('base64url');
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
