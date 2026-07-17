import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RealtimeService } from 'src/realtime/realtime.service';
import { DrainerService } from 'src/scheduler/drainer.service';
import { JobQueueService } from 'src/scheduler/job-queue.service';
import { SlaBreachSweep } from 'src/sla/sla-breach.sweep';
import { TenancyService } from 'src/tenancy/tenancy.service';
import request from 'supertest';
import { asOwner, contactOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * What survives the keep-warm ping being missed.
 *
 * The scheduler runs in-process on the web service, so a free-tier platform
 * that sleeps an idle service stops the ticker. An external ping every five
 * minutes is what prevents that — and it is somebody else's service, reached
 * over somebody else's network, so it will eventually not arrive.
 *
 * The claim this file exists to hold up is that such a gap costs *time* and
 * nothing else. Both ticks fire on state rather than on events: the sweep asks
 * "which Tickets are past their target and not yet latched", and the drain asks
 * "which Jobs are due", neither of which has any notion of a tick it should
 * have run at. So the work waits rather than being skipped.
 *
 * A gap is expressed here the way the sweeps themselves express time — by
 * passing a later `now` — which is exactly the shape of "nothing ran for six
 * hours, and then something did".
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';
const MARK = 'deployment-int-spec';

const HOUR = 60 * 60 * 1000;

/** Longer than any keep-warm ping interval — a genuine outage, not jitter. */
const OUTAGE = 6 * HOUR;

/**
 * The seeded first-response target for a `normal` Ticket, which is what
 * `POST /tickets` creates by default.
 *
 * Named here so the moment below is unambiguous: the sweep resumes `OUTAGE`
 * after the Ticket became overdue, which puts the instant it fell due squarely
 * inside the window in which nothing was running.
 */
const NORMAL_FIRST_RESPONSE = 8 * HOUR;

/** When the first sweep after the outage runs. */
const afterTheGap = (extra = 0) =>
  new Date(Date.now() + NORMAL_FIRST_RESPONSE + OUTAGE + extra);

describe('a missed keep-warm ping', () => {
  let app: INestApplication;
  let meridian: string;
  let agentToken: string;
  let contactId: string;
  let breachSweep: SlaBreachSweep;
  let drainer: DrainerService;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian } = await seededTenantIds());

    const { body } = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        tenantId: meridian,
        email: 'agent@meridian.test',
        password: PASSWORD,
      })
      .expect(200);

    agentToken = body.accessToken as string;
    contactId = await contactOf(meridian, 'jules@example.test');

    breachSweep = app.get(SlaBreachSweep);
    drainer = app.get(DrainerService);

    // The announcement seam, spied rather than socketed: this file is about
    // whether the effect happens at all after a gap, and the realtime suite
    // already proves an announcement reaches the agents room.
    const realtime = app.get(RealtimeService);
    jest.spyOn(realtime, 'slaBreached').mockResolvedValue(undefined);
    jest.spyOn(realtime, 'ticketUpdated').mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app?.close();
    await asOwner(`DELETE FROM ticket WHERE subject LIKE '${MARK}%'`, []);
    await asOwner(`DELETE FROM job WHERE kind = '${MARK}.job'`, []);
  });

  const createTicket = async (): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ subject: `${MARK} ${randomUUID()}`, contactId, source: 'portal' })
      .expect(201);

    return body.id as string;
  };

  it('still latches a breach that fell due while nothing was running', async () => {
    // The Ticket misses its target during the gap: no sweep runs at the moment
    // it becomes overdue, which is precisely the case an event-driven design
    // would drop on the floor. The first sweep afterwards has to notice.
    const id = await createTicket();

    await breachSweep.run(afterTheGap());

    const [ticket] = await asOwner<{ first_response_breached_at: Date | null }>(
      `SELECT first_response_breached_at FROM ticket WHERE id = $1`,
      [id],
    );

    expect(ticket.first_response_breached_at).not.toBeNull();
  });

  it('latches it once, however far behind the sweep is', async () => {
    // The other half, and the reason lateness is safe rather than merely
    // survivable: catching up is not the same as replaying. A sweep resuming
    // after six hours must not fire six hours of escalations, and it does not,
    // because the latch is set-once in SQL rather than counted per tick.
    const id = await createTicket();

    await breachSweep.run(afterTheGap());
    await breachSweep.run(afterTheGap(OUTAGE));

    const escalations = await asOwner(
      `SELECT id FROM audit_log WHERE ticket_id = $1 AND action = 'sla.breached'`,
      [id],
    );

    expect(escalations).toHaveLength(1);
  });

  it('still claims a Job that came due while nothing was draining', async () => {
    // The queue's half of the same property. `runAfter` is a threshold the
    // claim compares against the current time, not an appointment that can be
    // missed, so a Job due at any point during the gap is simply due now.
    const tenancy = app.get(TenancyService);

    await tenancy.withTenant(
      { tenantId: meridian, actor: { kind: 'system' } },
      (tx) =>
        app.get(JobQueueService).enqueue(tx, {
          kind: `${MARK}.job`,
          payload: {},
          runAfter: new Date(Date.now() - OUTAGE),
        }),
    );

    const summary = await drainer.tick();

    expect(summary.claimed).toBeGreaterThanOrEqual(1);

    // Claimed and then failed — there is no handler registered for this kind,
    // which is the cheapest way to observe a claim without inventing work. What
    // is asserted is that the drain reached it at all: a Job left `ready` here
    // would mean the gap had cost it its turn rather than delayed it.
    const [job] = await asOwner<{ status: string; attempts: number }>(
      `SELECT status::text, attempts FROM job WHERE kind = '${MARK}.job'`,
      [],
    );

    expect(job.attempts).toBeGreaterThanOrEqual(1);
  });
});
