/**
 * The room grammar, and the reason tenant isolation on the socket is a string
 * comparison rather than a query.
 *
 * Every room a client can subscribe to carries its tenant in its own name, so
 * the question "may this principal join this room?" reduces to "does the name's
 * tenant equal the token's tenant?" — see `can-join.ts`. That is a decision
 * about the *naming scheme*, not about the gate: a room called `agents` with the
 * tenant held somewhere alongside would make the gate a lookup, and a lookup is
 * a thing that can be skipped, cached wrong, or answered from the client's own
 * subscribe argument.
 *
 * Parsing is total and returns `null` rather than throwing, because a room name
 * is client input on every subscribe. An unparseable name is not an error
 * condition to distinguish; it is simply not a room, and it is refused by the
 * same path a well-formed room in another tenant is.
 */

/** What every room name begins with — `t` for tenant. */
export const ROOM_PREFIX = 't:';

/**
 * The three rooms, and there is deliberately no fourth.
 *
 * `agents` is the dashboard firehose, `ticket` is one thread as a customer may
 * see it, and `internal` is the staff-only sibling of that thread. The split
 * between the last two is the primary Note barrier: it is not a flag on an
 * event that some code has to honour, it is a room a widget's `canJoin` never
 * returns true for.
 */
export type RoomKind = 'agents' | 'ticket' | 'internal';

/** A room name taken apart. `ticketId` is present for everything but `agents`. */
export type Room =
  | { tenantId: string; kind: 'agents' }
  | { tenantId: string; kind: 'ticket' | 'internal'; ticketId: string };

/** The tenant-wide dashboard firehose: creations, assignments, updates. */
export const agentsRoom = (tenantId: string): string =>
  `${ROOM_PREFIX}${tenantId}:agents`;

/** One Ticket's customer-visible thread. */
export const ticketRoom = (tenantId: string, ticketId: string): string =>
  `${ROOM_PREFIX}${tenantId}:ticket:${ticketId}`;

/** One Ticket's staff-only sibling room, where Notes ride. */
export const internalRoom = (tenantId: string, ticketId: string): string =>
  `${ROOM_PREFIX}${tenantId}:ticket:${ticketId}:internal`;

/**
 * A room name reduced to its parts, or `null` if it is not one of ours.
 *
 * Strict about the *whole* name, not just its beginning. A prefix match would
 * accept `t:<tenant>:ticket:<id>:internal` as a `ticket` room — which is the one
 * confusion that matters here, since it would hand a widget the Note room under
 * a name its gate approves. Every branch below therefore checks the exact
 * segment count.
 *
 * The uuid check is not validation for its own sake. Ids are uuids everywhere in
 * this schema, so anything else cannot name a real tenant or Ticket; refusing it
 * here keeps arbitrary client strings from ever reaching the socket's room
 * registry, where they would otherwise accumulate as unbounded keys.
 */
export const parseRoom = (name: string): Room | null => {
  if (!name.startsWith(ROOM_PREFIX)) return null;

  const [tenantId, ...rest] = name.slice(ROOM_PREFIX.length).split(':');

  if (!isUuid(tenantId)) return null;

  if (rest.length === 1 && rest[0] === 'agents') {
    return { tenantId, kind: 'agents' };
  }

  if (rest[0] !== 'ticket') return null;

  const ticketId = rest[1];

  if (!isUuid(ticketId)) return null;

  if (rest.length === 2) return { tenantId, kind: 'ticket', ticketId };

  if (rest.length === 3 && rest[2] === 'internal') {
    return { tenantId, kind: 'internal', ticketId };
  }

  return null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const isUuid = (value: string | undefined): value is string =>
  value !== undefined && UUID.test(value);
