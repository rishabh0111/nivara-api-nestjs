/**
 * Who a unit of work is being done *for*, and *by*.
 *
 * Both halves are load-bearing and both are server-determined. `tenantId` comes
 * from a validated credential — never from a request body, a path parameter, or
 * a header a caller controls — and arms the row-level security policies. The
 * actor is what the audit trail records, so it can no more be guessed than the
 * tenant can.
 */

/** The kinds of thing that can act. Closed, and mirrored by the audit trail. */
export const ACTOR_KINDS = ['user', 'contact', 'service', 'system'] as const;

export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * `system` is the one actor without an id — there is no row to point at when
 * the scheduler or a database trigger acts. It is set explicitly at the call
 * site and never inferred from an absent actor, because "nobody supplied one"
 * and "the system did it" are different facts and only one of them is a bug.
 */
export type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'contact'; id: string }
  | { kind: 'service'; id: string }
  | { kind: 'system' };

export interface TenantContext {
  tenantId: string;
  actor: Actor;
}

/**
 * A context that cannot be armed.
 *
 * Always a programming error rather than bad user input: every field is
 * server-determined, so a malformed one means a call site skipped the
 * credential. It deliberately does not extend `AppException` — there is no
 * error code for it, and it should surface as a 500 rather than be caught and
 * reported as though the caller could fix it.
 */
export class InvalidTenantContextError extends Error {
  constructor(problem: string) {
    super(`Cannot arm tenant context: ${problem}.`);
    this.name = 'InvalidTenantContextError';
  }
}

/** The three transaction-local settings a tenant-scoped transaction opens with. */
export interface ContextSettings {
  tenantId: string;
  actorKind: ActorKind;
  /** Empty for the `system` actor, which has no row to point at. */
  actorId: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates a context and reduces it to the settings the policies read.
 *
 * Separated from the transaction that issues them so the rules are testable
 * without a database, and so `withTenant()` fails *before* opening a
 * transaction rather than midway through one.
 *
 * The tenant id is checked for uuid shape here even though it is sent as a
 * bound parameter. The policies cast it with `::uuid`, so a malformed value
 * would surface as a Postgres syntax error on whichever query happened to run
 * first — which reads as a database fault rather than as the missing
 * credential it actually is.
 */
export const contextSettings = (context: TenantContext): ContextSettings => {
  if (!context?.tenantId) {
    throw new InvalidTenantContextError('no tenant was supplied');
  }

  if (!UUID_PATTERN.test(context.tenantId)) {
    throw new InvalidTenantContextError(
      `tenant id ${JSON.stringify(context.tenantId)} is not a uuid`,
    );
  }

  const actor = context.actor;

  if (!actor?.kind) {
    throw new InvalidTenantContextError('no actor was supplied');
  }

  if (!ACTOR_KINDS.includes(actor.kind)) {
    throw new InvalidTenantContextError(
      `actor kind ${JSON.stringify(actor.kind)} is not one of ${ACTOR_KINDS.join(', ')}`,
    );
  }

  if (actor.kind === 'system') {
    return { tenantId: context.tenantId, actorKind: 'system', actorId: '' };
  }

  if (!actor.id) {
    throw new InvalidTenantContextError(`a ${actor.kind} actor needs an id`);
  }

  return {
    tenantId: context.tenantId,
    actorKind: actor.kind,
    actorId: actor.id,
  };
};
