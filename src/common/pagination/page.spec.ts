import { decodeCursor } from './cursor';
import { buildPage } from './page';

describe('buildPage', () => {
  const sort = { field: 'createdAt', direction: 'desc' } as const;

  type Row = { id: string; createdAt: string };

  const rows = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `id_${i}`,
      createdAt: `2026-07-${String(i + 1).padStart(2, '0')}`,
    }));

  it('returns a null cursor when the page is not full', () => {
    expect(buildPage(rows(3), 25, sort)).toEqual({
      data: rows(3),
      nextCursor: null,
    });
  });

  it('drops the probe row and emits a cursor when there is more', () => {
    // Callers fetch limit + 1 rows; the extra row is the has-more probe.
    const page = buildPage(rows(4), 3, sort);

    expect(page.data).toHaveLength(3);
    expect(page.data.map((r) => r.id)).toEqual(['id_0', 'id_1', 'id_2']);
    expect(page.nextCursor).not.toBeNull();
  });

  it('anchors the cursor on the last returned row, not the probe', () => {
    const page = buildPage(rows(4), 3, sort);

    expect(decodeCursor(page.nextCursor!)).toEqual({
      sort,
      value: '2026-07-03',
      id: 'id_2',
    });
  });

  it('returns an empty page without a cursor', () => {
    expect(buildPage([], 25, sort)).toEqual({ data: [], nextCursor: null });
  });

  it('emits no cursor when the page is exactly full but there is no probe', () => {
    expect(buildPage(rows(3), 3, sort).nextCursor).toBeNull();
  });
});
