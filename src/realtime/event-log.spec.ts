import { RealtimeEvent, TicketSnapshot } from './events';
import { EventLog } from './event-log';
import { RealtimePrincipal } from './realtime-principal';

const TENANT = '4d0e7a1c-2b3f-4a5e-8c9d-0f1e2a3b4c5d';

const staff: RealtimePrincipal = {
  kind: 'user',
  tenantId: TENANT,
  userId: 'u1',
  role: 'agent',
};

const widget: RealtimePrincipal = {
  kind: 'widget',
  tenantId: TENANT,
  sessionId: 's1',
  contactId: 'c1',
};

/** A stand-in payload — the log never reads inside `data`. */
const payload = { id: 'x' } as unknown as TicketSnapshot;

const ROOM = `t:${TENANT}:ticket:c0ffee00-1111-4222-8333-444455556666`;
const OTHER_ROOM = `t:${TENANT}:agents`;

describe('EventLog', () => {
  const append = (log: EventLog, room: string, event: RealtimeEvent) =>
    log.append(room, event, payload);

  describe('sequencing', () => {
    it('numbers a room from one, monotonically', () => {
      const log = new EventLog();

      expect(append(log, ROOM, 'ticket.created').seq).toBe(1);
      expect(append(log, ROOM, 'ticket.updated').seq).toBe(2);
      expect(append(log, ROOM, 'message.created').seq).toBe(3);
    });

    it('sequences each room independently', () => {
      const log = new EventLog();

      append(log, ROOM, 'ticket.created');
      append(log, ROOM, 'ticket.updated');

      expect(append(log, OTHER_ROOM, 'ticket.created').seq).toBe(1);
      expect(append(log, ROOM, 'message.created').seq).toBe(3);
    });

    it('stamps the envelope with its room, event and an instant', () => {
      const log = new EventLog();
      const envelope = append(log, ROOM, 'message.created');

      expect(envelope.room).toBe(ROOM);
      expect(envelope.event).toBe('message.created');
      expect(envelope.data).toBe(payload);
      expect(Date.parse(envelope.ts)).not.toBeNaN();
    });

    it('keeps numbering past the retention window', () => {
      const log = new EventLog({ retainPerRoom: 3 });

      for (let i = 0; i < 10; i++) append(log, ROOM, 'ticket.updated');

      expect(append(log, ROOM, 'ticket.updated').seq).toBe(11);
    });
  });

  describe('replay', () => {
    it('returns nothing and reports no gap for a room with no history', () => {
      const log = new EventLog();

      expect(log.replay(staff, ROOM, 0)).toEqual({ events: [], gap: false });
    });

    it('returns only events after the cursor', () => {
      const log = new EventLog();

      append(log, ROOM, 'ticket.created');
      append(log, ROOM, 'ticket.updated');
      append(log, ROOM, 'message.created');

      const { events, gap } = log.replay(staff, ROOM, 1);

      expect(gap).toBe(false);
      expect(events.map((e) => e.seq)).toEqual([2, 3]);
    });

    it('returns the whole retained history from a zero cursor', () => {
      const log = new EventLog();

      append(log, ROOM, 'ticket.created');
      append(log, ROOM, 'ticket.updated');

      expect(log.replay(staff, ROOM, 0).events.map((e) => e.seq)).toEqual([
        1, 2,
      ]);
    });

    it('returns nothing for a cursor already at the head', () => {
      const log = new EventLog();

      append(log, ROOM, 'ticket.created');

      expect(log.replay(staff, ROOM, 1)).toEqual({ events: [], gap: false });
    });

    it('never replays another room’s events', () => {
      const log = new EventLog();

      append(log, OTHER_ROOM, 'ticket.created');

      expect(log.replay(staff, ROOM, 0).events).toEqual([]);
    });
  });

  describe('the retention bound', () => {
    it('drops the oldest events once the window is full', () => {
      const log = new EventLog({ retainPerRoom: 3 });

      for (let i = 0; i < 5; i++) append(log, ROOM, 'ticket.updated');

      expect(log.replay(staff, ROOM, 0).events.map((e) => e.seq)).toEqual([
        3, 4, 5,
      ]);
    });

    it('reports a gap when the cursor fell out of the window', () => {
      const log = new EventLog({ retainPerRoom: 3 });

      for (let i = 0; i < 5; i++) append(log, ROOM, 'ticket.updated');

      // The client last saw seq 1; seq 2 is gone, so what it gets back is not
      // the complete tail it asked for.
      expect(log.replay(staff, ROOM, 1)).toMatchObject({ gap: true });
    });

    it('reports no gap when the cursor is still inside the window', () => {
      const log = new EventLog({ retainPerRoom: 3 });

      for (let i = 0; i < 5; i++) append(log, ROOM, 'ticket.updated');

      expect(log.replay(staff, ROOM, 2)).toMatchObject({ gap: false });
    });

    it('reports a gap for a positive cursor on a room it has never seen', () => {
      const log = new EventLog();

      expect(log.replay(staff, ROOM, 7)).toEqual({ events: [], gap: true });
    });

    it('forgets the least recently written room once the room bound is hit', () => {
      const log = new EventLog({ maxRooms: 2 });
      const rooms = ['a', 'b', 'c'].map((n) => `t:${TENANT}:ticket:${n}`);

      append(log, rooms[0], 'ticket.created');
      append(log, rooms[1], 'ticket.created');
      append(log, rooms[2], 'ticket.created');

      // The eviction is announced as a gap rather than hidden by a silently
      // restarted sequence, which is the only thing that keeps a reconnecting
      // client from discarding fresh events as duplicates.
      expect(log.replay(staff, rooms[0], 1)).toEqual({ events: [], gap: true });
      expect(log.replay(staff, rooms[1], 0).events).toHaveLength(1);
    });

    it('never restarts a resurrected room’s sequence below what it issued', () => {
      const log = new EventLog({ maxRooms: 2 });
      const rooms = ['a', 'b', 'c'].map((n) => `t:${TENANT}:ticket:${n}`);

      append(log, rooms[0], 'ticket.created');
      const lastBeforeEviction = append(log, rooms[0], 'ticket.updated').seq;

      // Push rooms[0] out of the LRU entirely...
      append(log, rooms[1], 'ticket.created');
      append(log, rooms[2], 'ticket.created');

      // ...then write to it again. A client still holding the old cursor must
      // not be handed a number it has already seen, or it will discard a fresh
      // event as a duplicate on `(room, seq)`.
      expect(append(log, rooms[0], 'message.created').seq).toBeGreaterThan(
        lastBeforeEviction,
      );
    });

    it('does not tell a stale cursor it is caught up after a resurrection', () => {
      const log = new EventLog({ maxRooms: 2 });
      const rooms = ['a', 'b', 'c'].map((n) => `t:${TENANT}:ticket:${n}`);

      append(log, rooms[0], 'ticket.created');
      const cursor = append(log, rooms[0], 'ticket.updated').seq;

      append(log, rooms[1], 'ticket.created');
      append(log, rooms[2], 'ticket.created');
      append(log, rooms[0], 'message.created');

      const { events, gap } = log.replay(staff, rooms[0], cursor);

      // Either it hands back the event it missed, or it admits the gap. What it
      // must never do is answer "nothing new" over a hole.
      expect(events.length > 0 || gap).toBe(true);
    });

    it('counts a write as use, so an active room is not evicted', () => {
      const log = new EventLog({ maxRooms: 2 });
      const rooms = ['a', 'b', 'c'].map((n) => `t:${TENANT}:ticket:${n}`);

      append(log, rooms[0], 'ticket.created');
      append(log, rooms[1], 'ticket.created');
      append(log, rooms[0], 'ticket.updated');
      append(log, rooms[2], 'ticket.created');

      expect(log.replay(staff, rooms[0], 0).events).toHaveLength(2);
      expect(log.replay(staff, rooms[1], 1)).toEqual({ events: [], gap: true });
    });
  });

  describe('the audience filter on replay', () => {
    it('withholds a Note from a widget while keeping the Messages', () => {
      const log = new EventLog();

      append(log, ROOM, 'message.created');
      append(log, ROOM, 'note.created');
      append(log, ROOM, 'message.created');

      const { events } = log.replay(widget, ROOM, 0);

      expect(events.map((e) => e.event)).toEqual([
        'message.created',
        'message.created',
      ]);
    });

    it('replays a Note to staff', () => {
      const log = new EventLog();

      append(log, ROOM, 'note.created');

      expect(log.replay(staff, ROOM, 0).events.map((e) => e.event)).toEqual([
        'note.created',
      ]);
    });

    it('leaves the withheld event’s seq missing rather than renumbering', () => {
      const log = new EventLog();

      append(log, ROOM, 'message.created');
      append(log, ROOM, 'note.created');
      append(log, ROOM, 'message.created');

      expect(log.replay(widget, ROOM, 0).events.map((e) => e.seq)).toEqual([
        1, 3,
      ]);
    });

    it('does not call a filtered-out event a gap', () => {
      const log = new EventLog();

      append(log, ROOM, 'note.created');

      expect(log.replay(widget, ROOM, 0)).toEqual({ events: [], gap: false });
    });
  });
});
