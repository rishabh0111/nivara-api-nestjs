import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { TicketState } from '../../generated/prisma/client';

export class SetStateDto {
  @ApiProperty({
    enum: TicketState,
    enumName: 'TicketState',
    description:
      'The state to move to. The request names a destination, not a transition: the origin is whatever the Ticket is in when the write lands, which is what makes a retry safe. An illegal move from that origin is a 409.',
  })
  @IsEnum(TicketState)
  state!: TicketState;
}
