import { timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { config } from './config';

export function secureEquals(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function getRequestApiKey(req: Request): string {
  const headerKey = req.get('x-api-key')?.trim();
  if (headerKey) return headerKey;

  const authorization = req.get('authorization') || '';
  const bearerPrefix = 'bearer';
  if (
    authorization.length <= bearerPrefix.length
    || authorization.slice(0, bearerPrefix.length).toLowerCase() !== bearerPrefix
    || authorization[bearerPrefix.length].trim() !== ''
  ) {
    return '';
  }

  return authorization.slice(bearerPrefix.length + 1).trim();
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!secureEquals(getRequestApiKey(req), config.apiKey)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
