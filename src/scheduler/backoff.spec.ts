import {
  BASE_BACKOFF_MS,
  JITTER_RATIO,
  MAX_BACKOFF_MS,
  backoffMs,
  nextRunAfter,
} from './backoff';

/** Pins the jitter so a delay is a number rather than a range. */
const noJitter = () => 0.5;
const minJitter = () => 0;
const maxJitter = () => 1;

describe('backoffMs', () => {
  it('doubles with each attempt', () => {
    const delays = [1, 2, 3, 4].map((attempts) =>
      backoffMs(attempts, noJitter),
    );

    expect(delays).toEqual([
      BASE_BACKOFF_MS,
      BASE_BACKOFF_MS * 2,
      BASE_BACKOFF_MS * 4,
      BASE_BACKOFF_MS * 8,
    ]);
  });

  it('caps rather than growing without bound', () => {
    // The cap is the whole reason to prefer a bounded schedule: an integration
    // down for a day should be retried every fifteen minutes, not next year.
    expect(backoffMs(50, noJitter)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(500, noJitter)).toBe(MAX_BACKOFF_MS);
  });

  it('stays finite at attempt counts that would overflow a naive shift', () => {
    expect(Number.isFinite(backoffMs(1024, noJitter))).toBe(true);
  });

  it('spreads a batch across a window rather than retrying in lockstep', () => {
    // Jitter is not decoration. Ten jobs failing on the same outage would
    // otherwise all come back at the same instant and hammer it together.
    const low = backoffMs(3, minJitter);
    const high = backoffMs(3, maxJitter);

    expect(low).toBeLessThan(high);
    expect(low).toBeCloseTo(BASE_BACKOFF_MS * 4 * (1 - JITTER_RATIO), 0);
    expect(high).toBeCloseTo(BASE_BACKOFF_MS * 4 * (1 + JITTER_RATIO), 0);
  });

  it('never returns a delay that would retry in the past', () => {
    const delays = Array.from({ length: 200 }, () => backoffMs(1, Math.random));

    expect(Math.min(...delays)).toBeGreaterThan(0);
  });

  it('treats a first failure as attempt one', () => {
    // Guards the off-by-one that would make the first retry instant.
    expect(backoffMs(0, noJitter)).toBe(BASE_BACKOFF_MS);
  });
});

describe('nextRunAfter', () => {
  it('is a future instant, which is the whole retry mechanism', () => {
    // The retry is a later `run_after`, not a sleeping worker — so this
    // function returning a Date is the entire backoff implementation.
    const now = new Date('2026-07-19T12:00:00.000Z');

    expect(nextRunAfter(1, now, noJitter)).toEqual(
      new Date(now.getTime() + BASE_BACKOFF_MS),
    );
  });

  it('leaves the clock it was given alone', () => {
    const now = new Date('2026-07-19T12:00:00.000Z');
    nextRunAfter(4, now, noJitter);

    expect(now).toEqual(new Date('2026-07-19T12:00:00.000Z'));
  });
});
