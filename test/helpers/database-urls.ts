/**
 * The placeholder the DB-free tests boot on.
 *
 * `DATABASE_URL` is required configuration, so booting the application needs
 * one — but most of the suite never opens a connection. Port 1 is reserved and
 * nothing listens on it, so a test using this is denying the *connection*, not
 * the configuration: it proves the code under test reaches no database, which
 * an absent variable could not distinguish from a boot that simply failed.
 */
export const UNREACHABLE_DATABASE_URL =
  'postgres://app_user:local_dev_only@127.0.0.1:1/nowhere';
