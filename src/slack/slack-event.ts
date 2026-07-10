/**
 * What arrives from Slack, reduced to what this adapter acts on.
 *
 * Two total functions over `unknown`, and both answer "not for us" rather than
 * throwing. That is the right shape because the *only* thing standing between
 * this file and the public internet is the signature check — which proves the
 * request came from Slack, and proves nothing whatever about its shape. Slack
 * ships new event types and new message subtypes without asking, so an
 * unrecognised payload is ordinary traffic rather than an error condition, and a
 * parser that threw would turn Slack's product roadmap into this system's
 * incident log.
 *
 * Pure, and deliberately not a Zod schema. What is being decided here is not
 * "is this well-formed" but "is this a thing a Ticket should be opened for",
 * which is a domain judgement with the ignore rules as its interesting half —
 * and those rules read better as the code below than as a union of a dozen
 * variants, most of which exist only to be discarded.
 */

/** What an inbound POST turned out to be. */
export type SlackEnvelope =
  /** The one-time handshake Slack does when an endpoint URL is saved. */
  | { kind: 'challenge'; challenge: string }
  /** A real event, with the two identifiers everything downstream needs. */
  | { kind: 'event'; teamId: string; eventId: string; event: unknown }
  /** Not something this adapter acts on. Acknowledged and dropped. */
  | { kind: 'ignored' };

/** What a message event turned out to be, once the ignore rules have run. */
export type SlackMessage =
  | (SlackUtterance & { kind: 'opens' })
  | (SlackUtterance & { kind: 'replies' })
  | { kind: 'ignored' };

interface SlackUtterance {
  channelId: string;
  /**
   * The thread this belongs to — Slack's stable identifier for a conversation.
   *
   * For an opening message it is the message's own `ts`, because the thread does
   * not exist until someone replies and Slack names it after its parent. That is
   * what makes the two paths meet: the Ticket created here is stored under this
   * value, and every later reply arrives carrying it.
   */
  threadTs: string;
  slackUserId: string;
  text: string;
}

/** Slack's outer wrapper, as far as this adapter reads it. */
export const readSlackEnvelope = (payload: unknown): SlackEnvelope => {
  const body = asRecord(payload);

  if (!body) return IGNORED;

  // The handshake, answered by echoing the challenge and doing nothing else.
  // It arrives once, when the endpoint URL is saved in the Slack app config.
  if (body['type'] === 'url_verification') {
    const challenge = asText(body['challenge']);

    return challenge ? { kind: 'challenge', challenge } : IGNORED;
  }

  if (body['type'] !== 'event_callback') return IGNORED;

  const teamId = asText(body['team_id']);
  const eventId = asText(body['event_id']);

  // Both are required, and for different reasons worth keeping distinct. Without
  // `team_id` there is no tenant to resolve and the event cannot be attributed to
  // anyone; without `event_id` there is nothing to key the dedupe record on, so
  // every one of Slack's redeliveries would be processed as new. Slack always
  // sends both — a payload missing one is not Slack, whatever it signed.
  if (!teamId || !eventId) return IGNORED;

  return { kind: 'event', teamId, eventId, event: body['event'] };
};

/**
 * A message event, or the reason it is not one.
 *
 * `botUserId` is the adapter's own Slack identity, and passing it in is what
 * closes the echo loop: this system delivers an agent's reply into the very
 * thread it ingests from, so without recognising its own postings, every reply
 * would be ingested straight back and appended to the Ticket as though the
 * customer had said it — each round trip adding a message, forever.
 */
export const readSlackMessage = (
  event: unknown,
  botUserId: string,
): SlackMessage => {
  const message = asRecord(event);

  if (!message || message['type'] !== 'message') return IGNORED;

  // Any subtype at all, rather than a list of the ones that are trouble.
  // `message_changed` carries an *edit* and would append the same sentence
  // twice; `channel_join` is furniture; `message_deleted` is a retraction. The
  // list grows without notice, so the rule is an allowlist of one: a plain human
  // utterance has no subtype.
  if (message['subtype'] !== undefined) return IGNORED;

  // Two guards for the same hazard at two widths. `bot_id` catches every
  // integration in the channel, ours included; the `botUserId` comparison catches
  // this adapter specifically, and is what survives Slack omitting `bot_id` on
  // some future shape. Neither alone is quite enough, and the cost of both is a
  // line.
  if (message['bot_id'] !== undefined) return IGNORED;

  const slackUserId = asText(message['user']);

  if (!slackUserId || slackUserId === botUserId) return IGNORED;

  const channelId = asText(message['channel']);
  const ts = asText(message['ts']);
  const text = asText(message['text'])?.trim();

  // No channel means nowhere to reply to, and a Ticket that cannot be answered
  // is worse than no Ticket. No text means nothing to say — a file share, an
  // unfurl — and an empty Ticket is a queue entry an agent cannot act on.
  if (!channelId || !ts || !text) return IGNORED;

  const threadTs = asText(message['thread_ts']);

  // A thread's parent is stamped with its own `thread_ts` the moment anyone
  // replies to it. Reading that as a reply would have the opening message trying
  // to append to the Ticket it is itself supposed to create — so the comparison
  // against `ts`, not the mere presence of `thread_ts`, is what separates the two.
  const kind = !threadTs || threadTs === ts ? 'opens' : 'replies';

  return {
    kind,
    channelId,
    threadTs: kind === 'opens' ? ts : threadTs!,
    slackUserId,
    text,
  };
};

const IGNORED = { kind: 'ignored' } as const;

/** An object, and specifically not an array or `null`, both of which `typeof` calls one. */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A non-empty string, or nothing. Numbers and booleans are not near-misses. */
const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
