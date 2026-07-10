import { readSlackEnvelope, readSlackMessage } from './slack-event';

const BOT = 'U_BOT';

const envelope = (event: Record<string, unknown>) => ({
  type: 'event_callback',
  team_id: 'T123',
  event_id: 'Ev123',
  event,
});

/**
 * A fixture with one field taken out.
 *
 * Written as a helper rather than as destructuring-with-rest so the removed key
 * is named at the call site. A `const { user: _unused, ...rest }` says what is
 * kept; this says what is missing, which is the thing each of these tests is
 * about.
 */
const without = (
  fixture: Record<string, unknown>,
  key: string,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fixture).filter(([k]) => k !== key));

const message = (over: Record<string, unknown> = {}) => ({
  type: 'message',
  channel: 'C123',
  user: 'U_ALICE',
  text: 'the printer is on fire',
  ts: '1700000000.000100',
  ...over,
});

describe('readSlackEnvelope', () => {
  it('recognises the one-time URL verification handshake', () => {
    expect(
      readSlackEnvelope({ type: 'url_verification', challenge: 'abc123' }),
    ).toEqual({ kind: 'challenge', challenge: 'abc123' });
  });

  it('ignores a url_verification with no challenge to echo', () => {
    expect(readSlackEnvelope({ type: 'url_verification' })).toEqual({
      kind: 'ignored',
    });
  });

  it('reads the team and event ids off an event callback', () => {
    const event = message();

    expect(readSlackEnvelope(envelope(event))).toEqual({
      kind: 'event',
      teamId: 'T123',
      eventId: 'Ev123',
      event,
    });
  });

  it('ignores an event callback with no event id to deduplicate on', () => {
    // Without an `event_id` there is nothing to key the dedupe record on, so
    // accepting it would mean processing every redelivery. Slack always sends
    // one; a payload without one is not Slack.
    expect(readSlackEnvelope(without(envelope(message()), 'event_id'))).toEqual(
      { kind: 'ignored' },
    );
  });

  it('ignores an event callback with no team to resolve a tenant from', () => {
    expect(readSlackEnvelope(without(envelope(message()), 'team_id'))).toEqual({
      kind: 'ignored',
    });
  });

  it('ignores an envelope of a type this adapter does not handle', () => {
    expect(readSlackEnvelope({ type: 'app_rate_limited' })).toEqual({
      kind: 'ignored',
    });
  });

  it('ignores anything that is not an object', () => {
    // The body reaches here already parsed, but "parsed" only means well-formed
    // JSON — `null`, `7` and `"hi"` are all valid documents.
    expect(readSlackEnvelope(null)).toEqual({ kind: 'ignored' });
    expect(readSlackEnvelope('event_callback')).toEqual({ kind: 'ignored' });
    expect(readSlackEnvelope([])).toEqual({ kind: 'ignored' });
  });
});

describe('readSlackMessage', () => {
  it('reads a top-level message as one that opens a conversation', () => {
    expect(readSlackMessage(message(), BOT)).toEqual({
      kind: 'opens',
      channelId: 'C123',
      threadTs: '1700000000.000100',
      slackUserId: 'U_ALICE',
      text: 'the printer is on fire',
    });
  });

  it('threads an opening message on its own timestamp', () => {
    // The thread does not exist yet, so the message's own `ts` is what replies
    // will carry as their `thread_ts` — which is what makes the reply path find
    // the Ticket this one creates.
    const opened = readSlackMessage(message({ ts: '1700000000.000999' }), BOT);

    expect(opened).toMatchObject({
      kind: 'opens',
      threadTs: '1700000000.000999',
    });
  });

  it('reads a thread reply as one that continues a conversation', () => {
    expect(
      readSlackMessage(
        message({
          ts: '1700000009.000200',
          thread_ts: '1700000000.000100',
          text: 'and now the desk',
        }),
        BOT,
      ),
    ).toEqual({
      kind: 'replies',
      channelId: 'C123',
      threadTs: '1700000000.000100',
      slackUserId: 'U_ALICE',
      text: 'and now the desk',
    });
  });

  it('treats a message whose thread_ts is its own ts as an opening', () => {
    // Slack stamps the parent of a thread with its own `thread_ts` once someone
    // replies. Reading that as a reply would have the parent trying to append to
    // a Ticket it is itself supposed to have created.
    expect(
      readSlackMessage(
        message({ ts: '1700000000.000100', thread_ts: '1700000000.000100' }),
        BOT,
      ),
    ).toMatchObject({ kind: 'opens' });
  });

  it('ignores the adapter’s own postings', () => {
    // The reply-back path posts into the same thread it ingests from. Without
    // this, every agent reply is delivered to Slack, ingested straight back, and
    // appended to the Ticket as though the customer had said it.
    expect(readSlackMessage(message({ user: BOT }), BOT)).toEqual({
      kind: 'ignored',
    });
  });

  it('ignores anything Slack marks as coming from a bot', () => {
    // A second, broader guard than the user check: other integrations in the
    // channel are not customers either, and their `user` is not our bot.
    expect(readSlackMessage(message({ bot_id: 'B999' }), BOT)).toEqual({
      kind: 'ignored',
    });
  });

  it('ignores an edited message', () => {
    // `message_changed` carries the *edit*, not a new utterance. Ingesting it
    // would append the same sentence to the Ticket a second time.
    expect(
      readSlackMessage(message({ subtype: 'message_changed' }), BOT),
    ).toEqual({ kind: 'ignored' });
  });

  it('ignores a channel join notice', () => {
    expect(readSlackMessage(message({ subtype: 'channel_join' }), BOT)).toEqual(
      { kind: 'ignored' },
    );
  });

  it('ignores any subtype at all, rather than an enumerated list', () => {
    // Allowlist rather than blocklist: Slack adds subtypes, and a blocklist is
    // wrong the day it does. A plain human utterance has no subtype.
    expect(
      readSlackMessage(message({ subtype: 'a_subtype_invented_in_2027' }), BOT),
    ).toEqual({ kind: 'ignored' });
  });

  it('ignores an event that is not a message', () => {
    expect(
      readSlackMessage({ type: 'reaction_added', user: 'U_ALICE' }, BOT),
    ).toEqual({ kind: 'ignored' });
  });

  it('ignores a message with no author to attribute it to', () => {
    expect(readSlackMessage(without(message(), 'user'), BOT)).toEqual({
      kind: 'ignored',
    });
  });

  it('ignores a message with no text', () => {
    // A share, a file upload, an unfurl-only post. There is nothing to put in a
    // Ticket, and an empty Ticket is worse than none.
    expect(readSlackMessage(message({ text: '   ' }), BOT)).toEqual({
      kind: 'ignored',
    });
  });

  it('ignores a message with no channel to reply into', () => {
    expect(readSlackMessage(without(message(), 'channel'), BOT)).toEqual({
      kind: 'ignored',
    });
  });

  it('trims the text it carries', () => {
    expect(readSlackMessage(message({ text: '  hello  ' }), BOT)).toMatchObject(
      { text: 'hello' },
    );
  });

  it('ignores anything that is not an object', () => {
    expect(readSlackMessage(null, BOT)).toEqual({ kind: 'ignored' });
    expect(readSlackMessage('message', BOT)).toEqual({ kind: 'ignored' });
  });
});
