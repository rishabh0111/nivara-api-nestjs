import {
  IDLE_AFTER_MS,
  IDLE_TICK_MS,
  SchedulerActivity,
} from './scheduler-activity';
import { isHealthProbe } from './scheduler-activity.middleware';
import { SchedulerHeartbeat } from './scheduler-heartbeat';
import {
  FAST_TICK,
  FAST_TICK_MS,
  SLOW_TICK,
  SLOW_TICK_MS,
  SchedulerTicker,
} from './scheduler-ticker.service';

/** What the free database waits, with no query, before suspending compute. */
const DATABASE_SUSPEND_MS = 5 * 60_000;

describe('the idle clock', () => {
  it('counts boot as activity, so a fresh process ticks at full rate', () => {
    const activity = new SchedulerActivity();

    expect(activity.isIdle()).toBe(false);
  });

  it('goes idle once a full window passes with no request', () => {
    const activity = new SchedulerActivity();
    const start = Date.now();
    activity.touch(start);

    expect(activity.isIdle(start + IDLE_AFTER_MS)).toBe(false);
    expect(activity.isIdle(start + IDLE_AFTER_MS + 1)).toBe(true);
  });

  it('wakes the ticker on the first request after idle, and only then', () => {
    const activity = new SchedulerActivity();
    const woken = jest.fn();
    activity.whenWoken(woken);
    const start = Date.now();
    activity.touch(start);

    activity.touch(start + 1_000);
    expect(woken).not.toHaveBeenCalled();

    activity.touch(start + 1_000 + IDLE_AFTER_MS + 1);
    expect(woken).toHaveBeenCalledTimes(1);
  });

  it('lets the database suspend between idle ticks', () => {
    // The reason the idle rate exists: a tick more often than the database's
    // suspend window keeps it awake around the clock.
    expect(IDLE_TICK_MS).toBeGreaterThan(DATABASE_SUSPEND_MS * 2);
  });
});

describe('which requests count', () => {
  it.each(['/health', '/health/ready', '/health?x=1'])(
    'ignores the probe %s',
    (url) => expect(isHealthProbe(url)).toBe(true),
  );

  it.each(['/tickets', '/widget/sessions', '/healthcheck-ish', '/'])(
    'counts %s',
    (url) => expect(isHealthProbe(url)).toBe(false),
  );
});

describe('the ticker under idle and wake', () => {
  let activity: SchedulerActivity;
  let heartbeat: SchedulerHeartbeat;
  let drain: jest.Mock;
  let sweep: jest.Mock;
  let ticker: SchedulerTicker;

  beforeEach(async () => {
    jest.useFakeTimers();
    activity = new SchedulerActivity();
    heartbeat = new SchedulerHeartbeat();
    drain = jest.fn().mockResolvedValue(undefined);
    sweep = jest.fn().mockResolvedValue(undefined);
    ticker = new SchedulerTicker(
      { runScheduler: true } as never,
      heartbeat,
      { tick: drain } as never,
      { tick: sweep } as never,
      activity,
    );
    await ticker.onApplicationBootstrap();
  });

  afterEach(() => {
    ticker.onApplicationShutdown();
    jest.useRealTimers();
  });

  const intervals = () =>
    Object.fromEntries(heartbeat.report().map((t) => [t.name, t.intervalMs]));

  it('runs at the active rates while the API is in use', async () => {
    expect(intervals()).toEqual({
      [FAST_TICK]: FAST_TICK_MS,
      [SLOW_TICK]: SLOW_TICK_MS,
    });

    const before = drain.mock.calls.length;
    await jest.advanceTimersByTimeAsync(FAST_TICK_MS * 3);
    expect(drain.mock.calls.length - before).toBe(3);
  });

  it('backs both ticks off once idle, and tells readiness', async () => {
    await jest.advanceTimersByTimeAsync(IDLE_AFTER_MS + SLOW_TICK_MS * 2);

    expect(intervals()).toEqual({
      [FAST_TICK]: IDLE_TICK_MS,
      [SLOW_TICK]: IDLE_TICK_MS,
    });

    const before = drain.mock.calls.length;
    await jest.advanceTimersByTimeAsync(IDLE_TICK_MS - 1_000);
    expect(drain.mock.calls.length - before).toBeLessThanOrEqual(1);
  });

  it('drains at once and returns to full rate on the first request', async () => {
    await jest.advanceTimersByTimeAsync(IDLE_AFTER_MS + SLOW_TICK_MS * 2);
    const drained = drain.mock.calls.length;
    const swept = sweep.mock.calls.length;

    activity.touch();
    await jest.advanceTimersByTimeAsync(0);

    expect(drain.mock.calls.length).toBe(drained + 1);
    expect(sweep.mock.calls.length).toBe(swept + 1);
    expect(intervals()).toEqual({
      [FAST_TICK]: FAST_TICK_MS,
      [SLOW_TICK]: SLOW_TICK_MS,
    });
  });
});
