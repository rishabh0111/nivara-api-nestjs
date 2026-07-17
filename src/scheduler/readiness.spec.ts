import { STALE_TICK_MULTIPLIER, evaluateReadiness } from './readiness';

const NOW = new Date('2026-07-19T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const FAST_MS = 3_000;
const SLOW_MS = 60_000;

/** Redis configured and answering — the uninteresting case, so a shared one. */
const REDIS_UP = { configured: true, reachable: true };

const ticking = (fastAgeMs = 0, slowAgeMs = 0) => ({
  enabled: true,
  ticks: [
    { name: 'fast', lastTickAt: ago(fastAgeMs), intervalMs: FAST_MS },
    { name: 'slow', lastTickAt: ago(slowAgeMs), intervalMs: SLOW_MS },
  ],
});

describe('evaluateReadiness', () => {
  it('is ready when the database answers and both ticks are current', () => {
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: REDIS_UP,
      scheduler: ticking(),
    });

    expect(result.status).toBe('ok');
    expect(result.scheduler.status).toBe('ok');
    expect(result.database.status).toBe('ok');
  });

  it('is not ready when the database is unreachable', () => {
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: false },
      redis: REDIS_UP,
      scheduler: ticking(),
    });

    expect(result.status).toBe('unavailable');
    expect(result.database.status).toBe('unavailable');
  });

  it('is not ready when a tick has stalled', () => {
    // The failure this endpoint exists for. A process serving HTTP with a dead
    // ticker looks perfectly healthy from outside and quietly stops doing
    // every timed thing the product promises.
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: REDIS_UP,
      scheduler: ticking(0, SLOW_MS * (STALE_TICK_MULTIPLIER + 1)),
    });

    expect(result.status).toBe('unavailable');
    expect(result.scheduler.status).toBe('stalled');
    expect(result.scheduler.ticks).toContainEqual(
      expect.objectContaining({ name: 'slow', status: 'stalled' }),
    );
    expect(result.scheduler.ticks).toContainEqual(
      expect.objectContaining({ name: 'fast', status: 'ok' }),
    );
  });

  it('judges each tick against its own interval', () => {
    // A fast drainer silent for a minute is wedged; a slow sweeper silent for
    // a minute is merely between ticks. One threshold for both would have to
    // pick which of those two mistakes to make.
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: REDIS_UP,
      scheduler: ticking(SLOW_MS, 0),
    });

    expect(result.status).toBe('unavailable');
    expect(result.scheduler.ticks).toContainEqual(
      expect.objectContaining({ name: 'fast', status: 'stalled' }),
    );
  });

  it('tolerates a few missed ticks before calling it a stall', () => {
    // Right at the boundary, and just inside it. A single skipped tick under
    // load is normal; readiness flapping on one is worse than useless.
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: REDIS_UP,
      scheduler: ticking(FAST_MS * STALE_TICK_MULTIPLIER, 0),
    });

    expect(result.status).toBe('ok');
  });

  it('reports the scheduler dormant, not stalled, when it is switched off', () => {
    // The API is fully functional with `RUN_SCHEDULER` off — that is the point
    // of the flag. Readiness must not report a ticker that was never meant to
    // run as a fault, or every scheduler-less deploy fails its health check.
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: REDIS_UP,
      scheduler: { enabled: false, ticks: [] },
    });

    expect(result.status).toBe('ok');
    expect(result.scheduler.status).toBe('disabled');
    expect(result.scheduler.ticks).toEqual([]);
  });

  it('is not ready when the scheduler is switched on but registered nothing', () => {
    // The flag asked for a ticker and this process has none — a bootstrap that
    // threw before registering. It is the most total failure available, so it
    // must not read as a healthy idle scheduler.
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: REDIS_UP,
      scheduler: { enabled: true, ticks: [] },
    });

    expect(result.status).toBe('unavailable');
    expect(result.scheduler.status).toBe('stalled');
  });

  it('reports a never-started ticker as stalled once it is overdue', () => {
    // A ticker that was enabled and then never fired at all is the same
    // outage as one that stopped, and must not read as healthy just because
    // there is no timestamp to find fault with.
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: REDIS_UP,
      scheduler: {
        enabled: true,
        ticks: [{ name: 'fast', lastTickAt: null, intervalMs: FAST_MS }],
      },
    });

    expect(result.status).toBe('unavailable');
    expect(result.scheduler.ticks[0]).toMatchObject({
      status: 'stalled',
      lastTickAt: null,
    });
  });

  it('reports Redis dormant, and stays ready, when it is not configured', () => {
    // The credential-free first run, and most of the test suite. Redis is an
    // optional dependency whose absence is a deliberate configuration rather
    // than a fault — a 503 here would make `docker compose up` report an
    // unhealthy service the moment REDIS_URL were left out.
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: { configured: false, reachable: false },
      scheduler: ticking(),
    });

    expect(result.status).toBe('ok');
    expect(result.redis.status).toBe('dormant');
  });

  it('reports Redis degraded — not unavailable — when it is configured and down', () => {
    // The one dependency that is reported without being judged, and the
    // asymmetry is the whole point of the word "degraded": an unreachable Redis
    // costs the deployment its ceilings, never its ability to answer.
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: { configured: true, reachable: false },
      scheduler: ticking(),
    });

    expect(result.status).toBe('ok');
    expect(result.redis.status).toBe('degraded');
  });

  it('distinguishes a Redis that is down from one that was never asked for', () => {
    // Both are "no ceilings are being enforced", and an operator needs to know
    // which — one is a deploy that is missing a variable, the other is a
    // provider that is down, and they have different fixes.
    const down = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: { configured: true, reachable: false },
      scheduler: ticking(),
    });

    const absent = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: { configured: false, reachable: false },
      scheduler: ticking(),
    });

    expect(down.redis.status).not.toEqual(absent.redis.status);
  });

  it('reports the age of each tick, so a stall is diagnosable from the response', () => {
    const result = evaluateReadiness({
      now: NOW,
      database: { reachable: true },
      redis: REDIS_UP,
      scheduler: ticking(4_500, 30_000),
    });

    expect(result.scheduler.ticks).toEqual([
      expect.objectContaining({ name: 'fast', ageSeconds: 4.5 }),
      expect.objectContaining({ name: 'slow', ageSeconds: 30 }),
    ]);
  });
});
