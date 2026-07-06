/**
 * The one message a client sends, and the shape check on it.
 *
 * A socket frame arrives as whatever the client serialized, with none of the
 * validation pipeline an HTTP body goes through — so this is the equivalent of
 * the DTO layer, written out because there is no decorator that would run here.
 *
 * It checks shape and nothing else. Whether the name denotes a room, and whether
 * this principal may join it, are two further questions answered by `parseRoom`
 * and `canJoin`; keeping them apart is what lets the gate's refusals stay
 * uniform instead of leaking "that was well-formed but forbidden" as a
 * distinguishable answer from "that was gibberish".
 */
export interface SubscribeRequest {
  room: string;
  /**
   * The highest `seq` this client has already seen in that room, or zero.
   *
   * Zero is "I have no history", not "replay everything" — the two coincide
   * today because the buffer is small, and the distinction is what a client
   * relies on after being told `gap: true`: it drops its cursor back to zero and
   * treats what follows as a fresh start behind a REST refetch.
   */
  afterSeq: number;
}

/**
 * The room named by a client message, ignoring everything else on it.
 *
 * What `unsubscribe` needs, and the reason it does not reuse `parseSubscribe`:
 * leaving is not a capability, so a malformed cursor on an unsubscribe should
 * not be able to keep a client in a room. Running the stricter parse there meant
 * `{ room, afterSeq: "3" }` acknowledged a leave that never happened.
 */
export const parseRoomName = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }

  const { room } = body as Record<string, unknown>;

  return typeof room === 'string' && room !== '' ? room : null;
};

export const parseSubscribe = (body: unknown): SubscribeRequest | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }

  const { room, afterSeq } = body as Record<string, unknown>;

  if (typeof room !== 'string' || room === '') return null;

  if (afterSeq === undefined) return { room, afterSeq: 0 };

  // A non-negative integer, and refused rather than coerced. A cursor that
  // arrived as `"3"` is a client bug, and quietly accepting it would mean the
  // one case that matters — a cursor this server never issued — is also being
  // guessed at rather than refused.
  if (
    typeof afterSeq !== 'number' ||
    !Number.isSafeInteger(afterSeq) ||
    afterSeq < 0
  ) {
    return null;
  }

  return { room, afterSeq };
};
