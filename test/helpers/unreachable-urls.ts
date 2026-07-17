/**
 * Addresses that are configured and cannot be connected to.
 *
 * Both point at port 1, which is reserved and which nothing listens on. That is
 * the distinction these exist to draw: a test using one of them is denying the
 * *connection*, not the configuration, and an absent variable could not tell
 * those apart — it would leave the application booting in a different shape
 * rather than in the same shape with a dependency down.
 */

/**
 * `DATABASE_URL` is required configuration, so booting the application needs
 * one — but most of the suite never opens a connection.
 */
export const UNREACHABLE_DATABASE_URL =
  'postgres://app_user:local_dev_only@127.0.0.1:1/nowhere';

/**
 * `REDIS_URL` is optional, which is exactly why this is needed: leaving it out
 * makes Redis dormant, a supported configuration, and dormant is not the state
 * a fail-open path is interesting in. Set-and-unreachable is.
 */
export const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1';
