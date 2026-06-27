import { ApiProperty } from '@nestjs/swagger';
import { ActorKind, AuditLog } from '../../generated/prisma/client';
import {
  AUDIT_ACTIONS_WIRE,
  AuditActionWire,
  toWireAction,
} from '../audit-actions';
import { TARGET_KINDS, TargetKind } from '../audit-entry';

/**
 * One audited event on the wire.
 *
 * Note the two absences. `tenantId` never appears, as everywhere else. And
 * neither does any conversation content: the log records control-plane changes
 * only, so there is no field here a Message or a Note could arrive in even if a
 * future call site tried to put one there.
 */
export class AuditEntryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    enum: AUDIT_ACTIONS_WIRE,
    enumName: 'AuditAction',
    description:
      'What happened. A closed catalog — `fromValue` and `toValue` are read according to this.',
  })
  action!: AuditActionWire;

  @ApiProperty({
    enum: ActorKind,
    enumName: 'ActorKind',
    description: 'Who acted. Read from the credential, never from the request.',
  })
  actorKind!: ActorKind;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Null exactly when `actorKind` is `system`, which is the one actor with no row to point at.',
  })
  actorId!: string | null;

  @ApiProperty({
    enum: TARGET_KINDS,
    enumName: 'AuditTargetKind',
    description:
      'The kind of row this is about. Open in the database — the column is text, so an existing action can point at a new kind of row without a migration — but published as the closed set that actually occurs, so a client can switch on it.',
  })
  targetKind!: TargetKind;

  @ApiProperty()
  targetId!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The Ticket this belongs to, or null once that Ticket has been deleted — the entry outlives its subject.',
  })
  ticketId!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The value before the change, as text. Null when there was none.',
  })
  fromValue!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The value after the change, as text. Null when there is none.',
  })
  toValue!: string | null;

  @ApiProperty({
    nullable: true,
    type: Object,
    description:
      'Action-specific extras — minted scopes, an SLA breach kind, an integration error.',
  })
  metadata!: Record<string, unknown> | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Ties one request’s cascade of entries together, when present.',
  })
  correlationId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** The one place an audit row becomes an audit response. */
export const toAuditEntryDto = (row: AuditLog): AuditEntryDto => ({
  id: row.id,
  action: toWireAction(row.action),
  actorKind: row.actorKind,
  actorId: row.actorId,
  // The column is text and the DTO is the closed set: a kind that is not in the
  // vocabulary is passed through rather than dropped, because silently omitting
  // an entry's subject from a record whose purpose is attribution would be a
  // worse answer than an unfamiliar string.
  targetKind: row.targetKind as TargetKind,
  targetId: row.targetId,
  ticketId: row.ticketId,
  fromValue: row.fromValue,
  toValue: row.toValue,
  metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  correlationId: row.correlationId,
  createdAt: row.createdAt.toISOString(),
});
