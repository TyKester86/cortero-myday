/**
 * Security headers on every response (no extra dependency).
 *
 * - CSP: only our own scripts run; Plaid's Link widget is the one outside
 *   script/frame (bank linking). No inline scripts anywhere in the app;
 *   inline *styles* are allowed (React style={{…}} attributes).
 * - frame-ancestors 'none' + X-Frame-Options: nobody can frame the app
 *   (clickjacking).
 * - HSTS in production: browsers only ever use HTTPS.
 * - Permissions-Policy: microphone (push-to-talk, the lecture recorder) and location (only while a
 *   member's own sharing is on, or a parent sets the family's place) for this site only; no camera
 *   API (progress photos use the file picker).
 */
import type { NextFunction, Request, Response } from 'express';

const PLAID = 'https://cdn.plaid.com';

export function csp(): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${PLAID}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self' https://production.plaid.com`,
    `frame-src ${PLAID}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(production: boolean) {
  const policy = csp();
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(self), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}
