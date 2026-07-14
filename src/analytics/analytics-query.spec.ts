import { AppException } from '../common/errors/app-exception';
import { DEFAULT_WINDOW_MS, planAnalytics } from './analytics-query';

/**
 * The window-and-group-by planner, in isolation.
 *
 * The claims here are about defaulting and rejection — the two things that
 * decide which rows the aggregate ever sees. A wrong default is not a crash, it
 * is a report over the wrong cohort that answers 200 all the same, so it is
 * asserted on the plan rather than through an endpoint.
 */
const NOW = new Date('2026-07-20T12:00:00.000Z');

describe('planAnalytics', () => {
  describe('the default window', () => {
    it('is the 30 days ending now when neither bound is given', () => {
      const plan = planAnalytics({}, NOW);

      expect(plan.to).toEqual(NOW);
      expect(plan.from).toEqual(new Date(NOW.getTime() - DEFAULT_WINDOW_MS));
      expect(plan.groupBy).toBeUndefined();
    });

    it('measures a defaulted `from` off the supplied `to`, not off the clock', () => {
      // "The thirty days ending then" — the reason `from` defaults off `to`
      // rather than off now.
      const to = '2026-06-01T00:00:00.000Z';
      const plan = planAnalytics({ to }, NOW);

      expect(plan.to).toEqual(new Date(to));
      expect(plan.from).toEqual(
        new Date(new Date(to).getTime() - DEFAULT_WINDOW_MS),
      );
    });

    it('runs a supplied `from` up to now when `to` is absent', () => {
      const from = '2026-01-01T00:00:00.000Z';
      const plan = planAnalytics({ from }, NOW);

      expect(plan.from).toEqual(new Date(from));
      expect(plan.to).toEqual(NOW);
    });
  });

  describe('window validation', () => {
    it('rejects a `from` that is not an instant', () => {
      expect(() => planAnalytics({ from: 'last-tuesday' }, NOW)).toThrow(
        AppException,
      );
    });

    it('rejects a `to` that is not an instant', () => {
      expect(() => planAnalytics({ to: 'soon' }, NOW)).toThrow(AppException);
    });

    it('rejects a reversed window', () => {
      expect(() =>
        planAnalytics(
          { from: '2026-07-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
          NOW,
        ),
      ).toThrow(AppException);
    });

    it('accepts a zero-width window — a single instant is a legal, empty cohort', () => {
      const at = '2026-07-01T00:00:00.000Z';

      expect(() => planAnalytics({ from: at, to: at }, NOW)).not.toThrow();
    });
  });

  describe('the group-by allowlist', () => {
    it.each(['priority', 'source', 'assignee', 'day'] as const)(
      'accepts %s',
      (axis) => {
        expect(planAnalytics({ groupBy: axis }, NOW).groupBy).toBe(axis);
      },
    );

    it('rejects anything outside the closed set', () => {
      expect(() => planAnalytics({ groupBy: 'contact' }, NOW)).toThrow(
        AppException,
      );
    });

    it('rejects an empty string rather than treating it as ungrouped', () => {
      expect(() => planAnalytics({ groupBy: '' }, NOW)).toThrow(AppException);
    });
  });
});
