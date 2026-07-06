import {
  audienceOf,
  canReceive,
  REALTIME_EVENTS,
  RealtimeEvent,
} from './events';
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

const contact: RealtimePrincipal = {
  kind: 'contact',
  tenantId: TENANT,
  contactId: 'c1',
};

describe('the event catalog', () => {
  it('is exactly the five events the contract publishes', () => {
    expect([...REALTIME_EVENTS]).toEqual([
      'ticket.created',
      'ticket.updated',
      'ticket.assigned',
      'message.created',
      'note.created',
    ]);
  });
});

describe('audience', () => {
  it('marks note.created, and only note.created, as staff-only', () => {
    const staffOnly = REALTIME_EVENTS.filter(
      (event) => audienceOf(event) === 'staff',
    );

    expect(staffOnly).toEqual(['note.created']);
  });

  it('lets staff receive every event in the catalog', () => {
    for (const event of REALTIME_EVENTS) {
      expect(canReceive(staff, event)).toBe(true);
    }
  });

  it.each([
    ['a widget visitor', widget],
    ['a signed-in Contact', contact],
  ])('withholds a Note from %s', (_label, principal) => {
    expect(canReceive(principal, 'note.created')).toBe(false);
  });

  it.each([
    ['a widget visitor', widget],
    ['a signed-in Contact', contact],
  ])('delivers customer-visible events to %s', (_label, principal) => {
    const customerVisible: RealtimeEvent[] = [
      'ticket.created',
      'ticket.updated',
      'ticket.assigned',
      'message.created',
    ];

    for (const event of customerVisible) {
      expect(canReceive(principal, event)).toBe(true);
    }
  });
});
