import { parseSort } from './sort';

describe('parseSort', () => {
  const allowed = ['createdAt', 'updatedAt'] as const;
  const fallback = { field: 'createdAt', direction: 'desc' } as const;

  it('defaults to created_at DESC when no sort is supplied', () => {
    expect(parseSort(undefined, allowed, fallback)).toEqual(fallback);
  });

  it('reads a bare field as ascending', () => {
    expect(parseSort('createdAt', allowed, fallback)).toEqual({
      field: 'createdAt',
      direction: 'asc',
    });
  });

  it('reads a leading minus as descending', () => {
    expect(parseSort('-updatedAt', allowed, fallback)).toEqual({
      field: 'updatedAt',
      direction: 'desc',
    });
  });

  it('rejects a field outside the resource allowlist', () => {
    expect(() => parseSort('secretColumn', allowed, fallback)).toThrow(
      expect.objectContaining({ code: 'invalid_sort' }),
    );
  });

  it('rejects an empty sort rather than silently defaulting', () => {
    expect(() => parseSort('-', allowed, fallback)).toThrow(
      expect.objectContaining({ code: 'invalid_sort' }),
    );
  });
});
