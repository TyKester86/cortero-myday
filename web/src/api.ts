import { useCallback, useEffect, useState } from 'react';
import type { ApiError } from '@myday/shared';

export class ApiFail extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).error === 'string';
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Same-origin JSON call. Types come from @myday/shared at each call site. */
export async function api<T>(path: string, method: Method = 'GET', body?: unknown): Promise<T> {
  const write = method !== 'GET';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: write ? { 'Content-Type': 'application/json' } : undefined,
    body: write ? JSON.stringify(body ?? {}) : undefined,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFail(res.status, isApiError(data) ? data.error : `Request failed (${res.status})`);
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
