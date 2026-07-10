import {
  FALLBACK_SUBJECT,
  MAX_DERIVED_SUBJECT,
  subjectFrom,
} from './slack-subject';

describe('subjectFrom', () => {
  it('uses a short message whole', () => {
    expect(subjectFrom('the printer is on fire')).toBe(
      'the printer is on fire',
    );
  });

  it('takes the first line of a multi-line message', () => {
    // Slack messages are chat: people press enter mid-thought, and everything
    // after the first line is detail rather than headline.
    expect(subjectFrom('billing is wrong\n\ninvoice 4471, charged twice')).toBe(
      'billing is wrong',
    );
  });

  it('trims the line it takes', () => {
    expect(subjectFrom('  spaced out  \nmore')).toBe('spaced out');
  });

  it('truncates a long line on a word boundary', () => {
    const subject = subjectFrom('word '.repeat(60));

    expect(subject.length).toBeLessThanOrEqual(MAX_DERIVED_SUBJECT + 1);
    expect(subject.endsWith('…')).toBe(true);
    expect(subject).not.toContain('  ');
  });

  it('cuts mid-token when there is no word boundary to back off to', () => {
    // A stack trace, a URL, a base64 blob. Returning nothing would be worse than
    // an ugly subject.
    const subject = subjectFrom('x'.repeat(400));

    expect(subject).toBe(`${'x'.repeat(MAX_DERIVED_SUBJECT)}…`);
  });

  it('does not back off to a space near the very start', () => {
    // One short word then a huge token: backing off to that first space would
    // yield a two-character subject, which says less than the truncated token.
    const subject = subjectFrom(`re ${'y'.repeat(400)}`);

    expect(subject.length).toBe(MAX_DERIVED_SUBJECT + 1);
  });

  it('falls back when the first line is empty', () => {
    expect(subjectFrom('\n\nthe detail is down here')).toBe(FALLBACK_SUBJECT);
  });

  it('falls back on an empty message', () => {
    expect(subjectFrom('')).toBe(FALLBACK_SUBJECT);
  });
});
