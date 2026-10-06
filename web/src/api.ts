import { useCallback, useEffect, useState } from 'react';
import type { ApiError } from '@myday/shared';

export class ApiFail extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** True when an offline write was queued to sync later. */
    readonly queued = false,
    /** The server's machine-readable reason, when it sent one. */
    readonly code?: string,
    /** Extra help from the server (e.g. a blocked post's rephrase suggestion). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).error === 'string';
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/* ---------- offline: queued writes, replayed with an Idempotency-Key ---------- */

interface Queued {
  key: string;
  path: string;
  method: Method;
  body: unknown;
  at: number;
}

const QUEUE = 'myday.offline-queue';
const listeners = new Set<() => void>();

function readQueue(): Queued[] {
  try {
    const raw = localStorage.getItem(QUEUE);
    return raw ? (JSON.parse(raw) as Queued[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(q: Queued[]): void {
  try {
    localStorage.setItem(QUEUE, JSON.stringify(q));
  } catch {
    /* storage blocked: the write can't be kept */
  }
  listeners.forEach((f) => f());
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let syncing = false;

/** Replay queued writes in order. Stops at the first network failure; drops writes the server refuses. */
export async function syncOffline(): Promise<number> {
  if (syncing || !navigator.onLine) return 0;
  syncing = true;
  let done = 0;
  try {
    for (;;) {
      const [next] = readQueue();
      if (!next) break;
      let res: Response;
      try {
        res = await fetch(next.path, {
          method: next.method,
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': next.key, 'X-MyDay-Replay': '1' },
          body: JSON.stringify(next.body ?? {}),
        });
      } catch {
        break; // still offline
      }
      if (res.status >= 500) break; // try again later
      writeQueue(readQueue().filter((q) => q.key !== next.key));
      done++;
    }
  } finally {
    syncing = false;
  }
  return done;
}

export function offlineQueueLength(): number {
  return readQueue().length;
}

/** Re-render when the queue or connectivity changes. */
export function useOffline(): { online: boolean; queued: number } {
  const [state, setState] = useState(() => ({ online: typeof navigator === 'undefined' ? true : navigator.onLine, queued: offlineQueueLength() }));
  useEffect(() => {
    const update = (): void => setState({ online: navigator.onLine, queued: offlineQueueLength() });
    const back = (): void => {
      update();
      void syncOffline().then(update);
    };
    listeners.add(update);
    window.addEventListener('online', back);
    window.addEventListener('offline', update);
    back();
    return () => {
      listeners.delete(update);
      window.removeEventListener('online', back);
      window.removeEventListener('offline', update);
    };
  }, []);
  return state;
}

/** Writes that make sense to queue while offline (not sign-in, uploads, chat or link flows). */
const NOT_QUEUEABLE = /^\/api\/(auth|chat|hana|money\/(link-token|exchange|sync)|kidmoney\/[^/]+\/bank|push|classroom|households|lectures\/upload)/;

/** Same-origin JSON call. Types come from @myday/shared at each call site. */
export async function api<T>(path: string, method: Method = 'GET', body?: unknown): Promise<T> {
  const write = method !== 'GET';
  const key = write ? newKey() : '';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: write ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : undefined,
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    if (write && !NOT_QUEUEABLE.test(path)) {
      writeQueue([...readQueue(), { key, path, method, body, at: Date.now() }]);
      throw new ApiFail(0, 'You’re offline — saved on this device. It will sync when you’re back online.', true);
    }
    throw new ApiFail(0, 'You’re offline right now.');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFail(res.status, isApiError(data) ? data.error : `Request failed (${res.status})`, false, isApiError(data) ? data.code : undefined, isApiError(data) ? data.details : undefined);
  return data as T;
}

export function withMember(path: string, memberKey: string | null): string {
  if (!memberKey) return path;
  return `${path}${path.includes('?') ? '&' : '?'}member=${encodeURIComponent(memberKey)}`;
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

export function useLoad<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path) return;
    let live = true;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not load'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, tick]);

  return { data, error, loading, reload, setData };
}
