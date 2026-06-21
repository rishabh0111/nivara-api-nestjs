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
