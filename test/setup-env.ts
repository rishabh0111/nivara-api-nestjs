import { config } from 'dotenv';
import { UNREACHABLE_DATABASE_URL } from './helpers/database-urls';

/**
 * The configuration floor every test boots on.
 *
 * `.env` first, because it is where a developer's real, reachable database and
 * the owner credential the isolation tests need to read the seeded ids live.
 * The application loads it too, but not until a module boots — too late for
 * tests that read `process.env` directly, and too late for the fallback below
 * to know whether a real value already exists.
 */
config();

/**
 * `DATABASE_URL` became required with the tenancy spine, so booting the
 * application now needs one — but most of the suite never opens a connection,
 * and none of it should depend on a developer having written a local `.env`.
 *
 * Only a fallback: anything real, from the environment or `.env`, wins. The
 * integration tests need a genuinely reachable database and would fail loudly
 * against this placeholder rather than pass vacuously.
 */
process.env['DATABASE_URL'] ??= UNREACHABLE_DATABASE_URL;

/**
 * `JWT_SECRET` became required with staff authentication, for the same reason
 * and with the same caveat: booting the application needs one, and no test
 * should depend on a developer having written a local `.env`.
 *
 * Tests that care about the signature — that a token signed with another key
 * is rejected — supply their own key rather than leaning on this one, so its
 * only job is to clear the length floor.
 */
process.env['JWT_SECRET'] ??= 'test-only-jwt-secret-at-least-32-chars-long';

/**
 * `WIDGET_SESSION_SECRET` became required with the widget surface, on exactly
 * the same terms.
 *
 * A different value from `JWT_SECRET` above, and that is not decoration: the
 * widget suite asserts that a staff token does not verify as a widget session
 * and vice versa, and if these two lines held the same string that test would
 * pass for the wrong reason — or rather, would fail to be a test at all.
 */
process.env['WIDGET_SESSION_SECRET'] ??=
  'test-only-widget-secret-at-least-32-chars-long';
