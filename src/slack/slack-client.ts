import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/**
 * How long one `chat.postMessage` may take before it is abandoned.
 *
 * Chosen against `LEASE_MS` in the queue rather than against Slack's latency: it
 * has to be comfortably shorter, so that a handler is always finished — one way
 * or the other — before another drainer is entitled to take its delivery. See the
 * `signal` below.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Where a post is going, what it says, and what to sign in as. */
export interface SlackPost {
  channelId: string;
  threadTs: string;
  text: string;

  /**
   * The workspace's own bot token, when the installation has one.
   *
   * Passed in rather than read here, because a token is a per-workspace fact and
   * this class serves every workspace. A single token read from configuration
   * authenticates against exactly one workspace, so with two tenants installed it
   * would make every reply but one fail `invalid_auth` — a permanent error, so
   * those replies would die on their first attempt rather than degrading.
   *
   * Optional so a single-workspace development run can lean on `SLACK_BOT_TOKEN`
   * instead, which is what the fallback below is for.
   */
  token?: string;
}

/**
 * A Slack API error that is not worth trying again.
 *
 * The distinction the retry loop rests on, and it is deliberately narrow. A
 * channel the bot was removed from, a thread that was deleted, an invalid token —
 * these will fail identically five minutes from now, so retrying buys nothing and
 * costs the tenant five minutes of not being told. Everything else, including
 * every network fault and every 5xx, is transient until proven otherwise: the far
 * end being briefly unavailable is the case the retry machinery exists for, and
 * misclassifying one of those as permanent loses a reply that would have gone
 * through.
 */
export class PermanentSlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSlackError';
  }
}

/**
 * The errors Slack returns that no amount of waiting will fix.
 *
 * An allowlist rather than a blocklist, which is the conservative direction: an
 * error nobody has classified is retried, and the worst case is five attempts
 * over a few minutes ending in the same notification a permanent failure would
 * have produced immediately. The reverse default would silently discard replies
 * on the first unfamiliar error string.
 */
const PERMANENT_ERRORS = new Set([
  'channel_not_found',
  'thread_not_found',
  'is_archived',
  'not_in_channel',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'no_permission',
  'msg_too_long',
]);

/**
 * The only thing in this system that talks to Slack.
 *
 * A class with one method, and it exists as a class rather than a function for
 * exactly one reason: it is the seam a test replaces. Everything else in this
 * adapter — verification, ingestion, delivery bookkeeping, the failure
 * notification — is then exercised against a real database and a real queue with
 * only the network stubbed, which is the boundary worth drawing. A `fetch` call
 * buried inside the delivery handler would have made the whole outbound path
 * testable only by mocking a global.
 *
 * `fetch` rather than Slack's SDK. The call is one POST with a JSON body and a
 * bearer token, and the SDK would bring a dependency, a retry policy that
 * disagrees with the queue's, and a shape the Spring and FastAPI ports cannot
 * mirror. What this file contains is a description of an HTTP request, which
 * ports directly.
 */
@Injectable()
export class SlackClient {
  constructor(private readonly config: AppConfigService) {}

  /**
   * Posts into a thread, and returns what Slack called the resulting message.
   *
   * `thread_ts` is what makes this a reply rather than a new conversation. Losing
   * it would post the answer to the channel's top level, where it reads as an
   * unrelated announcement and where the person who asked is not looking.
   *
   * Throwing is the only failure signal, because the drainer reads no other one —
   * and the two throw shapes carry the whole retry decision: a
   * `PermanentSlackError` is settled by the handler on the spot, anything else
   * goes back on the queue with backoff.
   */
  async postMessage(post: SlackPost): Promise<{ ts: string }> {
    // The workspace's own credential first, configuration second. A deployed
    // multi-tenant install has one token per workspace and never reaches the
    // fallback; a single-workspace development run has no `slack_credential` row
    // and relies on it entirely.
    const token = post.token ?? this.config.slackBotToken;

    // Unconfigured is permanent by definition: no amount of retrying supplies a
    // credential, and the tenant should be told now rather than in five minutes.
    if (!token) {
      throw new PermanentSlackError(
        'Slack is not configured in this process, so there is no credential to post with.',
      );
    }

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      // The timeout is load-bearing for at-most-once delivery, not merely tidy.
      // Mutual exclusion between two handlers working the same delivery is the
      // job's lease: a second drainer may only claim the row once the first
      // one's lease has expired. That argument holds only if no handler can
      // still be posting when its own lease runs out — and `fetch` has no
      // timeout by default, so a connection that hangs would do exactly that
      // and produce the double post the whole design forbids. Well under
      // `LEASE_MS`, so the gap is never open.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: post.channelId,
        thread_ts: post.threadTs,
        text: post.text,
      }),
    });

    // A transport-level failure. Retryable: Slack being briefly unreachable is
    // the ordinary case this whole pipe is built around.
    if (!response.ok) {
      throw new Error(
        `Slack answered HTTP ${response.status} to chat.postMessage`,
      );
    }

    // Slack answers 200 to almost everything and puts the verdict in the body,
    // which is the trap in this API: a handler reading only the status code would
    // record every failure as a success and every undelivered reply as delivered.
    const body = (await response.json()) as {
      ok?: boolean;
      error?: string;
      ts?: string;
    };

    if (!body.ok) {
      const error = body.error ?? 'unknown_error';

      throw PERMANENT_ERRORS.has(error)
        ? new PermanentSlackError(`Slack refused the post: ${error}`)
        : new Error(`Slack refused the post: ${error}`);
    }

    // The posted message's own id. Kept as the evidence outside Slack that this
    // happened — and, since a `delivered` row must carry proof, the thing that
    // makes that claim checkable.
    if (!body.ts) {
      throw new Error('Slack accepted the post but named no message');
    }

    return { ts: body.ts };
  }
}
