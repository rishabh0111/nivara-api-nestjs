import { AppException } from 'src/common/errors/app-exception';
import { decodeCursor, encodeCursor } from './cursor';

describe('cursor codec', () => {
  const sort = { field: 'createdAt', direction: 'desc' } as const;

  it('round-trips a sort value and id', () => {
    const cursor = encodeCursor({
      sort,
      value: '2026-07-18T10:00:00.000Z',
      id: 'tkt_1',
    });

    expect(decodeCursor(cursor)).toEqual({
      sort,
      value: '2026-07-18T10:00:00.000Z',
      id: 'tkt_1',
    });
  });

  it('is opaque — the encoded form leaks no column names', () => {
    const cursor = encodeCursor({ sort, value: 'v', id: 'tkt_1' });

    expect(cursor).not.toContain('createdAt');
    expect(cursor).not.toContain('tkt_1');
  });

  it('is URL-safe so it survives a query string unescaped', () => {
    const cursor = encodeCursor({
      sort,
      value: '2026-07-18T10:00:00.000Z',
      id: 'a/b+c=d',
    });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('rejects a cursor that is not valid base64url JSON', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(AppException);
    expect(() => decodeCursor('not-a-cursor')).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  });

  it('rejects a structurally valid cursor with the wrong shape', () => {
    const forged = Buffer.from(JSON.stringify({ hello: 'world' })).toString(
      'base64url',
    );

    expect(() => decodeCursor(forged)).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  });

  it('rejects a cursor from a future version', () => {
    const future = Buffer.from(
      JSON.stringify({ v: 99, f: 'createdAt', d: 'desc', k: 'x', i: 'y' }),
    ).toString('base64url');

    expect(() => decodeCursor(future)).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  });
});
