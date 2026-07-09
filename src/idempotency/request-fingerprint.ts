import { createHash } from 'node:crypto';

/**
 * A request body, reduced to a fixed-width fingerprint of what it *says*.
 *
 * This exists because an idempotency key identifies a request rather than a
 * caller, and the API can only hold a client to that if it can tell two requests
 * apart. Storing the body itself would do the same job and is the wrong trade:
 * it would put a copy of every side-effecting payload in a second table with a
 * different retention story, and the question being asked is only ever "same or
 * not".
 *
 * Deliberately over the body alone, not the method or path. Those are already
 * the `scope` a record is keyed by, so folding them in here would state the same
 * fact twice and make a mismatch report itself as the wrong error — a caller who
 * reused a key on a different endpoint should see the two claims as unrelated,
 * which they are, rather than as a payload disagreement.
 */
export const requestFingerprint = (body: unknown): string =>
  createHash('sha256').update(canonicalise(body)).digest('hex');

/**
 * The body as a canonical string: key order normalised, everything else left
 * exactly as it is.
 *
 * Object key order is the one difference between two serialisations of the same
 * request that carries no meaning — `JSON.stringify` preserves insertion order,
 * and a client retrying has made no promise about it. Array order is the
 * opposite: it is data, and normalising it would let `["a","b"]` replay as
 * `["b","a"]`.
 *
 * The `undefined` sentinel is a string rather than a fall-through to `"null"`,
 * because a POST with no body at all and a POST of the literal `null` are
 * different requests and JSON has one spelling for the second. A leading NUL
 * makes the sentinel unforgeable — `JSON.stringify` never emits one, so no real
 * body can collide with it — and it is written as an escape rather than typed
 * literally, because the raw byte makes this file binary to git and so
 * unreviewable in a diff.
 */
const canonicalise = (value: unknown): string => {
  if (value === undefined) return '\u0000no-body';

  return JSON.stringify(sortKeys(value));
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);

  // `null` is typeof 'object' and has no keys to sort; letting it through here
  // would mean `Object.keys(null)` a line later.
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;

  return Object.keys(source)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = sortKeys(source[key]);

      return sorted;
    }, {});
};
