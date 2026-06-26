import { ApiProperty } from '@nestjs/swagger';
import {
  Ticket,
  TicketPriority,
  TicketSource,
  TicketState,
} from '../../generated/prisma/client';

/**
 * A Ticket on the wire.
 *
 * Hand-written rather than the Prisma row passed through, so the API's shape
 * is a decision rather than a consequence of the schema — `tenantId` in
 * particular never appears, because it is the one field a client can neither
 * set nor learn anything from.
 */
export class TicketDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  subject!: string;

  @ApiProperty({ description: 'The requester.' })
  contactId!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The single User responsible, or null when untriaged.',
  })
  assigneeId!: string | null;

  @ApiProperty({ enum: TicketState, enumName: 'TicketState' })
  state!: TicketState;

  @ApiProperty({ enum: TicketPriority, enumName: 'TicketPriority' })
  priority!: TicketPriority;

  @ApiProperty({ enum: TicketSource, enumName: 'TicketSource' })
  source!: TicketSource;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

/**
 * The one place a Ticket row becomes a Ticket response.
 *
 * Every handler goes through here, which is what keeps a field from leaking
 * into one representation and not another — and what makes adding a column an
 * explicit decision about whether clients see it.
 */
export const toTicketDto = (ticket: Ticket): TicketDto => ({
  id: ticket.id,
  subject: ticket.subject,
  contactId: ticket.contactId,
  assigneeId: ticket.assigneeId,
  state: ticket.state,
  priority: ticket.priority,
  source: ticket.source,
  createdAt: ticket.createdAt.toISOString(),
  updatedAt: ticket.updatedAt.toISOString(),
});
