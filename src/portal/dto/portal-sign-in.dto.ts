import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Signing a Contact into the portal.
 *
 * Field-for-field the staff `SignInDto`, and deliberately a separate class
 * rather than a reuse of it. The two are the same shape by coincidence of what
 * a password login needs, not because they are the same request: they resolve
 * different tables on different axes, and their OpenAPI documentation says
 * different things about which principal comes back. Sharing the class would
 * make a change wanted by one surface silently apply to the other — and the
 * next change either one wants is a credential the other does not have.
 */
export class PortalSignInDto {
  @ApiProperty({
    description:
      'Which tenant’s portal to sign in to. Scoped to `(tenantId, email)`, so the same address at two tenants is two separate Contacts.',
    format: 'uuid',
  })
  @IsUUID()
  tenantId!: string;

  @ApiProperty({ format: 'email', example: 'jules@example.test' })
  @IsEmail()
  // Stored and compared lowercased, so casing in the form is not a failed
  // login the person cannot see the cause of.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ format: 'password', maxLength: 256 })
  @IsString()
  /*
   * A ceiling but deliberately no floor, for the reason the staff DTO gives:
   * a minimum here would refuse a short guess for its shape before any lookup,
   * which tells a guesser something the uniform refusal exists to withhold.
   */
  @MaxLength(256)
  password!: string;
}
