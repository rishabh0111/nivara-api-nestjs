import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, IsUUID, Length } from 'class-validator';
import { TicketSource } from '../../generated/prisma/client';

/**
 * Opening a Ticket.
 *
 * Conspicuously absent: `state` and `priority`. A Ticket is born `open` and
 * `normal`, so offering either here would be offering a caller the chance to
 * declare their own work urgent — and on the widget and portal sources, that
 * caller is the customer.
 *
 * Also absent: `tenantId`. It comes from the credential, always.
 */
export class CreateTicketDto {
  @ApiProperty({
    description: 'What the Ticket is about, in one line.',
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @Length(1, 200)
  subject!: string;

  @ApiProperty({
    description:
      'The requester. Must be a Contact of this tenant — one belonging to another tenant is refused as nonexistent.',
    format: 'uuid',
  })
  @IsUUID()
  contactId!: string;

  @ApiProperty({
    enum: TicketSource,
    enumName: 'TicketSource',
    description: 'The channel this Ticket arrived on. Fixed at creation.',
  })
  @IsEnum(TicketSource)
  source!: TicketSource;
}
