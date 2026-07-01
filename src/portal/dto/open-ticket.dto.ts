import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * A Contact opening its own Ticket.
 *
 * The whole request is a subject line, and everything absent from it is the
 * point:
 *
 * - **`contactId`** — the requester is the caller, taken from the credential.
 *   Accepting it here would be accepting a Ticket filed in someone else's name,
 *   and the field would be the only thing standing between a customer and doing
 *   exactly that. (The `WITH CHECK` half of the ticket policy refuses it below
 *   the application too, but the honest fix is not to ask.)
 * - **`source`** — fixed at `portal`, because this endpoint *is* the portal.
 *   Source is a fact about where a conversation started, and letting a caller
 *   declare it would make channel analytics a matter of client honesty.
 * - **`state` and `priority`** — a Ticket is born `open` and `normal`. Offering
 *   priority here would offer a customer the chance to declare their own work
 *   urgent, which is triage, and triage is staff work.
 * - **`tenantId`** — from the credential, always, as everywhere else.
 */
export class OpenTicketDto {
  @ApiProperty({
    description: 'What the Ticket is about, in one line.',
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @Length(1, 200)
  subject!: string;
}
