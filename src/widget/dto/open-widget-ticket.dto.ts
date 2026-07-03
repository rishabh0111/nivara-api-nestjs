import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * An anonymous visitor opening a Ticket.
 *
 * Field-for-field the portal's `OpenTicketDto`, and a separate class for the
 * reason `PortalSignInDto` is separate from the staff one: they are the same
 * shape by coincidence of what opening a Ticket needs, not because they are the
 * same request. They are raised on different axes, carry different Sources, and
 * their documentation says different things about where the requester comes
 * from. Sharing the class would make a change wanted by one surface silently
 * apply to the other — and the next thing the widget wants is almost certainly
 * an optional email, which the portal has no use for because its caller is
 * already identified.
 *
 * Everything absent is absent for the reasons the portal's version lists, plus
 * one of its own: there is no `contactId` and no place to put one, because at
 * the moment this request arrives the Contact may not exist yet. The server
 * creates it and names it as the requester; a visitor cannot file a Ticket in
 * anybody's name, including their own.
 */
export class OpenWidgetTicketDto {
  @ApiProperty({
    description: 'What the Ticket is about, in one line.',
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @Length(1, 200)
  subject!: string;
}
