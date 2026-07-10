import { parseSlackTarget, slackTarget } from '../slack/slack-target';

/**
 * The destination round trip.
 *
 * Worth its own tests because it is the one piece of adapter knowledge that is
 * split across a boundary: the dispatch side writes the string, the Slack side
 * reads it back, and nothing in between validates it. A silent disagreement here
 * is a delivery that goes nowhere and reports success.
 */
describe('slackTarget', () => {
  it('round-trips a destination', () => {
    expect(parseSlackTarget(slackTarget('C123', '1700000000.000100'))).toEqual({
      channelId: 'C123',
      threadTs: '1700000000.000100',
    });
  });

  it('refuses a target that names no thread', () => {
    expect(parseSlackTarget('C123')).toBeNull();
  });

  it('refuses a target with an empty half', () => {
    expect(parseSlackTarget('/1700000000.000100')).toBeNull();
    expect(parseSlackTarget('C123/')).toBeNull();
  });

  it('refuses a target with more parts than a destination has', () => {
    // Rejected rather than truncated to the first two. A three-part string is
    // something other than a Slack destination, and guessing which two parts were
    // meant is how a reply lands in the wrong channel.
    expect(parseSlackTarget('C123/1700000000.000100/extra')).toBeNull();
  });

  it('refuses an empty target', () => {
    expect(parseSlackTarget('')).toBeNull();
  });
});
