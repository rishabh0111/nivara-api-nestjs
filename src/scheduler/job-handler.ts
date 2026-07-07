import { TenantClient } from '../tenancy/tenancy.service';

/**
 * The contract between the drainer and the work it drains.
 *
 * The drainer knows nothing about Slack, or about any integration that arrives
 * later. It knows how to claim a row, run something, and settle the outcome —
 * so a new kind of queued work is a registry entry, not an edit to the loop.
 */

/** A job's arguments, as they round-trip through a `jsonb` column. */
export type JobPayload = Record<string, unknown>;

/** What the drainer hands a handler, minus the payload it passes separately. */
export interface JobContext {
  /**
   * The transaction, already inside `withTenant()` under the job's own tenant.
   *
   * The handler therefore runs in ordinary isolation, with the ordinary
   * policies armed — the cross-tenant view the claim needed does not reach it.
   * Domain writes go here so they commit with nothing else pending.
   */
  tx: TenantClient;

  tenantId: string;

  /**
   * Which attempt this is, counting from one. A handler that wants to behave
   * differently on a last attempt — logging more, degrading rather than failing
   * — can see it without the drainer inventing a hook for it.
   */
  attempt: number;
  maxAttempts: number;
}

/**
 * One kind of queued work.
 *
 * Throwing is the failure signal, and the only one: the drainer catches, records
 * the message, and schedules a retry. There is no return value to inspect,
 * because a handler that "returned failure" would be a second failure channel
 * with the same meaning as the first.
 *
 * Handlers must be idempotent. Delivery is at-least-once by construction — a
 * process killed between finishing the work and settling the row leaves a job
 * whose lease expires and is handed out again — so an effect that cannot stand
 * being applied twice is a bug in the handler rather than a gap in the queue.
 */
export type JobHandler = (
  payload: JobPayload,
  context: JobContext,
) => Promise<void>;

/** The kinds this process can run, keyed by the `kind` column. */
export type JobHandlerRegistry = Readonly<Record<string, JobHandler>>;

/**
 * The injection token for the registry.
 *
 * A token rather than a class so a port, or a test, can supply its own set
 * without subclassing anything. It is empty today: the two kinds this queue was
 * built for — `inbound.event` and `outbound.delivery` — arrive with the Slack
 * adapter, and shipping stubs for them now would be inventing a contract for
 * work whose shape is not settled.
 */
export const JOB_HANDLERS = 'JOB_HANDLERS';

export const EMPTY_REGISTRY: JobHandlerRegistry = Object.freeze({});
