import { useState } from 'react';
import { PROGRESS_POSES, type ProgressPhotos as Data, type ProgressPose } from '@myday/shared';
import { api, ApiFail, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { day } from '../../dates';

/**
 * Re-encode in the browser: max 1600 px, JPEG. Re-drawing on a canvas drops
 * EXIF (location, camera) and keeps uploads small.
 */
async function shrink(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that photo'))), 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const src = (id: number): string => `/api/progress-photos/${id}/image`;

/** Front, back and both sides, about once a month. Private to their owner. */
export function ProgressPhotos({ today }: { today: string }) {
  const { data, setData, error } = useLoad<Data>('/api/progress-photos');
  const confirm = useConfirm();
  const [busy, setBusy] = useState<ProgressPose | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [before, setBefore] = useState<string>('');
  const [after, setAfter] = useState<string>('');
  if (error || !data) return null;

  const setOn = async (enabled: boolean): Promise<void> => {
    setData(await api<Data>('/api/progress-photos', 'PUT', { enabled }));
  };
  const upload = async (pose: ProgressPose, file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(pose);
    setMsg(null);
    try {
      const body = await shrink(file);
      const res = await fetch(`/api/progress-photos/${pose}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'image/jpeg', 'X-MyDay-Upload': '1' },
        body,
      });
      const out = (await res.json().catch(() => null)) as (Data & { error?: string }) | null;
      if (!res.ok || !out) throw new ApiFail(res.status, out?.error ?? 'Upload failed');
      setData(out);
      setMsg('Saved ✓ Only you can see it.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save the photo');
    } finally {
      setBusy(null);
    }
  };
  const remove = async (id: number): Promise<void> => {
    if (!(await confirm({ title: 'Delete this photo?', body: 'It’s gone for good.', confirmLabel: 'Delete', danger: true }))) return;
    setData(await api<Data>(`/api/progress-photos/${id}`, 'DELETE'));
  };
  const removeAll = async (): Promise<void> => {
    if (!(await confirm({ title: 'Delete all your progress photos?', body: 'Every set, every pose. This can’t be undone.', confirmLabel: 'Delete all', danger: true }))) return;
    setData(await api<Data>('/api/progress-photos?confirm=DELETE', 'DELETE'));
  };

  if (!data.enabled) {
    return (
      <div className="card" data-testid="photos-off">
        <h2>Progress photos (optional)</h2>
        <p className="small muted">
          Front, back and both sides, about once a month — the mirror and the scale miss slow change; photos don’t. They’re private: only you can see them. Not
          your household, not a coach, not MyDay staff.
        </p>
        <button className="btn small" onClick={() => void setOn(true)} data-testid="photos-on">
          Turn on progress photos
        </button>
        {data.sets.length > 0 && (
          <button className="link small" onClick={() => void removeAll()}>
            Delete my {data.sets.length} saved set{data.sets.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
    );
  }

  const todays = data.sets.find((s) => s.takenOn === today);
  const dates = data.sets.map((s) => s.takenOn);
  const a = data.sets.find((s) => s.takenOn === (before || dates[dates.length - 1]));
  const b = data.sets.find((s) => s.takenOn === (after || dates[0]));
  return (
    <div className="card" data-testid="photos">
      <h2>Progress photos</h2>
      <p className="small muted">
        {data.due
          ? data.lastOn
            ? 'About 4 weeks since your last set — take this month’s when you’re ready.'
            : 'Take your first set — it’s the “before” you’ll be glad you have.'
          : `Last set ${day(data.lastOn)}. The next one is about 4 weeks after that — no rush.`}{' '}
        Same spot, same light, same time of day (morning works well), same clothes. A phone timer helps.
      </p>
      <div className="photogrid">
        {PROGRESS_POSES.map((p) => {
          const id = todays?.photos[p.key] ?? null;
          return (
            <div key={p.key} className="photoslot" data-testid={`pose-${p.key}`}>
              {id ? <img src={src(id)} alt={`${p.label}, today`} /> : <div className="photoph">{p.label}</div>}
              <b>{p.label}</b>
              <small className="muted">{p.tip}</small>
              <label className="btn small ghost">
                {busy === p.key ? 'Saving…' : id ? 'Retake' : 'Add photo'}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={busy !== null}
                  onChange={(e) => {
                    void upload(p.key, e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              {id && (
                <button className="link small" onClick={() => void remove(id)}>
                  Delete
                </button>
              )}
            </div>
          );
        })}
      </div>
      {msg && <p className="small muted">{msg}</p>}
      {dates.length >= 2 && a && b && (
        <div data-testid="photo-compare">
          <h3>Compare</h3>
          <div className="row small">
            <label>
              Before{' '}
              <select value={a.takenOn} onChange={(e) => setBefore(e.target.value)}>
                {dates.map((d) => (
                  <option key={d} value={d}>
                    {day(d)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              After{' '}
              <select value={b.takenOn} onChange={(e) => setAfter(e.target.value)}>
                {dates.map((d) => (
                  <option key={d} value={d}>
                    {day(d)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {PROGRESS_POSES.map((p) => (
            <div key={p.key} className="photocompare">
              {[a, b].map((s) => {
                const id = s.photos[p.key];
                return id ? <img key={s.takenOn} src={src(id)} alt={`${p.label}, ${s.takenOn}`} /> : <div key={s.takenOn} className="photoph">No {p.label.toLowerCase()} on {s.takenOn}</div>;
              })}
            </div>
          ))}
          <p className="small muted">Bodies change slowly and lighting changes fast. Compare months, not days.</p>
        </div>
      )}
      <div className="row small">
        <button className="link" onClick={() => void setOn(false)}>
          Turn off (keeps your photos)
        </button>
        {data.sets.length > 0 && (
          <button className="link" onClick={() => void removeAll()} data-testid="photos-delete-all">
            Delete all my photos
          </button>
        )}
      </div>
    </div>
  );
}
