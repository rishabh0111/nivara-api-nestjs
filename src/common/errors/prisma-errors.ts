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
