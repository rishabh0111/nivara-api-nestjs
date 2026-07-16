import { execFileSync } from 'node:child_process';
import {
  CONTACT_IDS,
  SERVICE_TOKEN_ID,
  SLACK_TEAM_ID,
  TENANT_IDS,
  TICKET_IDS,
  USER_IDS,
} from '../prisma/seed/anchors';
import { asOwner } from './helpers/as-owner';

/**
 * What `npm run db:seed` is supposed to leave behind.
 *
 * The seed is the first thing anybody evaluating this API sees, and it is the
 * only artifact in the repository whose failure mode is silence: a showcase
 * missing its breached SLA or its deflected Tickets still boots, still answers
 * 200, and simply shows nothing interesting. So the properties the showcase
 * rests on are asserted here rather than eyeballed once and assumed.
 *
 * Read as the owner throughout. Half of these claims are cross-tenant — "these
 * two tenants both exist and neither can see the other" is not a question any
 * tenant context can ask — and the rest are about columns the API deliberately
 * does not expose, like the shape of a stored password hash.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

/** Both halves of the deflection predicate, as analytics defines it. */
const DEFLECTED = `
  t.state IN ('resolved', 'closed')
  AND NOT EXISTS (SELECT 1 FROM message m
                   WHERE m.ticket_id = t.id AND m.author_kind = 'user')
  AND NOT EXISTS (SELECT 1 FROM note n
                   WHERE n.ticket_id = t.id AND n.author_kind = 'user')
`;

const count = async (sql: string, params: unknown[] = []): Promise<number> => {
  const rows = await asOwner<{ n: string }>(sql, params);

  return Number(rows[0].n);
};

const runSeed = (): void => {
  execFileSync('npx', ['prisma', 'db', 'seed'], { stdio: 'ignore' });
};

/**
 * A fresh seed before anything is asserted.
 *
 * Most of this file counts rows, and by the time it runs the suite has spent a
 * minute writing fixtures into the same database — Contacts, Tickets, sessions,
 * a Slack installation or two. Asserting "Sortwood has three Contacts" against
 * that is asserting something about the neighbours, and the failure would name
 * the seed.
 *
 * Reseeding is safe mid-suite because the seed truncates and every other
 * integration file builds its own fixtures in `beforeAll` rather than reading
 * rows a neighbour left behind. It is also the only honest way to test a
 * truncating seed: what it *leaves behind* is the whole claim.
 */
beforeAll(() => {
  jest.setTimeout(120_000);
  runSeed();
}, 120_000);

describe('the seeded tenants', () => {
  it('anchors the ids documentation quotes', async () => {
    const anchors = [
      ...Object.values(TENANT_IDS),
      ...Object.values(USER_IDS),
      ...Object.values(CONTACT_IDS),
      ...Object.values(TICKET_IDS),
      SERVICE_TOKEN_ID,
    ];

    const found = await asOwner<{ id: string }>(
      `SELECT id::text FROM tenant WHERE id = ANY($1)
       UNION ALL SELECT id::text FROM "user" WHERE id = ANY($1)
       UNION ALL SELECT id::text FROM contact WHERE id = ANY($1)
       UNION ALL SELECT id::text FROM ticket WHERE id = ANY($1)
       UNION ALL SELECT id::text FROM service_token WHERE id = ANY($1)`,
      [anchors],
    );

    expect(new Set(found.map((row) => row.id))).toEqual(new Set(anchors));
  });

  it('gives Meridian a staffed team and a showcase-scale backlog', async () => {
    const [staff, contacts, tickets] = await Promise.all([
      count(`SELECT COUNT(*) AS n FROM "user" WHERE tenant_id = $1`, [
        TENANT_IDS.meridian,
      ]),
      count(`SELECT COUNT(*) AS n FROM contact WHERE tenant_id = $1`, [
        TENANT_IDS.meridian,
      ]),
      count(`SELECT COUNT(*) AS n FROM ticket WHERE tenant_id = $1`, [
        TENANT_IDS.meridian,
      ]),
    ]);

    expect(staff).toBe(5);
    expect(contacts).toBeGreaterThanOrEqual(18);
    expect(tickets).toBeGreaterThanOrEqual(45);
  });

  it('keeps Sortwood small enough to be checked by hand', async () => {
    const [staff, contacts, tickets] = await Promise.all([
      count(`SELECT COUNT(*) AS n FROM "user" WHERE tenant_id = $1`, [
        TENANT_IDS.sortwood,
      ]),
      count(`SELECT COUNT(*) AS n FROM contact WHERE tenant_id = $1`, [
        TENANT_IDS.sortwood,
      ]),
      count(`SELECT COUNT(*) AS n FROM ticket WHERE tenant_id = $1`, [
        TENANT_IDS.sortwood,
      ]),
    ]);

    // An admin, an agent, and the shared-address User that exists to make
    // tenant-local identity checkable rather than asserted.
    expect(staff).toBe(3);
    expect(contacts).toBe(3);
    expect(tickets).toBe(5);
  });

  /**
   * Coverage rather than counts. A queue that happens to hold no `on_hold`
   * Ticket, or no `slack` one, is a demo where a whole feature is invisible and
   * nothing says so.
   */
  it('covers every state, priority and source in Meridian', async () => {
    const [states, priorities, sources] = await Promise.all([
      asOwner<{ v: string }>(
        `SELECT DISTINCT state::text AS v FROM ticket WHERE tenant_id = $1`,
        [TENANT_IDS.meridian],
      ),
      asOwner<{ v: string }>(
        `SELECT DISTINCT priority::text AS v FROM ticket WHERE tenant_id = $1`,
        [TENANT_IDS.meridian],
      ),
      asOwner<{ v: string }>(
        `SELECT DISTINCT source::text AS v FROM ticket WHERE tenant_id = $1`,
        [TENANT_IDS.meridian],
      ),
    ]);

    expect(new Set(states.map((row) => row.v))).toEqual(
      new Set(['open', 'pending', 'on_hold', 'resolved', 'closed']),
    );
    expect(new Set(priorities.map((row) => row.v))).toEqual(
      new Set(['low', 'normal', 'high', 'urgent']),
    );
    expect(new Set(sources.map((row) => row.v))).toEqual(
      new Set(['portal', 'widget', 'slack']),
    );
  });

  it('leaves roughly three Meridian Tickets in four assigned', async () => {
    const total = await count(
      `SELECT COUNT(*) AS n FROM ticket WHERE tenant_id = $1`,
      [TENANT_IDS.meridian],
    );
    const assigned = await count(
      `SELECT COUNT(*) AS n FROM ticket
        WHERE tenant_id = $1 AND assignee_id IS NOT NULL`,
      [TENANT_IDS.meridian],
    );

    expect(assigned / total).toBeGreaterThan(0.6);
    expect(assigned / total).toBeLessThan(0.8);
  });

  it('gives every Meridian Ticket a thread, and some of them Notes', async () => {
    const threadless = await count(
      `SELECT COUNT(*) AS n FROM ticket t
        WHERE t.tenant_id = $1
          AND NOT EXISTS (SELECT 1 FROM message m WHERE m.ticket_id = t.id)`,
      [TENANT_IDS.meridian],
    );
    const withNotes = await count(
      `SELECT COUNT(DISTINCT n.ticket_id) AS n FROM note n WHERE n.tenant_id = $1`,
      [TENANT_IDS.meridian],
    );

    expect(threadless).toBe(0);
    expect(withNotes).toBeGreaterThanOrEqual(5);
  });

  /**
   * The three SLA shapes a developer needs to see at once: a clock that has run
   * out, one that is stopped, and one that is still running. Each is a different
   * column combination, and a seed that produced only the third would look
   * perfectly healthy.
   */
  it('seeds breached, paused and in-progress SLA clocks', async () => {
    const [breached, paused, running] = await Promise.all([
      count(
        `SELECT COUNT(*) AS n FROM ticket
          WHERE tenant_id = $1
            AND (first_response_breached_at IS NOT NULL
                 OR resolution_breached_at IS NOT NULL)`,
        [TENANT_IDS.meridian],
      ),
      count(
        `SELECT COUNT(*) AS n FROM ticket
          WHERE tenant_id = $1 AND state = 'pending'
            AND sla_pause_started_at IS NOT NULL`,
        [TENANT_IDS.meridian],
      ),
      count(
        `SELECT COUNT(*) AS n FROM ticket
          WHERE tenant_id = $1 AND state IN ('open', 'on_hold')
            AND first_response_breached_at IS NULL
            AND resolution_breached_at IS NULL`,
        [TENANT_IDS.meridian],
      ),
    ]);

    expect(breached).toBeGreaterThanOrEqual(4);
    expect(paused).toBeGreaterThanOrEqual(3);
    expect(running).toBeGreaterThanOrEqual(5);
  });

  it('makes deflection non-zero without making it the whole queue', async () => {
    const deflected = await count(
      `SELECT COUNT(*) AS n FROM ticket t
        WHERE t.tenant_id = $1 AND ${DEFLECTED}`,
      [TENANT_IDS.meridian],
    );

    expect(deflected).toBeGreaterThanOrEqual(8);
    expect(deflected).toBeLessThanOrEqual(10);
  });

  /**
   * A deflected Ticket that an agent was holding would be two claims at once —
   * "nobody touched this" and "somebody owns it" — and the assignee breakdown
   * excludes deflected Tickets precisely because the pair is incoherent.
   */
  it('leaves deflected Tickets unassigned', async () => {
    const held = await count(
      `SELECT COUNT(*) AS n FROM ticket t
        WHERE t.tenant_id = $1 AND t.assignee_id IS NOT NULL AND ${DEFLECTED}`,
      [TENANT_IDS.meridian],
    );

    expect(held).toBe(0);
  });

  it('anchors the clock to the run rather than to a date in the file', async () => {
    const rows = await asOwner<{ oldest_days: string; newest_days: string }>(
      `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) / 86400 AS oldest_days,
              EXTRACT(EPOCH FROM (now() - MAX(created_at))) / 86400 AS newest_days
         FROM ticket WHERE tenant_id = $1`,
      [TENANT_IDS.meridian],
    );

    expect(Number(rows[0].oldest_days)).toBeGreaterThan(40);
    expect(Number(rows[0].oldest_days)).toBeLessThan(50);
    expect(Number(rows[0].newest_days)).toBeGreaterThanOrEqual(0);
    expect(Number(rows[0].newest_days)).toBeLessThan(2);
  });
});

describe('the seeded credentials', () => {
  it('stores every staff password as an argon2id hash', async () => {
    const rows = await asOwner<{ password_hash: string | null }>(
      `SELECT password_hash FROM "user"`,
    );

    expect(rows).not.toHaveLength(0);

    for (const row of rows) {
      expect(row.password_hash).toMatch(/^\$argon2id\$/);
    }
  });

  /**
   * One Google subject, on the one address that exists in both tenants. It is
   * there to show the linked-identity column populated without Google being
   * configured — and to cash the check that the unique index is per tenant, since
   * a global one would make this seed fail outright.
   */
  it('links a Google subject on the shared address alone', async () => {
    const rows = await asOwner<{ tenant_id: string; google_subject: string }>(
      `SELECT tenant_id::text, google_subject FROM "user"
        WHERE google_subject IS NOT NULL`,
    );

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.google_subject))).toHaveProperty(
      'size',
      1,
    );
    expect(new Set(rows.map((row) => row.tenant_id))).toEqual(
      new Set([TENANT_IDS.meridian, TENANT_IDS.sortwood]),
    );
  });

  it('keeps only the hash of the one minted service token', async () => {
    const rows = await asOwner<{ token_hash: string; scopes: string[] }>(
      `SELECT token_hash, scopes FROM service_token WHERE id = $1`,
      [SERVICE_TOKEN_ID],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].scopes.length).toBeGreaterThan(0);
  });

  /**
   * Both are ephemeral session state, and seeding either would be seeding a
   * credential nobody holds: a refresh token whose raw value exists nowhere, and
   * a widget session for a browser that never asked for one. Their absence is
   * the assertion — a seed that grew them later would be minting dead
   * credentials into every developer's database.
   */
  it('seeds no session rows', async () => {
    const [refresh, widget] = await Promise.all([
      count(`SELECT COUNT(*) AS n FROM refresh_token`),
      count(`SELECT COUNT(*) AS n FROM widget_session`),
    ]);

    expect(refresh).toBe(0);
    expect(widget).toBe(0);
  });
});

describe('the seeded Slack workspace', () => {
  it('records the installation and no credential for it', async () => {
    const installs = await asOwner<{ tenant_id: string; team_id: string }>(
      `SELECT tenant_id::text, team_id FROM slack_installation`,
    );
    const credentials = await count(
      `SELECT COUNT(*) AS n FROM slack_credential`,
    );

    expect(installs).toEqual([
      { tenant_id: TENANT_IDS.meridian, team_id: SLACK_TEAM_ID },
    ]);
    expect(credentials).toBe(0);
  });
});

/**
 * Re-runnability, cashed by actually re-running it.
 *
 * The claim is not "the seed is idempotent" — it deliberately is not, it
 * truncates — but "a second run lands on the same known state as the first". A
 * developer who has been clicking around resets by running it again, and the
 * failure this guards against is the one that only appears on the second run:
 * a unique-constraint collision, a duplicated tenant, or an anchor id that
 * moved.
 */
describe('re-running the seed', () => {
  it('lands on the same known state', async () => {
    const before = await asOwner<{ table: string; n: string }>(CENSUS);

    runSeed();

    const after = await asOwner<{ table: string; n: string }>(CENSUS);

    expect(after).toEqual(before);
  }, 120_000);
});

/** Row counts per seeded table, as one comparable value. */
const CENSUS = `
  SELECT 'tenant' AS table, COUNT(*)::text AS n FROM tenant
  UNION ALL SELECT 'user', COUNT(*)::text FROM "user"
  UNION ALL SELECT 'contact', COUNT(*)::text FROM contact
  UNION ALL SELECT 'ticket', COUNT(*)::text FROM ticket
  UNION ALL SELECT 'message', COUNT(*)::text FROM message
  UNION ALL SELECT 'note', COUNT(*)::text FROM note
  UNION ALL SELECT 'service_token', COUNT(*)::text FROM service_token
  UNION ALL SELECT 'slack_installation', COUNT(*)::text FROM slack_installation
  ORDER BY 1
`;
