import { ApiProperty } from '@nestjs/swagger';
import { WIDGET_SESSION_TTL_SECONDS } from '../widget-session-token';

/**
 * What minting or renewing a widget session returns.
 *
 * Unlike the staff and portal `SessionDto`, the credential is in the body and
 * there is no cookie — and that is deliberate rather than a shortcut. The widget
 * runs on the *tenant's* origin, not on ours, so a cookie set by this API would
 * be third-party and dropped by every browser that blocks those, which is now
 * most of them. A token the widget holds in memory is the shape that actually
 * works cross-origin.
 *
 * The security trade is real and is bounded on purpose: an in-memory bearer
 * token is reachable by a page script in a way an httpOnly cookie is not, so a
 * widget session is deliberately the least powerful credential in the system —
 * thirty minutes, revocable from a row, and holding no permission at all.
 */
export class WidgetSessionDto {
  @ApiProperty({
    description:
      'Bearer credential for the widget surface, prefixed `nvw_`. Hold it in memory for the life of the page — persisting it to `localStorage` leaves a working session behind on a shared machine.',
  })
  token!: string;

  @ApiProperty({
    description:
      'Seconds until this session expires. Renew before it elapses at `POST /widget/sessions/renew`; renewal keeps the same session and therefore the same conversation.',
    example: WIDGET_SESSION_TTL_SECONDS,
  })
  expiresInSeconds!: number;
}
