import { parseRoomName, parseSubscribe } from './subscribe-request';

const ROOM = 't:4d0e7a1c-2b3f-4a5e-8c9d-0f1e2a3b4c5d:agents';

describe('parseSubscribe', () => {
  it('reads a room with no cursor as a fresh subscribe', () => {
    expect(parseSubscribe({ room: ROOM })).toEqual({ room: ROOM, afterSeq: 0 });
  });

  it('reads a cursor when one is given', () => {
    expect(parseSubscribe({ room: ROOM, afterSeq: 12 })).toEqual({
      room: ROOM,
      afterSeq: 12,
    });
  });

  it('accepts an explicit zero cursor', () => {
    expect(parseSubscribe({ room: ROOM, afterSeq: 0 })?.afterSeq).toBe(0);
  });

  it.each([
    ['a non-object', 'lobby'],
    ['null', null],
    ['undefined', undefined],
    ['an array', [ROOM]],
    ['a missing room', {}],
    ['a non-string room', { room: 7 }],
    ['an empty room', { room: '' }],
    ['a negative cursor', { room: ROOM, afterSeq: -1 }],
    ['a fractional cursor', { room: ROOM, afterSeq: 1.5 }],
    ['a numeric-string cursor', { room: ROOM, afterSeq: '3' }],
    ['a NaN cursor', { room: ROOM, afterSeq: Number.NaN }],
    ['an infinite cursor', { room: ROOM, afterSeq: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_label, body) => {
    expect(parseSubscribe(body)).toBeNull();
  });

  it('does not validate the room name itself', () => {
    // Shape is this function's job; whether the name denotes a room this
    // principal may join is `canJoin`'s, and splitting them keeps one answer
    // out of the other's refusal.
    expect(parseSubscribe({ room: 'lobby' })).toEqual({
      room: 'lobby',
      afterSeq: 0,
    });
  });
});

describe('parseRoomName', () => {
  it('reads the room and ignores everything beside it', () => {
    expect(parseRoomName({ room: ROOM, afterSeq: 3 })).toBe(ROOM);
  });

  it('reads the room even when the cursor is nonsense', () => {
    // The whole reason this is separate from `parseSubscribe`: an unsubscribe
    // carrying a malformed cursor must still leave the room, because leaving is
    // not a capability and refusing it would strand the client subscribed.
    expect(parseRoomName({ room: ROOM, afterSeq: '3' })).toBe(ROOM);
    expect(parseRoomName({ room: ROOM, afterSeq: -1 })).toBe(ROOM);
  });

  it.each([
    ['a non-object', 'lobby'],
    ['null', null],
    ['an array', [ROOM]],
    ['a missing room', {}],
    ['an empty room', { room: '' }],
    ['a non-string room', { room: 7 }],
  ])('answers null for %s', (_label, body) => {
    expect(parseRoomName(body)).toBeNull();
  });
});
