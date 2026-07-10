import { Injectable } from '@nestjs/common';
import { TenancyService } from '../tenancy/tenancy.service';

/**
 * A workspace, once it has been recognised as belonging to somebody.
 *
 * The two facts the rest of the adapter needs and no more. Deliberately not the
 * row: handing back a Prisma model would make this the general read of a table
 * that a cross-tenant context can see, and the next caller would reach for a
 * column it has no business having outside a tenant.
 */
export interface SlackInstallation {
  tenantId: string;
  botUserId: string;
}

/**
 * Which tenant a Slack workspace is.
 *
 * The single most security-relevant lookup in this adapter, and the whole of it
 * is: the *verified* `team_id` selects a row, and the row names the tenant. What
 * makes it trustworthy is not this file — it is that the caller has already
 * proved, over the raw bytes and before any parsing, that the request came from
 * Slack. Everything the payload says about itself is worth exactly as much as
 * that signature, and no more; so the payload is allowed to name a *workspace*,
 * which is a fact Slack signed, and is never allowed to name a tenant, which is
 * a fact only this table knows.
 *
 * A workspace nobody has installed resolves to nothing. It is not an error: the
 * signature was genuine, so this really is Slack, telling us about a workspace we
 * have no arrangement with. The caller acknowledges and drops.
 */
@Injectable()
export class SlackInstallationService {
  constructor(private readonly tenancy: TenancyService) {}

  /**
   * The tenant behind a verified `team_id`, or `null`.
   *
   * Runs under the narrow installation-lookup context rather than a tenant,
   * because working out the tenant is what this call is *for* — see
   * `TenancyService.withInstallationLookup()` for what that context can and
   * cannot reach.
   *
   * Only the two columns it returns are selected. The policy narrows rows and
   * cannot narrow columns, so this projection is the one place that decides what
   * a pre-tenant read is allowed to see — which is why the table is kept free of
   * anything that would matter if the projection were widened.
   */
  async resolve(teamId: string): Promise<SlackInstallation | null> {
    return this.tenancy.withInstallationLookup((tx) =>
      tx.slackInstallation.findUnique({
        where: { teamId },
        select: { tenantId: true, botUserId: true },
      }),
    );
  }
}
