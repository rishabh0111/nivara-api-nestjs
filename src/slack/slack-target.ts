/**
 * How a Slack destination is written down, and read back.
 *
 * It lives in this folder rather than beside the dispatch that writes it, because
 * the shape of a destination is adapter knowledge and this is the adapter. A pure
 * module with no framework in it, so the dispatch side can import it without
 * importing the Slack module — which is what keeps the outbound pipe free of a
 * dependency on any particular channel's services.
 *
 * The two halves are here together on purpose. They are inverses, they are used
 * on opposite sides of a table that stores the result and never interprets it,
 * and a silent disagreement between them is a delivery that goes nowhere and
 * reports success. Separated, nothing would make them change together.
 */

/** A Slack destination as `outbound_delivery.target` stores it. */
export const slackTarget = (channelId: string, threadTs: string): string =>
  `${channelId}/${threadTs}`;

/**
 * The destination taken apart, or `null` if the string is not one.
 *
 * Total rather than throwing, and strict about the whole string: a three-part
 * value is refused rather than truncated to its first two, because guessing which
 * two parts were meant is how a reply lands in the wrong channel.
 */
export const parseSlackTarget = (
  target: string,
): { channelId: string; threadTs: string } | null => {
  const [channelId, threadTs, ...extra] = target.split('/');

  if (!channelId || !threadTs || extra.length > 0) return null;

  return { channelId, threadTs };
};
