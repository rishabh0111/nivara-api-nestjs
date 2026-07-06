import {
  agentsRoom,
  internalRoom,
  parseRoom,
  ticketRoom,
  ROOM_PREFIX,
} from './rooms';

const TENANT = '4d0e7a1c-2b3f-4a5e-8c9d-0f1e2a3b4c5d';
const OTHER = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d';
const TICKET = 'c0ffee00-1111-4222-8333-444455556666';

describe('room names', () => {
  it('prefixes every room with its tenant', () => {
    expect(agentsRoom(TENANT)).toBe(`${ROOM_PREFIX}${TENANT}:agents`);
    expect(ticketRoom(TENANT, TICKET)).toBe(
      `${ROOM_PREFIX}${TENANT}:ticket:${TICKET}`,
    );
    expect(internalRoom(TENANT, TICKET)).toBe(
      `${ROOM_PREFIX}${TENANT}:ticket:${TICKET}:internal`,
    );
  });

  it('round-trips each shape through the parser', () => {
    expect(parseRoom(agentsRoom(TENANT))).toEqual({
      tenantId: TENANT,
      kind: 'agents',
    });

    expect(parseRoom(ticketRoom(TENANT, TICKET))).toEqual({
      tenantId: TENANT,
      kind: 'ticket',
      ticketId: TICKET,
    });

    expect(parseRoom(internalRoom(TENANT, TICKET))).toEqual({
      tenantId: TENANT,
      kind: 'internal',
      ticketId: TICKET,
    });
  });

  it('reads the tenant out of the name rather than anywhere else', () => {
    expect(parseRoom(ticketRoom(OTHER, TICKET))?.tenantId).toBe(OTHER);
  });

  describe('refusals', () => {
    it.each([
      ['an empty string', ''],
      ['a name with no prefix', `${TENANT}:agents`],
      ['a foreign prefix', `x:${TENANT}:agents`],
      ['an unknown room kind', `${ROOM_PREFIX}${TENANT}:dashboards`],
      ['a tenant that is not a uuid', `${ROOM_PREFIX}not-a-uuid:agents`],
      ['a ticket id that is not a uuid', `${ROOM_PREFIX}${TENANT}:ticket:7`],
      ['an agents room with a suffix', `${ROOM_PREFIX}${TENANT}:agents:x`],
      ['a ticket room with no id', `${ROOM_PREFIX}${TENANT}:ticket`],
      [
        'an internal room with a foreign suffix',
        `${ROOM_PREFIX}${TENANT}:ticket:${TICKET}:private`,
      ],
      [
        'a trailing segment past :internal',
        `${ROOM_PREFIX}${TENANT}:ticket:${TICKET}:internal:x`,
      ],
    ])('rejects %s', (_label, name) => {
      expect(parseRoom(name)).toBeNull();
    });

    it('rejects a name whose tenant segment is empty', () => {
      expect(parseRoom(`${ROOM_PREFIX}:agents`)).toBeNull();
    });
  });
});
