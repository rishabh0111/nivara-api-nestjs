/**
 * Whether a write named a row that, from inside this tenant context, does not
 * exist.
 *
 * `P2003` is Prisma's foreign-key constraint failure, and under this schema's
 * composite references it is the answer to two questions at once: the row is
 * absent, or it belongs to another tenant. Call sites deliberately collapse
 * both into the same 404 — distinguishing them would turn a write endpoint into
 * a probe for the existence of another tenant's rows.
 *
 * Matched structurally rather than with `instanceof`. The generated client
 * ships its own error classes, and the ones a future client version constructs
 * are not guaranteed to be the ones a running process imported — a mismatch
 * turns a considered 404 into a 500, silently, on a client upgrade. The `P`
 * code is the documented contract; the class is an implementation of it.
 */
export const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'P2003';

/**
 * Whether a write lost a uniqueness race.
 *
 * Both the Prisma code and the raw SQLSTATE, because this schema's uniqueness
 * is not all declared the way Prisma understands it. `ticket_one_live_per_chain`
 * is a partial index over an *expression* — neither of which Prisma models — so
 * a violation of it can arrive from the driver adapter as a bare `23505` with
 * the `P2002` translation never applied. Matching only the Prisma code would
 * make the invariant that stops a burst of replies fanning out into duplicate
 * Tickets surface as a 500.
 *
 * Structural rather than `instanceof`, for the reason above: the generated
 * client's error classes are not guaranteed to be the ones a running process
 * imported.
 */
export const isUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;

  if ((error as { code?: unknown }).code === 'P2002') return true;

  const cause = (error as { cause?: unknown }).cause;

  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === '23505'
  );
};
