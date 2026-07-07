/**
 * Whether this process should be given traffic — the judgement half, kept pure.
 *
 * Readiness is the counterpart to liveness, and the split is deliberate:
 * `/health` answers 200 whenever the event loop is alive and touches nothing,
 * because it is the keep-warm ping and a database blip must not read as "this
 * process is dead". Dependency truth belongs here instead, where a 503 means
 * "route around me for now" rather than "restart me".
 *
 * The interesting failure is the one an HTTP check cannot otherwise see: a
 * process that serves requests perfectly while its ticker is wedged. Every timed
 * promise the product makes — SLA breach notices, the 7-day dwell transitions,
 * every queued outbound delivery — stops, and nothing about the API surface
 * looks wrong. So the ticker's own heartbeat is a dependency here, exactly like
 * Postgres.
 *
 * Nothing in this file reads a clock or a socket. The caller collects the facts;
 * this decides what they mean, which is what makes "returns 503 when the ticker
 * has stalled" a test that runs in a millisecond instead of one that waits.
 */

/**
 * How many intervals a tick may miss before it counts as stalled.
 *
 * Three, because one missed tick is normal under load and readiness that flaps
 * on it is worse than no readiness at all — a flapping probe teaches operators
 * to ignore it. Three consecutive misses is not scheduling jitter.
 */
export const STALE_TICK_MULTIPLIER = 3;

/** One ticker's last known heartbeat, and how often it is supposed to beat. */
export interface TickReport {
  name: string;
  /** Null when the ticker has been started but has not yet completed a tick. */
  lastTickAt: Date | null;
  intervalMs: number;
}

export interface SchedulerReport {
  /** Whether `RUN_SCHEDULER` put a ticker in this process at all. */
  enabled: boolean;
  ticks: TickReport[];
}

export interface ReadinessInput {
  now: Date;
  database: { reachable: boolean };
  scheduler: SchedulerReport;
}

export interface TickHealth {
  name: string;
  status: 'ok' | 'stalled';
  lastTickAt: string | null;
  /** Null only when the ticker has never beaten at all. */
  ageSeconds: number | null;
}

export interface DatabaseHealth {
  status: 'ok' | 'unavailable';
}

export interface SchedulerHealth {
  /** `disabled` is a healthy state, not a degraded one — see below. */
  status: 'ok' | 'stalled' | 'disabled';
  ticks: TickHealth[];
}

export interface Readiness {
  status: 'ok' | 'unavailable';
  database: DatabaseHealth;
  scheduler: SchedulerHealth;
}

const healthOf = (tick: TickReport, now: Date): TickHealth => {
  const stale = tick.intervalMs * STALE_TICK_MULTIPLIER;

  // A ticker that was enabled and never fired is the same outage as one that
  // stopped. Treating a missing timestamp as "no evidence of a problem" would
  // make the total failure the one case this endpoint cannot see.
  if (tick.lastTickAt === null) {
    return {
      name: tick.name,
      status: 'stalled',
      lastTickAt: null,
      ageSeconds: null,
    };
  }

  const ageMs = now.getTime() - tick.lastTickAt.getTime();

  return {
    name: tick.name,
    status: ageMs > stale ? 'stalled' : 'ok',
    lastTickAt: tick.lastTickAt.toISOString(),
    ageSeconds: ageMs / 1000,
  };
};

/**
 * Reduces the collected facts to a verdict.
 *
 * Each tick is judged against *its own* interval rather than a shared threshold.
 * A fast drainer silent for a minute is wedged; a slow sweeper silent for a
 * minute is simply between ticks, and a single threshold would have to choose
 * which of those two mistakes to make.
 *
 * A disabled scheduler is healthy. The `RUN_SCHEDULER` flag exists so the ticker
 * can be moved to its own service as a deploy change, and on the day that
 * happens every web instance runs without one — if that read as unready, the
 * flag would be unusable for the thing it was built for.
 */
export const evaluateReadiness = ({
  now,
  database,
  scheduler,
}: ReadinessInput): Readiness => {
  const ticks = scheduler.enabled
    ? scheduler.ticks.map((tick) => healthOf(tick, now))
    : [];

  // An enabled scheduler with no registered ticks is stalled, not idle. It
  // means the flag asked for a ticker and this process has none — a bootstrap
  // that threw before registering. Reading that as healthy would make the most
  // total failure available the one case the endpoint cannot see.
  const schedulerStatus = !scheduler.enabled
    ? 'disabled'
    : ticks.length === 0 || ticks.some((tick) => tick.status === 'stalled')
      ? 'stalled'
      : 'ok';

  const databaseStatus = database.reachable ? 'ok' : 'unavailable';

  return {
    status:
      databaseStatus === 'ok' && schedulerStatus !== 'stalled'
        ? 'ok'
        : 'unavailable',
    database: { status: databaseStatus },
    scheduler: { status: schedulerStatus, ticks },
  };
};
