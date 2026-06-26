import { AppException } from 'src/common/errors/app-exception';
import { encodeCursor } from './cursor';
import { keysetPlan, SortableFields } from './keyset';
import { Sort } from './sort';

/**
 * The seek predicate, in isolation.
 *
 * This is the half of pagination that a database test can only observe
 * indirectly — `test/tickets.int-spec.ts` proves a traversal is stable under
 * concurrent inserts, but it cannot show *why*, and a subtly wrong tiebreak
 * (dropping the `id` term, say) still passes on a corpus with no ties. Here
 * the emitted `where` is the whole subject, so the tuple comparison is
 * asserted rather than inferred.
 */

const FIELDS: SortableFields = {
  createdAt: 'date',
  subject: 'scalar',
};

const newestFirst: Sort = { field: 'createdAt', direction: 'desc' };
const oldestFirst: Sort = { field: 'createdAt', direction: 'asc' };

const cursorAt = (sort: Sort, value: string, id: string): string =>
  encodeCursor({ sort, value, id });

describe('keysetPlan', () => {
  describe('ordering', () => {
    /**
     * The `id` tiebreak is not decoration. Two rows sharing a `createdAt` — a
     * bulk import, or simply a millisecond with two inserts in it — have no
     * defined order without it, so a traversal can show one twice and the
     * other never.
     */
    it('always orders by the sort field and then by id, in the same direction', () => {
      expect(keysetPlan(newestFirst, undefined, FIELDS).orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);

      expect(keysetPlan(oldestFirst, undefined, FIELDS).orderBy).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
    });

    it('does not repeat the id term when id is itself the sort field', () => {
      const plan = keysetPlan({ field: 'id', direction: 'desc' }, undefined, {
        id: 'scalar',
      });

      expect(plan.orderBy).toEqual([{ id: 'desc' }]);
    });
  });

  describe('the first page', () => {
    it('seeks from nowhere — there is no predicate to apply', () => {
      expect(keysetPlan(newestFirst, undefined, FIELDS).where).toBeUndefined();
    });
  });

  describe('seeking past a cursor', () => {
    /**
     * Postgres would express this as `(created_at, id) < (?, ?)`, but Prisma
     * has no row-value comparison — so the tuple is expanded by hand into
     * "strictly past the anchor's value, or level with it and past its id".
     * Both halves are load-bearing: without the first the traversal never
     * advances past a tie, without the second it skips every row that ties.
     */
    it('descends past the anchor row, breaking ties on id', () => {
      const at = '2026-07-18T10:00:00.000Z';
      const plan = keysetPlan(
        newestFirst,
        cursorAt(newestFirst, at, 'ticket-7'),
        FIELDS,
      );

      expect(plan.where).toEqual({
        OR: [
          { createdAt: { lt: new Date(at) } },
          { createdAt: new Date(at), id: { lt: 'ticket-7' } },
        ],
      });
    });

    it('ascends past the anchor row, breaking ties on id', () => {
      const at = '2026-07-18T10:00:00.000Z';
      const plan = keysetPlan(
        oldestFirst,
        cursorAt(oldestFirst, at, 'ticket-7'),
        FIELDS,
      );

      expect(plan.where).toEqual({
        OR: [
          { createdAt: { gt: new Date(at) } },
          { createdAt: new Date(at), id: { gt: 'ticket-7' } },
        ],
      });
    });

    it('compares a non-date field as the scalar it is', () => {
      const sort: Sort = { field: 'subject', direction: 'asc' };
      const plan = keysetPlan(sort, cursorAt(sort, 'Refund', 'ticket-7'), {
        ...FIELDS,
      });

      expect(plan.where).toEqual({
        OR: [
          { subject: { gt: 'Refund' } },
          { subject: 'Refund', id: { gt: 'ticket-7' } },
        ],
      });
    });

    it('drops the tiebreak term when id is itself the sort field', () => {
      const sort: Sort = { field: 'id', direction: 'desc' };
      const plan = keysetPlan(sort, cursorAt(sort, 'ticket-7', 'ticket-7'), {
        id: 'scalar',
      });

      expect(plan.where).toEqual({ id: { lt: 'ticket-7' } });
    });
  });

  describe('a cursor that does not belong to this query', () => {
    /**
     * Mixing two orderings mid-traversal yields a page that is neither — so
     * the cursor carries the sort it was issued under and a mismatch restarts
     * the traversal rather than silently returning nonsense.
     */
    it('is refused when the sort changed under it', () => {
      expect(() =>
        keysetPlan(newestFirst, cursorAt(oldestFirst, 'x', 'y'), FIELDS),
      ).toThrow(expect.objectContaining({ code: 'invalid_cursor' }));
    });

    it('is refused when it is not a cursor at all', () => {
      expect(() => keysetPlan(newestFirst, 'garbage', FIELDS)).toThrow(
        AppException,
      );
    });

    /**
     * A cursor naming a field this resource cannot sort by. It cannot arrive
     * from a cursor this API issued, so it is either a hand-forged one or a
     * cursor from another resource — and interpolating its field name into a
     * query is the one way this helper could be made to touch a column the
     * allowlist exists to keep it away from.
     */
    it('is refused when it names a field this resource cannot sort by', () => {
      const sort: Sort = { field: 'passwordHash', direction: 'desc' };

      expect(() => keysetPlan(sort, cursorAt(sort, 'x', 'y'), FIELDS)).toThrow(
        expect.objectContaining({ code: 'invalid_cursor' }),
      );
    });
  });
});
