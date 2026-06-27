import { AuditAction } from '../generated/prisma/client';

/**
 * The action catalog as clients see it.
 *
 * Postgres stores `ticket.created` and Prisma generates `ticket_created`,
 * because a dot cannot appear in a TypeScript identifier. The dot is not
 * decoration: it namespaces the event as `resource.event`, mirroring the
 * `resource:verb` shape of the permission vocabulary, and it is the spelling the
 * design settled on and that downstream repos will map their tooling against.
 * So the published contract keeps it, and the underscored form stays an
 * artifact of the client generator that never reaches the wire.
 *
 * `satisfies Record<AuditAction, string>` is what keeps this honest: a ninth
 * action — `contact.merged`, when the merge seam ships — is a type error here
 * until it is given a wire name, rather than a value that silently serializes
 * in the wrong spelling.
 */
export const AUDIT_ACTION_WIRE = {
  ticket_created: 'ticket.created',
  ticket_transitioned: 'ticket.transitioned',
  ticket_assigned: 'ticket.assigned',
  ticket_priority_changed: 'ticket.priority_changed',
  sla_breached: 'sla.breached',
  token_minted: 'token.minted',
  token_revoked: 'token.revoked',
  integration_failed: 'integration.failed',
} as const satisfies Record<AuditAction, string>;

/** An action as it appears in a response and in the OpenAPI document. */
export type AuditActionWire =
  (typeof AUDIT_ACTION_WIRE)[keyof typeof AUDIT_ACTION_WIRE];

export const AUDIT_ACTIONS_WIRE = Object.values(
  AUDIT_ACTION_WIRE,
) as AuditActionWire[];

export const toWireAction = (action: AuditAction): AuditActionWire =>
  AUDIT_ACTION_WIRE[action];
