import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { TicketPriority } from '../../generated/prisma/client';

export class SetPriorityDto {
  @ApiProperty({
    enum: TicketPriority,
    enumName: 'TicketPriority',
    description:
      'The new urgency. Independent of state — any priority is valid in any state.',
  })
  @IsEnum(TicketPriority)
  priority!: TicketPriority;
}
