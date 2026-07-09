import { RequestPrincipal } from '../auth/request-principal';
import { httpScope, idempotencyContextFor } from './idempotency-scope';

const staff: RequestPrincipal = {
  kind: 'user',
  tenantId: 't-1',
  userId: 'u-1',
  role: 'agent',
};

const contact: RequestPrincipal = {
  kind: 'contact',
  tenantId: 't-1',
  contactId: 'c-1',
};

const service: RequestPrincipal = {
  kind: 'service',
  tenantId: 't-1',
  tokenId: 'k-1',
  scopes: [],
};

const visitor = (contactId: string | null): RequestPrincipal => ({
  kind: 'widget',
  tenantId: 't-1',
  sessionId: 'w-1',
  contactId,
});

/**
 * The scope is what keeps one caller from reading back another's cached
 * response, so these tests are really about isolation rather than about string
 * formatting. Two principals colliding on a scope is the leak; one principal
 * failing to produce a stable scope across its own retries is the duplicate.
 */
describe('httpScope', () => {
  it('is stable across a principal’s retries', () => {
    expect(httpScope(staff, 'POST', '/tickets')).toBe(
      httpScope({ ...staff }, 'POST', '/tickets'),
    );
  });

  it('separates two principals of the same kind', () => {
    expect(httpScope(contact, 'POST', '/portal/tickets')).not.toBe(
      httpScope({ ...contact, contactId: 'c-2' }, 'POST', '/portal/tickets'),
    );
  });

  it('separates principals of different kinds that share an id', () => {
    // A User and a Contact whose ids happen to collide are different callers,
    // and a scope built from the id alone would hand one the other's response.
    expect(httpScope(staff, 'POST', '/tickets')).not.toBe(
      httpScope(
        { kind: 'contact', tenantId: 't-1', contactId: 'u-1' },
        'POST',
        '/tickets',
      ),
    );
  });

  it('separates two requests by the same principal to different paths', () => {
    expect(httpScope(staff, 'POST', '/tickets')).not.toBe(
      httpScope(staff, 'POST', '/tickets/abc/notes'),
    );
  });

  it('distinguishes the concrete resource a sub-resource request addresses', () => {
    // The real path, not the route template: posting a message to ticket A and
    // to ticket B are different requests, and a template scope would make one
    // replayable as the other.
    expect(httpScope(staff, 'POST', '/tickets/a/messages')).not.toBe(
      httpScope(staff, 'POST', '/tickets/b/messages'),
    );
  });

  it('keys a widget visitor on the session, which outlives having no Contact', () => {
    // The whole reason the scope carries a session rather than an actor: the
    // first widget write happens before a Contact exists and the retry happens
    // after, and both must land on the same record or the retry opens a second
    // Ticket.
    expect(httpScope(visitor(null), 'POST', '/widget/tickets')).toBe(
      httpScope(visitor('c-9'), 'POST', '/widget/tickets'),
    );
  });

  it('separates two widget sessions', () => {
    expect(httpScope(visitor(null), 'POST', '/widget/tickets')).not.toBe(
      httpScope(
        { kind: 'widget', tenantId: 't-1', sessionId: 'w-2', contactId: null },
        'POST',
        '/widget/tickets',
      ),
    );
  });

  it('keys a service token on the token, not on the tenant', () => {
    expect(httpScope(service, 'POST', '/tickets')).not.toBe(
      httpScope({ ...service, tokenId: 'k-2' }, 'POST', '/tickets'),
    );
  });
});

describe('idempotencyContextFor', () => {
  it('attributes a record to the principal that claimed it', () => {
    expect(idempotencyContextFor(contact)).toEqual({
      tenantId: 't-1',
      actor: { kind: 'contact', id: 'c-1' },
    });
  });

  it('falls back to the system actor for a visitor with no Contact yet', () => {
    // Not a lie and not a bypass: the server really is claiming this key on
    // nobody's behalf, because the request that resolves the visitor into a
    // Contact is the one being guarded. Isolation is unaffected — it comes from
    // the session in the scope.
    expect(idempotencyContextFor(visitor(null))).toEqual({
      tenantId: 't-1',
      actor: { kind: 'system' },
    });
  });

  it('attributes a visitor who already has a Contact to that Contact', () => {
    expect(idempotencyContextFor(visitor('c-9'))).toEqual({
      tenantId: 't-1',
      actor: { kind: 'contact', id: 'c-9' },
    });
  });
});
