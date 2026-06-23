import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * The one request in the application that names its own tenant.
 *
 * There is no credential to read it from yet — that is what this request is
 * asking for — so the tenant arrives as input. It is a routing input and not
 * an authority claim: it decides which tenant's `user` rows the lookup can
 * see, and seeing them still requires the right password. Once a token exists,
 * the tenant comes from the token and never from a request again.
 */
export class SignInDto {
  @ApiProperty({
    description:
      'Which tenant to sign in to. Login is scoped to `(tenantId, email)`, so the same address at two tenants is two separate Users with two separate passwords.',
    format: 'uuid',
  })
  @IsUUID()
  tenantId!: string;

  @ApiProperty({ format: 'email', example: 'admin@meridian.test' })
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
   * A ceiling but deliberately no floor. Argon2's cost is linear in input
   * length, so an unbounded password is unbounded work handed to an
   * unauthenticated caller — but a *minimum* here would answer a short guess
   * with 422 before any lookup, which tells the guesser their password was
   * refused for its shape rather than its correctness. Every wrong credential
   * must be refused identically, and the length rule belongs where a password
   * is chosen, not where one is checked.
   */
  @MaxLength(256)
  password!: string;
}
