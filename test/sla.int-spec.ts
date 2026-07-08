import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { RealtimeService } from 'src/realtime/realtime.service';
import { DwellSweep } from 'src/sla/dwell.sweep';
import { SlaBreachSweep } from 'src/sla/sla-breach.sweep';
import { asOwner, contactOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * The clocks, the latches, and the two dwell timers.
 *
 * Every test here runs the sweep **twice** and asserts a single effect. That is
 * not belt-and-braces: the sweeps have no lock, no in-memory state and no
 * "already handled" flag, so idempotence is entirely a property of two SQL
 * predicates, and a suite that ran each sweep once would pass just as happily
 * against an implementation that escalated the same breach every sixty seconds
 * forever.
 *
 * Time is moved by backdating rows rather than by waiting. The windows here are
 * hours and days, so this is the only way the suite can exist — and it is also
 * the honest way, since the sweep takes `now` as a parameter precisely so that
 * "what would happen next Tuesday" is a question a test can ask.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';
const MARK = 'sla-int-spec';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface ClockRow {
  id: string;
  state: string;
  priority: string;
  first_response_at: Date | null;
  sla_paused_ms: string;
  sla_pause_started_at: Date | null;
  first_response_breached_at: Date | null;
  resolution_breached_at: Date | null;
  last_activity_at: Date;
}

describe('SLA clocks, breach latches and the dwell sweeps', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;
  let agentToken: string;
  let adminToken: string;
  let contactId: string;
  let breachSweep: SlaBreachSweep;
  let dwellSweep: DwellSweep;

  /** Every breach announced during one test, in emission order. */
  let announced: { tenantId: string; ticketId: string; timer: string }[];

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());

    agentToken = await tokenFor(meridian, 'agent@meridian.test');
    adminToken = await tokenFor(meridian, 'admin@meridian.test');
    contactId = await contactOf(meridian, 'jules@example.test');

    breachSweep = app.get(SlaBreachSweep);
    dwellSweep = app.get(DwellSweep);

    // Spying on the seam rather than opening a socket. What these tests are
    // about is *how many times* a breach is announced, and the socket suite
    // already proves that an announcement reaches the agents room.
    const realtime = app.get(RealtimeService);

    jest
      .spyOn(realtime, 'slaBreached')
      .mockImplementation((tenantId, breach) => {
        announced.push({
          tenantId,
          ticketId: breach.ticketId,
          timer: breach.timer,
        });

        return Promise.resolve();
      });

    jest.spyOn(realtime, 'ticketUpdated').mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app?.close();
    await asOwner(`DELETE FROM ticket WHERE subject LIKE '${MARK}%'`, []);
  });

  beforeEach(() => {
    announced = [];
  });

  const server = () => request(app.getHttpServer());

  const tokenFor = async (tenantId: string, email: string): Promise<string> => {
    const { body } = await server()
      .post('/auth/sign-in')
      .send({ tenantId, email, password: PASSWORD })
      .expect(200);

    return body.accessToken as string;
  };

  const createTicket = async (): Promise<string> => {
    const { body } = await server()
      .post('/tickets')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ subject: `${MARK} ${randomUUID()}`, contactId, source: 'portal' })
      .expect(201);

    return body.id as string;
  };

  const setState = (id: string, state: string, token = agentToken) =>
    server()
      .patch(`/tickets/${id}/state`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state })
      .expect(200);

  const setPriority = (id: string, priority: string) =>
    server()
      .patch(`/tickets/${id}/priority`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ priority })
      .expect(200);

  const postMessage = (id: string) =>
    server()
      .post(`/tickets/${id}/messages`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ body: 'looking into it now' })
      .expect(201);

  /**
   * The customer's own reply, which arrives on the portal surface.
   *
   * A different route rather than the same one with a different token — a
   * Contact holds no `ticket:reply`, so the agent endpoint refuses them. Worth
   * keeping distinct here, because "the customer's message does not satisfy
   * first response" is a claim about the author on the row, and posting it
   * through the path a customer actually uses is what makes the test about the
   * trigger rather than about a token.
   */
  const postContactMessage = async (id: string) =>
    server()
      .post(`/portal/tickets/${id}/messages`)
      .set('Authorization', `Bearer ${await portalTokenFor()}`)
      .send({ body: 'still not working, any update?' })
      .expect(201);

  const postNote = (id: string) =>
    server()
      .post(`/tickets/${id}/notes`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ body: 'checked the logs, nothing yet' })
      .expect(201);

  const clockOf = async (id: string): Promise<ClockRow> => {
    const rows = await asOwner<ClockRow>(
      `SELECT id::text, state::text, priority::text, first_response_at,
              sla_paused_ms::text, sla_pause_started_at,
              first_response_breached_at, resolution_breached_at,
              last_activity_at
         FROM ticket WHERE id = $1`,
      [id],
    );

    return rows[0];
  };

  /**
   * Rewinds a Ticket's creation so that `age` has elapsed against its clock.
   *
   * As the owner and by direct column write, because there is no legitimate way
   * to do this and there should not be one — the point of the accumulator is
   * that no caller can edit it. Only `created_at` moves, so whatever pause the
   * Ticket has accrued through real transitions is preserved and keeps counting
   * against the elapsed figure exactly as it would have in slow motion.
   */
  const age = (id: string, by: number) =>
    asOwner(
      `UPDATE ticket SET created_at = created_at - ($2 || ' milliseconds')::interval
        WHERE id = $1`,
      [id, String(by)],
    );

  /** Backdates the dwell stamp without touching state, as real silence would. */
  const silentFor = (id: string, duration: number) =>
    asOwner(
      `UPDATE ticket SET last_activity_at = now() - ($2 || ' milliseconds')::interval
        WHERE id = $1`,
      [id, String(duration)],
    );

  const auditBreaches = (id: string) =>
    asOwner<{ actor_kind: string; actor_id: string | null; metadata: unknown }>(
      `SELECT actor_kind::text, actor_id::text, metadata
         FROM audit_log
        WHERE ticket_id = $1 AND action = 'sla.breached'
        ORDER BY created_at`,
      [id],
    );

  /** The tick, twice. Every effect below is asserted against both runs. */
  const sweepTwice = async (now = new Date()): Promise<void> => {
    await breachSweep.run(now);
    await breachSweep.run(now);
  };

  describe('the target matrix', () => {
    it('seeds all four priorities for every tenant, identically', async () => {
      const rows = await asOwner<{
        tenant_id: string;
        priority: string;
        first_response_ms: string;
        resolution_ms: string;
      }>(
        `SELECT tenant_id::text, priority::text,
                first_response_ms::text, resolution_ms::text
           FROM sla_target WHERE tenant_id = ANY($1)`,
        [[meridian, sortwood]],
      );

      // Keyed rather than ordered: the claim is which targets each priority
      // carries, and asserting a row order would be asserting the enum's
      // declaration order as well.
      const matrix = (tenantId: string) =>
        Object.fromEntries(
          rows
            .filter((row) => row.tenant_id === tenantId)
            .map((row) => [
              row.priority,
              [Number(row.first_response_ms), Number(row.resolution_ms)],
            ]),
        );

      const expected = {
        low: [24 * HOUR, 120 * HOUR],
        normal: [8 * HOUR, 72 * HOUR],
        high: [2 * HOUR, 24 * HOUR],
        urgent: [1 * HOUR, 8 * HOUR],
      };

      expect(matrix(meridian)).toEqual(expected);
      expect(matrix(sortwood)).toEqual(expected);
    });

    it('is not writable by the application, at any privilege', async () => {
      // Not "there is no endpoint" — a claim about one port — but a withheld
      // privilege, which the Spring and FastAPI ports inherit for free.
      const [grant] = await asOwner<{ privileges: string }>(
        `SELECT string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privileges
           FROM information_schema.role_table_grants
          WHERE grantee = 'app_user' AND table_name = 'sla_target'`,
      );

      expect(grant.privileges).toBe('SELECT');
    });
  });

  describe('the first-response clock', () => {
    it('is satisfied by an agent’s customer-visible message', async () => {
      const id = await createTicket();
      expect((await clockOf(id)).first_response_at).toBeNull();

      await postMessage(id);

      expect((await clockOf(id)).first_response_at).not.toBeNull();
    });

    it('is not satisfied by an internal Note', async () => {
      // The rule that stops the metric measuring activity instead of
      // responsiveness: a team cannot answer its customer by writing to itself.
      const id = await createTicket();

      await postNote(id);

      expect((await clockOf(id)).first_response_at).toBeNull();
    });

    it('is not satisfied by a state change', async () => {
      const id = await createTicket();

      await setState(id, 'pending');
      await setState(id, 'open');

      expect((await clockOf(id)).first_response_at).toBeNull();
    });

    it('is not satisfied by the customer’s own message', async () => {
      // Their message is the question, not the answer to it.
      const id = await createTicket();

      await postContactMessage(id);

      expect((await clockOf(id)).first_response_at).toBeNull();
    });

    it('records the first reply and is never overwritten by a later one', async () => {
      const id = await createTicket();

      await postMessage(id);
      const first = (await clockOf(id)).first_response_at;

      await postMessage(id);
      expect((await clockOf(id)).first_response_at).toEqual(first);

      // And not by a writer holding every privilege the application does not.
      // "Set once" is a trigger, so it is true of the owner connection too.
      await asOwner(
        `UPDATE ticket SET first_response_at = now() WHERE id = $1`,
        [id],
      );

      expect((await clockOf(id)).first_response_at).toEqual(first);
    });
  });

  describe('the resolution clock', () => {
    it('pauses in pending and keeps running in on_hold', async () => {
      const paused = await createTicket();
      const held = await createTicket();

      await setState(paused, 'pending');
      await setState(held, 'on_hold');

      // Time waiting on the customer is not the team's to answer for; an
      // internal blocker is still the customer waiting, and hiding it would
      // make the metric flattering rather than useful.
      expect((await clockOf(paused)).sla_pause_started_at).not.toBeNull();
      expect((await clockOf(held)).sla_pause_started_at).toBeNull();
    });

    it('accumulates a pending interval when the Ticket comes back', async () => {
      const id = await createTicket();

      await setState(id, 'pending');
      await asOwner(
        `UPDATE ticket SET sla_pause_started_at = now() - interval '3 hours' WHERE id = $1`,
        [id],
      );
      await setState(id, 'open');

      const row = await clockOf(id);

      expect(row.sla_pause_started_at).toBeNull();
      expect(Number(row.sla_paused_ms)).toBeGreaterThanOrEqual(3 * HOUR - 1000);
      expect(Number(row.sla_paused_ms)).toBeLessThan(3 * HOUR + 60_000);
    });

    it('resumes rather than resets when a resolved Ticket is reopened', async () => {
      // The property that stops reopen being a way to launder elapsed time. A
      // Ticket resolved at six hours does not get a fresh budget.
      const id = await createTicket();
      await age(id, 6 * HOUR);

      await setState(id, 'resolved');
      await setState(id, 'open');

      const row = await clockOf(id);

      // Creation is still six hours ago and the pause is only the resolved
      // interval — a handful of milliseconds — so the clock reads six hours.
      expect(Number(row.sla_paused_ms)).toBeLessThan(60_000);

      const [elapsed] = await asOwner<{ ms: string }>(
        `SELECT ticket_sla_active_elapsed_ms(created_at, sla_paused_ms,
                  sla_pause_started_at, now())::text AS ms
           FROM ticket WHERE id = $1`,
        [id],
      );

      expect(Number(elapsed.ms)).toBeGreaterThan(6 * HOUR - 60_000);
    });
  });

  describe('breach latches', () => {
    it('latches first response once, however many times the sweep runs', async () => {
      const id = await createTicket();
      // `normal` promises a first response in eight hours.
      await age(id, 9 * HOUR);

      await sweepTwice();

      const row = await clockOf(id);
      expect(row.first_response_breached_at).not.toBeNull();
      // Nine hours is well short of the 72-hour resolution target.
      expect(row.resolution_breached_at).toBeNull();

      expect(await auditBreaches(id)).toHaveLength(1);
      expect(announced.filter((event) => event.ticketId === id)).toEqual([
        { tenantId: meridian, ticketId: id, timer: 'first_response' },
      ]);
    });

    it('writes the audit row as the system actor, with the timer in metadata', async () => {
      const id = await createTicket();
      await age(id, 9 * HOUR);

      await sweepTwice();

      expect(await auditBreaches(id)).toEqual([
        {
          actor_kind: 'system',
          actor_id: null,
          metadata: { kind: 'first_response' },
        },
      ]);
    });

    it('never changes the Ticket’s priority or assignee', async () => {
      // Escalation is notify-don't-mutate. Bumping the priority would
      // retroactively change the target the Ticket is scored against, since
      // priority is the sole SLA key.
      const id = await createTicket();
      await age(id, 9 * HOUR);

      const before = await clockOf(id);
      await sweepTwice();
      const after = await clockOf(id);

      expect(after.priority).toBe(before.priority);
      expect(after.state).toBe(before.state);
    });

    it('latches both clocks on a Ticket left long enough to miss both', async () => {
      const id = await createTicket();
      await age(id, 80 * HOUR);

      await sweepTwice();

      const row = await clockOf(id);
      expect(row.first_response_breached_at).not.toBeNull();
      expect(row.resolution_breached_at).not.toBeNull();

      expect(await auditBreaches(id)).toHaveLength(2);
      expect(
        announced.filter((event) => event.ticketId === id).map((e) => e.timer),
      ).toEqual(['first_response', 'resolution']);
    });

    it('survives a late reply — a breach that happened stays recorded', async () => {
      const id = await createTicket();
      await age(id, 9 * HOUR);
      await sweepTwice();

      const latched = (await clockOf(id)).first_response_breached_at;
      expect(latched).not.toBeNull();

      await postMessage(id);
      await sweepTwice();

      expect((await clockOf(id)).first_response_breached_at).toEqual(latched);
    });

    it('survives a reopen', async () => {
      const id = await createTicket();
      await age(id, 80 * HOUR);
      await sweepTwice();

      const latched = (await clockOf(id)).resolution_breached_at;

      await setState(id, 'resolved');
      await setState(id, 'open');

      expect((await clockOf(id)).resolution_breached_at).toEqual(latched);
    });

    it('does not breach a Ticket that was answered inside its target', async () => {
      const id = await createTicket();
      await postMessage(id);
      await age(id, 9 * HOUR);

      await sweepTwice();

      expect((await clockOf(id)).first_response_breached_at).toBeNull();
      expect(announced.filter((event) => event.ticketId === id)).toEqual([]);
    });

    it('does not breach resolution on a Ticket that is already resolved', async () => {
      const id = await createTicket();
      await postMessage(id);
      await setState(id, 'resolved');
      // The clock stopped at `resolved`, so wall-clock age past the target does
      // not accrue against it.
      await age(id, 80 * HOUR);

      await sweepTwice();

      expect((await clockOf(id)).resolution_breached_at).toBeNull();
    });

    it('does not count paused time against the resolution target', async () => {
      const id = await createTicket();
      await postMessage(id);
      // Eighty hours old against a 72-hour resolution target, but the whole of
      // it was spent waiting on the customer.
      await age(id, 80 * HOUR);
      await setState(id, 'pending');
      await asOwner(
        `UPDATE ticket SET sla_pause_started_at = created_at WHERE id = $1`,
        [id],
      );

      await sweepTwice();

      expect((await clockOf(id)).resolution_breached_at).toBeNull();
    });

    it('keeps the first-response clock running while the Ticket waits in pending', async () => {
      // The first-response clock does not pause, and this is the case that
      // makes it matter: a Ticket parked in `pending` that nobody ever answered.
      // If it paused here, a team could discharge its response promise by moving
      // the Ticket instead of replying to it — and the breach would never fire,
      // silently, for exactly the tickets that most deserve it.
      const id = await createTicket();
      await age(id, 9 * HOUR);
      await setState(id, 'pending');
      await asOwner(
        `UPDATE ticket SET sla_pause_started_at = created_at WHERE id = $1`,
        [id],
      );

      await sweepTwice();

      expect((await clockOf(id)).first_response_breached_at).not.toBeNull();
      expect(
        announced.filter((event) => event.ticketId === id).map((e) => e.timer),
      ).toEqual(['first_response']);
    });

    it('keeps the first-response clock running through a resolve with no reply', async () => {
      // Resolving a Ticket is not answering it. The resolution clock stops here
      // — the work is done, as far as the team is concerned — but nobody ever
      // said anything to the customer, so first response is still owed and still
      // breaches.
      const id = await createTicket();
      await setState(id, 'resolved');
      await age(id, 9 * HOUR);

      await sweepTwice();

      const row = await clockOf(id);
      expect(row.first_response_at).toBeNull();
      expect(row.first_response_breached_at).not.toBeNull();
      expect(row.resolution_breached_at).toBeNull();
    });

    it('scores each priority against its own target', async () => {
      // `urgent` promises a first response in one hour, `normal` in eight.
      const urgent = await createTicket();
      const normal = await createTicket();

      await setPriority(urgent, 'urgent');
      await age(urgent, 2 * HOUR);
      await age(normal, 2 * HOUR);

      await sweepTwice();

      expect((await clockOf(urgent)).first_response_breached_at).not.toBeNull();
      expect((await clockOf(normal)).first_response_breached_at).toBeNull();
    });
  });

  describe('the dwell timers', () => {
    const dwellTwice = async (now = new Date()): Promise<void> => {
      await dwellSweep.run(now);
      await dwellSweep.run(now);
    };

    it('resolves a pending Ticket silent for seven days, once', async () => {
      const id = await createTicket();
      await setState(id, 'pending');
      await silentFor(id, 8 * DAY);

      await dwellTwice();

      expect((await clockOf(id)).state).toBe('resolved');

      // One transition, not two: the second run's `WHERE state = 'pending'`
      // no longer matches the row the first one moved.
      const transitions = await asOwner<{ to_value: string }>(
        `SELECT to_value FROM audit_log
          WHERE ticket_id = $1 AND action = 'ticket.transitioned'
            AND to_value = 'resolved'`,
        [id],
      );

      expect(transitions).toHaveLength(1);
    });

    it('closes a resolved Ticket silent for seven days, once', async () => {
      const id = await createTicket();
      await setState(id, 'resolved');
      await silentFor(id, 8 * DAY);

      await dwellTwice();

      expect((await clockOf(id)).state).toBe('closed');
    });

    it('attributes the transition to the system actor', async () => {
      const id = await createTicket();
      await setState(id, 'pending');
      await silentFor(id, 8 * DAY);

      await dwellTwice();

      const [entry] = await asOwner<{ actor_kind: string; actor_id: string }>(
        `SELECT actor_kind::text, actor_id::text FROM audit_log
          WHERE ticket_id = $1 AND action = 'ticket.transitioned'
            AND to_value = 'resolved'`,
        [id],
      );

      expect(entry).toEqual({ actor_kind: 'system', actor_id: null });
    });

    it('leaves a Ticket alone until the window has actually passed', async () => {
      const id = await createTicket();
      await setState(id, 'pending');
      await silentFor(id, 6 * DAY);

      await dwellTwice();

      expect((await clockOf(id)).state).toBe('pending');
    });

    it('does not sweep a pending Ticket all the way to closed in one tick', async () => {
      // The first timer stamps `last_activity_at`, so the Ticket it resolves is
      // seven days short of the second — which is what makes running both in one
      // pass safe rather than a way to close work nobody looked at.
      const id = await createTicket();
      await setState(id, 'pending');
      await silentFor(id, 30 * DAY);

      await dwellTwice();

      expect((await clockOf(id)).state).toBe('resolved');
    });

    it('counts a customer’s reply as activity', async () => {
      const id = await createTicket();
      await setState(id, 'pending');
      await silentFor(id, 8 * DAY);

      // A Message moves nothing on the Ticket's own columns, which is exactly
      // why the dwell timers read `last_activity_at` and not `updated_at`.
      //
      // The reply also reopens the Ticket, which is the contact-reply path's
      // doing rather than this sweep's — so the assertion is that the dwell
      // timer did not settle it, not that it stayed put. A Ticket someone is
      // still talking on is not abandoned by either route out of `pending`.
      await postContactMessage(id);

      await dwellTwice();

      expect((await clockOf(id)).state).toBe('open');
    });

    it('counts an internal Note as activity', async () => {
      // A Note never satisfies first response, but it does mean somebody is
      // working the Ticket — so it should not settle out from under them. The
      // two questions are different and the two columns record them separately.
      const id = await createTicket();
      await setState(id, 'pending');
      await silentFor(id, 8 * DAY);

      await postNote(id);

      await dwellTwice();

      const row = await clockOf(id);
      expect(row.state).toBe('pending');
      expect(row.first_response_at).toBeNull();
    });

    it('leaves a closed Ticket alone', async () => {
      const id = await createTicket();
      await setState(id, 'resolved');
      await setState(id, 'closed', adminToken);
      await silentFor(id, 30 * DAY);

      await dwellTwice();

      expect((await clockOf(id)).state).toBe('closed');
    });

    it('does not let a latched breach reset the silence window', async () => {
      // The sweeps run in one tick against the same rows. If latching a breach
      // counted as activity, a breached Ticket could never dwell — so the
      // trigger bumps `last_activity_at` for the three audited edits and not for
      // a latch write.
      const id = await createTicket();
      await setState(id, 'pending');
      await age(id, 30 * DAY);
      await silentFor(id, 8 * DAY);

      await breachSweep.run(new Date());
      await dwellSweep.run(new Date());

      expect((await clockOf(id)).state).toBe('resolved');
    });
  });

  describe('tenant isolation', () => {
    it('sweeps every tenant without any tenant seeing another', async () => {
      // The sweeper's cross-tenant reach is the list of ids and nothing else:
      // each tenant's Tickets are read and written under an ordinary tenant
      // context, so a breach in Meridian is announced to Meridian's room.
      const id = await createTicket();
      await age(id, 9 * HOUR);

      await sweepTwice();

      const mine = announced.filter((event) => event.ticketId === id);

      expect(mine).toHaveLength(1);
      expect(mine[0].tenantId).toBe(meridian);
    });

    it('gives the sweeper context no reach beyond enumerating tenants', async () => {
      // The setting is named by exactly one policy on exactly one table. A
      // second table growing the same clause would make this a skeleton key,
      // and it would be invisible in review — so the assertion is over
      // `pg_policies` rather than over behaviour at one call site.
      const policies = await asOwner<{
        tablename: string;
        policyname: string;
      }>(
        `SELECT tablename, policyname
           FROM pg_policies
          WHERE qual LIKE '%app.sweeper%' OR with_check LIKE '%app.sweeper%'
          ORDER BY tablename, policyname`,
      );

      expect(policies).toEqual([
        { tablename: 'tenant', policyname: 'sweeper_enumerate' },
      ]);
    });
  });

  const portalTokenFor = async (): Promise<string> => {
    const { body } = await server()
      .post('/portal/auth/sign-in')
      .send({
        tenantId: meridian,
        email: 'jules@example.test',
        password: PASSWORD,
      })
      .expect(200);

    return body.accessToken as string;
  };
});
