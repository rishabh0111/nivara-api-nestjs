import { ticketWhere, UNASSIGNED } from './ticket-filters';

/**
 * The filter allowlist, in isolation.
 *
 * Every claim here is about what reaches the database. An over-permissive
 * filter is not a crash — it is a query that quietly works, which is why this
 * is asserted on the emitted `where` rather than through an endpoint that
 * would answer 200 either way.
 */
const A_USER = '019f752b-b442-74ed-843d-aff38a2cbb46';
const A_CONTACT = '019f752b-b5a3-70e9-8e65-299c655f7706';

describe('ticketWhere', () => {
  describe('with nothing to filter on', () => {
    it('constrains nothing — the tenant policy is the only predicate', () => {
      expect(ticketWhere({})).toEqual({});
    });
  });

  describe('state', () => {
    it('matches a single state', () => {
      expect(ticketWhere({ state: 'open' })).toEqual({
        state: { in: ['open'] },
      });
    });

    /**
     * The queue view an agent actually wants — "everything still live" — is
     * several states, so a comma list is the difference between one request
     * and four.
     */
    it('matches any of a comma-separated set', () => {
      expect(ticketWhere({ state: 'open,pending,on_hold' })).toEqual({
        state: { in: ['open', 'pending', 'on_hold'] },
      });
    });

    it('refuses a value outside the enum', () => {
      expect(() => ticketWhere({ state: 'escalated' })).toThrow(
        expect.objectContaining({ code: 'invalid_filter' }),
      );
    });

    /**
     * One bad value in a list poisons the list. Silently dropping it would
     * answer a question the caller did not ask, and they would have no way to
     * tell from the response that it happened.
     */
    it('refuses a set containing an unknown value', () => {
      expect(() => ticketWhere({ state: 'open,escalated' })).toThrow(
        expect.objectContaining({ code: 'invalid_filter' }),
      );
    });
  });

  describe('priority', () => {
    it('matches any of a comma-separated set', () => {
      expect(ticketWhere({ priority: 'high,urgent' })).toEqual({
        priority: { in: ['high', 'urgent'] },
      });
    });

    it('refuses a value outside the enum', () => {
      expect(() => ticketWhere({ priority: 'critical' })).toThrow(
        expect.objectContaining({ code: 'invalid_filter' }),
      );
    });
  });

  describe('source', () => {
    it('matches any of a comma-separated set', () => {
      expect(ticketWhere({ source: 'widget,slack' })).toEqual({
        source: { in: ['widget', 'slack'] },
      });
    });

    it('refuses a value outside the enum', () => {
      expect(() => ticketWhere({ source: 'carrier-pigeon' })).toThrow(
        expect.objectContaining({ code: 'invalid_filter' }),
      );
    });
  });

  describe('assignee', () => {
    it('matches one assignee by id', () => {
      expect(ticketWhere({ assigneeId: A_USER })).toEqual({
        assigneeId: A_USER,
      });
    });

    /**
     * The triage queue. Untriaged is `assignee IS NULL` rather than a `new`
     * state, so there has to be a way to ask for it — and `assigneeId=` empty
     * would be indistinguishable from an omitted parameter.
     */
    it('matches unassigned tickets on the literal `none`', () => {
      expect(ticketWhere({ assigneeId: 'none' })).toEqual({
        assigneeId: null,
      });
    });

    /**
     * An id column is `uuid`, so a value that is not one cannot match any row
     * — but Postgres does not shrug at it, it raises a type error. Left to
     * reach the database it surfaces as a 500: the client's typo, reported as
     * the server's fault.
     */
    it('refuses an assignee id that is not a uuid', () => {
      expect(() => ticketWhere({ assigneeId: 'not-a-uuid' })).toThrow(
        expect.objectContaining({ code: 'invalid_filter' }),
      );
    });
  });

  describe('requester', () => {
    it('matches one Contact by id', () => {
      expect(ticketWhere({ contactId: A_CONTACT })).toEqual({
        contactId: A_CONTACT,
      });
    });

    it('refuses a Contact id that is not a uuid', () => {
      expect(() => ticketWhere({ contactId: 'not-a-uuid' })).toThrow(
        expect.objectContaining({ code: 'invalid_filter' }),
      );
    });
  });

  describe('creation window', () => {
    it('bounds below, above, and both at once', () => {
      const after = '2026-07-01T00:00:00.000Z';
      const before = '2026-07-18T00:00:00.000Z';

      expect(ticketWhere({ createdAfter: after })).toEqual({
        createdAt: { gte: new Date(after) },
      });

      expect(ticketWhere({ createdBefore: before })).toEqual({
        createdAt: { lte: new Date(before) },
      });

      expect(
        ticketWhere({ createdAfter: after, createdBefore: before }),
      ).toEqual({ createdAt: { gte: new Date(after), lte: new Date(before) } });
    });

    /**
     * An unparseable date would otherwise reach Prisma as `Invalid Date` and
     * surface as a 500 — the client's typo, reported as the server's fault.
     */
    it('refuses a timestamp it cannot parse', () => {
      expect(() => ticketWhere({ createdAfter: 'last tuesday' })).toThrow(
        expect.objectContaining({ code: 'invalid_filter' }),
      );
    });
  });

  describe('several filters at once', () => {
    it('combines them conjunctively', () => {
      expect(
        ticketWhere({
          state: 'open',
          priority: 'urgent',
          assigneeId: UNASSIGNED,
        }),
      ).toEqual({
        state: { in: ['open'] },
        priority: { in: ['urgent'] },
        assigneeId: null,
      });
    });
  });
});
