/**
 * The keep-warm contract, in one place.
 *
 * Nothing in this file runs. It holds the two numbers a deployment is
 * configured against — how often something outside this process pings
 * `/health`, and how long the platform lets a service sit idle before it
 * sleeps — so that the relationship between them is checked by a test rather
 * than asserted in prose that ages.
 *
 * Why any of this exists: the scheduler runs in-process on the web service, so
 * a sleeping service is a stopped ticker, and a stopped ticker is every timed
 * promise the product makes quietly not happening. Inbound HTTP is what resets
 * the platform's idle timer, so a ping arriving faster than that timer keeps the
 * process — and therefore the ticker — alive.
 *
 * The ping targets liveness, which touches no dependency, and that pairing is
 * the point: a keep-warm ping that could fail on a database blip would let the
 * service sleep for a reason unrelated to whether it is running.
 *
 * **This is a schedule, not a correctness mechanism.** Nothing here is load
 * bearing for whether the right thing eventually happens. The sweeps fire on
 * state rather than on events — a set-once breach latch, a from-to transition
 * guard, a `runAfter` in the past — so a tick that does not happen at 12:00 does
 * the same work at 12:05 and reaches the same result. A missed ping therefore
 * delays sweep work; it cannot lose it. That is what makes it acceptable to
 * depend on an external pinger and on one platform's current idle behaviour.
 */

/**
 * How often the external pinger hits `/health`.
 *
 * Five minutes because it is the finest interval free uptime monitors offer,
 * and because — see the margin below — it is comfortably inside the idle
 * window rather than merely under it.
 */
export const KEEP_WARM_INTERVAL_MS = 5 * 60_000;

/**
 * How long the hosting platform tolerates no inbound request before sleeping
 * the service.
 *
 * A fact about somebody else's product, recorded here because the ping interval
 * is meaningless without it. If a platform ever shortens this below the ping
 * interval, the failure is a ticker that naps between pings — visible as a
 * stalled tick on `/health/ready`, and answered by moving the scheduler to its
 * own always-on service behind `RUN_SCHEDULER`.
 */
export const PLATFORM_IDLE_WINDOW_MS = 15 * 60_000;
