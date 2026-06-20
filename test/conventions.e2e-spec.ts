import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootWithControllers } from './helpers/boot';
import { ProbeController } from './fixtures/probe.controller';

describe('API conventions', () => {
  let app: INestApplication;
  const get = (path: string) => request(app.getHttpServer()).get(path);

  beforeAll(async () => {
    app = await bootWithControllers(ProbeController);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('success envelope', () => {
    it('returns a single resource bare, with no wrapper', async () => {
      const response = await get('/probe/one');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: expect.any(String),
        createdAt: expect.any(String),
      });
      expect(response.body).not.toHaveProperty('data');
    });

    it('wraps a collection as { data, nextCursor }', async () => {
      const response = await get('/probe');

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(['data', 'nextCursor']);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('never reports a total', async () => {
      const { body } = await get('/probe');

      expect(body).not.toHaveProperty('total');
      expect(body).not.toHaveProperty('count');
    });
  });

  describe('pagination', () => {
    it('defaults to 25 rows', async () => {
      const { body } = await get('/probe');

      // The fixture holds fewer than 25 rows, so a default page returns them all.
      expect(body.data).toHaveLength(7);
      expect(body.nextCursor).toBeNull();
    });

    it('honours an explicit limit and emits a cursor when more remain', async () => {
      const { body } = await get('/probe?limit=3');

      expect(body.data).toHaveLength(3);
      expect(body.nextCursor).toEqual(expect.any(String));
    });

    it('rejects a limit above the 100 maximum', async () => {
      const response = await get('/probe?limit=101');

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('validation_failed');
    });

    it('rejects a non-numeric limit', async () => {
      expect((await get('/probe?limit=lots')).status).toBe(422);
    });

    it('traverses the full corpus without skipping or duplicating', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;

      do {
        const query: string = cursor
          ? `/probe?limit=2&cursor=${encodeURIComponent(cursor)}`
          : '/probe?limit=2';
        const { body } = await get(query);

        seen.push(...body.data.map((r: { id: string }) => r.id));
        cursor = body.nextCursor;
      } while (cursor !== null);

      expect(seen).toEqual(['w_6', 'w_5', 'w_4', 'w_3', 'w_2', 'w_1', 'w_0']);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('rejects a malformed cursor', async () => {
      const response = await get('/probe?cursor=garbage');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_cursor');
    });

    it('rejects a cursor carried across a change of sort', async () => {
      const { body } = await get('/probe?limit=2');
      const response = await get(
        `/probe?limit=2&sort=label&cursor=${encodeURIComponent(body.nextCursor)}`,
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_cursor');
    });
  });

  describe('filtering and sorting', () => {
    it('rejects an unknown query parameter rather than ignoring it', async () => {
      const response = await get('/probe?colr=red');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_filter');
      expect(response.body.error.message).toContain('colr');
    });

    it('names every unknown parameter at once', async () => {
      const { body } = await get('/probe?foo=1&bar=2');

      expect(body.error.message).toContain('foo');
      expect(body.error.message).toContain('bar');
    });

    it('rejects a query parameter on a route that declares none', async () => {
      // The validation pipe's whitelist can only reject against a bound DTO, so
      // a route with no query parameters would otherwise accept anything —
      // making the rule true by convention rather than by construction.
      const response = await get('/probe/one?bogus=1');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_filter');
      expect(response.body.error.message).toContain('bogus');
    });

    it('leaves a no-parameter route working when none is supplied', async () => {
      expect((await get('/probe/one')).status).toBe(200);
    });

    it('accepts a filter value inside the allowlist', async () => {
      expect((await get('/probe?colour=red')).status).toBe(200);
    });

    it('rejects a filter value outside the allowlist', async () => {
      const response = await get('/probe?colour=chartreuse');

      expect(response.status).toBe(422);
      expect(response.body.error.details[0].field).toBe('colour');
    });

    it('reads a bare sort field as ascending and `-field` as descending', async () => {
      const asc = await get('/probe?sort=createdAt');
      const desc = await get('/probe?sort=-createdAt');

      expect(asc.status).toBe(200);
      expect(desc.status).toBe(200);
    });

    it('rejects a sort field outside the allowlist', async () => {
      const response = await get('/probe?sort=secretColumn');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_sort');
    });
  });

  describe('error envelope', () => {
    it('is flat and wraps under `error`', async () => {
      const response = await get('/probe/missing');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      });
    });

    it('omits `details` on everything but validation', async () => {
      const { body } = await get('/probe/missing');

      expect(body.error).not.toHaveProperty('details');
    });

    it('enumerates one detail entry per offending field on 422', async () => {
      const response = await request(app.getHttpServer())
        .post('/probe')
        .send({ count: 0 });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('validation_failed');
      expect(
        response.body.error.details
          .map((d: { field: string }) => d.field)
          .sort(),
      ).toEqual(['count', 'label']);
    });

    it('reports an undeclared body property as a validation failure', async () => {
      // Not `invalid_filter`: that code is query-scoped in the catalog, and
      // `nivara-web` branches on the code.
      const response = await request(app.getHttpServer())
        .post('/probe')
        .send({ label: 'x', count: 1, sneaky: true });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('validation_failed');
      expect(response.body.error.details).toContainEqual({
        field: 'sneaky',
        issue: 'is not a recognised property',
      });
    });

    it('answers an unmatched route in the same envelope', async () => {
      const response = await get('/no/such/route');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    });

    it('never leaks internals from an unexpected failure', async () => {
      const response = await get('/probe/boom');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: 'internal_error',
          message: 'An unexpected error occurred.',
        },
      });
      expect(JSON.stringify(response.body)).not.toContain(
        'secret internal detail',
      );
      expect(JSON.stringify(response.body)).not.toContain('stack');
    });
  });
});
