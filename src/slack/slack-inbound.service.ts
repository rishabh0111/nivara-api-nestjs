import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  IdempotencyKey,
  IdempotencyService,
} from '../idempotency/idempotency.service';
import { verifySignature } from '../integrations/signature-scheme';
import {
  INBOUND_EVENT_JOB,
  inboundEventScope,
} from '../integrations/job-kinds';
import { JobQueueService } from '../scheduler/job-queue.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantContext } from '../tenancy/tenant-context';
import { readSlackEnvelope } from './slack-event';
import { SlackInstallationService } from './slack-installation.service';
import { SLACK_SIGNATURE_SCHEME } from './slack-signature';

/** The bytes and headers of one inbound POST, before anything has been believed. */
export interface SlackRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

/**
 * What the endpoint should answer.
 *
 * Three outcomes, and only one of them is a refusal. `ack` covers every case
 * where the request was genuinely from Slack and there is nothing more to do —
 * an unknown workspace, a duplicate, an event type this adapter ignores. Slack
 * treats anything but a 200 as a failure and retries it, so answering those with
 * an error would buy a retry storm for events that will never be processed no
 * matter how many times they arrive.
 */
export type SlackAck =
  /** 200, nothing in the body. */
  | { outcome: 'ack' }
  /** 200, echoing the challenge — the one-time endpoint handshake. */
  | { outcome: 'challenge'; challenge: string }
  /** 401, empty. The request did not come from Slack, or came too long ago. */
  | { outcome: 'refuse' };

/**
 * The front half of the Slack adapter: decide whether to believe a request, then
 * get off the line.
 *
 * The ordering below is the design, and it is stricter than it looks. Every step
 * is a gate on the next, and *no write of any kind happens above the signature
 * check* — not a log line naming a tenant, not a dedupe row, not a queued job.
 * An unverified request therefore leaves no trace in tenant data and cannot cost
 * a row, which is what makes a public unauthenticated endpoint safe to expose at
 * all.
 *
 *   1. verify over the raw bytes, before parsing
 *   2. parse
 *   3. resolve the tenant from the *verified* workspace
 *   4. claim the event id, first-writer-wins
 *   5. queue the work durably
 *   6. answer
 *
 * Steps 5 and 6 are the ack-fast requirement, and step 5 is why it is safe: the
 * job is a committed row before Slack is told yes, so the gap between "we
 * accepted this" and "we did it" survives a restart of this process. Slack gives
 * three seconds and retries otherwise, and the work here — ingesting a Contact,
 * opening a Ticket, announcing it — is not work with a three-second bound.
 */
@Injectable()
export class SlackInboundService {
  private readonly logger = new Logger(SlackInboundService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly installations: SlackInstallationService,
    private readonly idempotency: IdempotencyService,
    private readonly queue: JobQueueService,
    private readonly tenancy: TenancyService,
  ) {}

  async accept(
    request: SlackRequest,
    now: Date = new Date(),
  ): Promise<SlackAck> {
    const secret = this.config.slackSigningSecret;

    // Dormant rather than broken, and this is the *only* gate — the route is
    // mounted unconditionally, because a controller that appeared and disappeared
    // with configuration would make "does this endpoint exist" a question whose
    // answer depends on a deployment's environment.
    //
    // It refuses rather than acking. There is no secret, so nothing about the
    // request has been proved, and acknowledging an unverified request is exactly
    // the thing this method exists not to do. A caller reaching a dormant adapter
    // therefore sees the same bare 401 a forged request sees, which is also the
    // right answer: whether a tenant has Slack configured is not something an
    // unauthenticated caller should be able to probe for.
    if (!secret) return REFUSE;

    const verification = verifySignature(SLACK_SIGNATURE_SCHEME, {
      headers: request.headers,
      rawBody: request.rawBody,
      secret,
      now,
    });

    if (!verification.ok) {
      // The reason goes to the log and never to the response. A client able to
      // tell "your signature is wrong" from "your clock is off" learns which half
      // of the scheme to keep probing; the operator reading this at three in the
      // morning is not that client, and the two have completely different fixes.
      this.logger.warn(
        `Refused an inbound Slack request: ${verification.reason}`,
      );

      return REFUSE;
    }

    // Only now. Parsing before this point would put a parser — the largest piece
    // of attack surface in the request path — in front of the gate, which is the
    // whole reason the signature is computed over raw bytes rather than over a
    // re-encoded object.
    const payload = parseJson(request.rawBody);

    if (payload === undefined) {
      this.logger.warn('A verified Slack request carried an unparseable body');

      return ACK;
    }

    const envelope = readSlackEnvelope(payload);

    if (envelope.kind === 'challenge') {
      // The handshake, and deliberately the only thing that happens on it. It
      // arrives once, when the endpoint URL is saved, and it names no workspace —
      // so there is nothing to resolve, nothing to deduplicate and nothing to
      // queue.
      return { outcome: 'challenge', challenge: envelope.challenge };
    }

    if (envelope.kind === 'ignored') return ACK;

    // The tenant, from the workspace Slack signed for — never from anything the
    // payload says about who it belongs to.
    const installation = await this.installations.resolve(envelope.teamId);

    if (!installation) {
      // Genuinely from Slack, about a workspace we have no arrangement with. An
      // error here would have Slack retrying an event that can never be
      // processed, so it is acknowledged and logged.
      this.logger.warn(
        `Dropped a verified Slack event from unrecognised workspace ${envelope.teamId}`,
      );

      return ACK;
    }

    const context: TenantContext = {
      tenantId: installation.tenantId,
      actor: { kind: 'system' },
    };

    const key: IdempotencyKey = {
      scope: inboundEventScope('slack'),
      key: envelope.eventId,
    };

    // No request hash, and that absence is load-bearing rather than lazy. Slack
    // redelivers the *same* event in an envelope that is not guaranteed
    // byte-identical, so hashing it would report a key-reuse bug for what is in
    // fact the ordinary at-least-once redelivery this claim exists to absorb.
    const claim = await this.idempotency.claim(context, key);

    if (claim.outcome !== 'fresh') {
      // A retry of something already handled, or one arriving while the original
      // is still in flight. Both are acked and dropped: the effect is owed
      // exactly once and somebody already owns it.
      return ACK;
    }

    try {
      // The durable half of ack-fast. Queued inside a transaction, so the row is
      // committed before Slack is answered — which is the difference between
      // "accepted and will happen" and "accepted and might have evaporated".
      await this.tenancy.withTenant(context, (tx) =>
        this.queue.enqueue(tx, {
          kind: INBOUND_EVENT_JOB,
          payload: {
            source: 'slack',
            eventId: envelope.eventId,
            botUserId: installation.botUserId,
            // The one place this codebase's "payloads are ids, never content"
            // convention is knowingly broken, and it is broken because the
            // convention's premise does not hold here: there is no row to point
            // at yet. The event *is* the input, and it exists nowhere else until
            // this job runs.
            //
            // The convention's actual concern — that the drainer's claim is the
            // one cross-tenant read in the application, so a payload is readable
            // with no tenant armed — is met by what is carried rather than by
            // carrying less. This is an already-verified Slack event: a channel
            // id, a user id and a sentence a customer wrote in a channel their
            // own team's bot is sitting in. It is exactly as sensitive as the
            // Ticket it is about to become, and it is deleted with the job.
            event: envelope.event,
          },
        }),
      );
    } catch (error) {
      // The key goes back. A claim left standing for work that was never queued
      // would make every one of Slack's redeliveries drop as a duplicate for the
      // next twenty-four hours — the event would be lost, and lost silently,
      // which is the one outcome worse than failing here.
      await this.idempotency.release(context, key);

      throw error;
    }

    // Completed with no response to cache, which is what the record's nullable
    // response columns are for. There is nobody to answer: the next redelivery
    // reads `replay`, finds nothing to replay, and drops — which is the whole of
    // what dedupe means on this path.
    await this.idempotency.complete(context, key);

    return ACK;
  }
}

const ACK: SlackAck = { outcome: 'ack' };
const REFUSE: SlackAck = { outcome: 'refuse' };

/**
 * `undefined` for a body that is not JSON, rather than a throw.
 *
 * A verified request with an unparseable body is a strange thing rather than an
 * attack — the signature says Slack sent it — so it is acknowledged and logged
 * instead of being answered with a 400 that would only make Slack send it again.
 */
const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};
