/**
 * The longest a derived subject may be.
 *
 * Chosen to be readable in a queue list rather than to fit a column — `subject`
 * is unbounded text. A subject that wraps in the console is a subject that stops
 * being scannable, which is the only job it has here.
 */
export const MAX_DERIVED_SUBJECT = 120;

/** What a Ticket is called when nobody typed a subject and nothing can be read. */
export const FALLBACK_SUBJECT = 'Slack conversation';

/**
 * A Slack message turned into something an agent can scan in a queue.
 *
 * Slack has no subject line, and inventing a real one would mean asking a model
 * to summarize — which is the AI layer's job, on its own schedule, and not
 * something the ingest path should block on. So this is deliberately mechanical:
 * the first line, trimmed, truncated on a word boundary. It reads as a subject
 * because the first line of a support request usually is one.
 *
 * The first *line* rather than the first sentence, because Slack messages are
 * written as chat: people press enter, they rarely write full stops, and
 * sentence-splitting a message with none would return the whole thing.
 */
export const subjectFrom = (text: string): string => {
  const firstLine = text.split('\n')[0]?.trim() ?? '';

  if (firstLine.length === 0) return FALLBACK_SUBJECT;
  if (firstLine.length <= MAX_DERIVED_SUBJECT) return firstLine;

  const clipped = firstLine.slice(0, MAX_DERIVED_SUBJECT);
  const lastSpace = clipped.lastIndexOf(' ');

  // Back off to a word boundary when there is one worth backing off to. A single
  // very long token — a stack trace, a URL — has no space to find, and cutting it
  // mid-token beats returning nothing.
  const body =
    lastSpace > MAX_DERIVED_SUBJECT / 2 ? clipped.slice(0, lastSpace) : clipped;

  return `${body.trimEnd()}…`;
};
