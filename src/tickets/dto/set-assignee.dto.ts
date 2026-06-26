import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, ValidateIf } from 'class-validator';

/**
 * Assigning, and unassigning.
 *
 * One body for both, with `null` meaning nobody — rather than a second
 * endpoint or a `DELETE` on a sub-resource. "Who is responsible for this" has
 * one answer at a time, so setting it and clearing it are the same operation
 * with different arguments, and a client moving a ticket between people never
 * has to decide which verb this is.
 */
export class SetAssigneeDto {
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description:
      'The User to make responsible, or null to unassign. Must be a User of this tenant.',
  })
  // `ValidateIf` rather than `IsOptional`: an omitted key and an explicit null
  // must not be the same request. Omitting it is a malformed body — there is
  // no assignment being expressed — while `null` is the deliberate act of
  // clearing one, and `IsOptional` would silently accept the first as the
  // second.
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  assigneeId!: string | null;
}
