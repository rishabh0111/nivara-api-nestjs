import {
  canReceive,
  RealtimeEnvelope,
  RealtimeEvent,
  RealtimePayloads,
} from './events';
import { RealtimePrincipal } from './realtime-principal';

/**
 * How many envelopes a single room keeps for replay.
 *
 * Sized for the failure this exists to cover — a tab that slept, a laptop lid, a
 * train tunnel — not for a client that has been away long enough to have lost
 * the thread anyway. Two hundred entries on one Ticket is a conversation nobody
 * disconnected through; past that, refetching over REST is both correct and
 * cheaper than a socket replaying a backlog.
 */
const RETAIN_PER_ROOM = 200;

/**
 * How many rooms are remembered at all.
 *
 * The bound that actually matters, and the one that is easy to forget: rooms are
 * per-Ticket, so their *names* are unbounded over time even though each buffer
 * is not. Without this, a long-running process accumulates one entry per Ticket
 * ever touched.
 */
const MAX_ROOMS = 2_000;

export interface EventLogOptions {
  retainPerRoom?: number;
  maxRooms?: number;
}

/**
 * What a client gets back when it asks for what it missed.
 *
 * `gap` is the honest half. Replay is bounded, so "here is everything after your
 * cursor" is a promise this log cannot always keep, and a silent short answer
 * would leave a client believing it had caught up on a view that is quietly
 * stale — the exact failure the replay window exists to prevent. `gap: true`
 * means: discard what you have for this room and refetch it over REST.
 */
export interface Replay {
  events: RealtimeEnvelope[];
  gap: boolean;
}

/**
 * Per-room sequencing and the bounded history behind reconnect replay.
 *
 * In-memory and single-process, which is a real constraint rather than a
 * shortcut left unstated: two API processes would each number their own rooms
 * from one, and a client moving between them would see the sequence go
 * backwards. The seam for fixing that is this class — a Redis-backed
 * implementation gives `INCR` per room and a capped stream per room, and nothing
 * outside this file changes, because the gateway only ever calls `append` and
 * `replay`.
 *
 * Ordering is per-room and there is deliberately no global sequence. A global
 * one would have to be assigned under a single lock to mean anything, and it
 * would answer a question no client asks: nobody needs to know whether a Note on
 * one Ticket preceded a Message on another.
 *
 * Not `@Injectable()`, and constructed by a factory in `RealtimeModule`. It is a
 * data structure with tunable bounds rather than a service with collaborators,
 * so a container that tried to resolve its constructor would be trying to inject
 * `retainPerRoom`. Handing it to the container as a finished object keeps the
 * bounds where a test can pass its own without the module knowing.
 */
export class EventLog {
  private readonly retainPerRoom: number;
  private readonly maxRooms: number;

  /**
   * Insertion-ordered, and used as the LRU itself rather than alongside one.
   * `Map` iterates in insertion order, so "least recently written" is the first
   * key, and `append` re-inserting is what moves a room to the back.
   */
  private readonly rooms = new Map<string, RoomLog>();

  /**
   * The highest `seq` any evicted room had reached.
   *
   * One integer standing in for every counter this log has thrown away. See
   * `touch` — it is what keeps a resurrected room's numbering above its own
   * past without remembering the rooms themselves.
   */
  private evictedHighWater = 0;

  constructor(options: EventLogOptions = {}) {
    this.retainPerRoom = options.retainPerRoom ?? RETAIN_PER_ROOM;
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
  }

  /**
   * Assigns the next sequence number in a room and retains the envelope.
   *
   * Returns the envelope rather than publishing it, because numbering and
   * delivery are different concerns with different failure modes: a `seq` must
   * be assigned exactly once and in order, whereas delivery is at-least-once and
   * per-socket. Keeping them apart is also what lets the audience filter run at
   * delivery and again at replay against the *same* stored envelope.
   */
  append<E extends RealtimeEvent>(
    room: string,
    event: E,
    data: RealtimePayloads[E],
  ): RealtimeEnvelope<E> {
    const log = this.touch(room);
    const envelope: RealtimeEnvelope<E> = {
      event,
      room,
      seq: ++log.head,
      ts: new Date().toISOString(),
      data,
    };

    log.buffer.push(envelope);

    if (log.buffer.length > this.retainPerRoom) log.buffer.shift();

    return envelope;
  }

  /**
   * What this principal missed in this room after `afterSeq`.
   *
   * The audience filter runs here as well as on live delivery, and that is the
   * point rather than belt-and-braces for its own sake: a widget correctly
   * denied a Note while connected would otherwise be handed it on reconnect, and
   * "the leak arrives ninety seconds late" is not a smaller leak.
   *
   * Filtering leaves *holes* in the sequence a customer sees — 1, 3, 4 — and
   * that is deliberate. Renumbering per audience would mean the `seq` a client
   * stores is not the `seq` the server assigned, so two clients could not
   * compare cursors and a reconnect would ask for the wrong point. The contract
   * is therefore "seq is monotonic, not contiguous", which is all a client needs
   * to order and dedupe.
   *
   * A withheld event is not a gap for the same reason: the client received
   * everything it was ever entitled to.
   */
  replay(principal: RealtimePrincipal, room: string, afterSeq: number): Replay {
    const log = this.rooms.get(room);

    // A cursor of zero means "I have no history for this room" — a fresh
    // subscribe — so there is nothing that could have been missed. Only a client
    // claiming to have seen something can be told it is behind.
    if (!log) return { events: [], gap: afterSeq > 0 };

    const earliest = log.buffer[0]?.seq;
    const gap =
      afterSeq > 0 && (earliest === undefined || earliest > afterSeq + 1);

    return {
      events: log.buffer.filter(
        (envelope) =>
          envelope.seq > afterSeq && canReceive(principal, envelope.event),
      ),
      gap,
    };
  }

  /**
   * The room's log, created if new, moved to the back of the LRU either way.
   *
   * Eviction is where per-room monotonicity is nearly lost, and the high-water
   * mark is what saves it. Dropping a room takes its counter with it, so a room
   * written to again after eviction would restart at 1 — and a client still
   * holding a cursor of 50 would then discard every fresh event as a duplicate
   * on `(room, seq)`, silently and forever. The `gap` flag does not rescue that
   * case: with a buffer holding seq 1 and a cursor of 50, `replay` computes no
   * gap and reports "nothing new" over a hole.
   *
   * Seeding new rooms from `evictedHighWater` fixes it for a constant: every
   * room created after an eviction starts above the highest number *any* evicted
   * room ever issued, so a resurrected room cannot reuse one of its own. It
   * costs one integer rather than a counter per room name — the unbounded leak
   * keeping every counter would have been.
   *
   * The price is that `seq` is no longer "starts at 1" once a process has
   * evicted anything. That was never a promise worth keeping: the contract is
   * ordering and dedupe, both of which need monotonic and neither of which needs
   * dense or small.
   */
  private touch(room: string): RoomLog {
    const existing = this.rooms.get(room);

    if (existing) {
      this.rooms.delete(room);
      this.rooms.set(room, existing);

      return existing;
    }

    if (this.rooms.size >= this.maxRooms) {
      const oldest = this.rooms.keys().next();

      if (!oldest.done) {
        this.evictedHighWater = Math.max(
          this.evictedHighWater,
          this.rooms.get(oldest.value)?.head ?? 0,
        );
        this.rooms.delete(oldest.value);
      }
    }

    const fresh: RoomLog = { head: this.evictedHighWater, buffer: [] };

    this.rooms.set(room, fresh);

    return fresh;
  }
}

interface RoomLog {
  /** The highest sequence number assigned, retained past what the buffer holds. */
  head: number;
  buffer: RealtimeEnvelope[];
}
