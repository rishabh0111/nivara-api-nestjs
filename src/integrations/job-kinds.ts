/**
 * The two kinds of queued work an integration produces.
 *
 * Named here rather than inside the Slack adapter because they are the shape of
 * *every* source adapter, not of this one: something arrives from outside and has
 * to be processed after the acknowledgement, and something written here has to
 * reach the outside and may fail on the way. A second adapter registers handlers
 * under these same two kinds and adds no third.
 *
 * They are strings in a `jsonb`-adjacent column rather than an enum for the
 * reason `Job.kind` records: the catalog that decides anything is the handler
 * registry in the application, and an unrecognised kind is a dead-lettered row
 * rather than a rejected insert.
 */
export const INBOUND_EVENT_JOB = 'inbound.event';
export const OUTBOUND_DELIVERY_JOB = 'outbound.delivery';

/**
 * The dedupe partition inbound events share.
 *
 * A scope of its own, beside the request-line scopes HTTP callers get, because it
 * is a different question asked by something with no request line and no response
 * to cache: "have I already handled this exact delivery?". Keyed per source so two
 * adapters cannot collide on a provider's identifier format.
 */
export const inboundEventScope = (source: string): string => `${source}:event`;

/**
 * One string out of a job payload, or an empty one.
 *
 * A payload arrives back from a `jsonb` column typed `unknown`, so every read of
 * it is a claim about what was written. Going through here rather than `String()`
 * at each call site keeps that claim honest: `String()` on an object yields
 * `"[object Object]"`, which is a value that then flows on as though it were an
 * id — the sort of thing that surfaces three layers away as a lookup that never
 * matches.
 *
 * Empty rather than `undefined`, because every caller's next move is a lookup and
 * an empty key finds nothing. A malformed payload therefore fails as "no such
 * row" rather than as a type error, which is the same way an id for a deleted row
 * fails, and both are handled.
 */
export const payloadString = (
  payload: Record<string, unknown>,
  key: string,
): string => {
  const value = payload[key];

  return typeof value === 'string' ? value : '';
};
