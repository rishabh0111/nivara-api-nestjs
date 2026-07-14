import { AppException } from '../common/errors/app-exception';

/**
 * The closed group-by set, and the whole of it.
 *
 * Four axes, each a single indexed column on `ticket`, composing as one
 * `GROUP BY`. Deliberately not an open-ended query builder: an arbitrary
 * group-by is a mini query-product, which is a data-export surface wearing an
 * analytics hat — exactly what this endpoint is defined not to be. A caller
 * naming anything outside this list is a 400 rather than a silently ignored
 * parameter, on the same rule the ticket filters follow.
 *
 * `day` is the one axis that is not a bare column: it is the daily bucket
 * `date_trunc('day', created_at)` the trend series reads, and it is named here
 * beside the columns rather than treated as a special case because to a caller
 * it is just another cut.
 */
export const GROUP_BY_AXES = ['priority', 'source', 'assignee', 'day'] as const;

/**
 * A validated group-by axis, narrowed from the request string to the closed
 * set. Downstream — the SQL group expression, the response `groupBy` field — is
 * typed against this rather than `string`, so an axis the planner did not admit
 * cannot reach a query.
 */
export type GroupBy = (typeof GROUP_BY_AXES)[number];

/** The default cohort span: the last 30 days, anchored on creation time. */
export const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A validated analytics request: a half-open cohort window `[from, to)` on
 * `created_at`, and at most one group-by axis.
 *
 * `from`/`to` are `Date` rather than strings by the time they leave here, so
 * the service never re-parses and a malformed instant fails at the edge with a
 * catalogued code rather than as a Postgres error mid-query.
 */
export interface AnalyticsPlan {
  from: Date;
  to: Date;
  groupBy?: GroupBy;
}

/** The raw query surface of `GET /analytics`, exactly the parameters it declares. */
export interface AnalyticsQueryInput {
  from?: string;
  to?: string;
  groupBy?: string;
}

/**
 * Turns the request's parameters into a plan, defaulting and validating.
 *
 * The window defaults to the last 30 days: `to` is now, `from` is thirty days
 * before whichever `to` is in force. Supplying one bound and not the other is
 * meaningful — a `from` alone means "since then until now", a `to` alone means
 * "the thirty days ending then" — which is why the default for `from` is
 * measured off `to` rather than off the clock.
 *
 * `now` is a parameter rather than read here, so "what would this report have
 * said last Tuesday" is a question a test can ask and the default window is
 * deterministic under one.
 *
 * Every rejection is `invalid_filter`: an unparseable instant, a reversed
 * window, and an unknown group-by are all the same kind of failure — a
 * well-formed request naming a value outside what this resource accepts — and
 * the catalog already has one code for exactly that.
 */
export const planAnalytics = (
  input: AnalyticsQueryInput,
  now: Date = new Date(),
): AnalyticsPlan => {
  const to = input.to === undefined ? now : parseInstant(input.to, 'to');
  const from =
    input.from === undefined
      ? new Date(to.getTime() - DEFAULT_WINDOW_MS)
      : parseInstant(input.from, 'from');

  if (from.getTime() > to.getTime()) {
    throw new AppException(
      'invalid_filter',
      '`from` is after `to`: the cohort window is empty. Give a range where `from` is at or before `to`.',
    );
  }

  return { from, to, groupBy: parseGroupBy(input.groupBy) };
};

/**
 * An ISO-8601 instant, or the refusal a malformed one earns.
 *
 * `Date.parse` is deliberately not trusted on its own — it accepts a bare
 * `'2026'` and a swathe of locale strings — so the parsed value is round-tripped
 * back through `toISOString()` semantics by rejecting `NaN` only. The value a
 * caller sends is an instant on the cohort anchor, and anything that is not one
 * is a 400 rather than a window that silently starts at the epoch.
 */
const parseInstant = (raw: string, field: 'from' | 'to'): Date => {
  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    throw new AppException(
      'invalid_filter',
      `\`${field}\` is not a valid ISO-8601 instant.`,
    );
  }

  return parsed;
};

/** A group-by axis from the closed set, `undefined` for the ungrouped report, or a 400. */
const parseGroupBy = (raw: string | undefined): GroupBy | undefined => {
  if (raw === undefined) return undefined;

  if (!isGroupBy(raw)) {
    throw new AppException(
      'invalid_filter',
      `\`groupBy\` must be one of: ${GROUP_BY_AXES.join(', ')}.`,
    );
  }

  return raw;
};

const isGroupBy = (value: string): value is GroupBy =>
  (GROUP_BY_AXES as readonly string[]).includes(value);
