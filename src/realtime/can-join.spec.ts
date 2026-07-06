import { canJoin } from './can-join';
import { RealtimePrincipal } from './realtime-principal';
import { agentsRoom, internalRoom, ticketRoom } from './rooms';

const TENANT = '4d0e7a1c-2b3f-4a5e-8c9d-0f1e2a3b4c5d';
const OTHER = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d';
const TICKET = 'c0ffee00-1111-4222-8333-444455556666';

const staff: RealtimePrincipal = {
  kind: 'user',
  tenantId: TENANT,
  userId: 'u1',
  role: 'agent',
};

const admin: RealtimePrincipal = { ...staff, role: 'admin', userId: 'u2' };

const widget: RealtimePrincipal = {
  kind: 'widget',
  tenantId: TENANT,
  sessionId: 's1',
  contactId: 'c1',
};

const contact: RealtimePrincipal = {
  kind: 'contact',
  tenantId: TENANT,
  contactId: 'c1',
};

describe('canJoin', () => {
  describe('the tenant gate', () => {
    it.each([
      ['the agents room', agentsRoom(OTHER)],
      ['a ticket room', ticketRoom(OTHER, TICKET)],
      ['the internal room', internalRoom(OTHER, TICKET)],
    ])('refuses staff %s of another tenant', (_label, room) => {
      expect(canJoin(staff, room)).toBe('deny');
    });

    it.each([
      ['a widget visitor', widget],
      ['a signed-in Contact', contact],
    ])('refuses %s a ticket room of another tenant', (_label, principal) => {
      expect(canJoin(principal, ticketRoom(OTHER, TICKET))).toBe('deny');
    });
  });

  describe('staff', () => {
    it.each([
      ['an agent', staff],
      ['an admin', admin],
    ])('admits %s to every room in their own tenant', (_label, principal) => {
      expect(canJoin(principal, agentsRoom(TENANT))).toBe('allow');
      expect(canJoin(principal, ticketRoom(TENANT, TICKET))).toBe('allow');
      expect(canJoin(principal, internalRoom(TENANT, TICKET))).toBe('allow');
    });

    it('admits staff to any Ticket without a requester check', () => {
      expect(canJoin(staff, ticketRoom(TENANT, TICKET))).toBe('allow');
    });
  });

  describe('the customer axis', () => {
    it.each([
      ['a widget visitor', widget],
      ['a signed-in Contact', contact],
    ])('refuses %s the agents firehose', (_label, principal) => {
      expect(canJoin(principal, agentsRoom(TENANT))).toBe('deny');
    });

    it.each([
      ['a widget visitor', widget],
      ['a signed-in Contact', contact],
    ])('refuses %s the internal Note room', (_label, principal) => {
      expect(canJoin(principal, internalRoom(TENANT, TICKET))).toBe('deny');
    });

    it.each([
      ['a widget visitor', widget],
      ['a signed-in Contact', contact],
    ])(
      'defers %s on their own tenant’s ticket room to a requester check',
      (_label, principal) => {
        expect(canJoin(principal, ticketRoom(TENANT, TICKET))).toBe(
          'requires-requester-match',
        );
      },
    );

    it('defers rather than admitting a visitor who has no Contact yet', () => {
      const anonymous: RealtimePrincipal = { ...widget, contactId: null };

      expect(canJoin(anonymous, ticketRoom(TENANT, TICKET))).toBe(
        'requires-requester-match',
      );
    });
  });

  describe('names that are not rooms', () => {
    it.each([
      ['an unparseable name', 'lobby'],
      ['a room with no tenant prefix', `${TENANT}:agents`],
      ['an unknown kind', `t:${TENANT}:dashboards`],
      ['an empty name', ''],
    ])('refuses staff %s', (_label, room) => {
      expect(canJoin(staff, room)).toBe('deny');
    });
  });
});
