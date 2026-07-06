import { Injectable } from '@nestjs/common';
import { Message, Note, Ticket } from '../generated/prisma/client';
import { EventLog } from './event-log';
import {
  RealtimeEvent,
  RealtimePayloads,
  ThreadEntrySnapshot,
  TicketSnapshot,
} from './events';
import { RealtimeGateway } from './realtime.gateway';
import { agentsRoom, internalRoom, ticketRoom } from './rooms';

/**
 * What the rest of the application announces through, and the only thing it
 * sees of the socket.
 *
 * Five methods named after the five events, taking domain rows and nothing else.
 * A caller does not choose a room, does not build an envelope, and does not
 * decide an audience — which is what keeps the routing rules in one file where
 * they can be read against the contract document, rather than scattered across
 * every service that has news.
 *
 * Every method is safe to call and safe to forget. Emission happens *after* the
 * transaction that produced the row has committed, so an announcement never
 * describes a state the database rolled back; and a delivery failure is logged
 * rather than raised, so a socket problem cannot fail a write that already
 * succeeded. The client's reconnect-and-replay path is what covers the gap that
 * leaves — which is the honest shape for at-least-once, rather than pretending
 * the socket is transactional.
 */
@Injectable()
export class RealtimeService {
  constructor(
    private readonly log: EventLog,
    private readonly gateway: RealtimeGateway,
  ) {}

  /**
   * A new Ticket, to the dashboard.
   *
   * The agents room only. Nobody is watching a Ticket's own room before it
   * exists, and a Contact learns about their own Ticket from the response to the
   * request that opened it.
   */
  async ticketCreated(ticket: Ticket): Promise<void> {
    await this.publish(
      agentsRoom(ticket.tenantId),
      'ticket.created',
      ticketSnapshot(ticket),
    );
  }

  /**
   * A changed Ticket, to the dashboard *and* to the Ticket's own room.
   *
   * The only event with two destinations, and it is two publishes rather than
   * one fan-out because `seq` is per-room: each copy is separately numbered in
   * the room it lands in, which is what lets a client watching both dedupe each
   * stream on its own terms. The same fact reaching one client twice under two
   * `(room, seq)` pairs is expected; a shared number across rooms would be the
   * thing that broke ordering.
   *
   * This is what a state transition, a priority change and a reopen all surface
   * as. There is no `ticket.state.changed`: the payload is a snapshot, so a
   * client diffs it against what it holds, and one event per column would have
   * meant a catalog that grows with the schema.
   */
  async ticketUpdated(ticket: Ticket): Promise<void> {
    const snapshot = ticketSnapshot(ticket);

    await this.publish(agentsRoom(ticket.tenantId), 'ticket.updated', snapshot);
    await this.publish(
      ticketRoom(ticket.tenantId, ticket.id),
      'ticket.updated',
      snapshot,
    );
  }

  /**
   * A Ticket handed to someone, or unassigned, to the dashboard.
   *
   * Separate from `ticket.updated` even though the payload is identical, because
   * "this is now yours" is the one Ticket change an agent's console reacts to
   * rather than merely re-renders. The dashboard room only: who is working a
   * Ticket is queue information, and a customer watching their own thread has no
   * business learning the tenant's staffing.
   */
  async ticketAssigned(ticket: Ticket): Promise<void> {
    await this.publish(
      agentsRoom(ticket.tenantId),
      'ticket.assigned',
      ticketSnapshot(ticket),
    );
  }

  /** A customer-visible entry, to the Ticket's customer-visible room. */
  async messageCreated(message: Message): Promise<void> {
    await this.publish(
      ticketRoom(message.tenantId, message.ticketId),
      'message.created',
      threadEntry(message),
    );
  }

  /**
   * An internal entry, to the room a widget can never join.
   *
   * The room is the primary barrier and the `staff` audience on the event is the
   * backstop; this line is where the first of the two is chosen, and it is the
   * line a mistake would live on. It is worth noticing that the mistake is
   * survivable: writing `ticketRoom` here would put a Note in front of nobody,
   * because `deliver` asks `canReceive` of every recipient on the way out.
   */
  async noteCreated(note: Note): Promise<void> {
    await this.publish(
      internalRoom(note.tenantId, note.ticketId),
      'note.created',
      threadEntry(note),
    );
  }

  private async publish<E extends RealtimeEvent>(
    room: string,
    event: E,
    data: RealtimePayloads[E],
  ): Promise<void> {
    await this.gateway.deliver(this.log.append(room, event, data));
  }
}

/**
 * A `Ticket` row as the wire carries it.
 *
 * Mapped explicitly rather than spread, for the reason the REST DTOs are: the
 * set of columns on the table and the set of fields on a published contract are
 * two different things that happen to overlap today, and a spread would publish
 * the next column somebody adds without anyone deciding to.
 *
 * Dates go out as ISO-8601 strings because that is what JSON has. `Date` objects
 * survive Socket.IO's default serializer, which would make the wire format
 * depend on the transport rather than on this contract.
 */
const ticketSnapshot = (ticket: Ticket): TicketSnapshot => ({
  id: ticket.id,
  subject: ticket.subject,
  state: ticket.state,
  priority: ticket.priority,
  source: ticket.source,
  contactId: ticket.contactId,
  assigneeId: ticket.assigneeId,
  spawnedFromTicketId: ticket.spawnedFromTicketId,
  rootTicketId: ticket.rootTicketId,
  createdAt: ticket.createdAt.toISOString(),
  updatedAt: ticket.updatedAt.toISOString(),
});

/** A `Message` or a `Note` row as the wire carries it — the same fields either way. */
const threadEntry = (entry: Message | Note): ThreadEntrySnapshot => ({
  id: entry.id,
  ticketId: entry.ticketId,
  body: entry.body,
  authorKind: entry.authorKind,
  authorId: entry.authorId,
  createdAt: entry.createdAt.toISOString(),
});
