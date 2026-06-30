import { ApiProperty } from '@nestjs/swagger';
import { ActorKind, Message } from '../../generated/prisma/client';

/**
 * A Message on the wire.
 *
 * Hand-written rather than the row passed through, for the reason `TicketDto`
 * gives: the API's shape is a decision, and `tenantId` never appears on it.
 */
export class MessageDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'The Ticket this belongs to.' })
  ticketId!: string;

  @ApiProperty({ description: 'What was said, as plain text.' })
  body!: string;

  @ApiProperty({
    enum: ActorKind,
    enumName: 'ActorKind',
    description:
      'What kind of thing wrote this — a User, a Contact, a ServiceToken, or the system. Server-stamped from the writing credential and not settable.',
  })
  authorKind!: ActorKind;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description:
      'The author’s id, or null for `system` — the one actor with no row to point at. Polymorphic: read it against `authorKind` to know which table it names.',
  })
  authorId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** The one place a Message row becomes a Message response. */
export const toMessageDto = (message: Message): MessageDto => ({
  id: message.id,
  ticketId: message.ticketId,
  body: message.body,
  authorKind: message.authorKind,
  authorId: message.authorId,
  createdAt: message.createdAt.toISOString(),
});
