import {
  TicketPriority,
  TicketSource,
  TicketState,
} from '../generated/prisma/client';
import { isStaff, RealtimePrincipal } from './realtime-principal';

/**
 * The published event set, in the order the contract document lists them.
 *
 * A closed catalog for the same reason `ERROR_CATALOG` is one: `nivara-web`
 * branches on these names, so adding one is a deliberate act belonging to the
 * ticket that introduces the fact being announced, and renaming one is a
 * breaking change. Tickets 15 and 17 add `ticket.sla.breached` and
 * `ticket.integration.failed` to this array and to nothing else — the envelope,
 * the rooms, and the sequencing are already general over it.
 *
 * Typing and presence are deliberately absent, and the envelope is what makes
 * adding them later cheap rather than a version bump.
 */
export const REALTIME_EVENTS = [
  'ticket.created',
  'ticket.updated',
  'ticket.assigned',
  'message.created',
  'note.created',
] as const;

export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];

/**
 * The Ticket as the socket announces it.
 *
 * A snapshot rather than a diff, and deliberately the same shape for all three
 * ticket events. A client that missed the previous state cannot apply a diff,
 * and a client that has it can compute one — so the snapshot is the shape that
 * works for both, and it makes replay after a disconnection meaningful instead
 * of a list of deltas against an unknown base.
 *
 * The event *name* is what says which fact changed. `ticket.assigned` carries no
 * `previousAssigneeId`, because the socket is a notification that something
 * moved, not the audit trail — that record exists, is append-only, and is read
 * over REST.
 *
 * The subject is here and the body of nothing is: a dashboard row needs the
 * subject to render, whereas conversation content rides its own events into
 * rooms with their own audiences.
 */
export interface TicketSnapshot {
  id: string;
  subject: string;
  state: TicketState;
  priority: TicketPriority;
  source: TicketSource;
  contactId: string;
  assigneeId: string | null;
  spawnedFromTicketId: string | null;
  rootTicketId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A thread entry as the socket announces it — one shape for Messages and Notes.
 *
 * The two payloads being identical is safe here precisely because nothing on
 * this surface decides *which* to send from a field: a Note is a Note because it
 * was emitted under `note.created` into the `:internal` room, not because a
 * discriminator on the payload says so. The separation that `MessageService` and
 * `NoteService` keep by never sharing a query is kept here by never sharing a
 * room.
 */
export interface ThreadEntrySnapshot {
  id: string;
  ticketId: string;
  body: string;
  authorKind: string;
  authorId: string | null;
  createdAt: string;
}

/** The payload each event carries, keyed by event name. */
export interface RealtimePayloads {
  'ticket.created': TicketSnapshot;
  'ticket.updated': TicketSnapshot;
  'ticket.assigned': TicketSnapshot;
  'message.created': ThreadEntrySnapshot;
  'note.created': ThreadEntrySnapshot;
}

/**
 * The wire envelope, identical for every event.
 *
 * Framework-neutral on purpose: nothing in this shape is a Socket.IO concept, so
 * the Spring and FastAPI ports re-implement the same semantics over whatever
 * server library they use and `nivara-web` cannot tell which one it is talking
 * to.
 *
 * `room` is carried inside the envelope even though the transport already routed
 * by it, because `seq` is meaningless without it — the sequence is per-room, so a
 * client dedupes on the pair `(room, seq)` and needs both in one object it can
 * store.
 *
 * `ts` is an ISO-8601 instant from the server's clock, for display and for
 * ordering across rooms where nothing stronger is available. It is explicitly not
 * the ordering authority within a room; `seq` is.
 */
export interface RealtimeEnvelope<E extends RealtimeEvent = RealtimeEvent> {
  event: E;
  room: string;
  seq: number;
  ts: string;
  data: RealtimePayloads[E];
}

/**
 * Who an event may reach, independent of which room carried it.
 *
 * This is the *second* Note barrier, and it earns its place by being redundant.
 * The first is structural — a widget's `canJoin` never returns true for an
 * `:internal` room — and if that were the only one, then a single mistake in a
 * future emit call, targeting a Note at the customer-visible thread room, would
 * be a leak with nothing to catch it. Here, that mistake delivers to nobody.
 *
 * Kept as a property of the *event* rather than of the room, deliberately. A
 * room-derived rule would say "the internal room is staff-only", which is
 * already true and already enforced; this says "a Note is staff-only wherever it
 * is found", which is the fact that actually needs to survive a mis-routed emit.
 */
export type Audience = 'all' | 'staff';

const AUDIENCE: Record<RealtimeEvent, Audience> = {
  'ticket.created': 'all',
  'ticket.updated': 'all',
  'ticket.assigned': 'all',
  'message.created': 'all',
  // The one entry that matters. A Note is what an agent suspects rather than
  // what they will say, and it rides the same conversation as the customer's
  // own messages — so "the thread" is exactly where a naive broadcast would put
  // it in front of them.
  'note.created': 'staff',
};

export const audienceOf = (event: RealtimeEvent): Audience => AUDIENCE[event];

/**
 * Whether this principal may be handed this event.
 *
 * Applied on delivery *and* on replay, because a bounded buffer replayed
 * wholesale would otherwise hand a reconnecting widget the Notes it was
 * correctly denied while it was connected — the same leak, arriving late.
 */
export const canReceive = (
  principal: RealtimePrincipal,
  event: RealtimeEvent,
): boolean => audienceOf(event) === 'all' || isStaff(principal);
