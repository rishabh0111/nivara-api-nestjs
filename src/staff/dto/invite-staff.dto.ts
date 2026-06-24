import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsString, Length } from 'class-validator';
import { UserRole } from '../../generated/prisma/client';

/**
 * What an admin decides when provisioning a colleague.
 *
 * Conspicuously not here: the tenant. It comes from the inviting admin's token
 * and nowhere else, so an admin cannot provision a User into a tenant they do
 * not belong to — the request has no field in which to try.
 */
export class InviteStaffDto {
  @ApiProperty({
    format: 'email',
    example: 'new.agent@meridian.test',
    description:
      'The address the invitee will sign in with. Unique within the tenant; the same address may hold a separate membership at another tenant.',
  })
  @IsEmail()
  // Stored lowercased, because `(tenantId, email)` is the login lookup key and
  // a casing difference would silently create a second membership.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ example: 'Nadia Farouk', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({
    enum: Object.values(UserRole),
    description:
      'The authority the invitee will hold. Decided here by the admin, never chosen by the person accepting.',
  })
  @IsEnum(UserRole)
  role!: UserRole;
}
