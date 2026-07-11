import { Response } from 'express';
import { AppException } from '../common/errors/app-exception';
import { RateLimitDecision } from './fixed-window';

type Denied = Extract<RateLimitDecision, { outcome: 'denied' }>;

/**
 * Turn a refusal into headers on the response, then throw the catalogued error.
 *
 * Two steps rather than one, because `AppException` carries a code and a
 * message and deliberately no headers — the error envelope is a body contract,
 * and giving every exception a header bag so that one of them could use it
 * would be a wide change for a narrow need. Writing them onto the response
 * first works because `AppExceptionFilter` sets a status and a body and never
 * clears headers, so what is set here survives into the response.
 *
 * The dependency that creates is real and worth naming: if the filter ever
 * started replacing the response object, these headers would vanish silently.
 * `rate-limit.int-spec.ts` asserts them over a real HTTP response for exactly
 * that reason — the coupling is caught by a red test rather than by a client
 * noticing its backoff has stopped working.
 *
 * Both call sites — the per-principal guard and the pre-trust Slack middleware
 * — go through here, so a refusal looks identical whichever ceiling produced
 * it. A client's backoff logic should not have to know which one it hit.
 */
export const refuse = (response: Response, decision: Denied): never => {
  // `Retry-After` is the one a generic HTTP client already understands, and it
  // is why a caller that knows nothing about this API still backs off
  // correctly. The `RateLimit-*` trio is the IETF draft shape, in delta-seconds
  // rather than a timestamp, and tells a client what it just hit.
  //
  // Set on the refusal only. Emitting them on every successful response would
  // let a client pace itself before being refused, which is the shape those
  // headers were designed for — but it means a Redis round trip's result on the
  // hot path of every request, and ticket 18 asked for them on the 429. The
  // seam is here when that becomes worth it.
  response.setHeader('Retry-After', decision.retryAfterSeconds);
  response.setHeader('RateLimit-Limit', decision.limit);
  response.setHeader('RateLimit-Remaining', 0);
  response.setHeader('RateLimit-Reset', decision.retryAfterSeconds);

  throw new AppException(
    'rate_limited',
    `Rate limit of ${decision.limit} requests per minute exceeded. Retry after ${decision.retryAfterSeconds} seconds.`,
  );
};
