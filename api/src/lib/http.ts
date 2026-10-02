import type { NextFunction, Request, Response } from 'express';
import type { ApiError } from '@myday/shared';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response<ApiError>, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
}

/* ---------- tiny input validators (no `any`, no extra dependency) ---------- */

export function str(v: unknown, field: string, max: number, required = false): string {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  return s.slice(0, max);
}

export function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function idParam(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad id');
  return n;
}

export function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new HttpError(400, `${field} must be true or false`);
  return v;
}
