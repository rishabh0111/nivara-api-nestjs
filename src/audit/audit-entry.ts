import { AuditAction } from '../generated/prisma/client';

/**
 * What an audit row can point at.
 *
 * A union in TypeScript and plain text in the column, deliberately. The closed
 * vocabulary this table commits to is the *action* catalog — closing the target
 * set in the database as well would mean a migration whenever an existing
 * action learned to point at a new kind of row, which is a schema change that
 * asserts nothing. Here it is a type so a call site cannot invent a spelling,
 * and `serviceToken` vs `service_token` cannot become two kinds of the same
 * thing.
 */
export const TARGET_KINDS = [
  'ticket',
  'service_token',
  'integration',
  'contact',
] as const;

export type TargetKind = (typeof TARGET_KINDS)[number];

/**
 * One thing that happened, as the caller describes it.
 *
 * Note what is *not* here: the tenant, and the actor. Both are read from the
 * armed transaction by the database itself, so there is no parameter for a call
 * site to get wrong and none for it to falsify. "Who did this" is a fact about
 * the credential that opened the transaction, not a claim the code doing the
 * work gets to make about itself.
 */
export interface AuditEntry {
  action: AuditAction;

  /** The row this is *about*, and the identity that outlives its deletion. */
  targetKind: TargetKind;
  targetId: string;

  /**
   * The Ticket whose timeline this belongs on, when there is one.
   *
   * Separate from the target because most rows describe something that merely
   * *belongs* to a Ticket rather than the Ticket itself — and because this is
   * the column the timeline query reads, so it is a real foreign key rather
   * than an interpretation of `targetId`.
   */
  ticketId?: string | null;

  /**
   * Old and new, as text. Transitions, priority changes and assignments are all
   * old→new pairs; `action` is what says how to read them.
   */
  fromValue?: string | null;
  toValue?: string | null;

  /** The irregular tail — scopes, error details, the `sla.breached` kind. */
  metadata?: Record<string, unknown>;
}
