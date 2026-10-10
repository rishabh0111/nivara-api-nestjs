import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { SchedulerActivity } from './scheduler-activity';

/**
 * Tells the scheduler a person (or a service acting for one) is here.
 *
 * Everything counts except the health checks. `/health` is what the external
 * keep-warm pinger hits every five minutes; counting it would hold the ticks
 * at full rate forever and the database awake with them, which is the cost
 * this exists to remove. `/health/ready` is excluded for the same reason: it
 * is a probe, not a visit.
 */
@Injectable()
export class SchedulerActivityMiddleware implements NestMiddleware {
  constructor(private readonly activity: SchedulerActivity) {}

  use(request: Request, _response: Response, next: NextFunction): void {
    if (!isHealthProbe(request.originalUrl)) this.activity.touch();
    next();
  }
}

export const isHealthProbe = (url: string): boolean => {
  const path = url.split('?')[0];
  return path === '/health' || path.startsWith('/health/');
};
