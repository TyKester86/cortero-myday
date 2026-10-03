/**
 * Lecture recordings that live on the device until they upload.
 *
 * While recording, every 5-second chunk of audio is written to IndexedDB, so
 * a phone that kills the tab mid-class still keeps everything up to the last
 * chunk. On stop the recording is marked ready; the uploader (useRecordingUploads,
 * mounted app-wide) sends every ready recording, oldest first, whenever there's
 * signal — on page load, when the browser comes back online, and with retries.
 * A recording is removed from the device only after the server has it.
 *
 * Each recording belongs to the account that made it: on a shared family
 * phone, one kid's recording is never uploaded under another kid's sign-in.
 */
import { useEffect, useSyncExternalStore } from 'react';

export interface PendingRecording {
  id: string;
  userId: number;
  /** null = recorded offline before the class list could load: pick one before it uploads. */
  classId: number | null;
  className: string;
  mime: string;
  startedAt: number;
  /** Time of the last saved chunk (≈ the end of the recording). */
  lastChunkAt: number;
  state: 'recording' | 'ready' | 'uploading';
  attempts: number;
  lastError: string;
  /** Server refused it (e.g. the class was deleted): needs the kid, not a retry. */
  stuck: boolean;
}

const DB = 'myday-recordings';
const RECS = 'recordings';
const CHUNKS = 'chunks';
const LOCK = (id: string): string => `myday-rec-${id}`;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(RECS)) db.createObjectStore(RECS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['recId', 'seq'] }).createIndex('recId', 'recId');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB unavailable'));
  });
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = run(t);
    t.oncomplete = () => {
      db.close();
      resolve(req ? (req.result as T) : undefined);
    };
    t.onerror = () => {
      db.close();
      reject(t.error ?? new Error('IndexedDB write failed'));
    };
    t.onabort = () => {
      db.close();
      reject(t.error ?? new Error('IndexedDB write aborted (storage full?)'));
    };
  });
}

/* ---------- a tiny store so the page re-renders when the list changes ---------- */

let snapshot: PendingRecording[] = [];
const listeners = new Set<() => void>();
async function refresh(): Promise<void> {
  try {
    const all = ((await tx<PendingRecording[]>([RECS], 'readonly', (t) => t.objectStore(RECS).getAll())) ?? []).sort((a, b) => a.startedAt - b.startedAt);
    snapshot = all;
  } catch {
    snapshot = [];
  }
  listeners.forEach((f) => f());
}

export function usePendingRecordings(): PendingRecording[] {
  useEffect(() => {
    void refresh();
  }, []);
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => snapshot,
  );
}

async function put(r: PendingRecording): Promise<void> {
  await tx([RECS], 'readwrite', (t) => {
    t.objectStore(RECS).put(r);
  });
}

async function get(id: string): Promise<PendingRecording | undefined> {
  return tx<PendingRecording>([RECS], 'readonly', (t) => t.objectStore(RECS).get(id));
}

/* ---------- recording ---------- */

/** Start a recording on the device; hold a lock so other tabs know it's live. */
export async function beginRecording(o: { userId: number; classId: number | null; className: string; mime: string }): Promise<string> {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  const now = Date.now();
  await put({ id, ...o, startedAt: now, lastChunkAt: now, state: 'recording', attempts: 0, lastError: '', stuck: false });
  holdLock(id);
  await refresh();
  return id;
}

const releases = new Map<string, () => void>();
function holdLock(id: string): void {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return;
  void locks.request(LOCK(id), () => new Promise<void>((resolve) => releases.set(id, resolve))).catch(() => undefined);
}

/** Save one chunk (in order). Throws when the device is out of space. */
export async function saveChunk(id: string, seq: number, blob: Blob): Promise<void> {
  await tx([CHUNKS, RECS], 'readwrite', (t) => {
    t.objectStore(CHUNKS).put({ recId: id, seq, blob });
    const recs = t.objectStore(RECS);
    const g = recs.get(id);
    g.onsuccess = () => {
      const r = g.result as PendingRecording | undefined;
      if (r) recs.put({ ...r, lastChunkAt: Date.now() });
    };
  });
}

/** Stop: the recording is complete and safe; it uploads on its own. */
export async function finishRecording(id: string): Promise<void> {
  const r = await get(id);
  if (r) await put({ ...r, state: 'ready' });
  releases.get(id)?.();
  releases.delete(id);
  await refresh();
}

/**
 * A tab that was killed mid-recording leaves a 'recording' row nobody holds.
 * Those are finished as they are (everything up to the last chunk is kept).
 */
async function recoverOrphans(): Promise<void> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  const held = new Set<string>();
  if (locks) {
    const q = await locks.query().catch(() => null);
    for (const l of q?.held ?? []) if (l.name) held.add(l.name);
  }
  const all = (await tx<PendingRecording[]>([RECS], 'readonly', (t) => t.objectStore(RECS).getAll())) ?? [];
  for (const r of all) {
    if (r.state === 'ready') continue;
    if (releases.has(r.id)) continue; // live in this tab
    // No Web Locks: fall back to "no chunk for a minute".
    const orphan = locks ? !held.has(LOCK(r.id)) : Date.now() - r.lastChunkAt > 60_000;
    if (orphan) await put({ ...r, state: 'ready' });
  }
}

async function audioOf(id: string, mime: string): Promise<Blob> {
  const chunks = (await tx<Array<{ seq: number; blob: Blob }>>([CHUNKS], 'readonly', (t) => t.objectStore(CHUNKS).index('recId').getAll(id))) ?? [];
  return new Blob(chunks.sort((a, b) => a.seq - b.seq).map((c) => c.blob), { type: mime });
}

export async function removeRecording(id: string): Promise<void> {
  await tx([RECS, CHUNKS], 'readwrite', (t) => {
    t.objectStore(RECS).delete(id);
    t.objectStore(CHUNKS).index('recId').openCursor(IDBKeyRange.only(id)).onsuccess = function () {
      const cur = this.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
  });
  await refresh();
}

export async function setRecordingClass(id: string, classId: number, className: string): Promise<void> {
  const r = await get(id);
  if (r) await put({ ...r, classId, className, stuck: false, lastError: '' });
  await refresh();
}

/* ---------- uploading ---------- */

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export type UploadResult = { id: string; lectureId: number };
const uploadedListeners = new Set<(r: UploadResult) => void>();
/** Hear about uploads (the recorder opens the new lecture when it's the one just recorded). */
export function onUploaded(f: (r: UploadResult) => void): () => void {
  uploadedListeners.add(f);
  return () => uploadedListeners.delete(f);
}

let flushing: Promise<void> | null = null;
let retryTimer: number | null = null;
let backoff = 5_000;

/** Upload every ready recording of this account, oldest first. Safe to call any time. */
export function flushRecordings(userId: number): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      await recoverOrphans();
      const all = ((await tx<PendingRecording[]>([RECS], 'readonly', (t) => t.objectStore(RECS).getAll())) ?? [])
        .filter((r) => r.userId === userId && r.state !== 'recording' && r.classId !== null && !r.stuck)
        .sort((a, b) => a.startedAt - b.startedAt);
      let retryLater = false;
      for (const r of all) {
        if (!navigator.onLine) {
          retryLater = true;
          break;
        }
        await put({ ...r, state: 'uploading' });
        await refresh();
        try {
          const audio = await audioOf(r.id, r.mime);
          const durationS = Math.max(0, Math.round((r.lastChunkAt - r.startedAt) / 1000));
          const qs = new URLSearchParams({ classId: String(r.classId), durationS: String(durationS), clientId: r.id, recordedOn: localDay(r.startedAt) });
          const res = await fetch(`/api/lectures/upload?${qs}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': r.mime || 'audio/webm', 'X-MyDay-Upload': '1' },
            body: audio,
          });
          const out = (await res.json().catch(() => null)) as { lecture?: { id: number }; error?: string } | null;
          if (res.ok && out?.lecture) {
            await removeRecording(r.id);
            uploadedListeners.forEach((f) => f({ id: r.id, lectureId: out.lecture?.id ?? 0 }));
            continue;
          }
          // 4xx = the server won't take it as is (policy screen, deleted class, signed out): the kid has to act.
          const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
          await put({ ...r, state: 'ready', attempts: r.attempts + 1, stuck: permanent && res.status !== 401, lastError: out?.error ?? `Upload failed (${res.status})` });
          if (!permanent) retryLater = true;
        } catch {
          await put({ ...r, state: 'ready', attempts: r.attempts + 1, lastError: 'No signal — it will upload by itself.' });
          retryLater = true;
        }
      }
      if (retryLater) {
        if (retryTimer) window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => void flushRecordings(userId), backoff);
        backoff = Math.min(backoff * 2, 5 * 60_000);
      } else {
        backoff = 5_000;
      }
    } finally {
      flushing = null;
      await refresh();
    }
  })();
  return flushing;
}

/** Retry a recording the server refused, after the kid fixed it (e.g. picked a class). */
export async function retryRecording(id: string, userId: number): Promise<void> {
  const r = await get(id);
  if (r) await put({ ...r, stuck: false, lastError: '' });
  await flushRecordings(userId);
}

/** Mounted once for the signed-in account: upload on load, on reconnect, and when the app comes back to the front. */
export function useRecordingUploads(userId: number | null): void {
  useEffect(() => {
    if (userId === null || typeof indexedDB === 'undefined') return;
    const go = (): void => {
      backoff = 5_000;
      void flushRecordings(userId);
    };
    const visible = (): void => {
      if (document.visibilityState === 'visible') go();
    };
    go();
    window.addEventListener('online', go);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', go);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [userId]);
}
