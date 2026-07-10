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
 * breaking change. `ticket.sla.breached` arrived that way and cost exactly the
 * three lines the design predicted — this array, a payload, an audience — with
 * the envelope, the rooms, and the sequencing already general over it.
 * `ticket.integration.failed` arrived on exactly those terms and cost exactly
 * those three lines, which is the second time the prediction held.
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
  'ticket.sla.breached',
  'ticket.integration.failed',
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

/** Which of a Ticket's two clocks ran out. */
export type SlaTimer = 'first_response' | 'resolution';

/**
 * A promise the tenant did not keep.
 *
 * Not a `TicketSnapshot`, and that is the point rather than an omission. The
 * three ticket events announce that a Ticket changed; this one announces that
 * *nothing* changed for too long, and the Ticket's columns are the same as they
 * were a second ago. A snapshot would invite a console to render it as an update
 * and diff away the only fact being reported.
 *
 * `breachedAt` is the latch value, not the emission time — the two differ by
 * however long the sweep took to notice, and a dashboard sorting by urgency
 * wants the former. It is also what makes the event replayable without becoming
 * a lie about when the deadline passed.
 */
export interface SlaBreachSnapshot {
  ticketId: string;
  timer: SlaTimer;
  breachedAt: string;
}

/**
 * A reply that did not reach the customer.
 *
 * The one event in this catalog that announces a failure of the system rather
 * than a fact about the domain, and its shape follows from the rule that governs
 * that: **notify, don't mutate**. Nothing about the Ticket changed — it was not
 * reopened, not escalated, not flagged — because a delivery giving up is a
 * problem with an integration and letting it edit support state would mean an
 * outage rewriting a tenant's queue. So the payload names the Message rather than
 * carrying a Ticket snapshot: there is no snapshot to send, because nothing moved.
 *
 * It is addressed to the agents room, which is the whole point of announcing it.
 * An agent who typed a reply and watched it post has no other way to learn it
 * never arrived — the Message is in the thread, the Ticket looks answered, and
 * the customer is still waiting. The `dead` delivery row is the durable record;
 * this is the tap on the shoulder.
 *
 * `error` is the far end's own words, and it is here rather than only in the log
 * because the remedies differ and an agent can act on some of them. "Channel not
 * found" means somebody removed the bot; a rate limit means try later; an auth
 * failure means an admin has work to do.
 */
export interface IntegrationFailureSnapshot {
  ticketId: string;
  messageId: string;
  /** Which adapter gave up — `slack` today. */
  source: string;
  /** Where it was trying to reach, as that adapter spells a destination. */
  target: string;
  error: string;
}

/** The payload each event carries, keyed by event name. */
export interface RealtimePayloads {
  'ticket.created': TicketSnapshot;
  'ticket.updated': TicketSnapshot;
  'ticket.assigned': TicketSnapshot;
  'message.created': ThreadEntrySnapshot;
  'note.created': ThreadEntrySnapshot;
  'ticket.sla.breached': SlaBreachSnapshot;
  'ticket.integration.failed': IntegrationFailureSnapshot;
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
  // The second staff-only entry, and for a different reason than the first. A
  // Note is staff-only because of what it contains; a breach is staff-only
  // because of what it admits. It only ever goes to the agents room, which a
  // Contact cannot join — so like `note.created`, this line is the backstop
  // rather than the barrier, and it is what makes a future mis-routed emit
  // deliver to nobody instead of telling a customer their ticket was missed.
  'ticket.sla.breached': 'staff',
  // The third staff-only entry, and the plainest of the three. A Note is
  // staff-only because of what it contains and a breach because of what it
  // admits; this one because it is addressed to the person who has to do
  // something. Telling a customer "we tried to answer you and could not" would
  // be worse than the silence it describes — they cannot act on it, and it
  // announces that a reply they never saw exists somewhere.
  'ticket.integration.failed': 'staff',
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
