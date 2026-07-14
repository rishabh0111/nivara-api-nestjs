import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { asOwner, asOwnerArmed, contactOf, userOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * The live analytics aggregates, against a hand-built cohort.
 *
 * Every headline figure here is asserted against a fixture whose expected value
 * was computed by hand — that is the whole point of this file. A metric is a
 * query that answers 200 whatever it returns, so an off-by-one in a `FILTER` or
 * a wrong denominator is invisible unless the number is checked against one a
 * person worked out from the rows.
 *
 * The cohort is pinned to June 2020, a window nothing else in the suite or the
 * seed writes into, so the tenant-wide aggregate sees exactly these tickets and
 * no other. Rows are built by direct owner writes rather than through the API:
 * the API cannot backdate a creation, freeze a first-response duration, or latch
 * a breach, and those are precisely the facts each metric reads.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';
const MARK = 'analytics-int-spec';
const HOUR = 60 * 60 * 1000;

const FROM = '2020-06-01T00:00:00.000Z';
const TO = '2020-07-01T00:00:00.000Z';

/** One fixture Ticket, as a set of facts the metrics read. */
interface TicketSpec {
  key: string;
  createdAt: string;
  state: 'open' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  source: 'portal' | 'widget' | 'slack';
  assignee: 'A' | 'B' | null;
  /** Sets `first_response_at` to creation + this many ms. Absent leaves it null. */
  firstResponseMs?: number;
  frBreach?: boolean;
  resBreach?: boolean;
  /** For a terminal Ticket, freezes the pause-aware resolution duration to this. */
  resolutionMs?: number;
  touch?: 'user-message' | 'user-note' | 'contact-message' | 'service-message';
}

/**
 * The cohort, laid out so every expected figure below is arithmetic on this
 * table rather than on a query. Eight in-window Tickets across four June days,
 * two per day, plus two controls one month either side of the window.
 */
const SPECS: TicketSpec[] = [
  // 2020-06-10 — a deflected close and a deflected resolve.
  {
    key: 'T1',
    createdAt: '2020-06-10T00:00:00.000Z',
    state: 'closed',
    priority: 'low',
    source: 'widget',
    assignee: null,
    resolutionMs: 10 * HOUR,
  },
  {
    key: 'T2',
    createdAt: '2020-06-10T06:00:00.000Z',
    state: 'resolved',
    priority: 'normal',
    source: 'widget',
    assignee: 'A',
    resolutionMs: 20 * HOUR,
    touch: 'contact-message',
  },
  // 2020-06-11 — an agent-answered resolve that breached first response, and a
  // closed Ticket disqualified from deflection by a single internal Note.
  {
    key: 'T3',
    createdAt: '2020-06-11T00:00:00.000Z',
    state: 'resolved',
    priority: 'normal',
    source: 'portal',
    assignee: 'A',
    firstResponseMs: 1 * HOUR,
    frBreach: true,
    resolutionMs: 5 * HOUR,
    touch: 'user-message',
  },
  {
    key: 'T4',
    createdAt: '2020-06-11T06:00:00.000Z',
    state: 'closed',
    priority: 'high',
    source: 'slack',
    assignee: 'A',
    resolutionMs: 30 * HOUR,
    touch: 'user-note',
  },
  // 2020-06-12 — two still-open Tickets, both breaching, neither resolved.
  {
    key: 'T5',
    createdAt: '2020-06-12T00:00:00.000Z',
    state: 'open',
    priority: 'urgent',
    source: 'portal',
    assignee: 'B',
    firstResponseMs: 2 * HOUR,
    frBreach: true,
    resBreach: true,
    touch: 'user-message',
  },
  {
    key: 'T6',
    createdAt: '2020-06-12T06:00:00.000Z',
    state: 'open',
    priority: 'normal',
    source: 'widget',
    assignee: null,
    frBreach: true,
  },
  // 2020-06-13 — an AI-deflected resolve, and an agent-answered resolve that
  // breached resolution.
  {
    key: 'T7',
    createdAt: '2020-06-13T00:00:00.000Z',
    state: 'resolved',
    priority: 'high',
    source: 'portal',
    assignee: null,
    firstResponseMs: 3 * HOUR,
    resolutionMs: 15 * HOUR,
    touch: 'service-message',
  },
  {
    key: 'T8',
    createdAt: '2020-06-13T06:00:00.000Z',
    state: 'resolved',
    priority: 'low',
    source: 'portal',
    assignee: 'B',
    firstResponseMs: 4 * HOUR,
    resBreach: true,
    resolutionMs: 25 * HOUR,
    touch: 'user-message',
  },
  // Controls, one month either side. Neither may ever count.
  {
    key: 'T9',
    createdAt: '2020-05-15T00:00:00.000Z',
    state: 'resolved',
    priority: 'normal',
    source: 'portal',
    assignee: null,
    resolutionMs: 99 * HOUR,
  },
  {
    key: 'T10',
    createdAt: '2020-07-15T00:00:00.000Z',
    state: 'resolved',
    priority: 'urgent',
    source: 'portal',
    assignee: 'A',
    firstResponseMs: 9 * HOUR,
    frBreach: true,
    resBreach: true,
    resolutionMs: 99 * HOUR,
    touch: 'user-message',
  },
];

describe('Analytics: live tenant-scoped aggregates', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;
  let agentToken: string;
  let contactToken: string;
  let contactId: string;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());

    agentToken = await tokenFor(meridian, 'agent@meridian.test');
    contactToken = await portalTokenFor(meridian, 'jules@example.test');
    contactId = await contactOf(meridian, 'jules@example.test');
    userA = await userOf(meridian, 'agent@meridian.test');
    userB = await userOf(meridian, 'admin@meridian.test');

    // A clean slate, in case an earlier crashed run left rows in the window.
    await asOwner(`DELETE FROM ticket WHERE subject LIKE '${MARK}%'`, []);

    for (const spec of SPECS) await buildTicket(meridian, spec);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await asOwner(`DELETE FROM ticket WHERE subject LIKE '${MARK}%'`, []);
  });

  const server = () => request(app.getHttpServer());

  const tokenFor = async (tenantId: string, email: string): Promise<string> => {
    const { body } = await server()
      .post('/auth/sign-in')
      .send({ tenantId, email, password: PASSWORD })
      .expect(200);

    return body.accessToken as string;
  };

  const portalTokenFor = async (
    tenantId: string,
    email: string,
  ): Promise<string> => {
    const { body } = await server()
      .post('/portal/auth/sign-in')
      .send({ tenantId, email, password: PASSWORD })
      .expect(200);

    return body.accessToken as string;
  };

  /**
   * Materializes one spec as owner.
   *
   * The order is load-bearing. `first_response_at` and the latches are stamped
   * while the Ticket is still `open` and still null, so the state-machine
   * trigger's set-once coercion preserves them rather than clobbering them; the
   * terminal transition runs next; and the pause accumulator is frozen last,
   * with no state change, so the trigger leaves it exactly where it is set. A
   * conversation touch is added afterwards, so a `user`/`service` message can
   * never be the thing that satisfied the response clock — that fact is owned
   * here, not inferred from a message time.
   */
  const buildTicket = async (
    tenantId: string,
    spec: TicketSpec,
  ): Promise<void> => {
    const created = new Date(spec.createdAt);
    const assigneeId =
      spec.assignee === 'A' ? userA : spec.assignee === 'B' ? userB : null;

    const [{ id }] = await asOwner<{ id: string }>(
      `INSERT INTO "ticket"
         (id, tenant_id, subject, contact_id, assignee_id, state, priority,
          source, created_at, updated_at, last_activity_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'open', $5, $6, $7, $7, $7)
       RETURNING id::text`,
      [
        tenantId,
        `${MARK} ${spec.key}`,
        contactId,
        assigneeId,
        spec.priority,
        spec.source,
        spec.createdAt,
      ],
    );

    const frAt =
      spec.firstResponseMs === undefined
        ? null
        : new Date(created.getTime() + spec.firstResponseMs).toISOString();
    const latch = new Date(created.getTime() + 60_000).toISOString();

    await asOwner(
      `UPDATE "ticket"
          SET first_response_at = $2,
              first_response_breached_at = $3,
              resolution_breached_at = $4
        WHERE id = $1`,
      [id, frAt, spec.frBreach ? latch : null, spec.resBreach ? latch : null],
    );

    // Under an armed system context, not a bare owner statement: the transition
    // trigger writes a `ticket.transitioned` audit row and refuses to invent an
    // actor, exactly as it would for the dwell sweep that moves a Ticket on
    // nobody's behalf.
    const asSystem = { tenantId, actorKind: 'system' as const };

    if (spec.state !== 'open') {
      await asOwnerArmed(
        asSystem,
        `UPDATE "ticket" SET state = 'resolved' WHERE id = $1`,
        [id],
      );
    }
    if (spec.state === 'closed') {
      await asOwnerArmed(
        asSystem,
        `UPDATE "ticket" SET state = 'closed' WHERE id = $1`,
        [id],
      );
    }

    if (spec.resolutionMs !== undefined && spec.state !== 'open') {
      const pauseStart = new Date(
        created.getTime() + spec.resolutionMs,
      ).toISOString();

      await asOwner(
        `UPDATE "ticket"
            SET sla_paused_ms = 0, sla_pause_started_at = $2
          WHERE id = $1`,
        [id, pauseStart],
      );
    }

    if (spec.touch) await addTouch(tenantId, id, spec.touch);
  };

  /**
   * Adds the one conversation row a spec's deflection classification turns on.
   *
   * `asOwnerArmed` so the author is stamped from the armed actor rather than
   * supplied — a `user` Note and a `user` Message both disqualify deflection, a
   * `contact` reply and a `service` reply both leave it intact, and stamping
   * from context is how each row genuinely carries the author kind the metric
   * reads.
   */
  const addTouch = async (
    tenantId: string,
    ticketId: string,
    touch: NonNullable<TicketSpec['touch']>,
  ): Promise<void> => {
    const armed = {
      'user-message': { actorKind: 'user' as const, actorId: userA },
      'user-note': { actorKind: 'user' as const, actorId: userA },
      'contact-message': { actorKind: 'contact' as const, actorId: contactId },
      'service-message': {
        actorKind: 'service' as const,
        actorId: randomUUID(),
      },
    }[touch];

    const table = touch === 'user-note' ? 'note' : 'message';

    await asOwnerArmed(
      { tenantId, actorKind: armed.actorKind, actorId: armed.actorId },
      `INSERT INTO "${table}" (id, tenant_id, ticket_id, body)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [tenantId, ticketId, 'fixture'],
    );
  };

  interface Rate {
    count: number;
    rate: number | null;
  }
  interface Duration {
    p50: number;
    p90: number;
  }
  interface Metrics {
    cohortSize: number;
    deflection: Rate;
    resolution: Rate;
    firstResponseBreach: Rate;
    resolutionBreach: Rate;
    firstResponseMs: Duration | null;
    resolutionMs: Duration | null;
  }
  interface Report {
    from: string;
    to: string;
    groupBy: string | null;
    overall: Metrics;
    groups: (Metrics & { key: string })[] | null;
  }

  const reportAs = async (
    token: string,
    query: Record<string, string> = {},
  ): Promise<Report> => {
    const { body } = await server()
      .get('/analytics')
      .query({ from: FROM, to: TO, ...query })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return body as Report;
  };

  describe('the shared cohort', () => {
    it('is the tickets created in the window, and only those', async () => {
      // Eight in-window, and the two controls one month either side excluded —
      // the window is a half-open interval on creation time.
      const { overall } = await reportAs(agentToken);

      expect(overall.cohortSize).toBe(8);
    });

    it('defaults to a 30-day window anchored on creation time', async () => {
      // No `from`/`to`: the default window is the last 30 days, so a cohort
      // pinned to 2020 falls entirely outside it and the tenant reports zero
      // rather than the fixture.
      const { body } = await server()
        .get('/analytics')
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(200);

      const report = body as Report;

      expect(report.overall.cohortSize).toBe(0);
      expect(report.overall.deflection.rate).toBeNull();
    });
  });

  describe('the four headline rates', () => {
    it('computes deflection over the shared cohort', async () => {
      // Deflected = terminal with no user Message or Note: T1, T2 (contact
      // reply only), T7 (AI reply only). T4 is terminal but carries a user Note,
      // so it is excluded — the note-as-agent-touch rule.
      const { deflection } = (await reportAs(agentToken)).overall;

      expect(deflection.count).toBe(3);
      expect(deflection.rate).toBeCloseTo(3 / 8, 10);
    });

    it('excludes a ticket disqualified only by a user Note', async () => {
      // T4 has no customer-visible reply at all — only an internal Note — and
      // is still not deflected. The claim deflection makes is "no agent touched
      // it", and a Note is a touch.
      const { deflection } = (await reportAs(agentToken)).overall;

      // If the Note were ignored, T4 would count and this would be 4.
      expect(deflection.count).toBe(3);
    });

    it('computes resolution rate over the shared cohort', async () => {
      // Terminal (resolved or closed): T1, T2, T3, T4, T7, T8. T5 and T6 are
      // still open.
      const { resolution } = (await reportAs(agentToken)).overall;

      expect(resolution.count).toBe(6);
      expect(resolution.rate).toBeCloseTo(6 / 8, 10);
    });

    it('reports the two breach rates separately', async () => {
      // First-response latch: T3, T5, T6. Resolution latch: T5, T8. Reported
      // apart, so a slow start (three) is distinguishable from a slow finish
      // (two) rather than collapsed into one "any breach" figure.
      const { firstResponseBreach, resolutionBreach } = (
        await reportAs(agentToken)
      ).overall;

      expect(firstResponseBreach.count).toBe(3);
      expect(firstResponseBreach.rate).toBeCloseTo(3 / 8, 10);
      expect(resolutionBreach.count).toBe(2);
      expect(resolutionBreach.rate).toBeCloseTo(2 / 8, 10);
    });
  });

  describe('the duration distributions', () => {
    it('reports first-response time at p50 and p90', async () => {
      // First responses: 1h, 2h, 3h, 4h (T3, T5, T7, T8). percentile_cont over
      // [1,2,3,4]h gives p50 = 2.5h and p90 = 3.7h.
      const { firstResponseMs } = (await reportAs(agentToken)).overall;

      expect(firstResponseMs).not.toBeNull();
      expect(firstResponseMs!.p50).toBeCloseTo(2.5 * HOUR, 0);
      expect(firstResponseMs!.p90).toBeCloseTo(3.7 * HOUR, 0);
    });

    it('reports resolution time at p50 and p90', async () => {
      // Resolution durations, pause-frozen: 5, 10, 15, 20, 25, 30h. p50 = 17.5h,
      // p90 = 27.5h.
      const { resolutionMs } = (await reportAs(agentToken)).overall;

      expect(resolutionMs).not.toBeNull();
      expect(resolutionMs!.p50).toBeCloseTo(17.5 * HOUR, 0);
      expect(resolutionMs!.p90).toBeCloseTo(27.5 * HOUR, 0);
    });
  });

  describe('the closed group-by set', () => {
    it('partitions the cohort by source, summing back to the whole', async () => {
      const { overall, groups } = await reportAs(agentToken, {
        groupBy: 'source',
      });

      const bySource = Object.fromEntries(
        groups!.map((g) => [g.key, g.cohortSize]),
      );

      expect(bySource).toEqual({ widget: 3, portal: 4, slack: 1 });
      expect(sum(groups!)).toBe(overall.cohortSize);
    });

    it('partitions the cohort by priority, summing back to the whole', async () => {
      const { overall, groups } = await reportAs(agentToken, {
        groupBy: 'priority',
      });

      const byPriority = Object.fromEntries(
        groups!.map((g) => [g.key, g.cohortSize]),
      );

      expect(byPriority).toEqual({ low: 2, normal: 3, high: 2, urgent: 1 });
      expect(sum(groups!)).toBe(overall.cohortSize);
    });

    it('buckets the cohort by UTC day, summing back to the whole', async () => {
      const { overall, groups } = await reportAs(agentToken, {
        groupBy: 'day',
      });

      const byDay = Object.fromEntries(
        groups!.map((g) => [g.key, g.cohortSize]),
      );

      expect(byDay).toEqual({
        '2020-06-10': 2,
        '2020-06-11': 2,
        '2020-06-12': 2,
        '2020-06-13': 2,
      });
      expect(sum(groups!)).toBe(overall.cohortSize);
    });

    it('computes every metric within a group, not just its size', async () => {
      // The widget cut is T1, T2, T6. Worked by hand: deflected T1, T2 (2/3);
      // resolved T1, T2 (2/3); first-response breach T6 alone (1/3); no
      // resolution breach; no first response anywhere in the cut, so that
      // duration is null; resolution durations 10h (T1) and 20h (T2), giving
      // p50 15h and p90 19h.
      const { groups } = await reportAs(agentToken, { groupBy: 'source' });
      const widget = groups!.find((g) => g.key === 'widget')!;

      expect(widget.cohortSize).toBe(3);
      expect(widget.deflection).toEqual({ count: 2, rate: 2 / 3 });
      expect(widget.resolution).toEqual({ count: 2, rate: 2 / 3 });
      expect(widget.firstResponseBreach).toEqual({ count: 1, rate: 1 / 3 });
      expect(widget.resolutionBreach).toEqual({ count: 0, rate: 0 });
      expect(widget.firstResponseMs).toBeNull();
      expect(widget.resolutionMs!.p50).toBeCloseTo(15 * HOUR, 0);
      expect(widget.resolutionMs!.p90).toBeCloseTo(19 * HOUR, 0);
    });

    it('computes metrics over the narrowed assignee cohort', async () => {
      // userA's cut is T3 and T4 — T2 is dropped as deflected — so its rates and
      // durations are over two tickets, not three. Worked by hand: nothing
      // deflected; both resolved (2/2); first-response breach T3 alone (1/2); no
      // resolution breach; one first response of 1h, so p50 = p90 = 1h;
      // resolution durations 5h (T3) and 30h (T4), giving p50 17.5h and p90
      // 27.5h.
      const { groups } = await reportAs(agentToken, { groupBy: 'assignee' });
      const cut = groups!.find((g) => g.key === userA)!;

      expect(cut.cohortSize).toBe(2);
      expect(cut.deflection).toEqual({ count: 0, rate: 0 });
      expect(cut.resolution).toEqual({ count: 2, rate: 1 });
      expect(cut.firstResponseBreach).toEqual({ count: 1, rate: 0.5 });
      expect(cut.firstResponseMs!.p50).toBeCloseTo(1 * HOUR, 0);
      expect(cut.firstResponseMs!.p90).toBeCloseTo(1 * HOUR, 0);
      expect(cut.resolutionMs!.p50).toBeCloseTo(17.5 * HOUR, 0);
      expect(cut.resolutionMs!.p90).toBeCloseTo(27.5 * HOUR, 0);
    });

    it('excludes deflected and unassigned tickets from the assignee cut', async () => {
      // The assignee cut is agent-touched, assigned work only. userA holds T2,
      // T3, T4 — but T2 is deflected, so it drops. userB holds T5, T8. Every
      // unassigned ticket (T1, T6, T7) is absent, deflected or not.
      const { groups } = await reportAs(agentToken, { groupBy: 'assignee' });

      const byAssignee = Object.fromEntries(
        groups!.map((g) => [g.key, g.cohortSize]),
      );

      expect(byAssignee).toEqual({ [userA]: 2, [userB]: 2 });
      // Four, not eight: the cut is deliberately not a partition of the cohort.
      expect(sum(groups!)).toBe(4);
    });

    it('rejects a group-by outside the closed set', async () => {
      const { body } = await server()
        .get('/analytics')
        .query({ from: FROM, to: TO, groupBy: 'contact' })
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(400);

      expect(body.error.code).toBe('invalid_filter');
    });

    it('rejects an unknown query parameter rather than ignoring it', async () => {
      const { body } = await server()
        .get('/analytics')
        .query({ from: FROM, to: TO, groupby: 'source' })
        .set('Authorization', `Bearer ${agentToken}`)
        .expect(400);

      expect(body.error.code).toBe('invalid_filter');
    });
  });

  describe('access and isolation', () => {
    it('is gated on the analytics permission', async () => {
      // A Contact holds no analytics grant — the portal principal is refused
      // before any query runs.
      const { body } = await server()
        .get('/analytics')
        .query({ from: FROM, to: TO })
        .set('Authorization', `Bearer ${contactToken}`)
        .expect(403);

      expect(body.error.code).toBe('forbidden');
    });

    it('cannot see another tenant’s tickets', async () => {
      // The same-window cohort in a second tenant does not move Meridian's
      // figure: RLS filters before the aggregate, so cross-tenant counting is
      // impossible even over an identical window.
      const other = randomUUID();

      await asOwner(
        `INSERT INTO "ticket"
           (id, tenant_id, subject, contact_id, state, priority, source,
            created_at, updated_at, last_activity_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'open', 'normal', 'portal',
                 $4, $4, $4)`,
        [
          sortwood,
          `${MARK} ${other}`,
          await contactOf(sortwood, 'sam@example.test'),
          '2020-06-15T00:00:00.000Z',
        ],
      );

      const { overall } = await reportAs(agentToken);

      expect(overall.cohortSize).toBe(8);
    });
  });

  const sum = (groups: { cohortSize: number }[]): number =>
    groups.reduce((total, g) => total + g.cohortSize, 0);
});
