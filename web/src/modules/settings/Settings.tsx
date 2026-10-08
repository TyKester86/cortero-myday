import { useState } from 'react';
import { Link } from 'react-router';
import type { EngagementResponse, HouseholdInfo, NotificationsResponse } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useSession } from '../../session';
import { InviteGrownUp, MergeDuplicate } from './HouseholdTools';
import { Modules } from './Modules';
import { YourData } from './YourData';

export const ACCENTS: Array<[string, string]> = [
  ['navy', '#c2410c'], // default ember (key kept for saved prefs)
  ['teal', '#1f7f86'],
  ['purple', '#6a4bc4'],
  ['rose', '#c0466b'],
  ['orange', '#c46a1b'],
  ['green', '#2f8f5b'],
];

export function applyLook(theme: string, accent: string): void {
  const el = document.documentElement;
  if (theme === 'light' || theme === 'dark') el.dataset.theme = theme;
  else delete el.dataset.theme;
  el.dataset.accent = accent;
}

function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Settings: look (theme + accent), notifications (gentle, batched, your times), household gates. */
export default function Settings() {
  const { me, isAdult } = useSession();
  const [theme, setTheme] = useState(me.prefs?.theme ?? 'system');
  const [accent, setAccent] = useState(me.prefs?.accent ?? 'navy');
  const notif = useLoad<NotificationsResponse>('/api/notifications');
  const [hh, setHh] = useState<HouseholdInfo | null>(me.household);
  const [msg, setMsg] = useState<string | null>(null);

  const look = async (t: string, a: string): Promise<void> => {
    setTheme(t as typeof theme);
    setAccent(a);
    applyLook(t, a);
    try {
      await api<EngagementResponse>('/api/me/prefs', 'PATCH', { theme: t, accent: a });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const savePrefs = async (patch: Partial<NotificationsResponse['prefs']>): Promise<void> => {
    try {
      notif.setData(await api<NotificationsResponse>('/api/notifications', 'PUT', patch));
      setMsg('Saved ✓');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const enablePush = async (): Promise<void> => {
    const n = notif.data;
    if (!n) return;
    try {
      if (n.vapidPublicKey && 'serviceWorker' in navigator && 'PushManager' in window) {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          setMsg('Notifications are blocked in this browser’s settings.');
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(n.vapidPublicKey) });
        notif.setData(await api<NotificationsResponse>('/api/push/subscribe', 'POST', sub.toJSON()));
      }
      await savePrefs({ enabled: true });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not turn on notifications');
    }
  };

  const p = notif.data?.prefs;
  return (
    <section>
      <h1>Settings</h1>
      {msg && <p className="muted" role="status">{msg}</p>}
      <div className="card" data-testid="look">
        <h2>Look</h2>
        <div className="chips">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} className={theme === t ? 'chip on' : 'chip'} onClick={() => void look(t, accent)}>
              {t === 'system' ? 'Default (dark)' : t === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {ACCENTS.map(([name, hex]) => (
            <button key={name} className={accent === name ? 'swatch on' : 'swatch'} style={{ background: hex }} aria-label={`${name} accent`} aria-pressed={accent === name} onClick={() => void look(theme, name)} />
          ))}
        </div>
      </div>

      <div className="card" data-testid="notifications">
        <h2>Notifications</h2>
        <p className="muted small">At most one gentle nudge a day, at the time you pick. Never during quiet hours. No guilt, ever.</p>
        {!notif.data ? (
          <p className="muted">Loading…</p>
        ) : !p?.enabled ? (
          <>
            {!notif.data.vapidPublicKey && <p className="muted small">Push isn't set up on this server yet — your choices are saved for when it is.</p>}
            <InstallHint />
            <button className="btn small" onClick={() => void enablePush()}>
              Turn on notifications
            </button>
          </>
        ) : (
          <div className="form">
            <div className="chips">
              {(['chores', 'homework', 'bills'] as const).map((k) => (
                <button key={k} className={p[k] ? 'chip on' : 'chip'} onClick={() => void savePrefs({ [k]: !p[k] })}>
                  {k}
                </button>
              ))}
            </div>
            <label>
              Send my nudge at
              <input type="time" value={p.sendAt} onChange={(e) => void savePrefs({ sendAt: e.target.value })} />
            </label>
            <label>
              How often
              <select value={p.frequency} onChange={(e) => void savePrefs({ frequency: e.target.value as typeof p.frequency })}>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Sundays only</option>
              </select>
            </label>
            <div className="row">
              <label className="grow">
                Quiet from
                <input type="time" value={p.quietStart} onChange={(e) => void savePrefs({ quietStart: e.target.value })} />
              </label>
              <label className="grow">
                until
                <input type="time" value={p.quietEnd} onChange={(e) => void savePrefs({ quietEnd: e.target.value })} />
              </label>
            </div>
            {notif.data.preview && (
              <p className="small">
                Today's nudge would say: <i>{notif.data.preview.body}</i>
              </p>
            )}
            <div className="row">
              <button className="btn small ghost" onClick={() => void api<{ delivered: number }>('/api/push/test', 'POST').then((r) => setMsg(`Test sent to ${r.delivered} device(s)`)).catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Could not send'))}>
                Send a test
              </button>
              <button className="btn small ghost" onClick={() => void savePrefs({ enabled: false })}>
                Turn off
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Health</h2>
        <Link to="/health">Change your body-style build →</Link>
      </div>

      {isAdult && hh && (
        <div className="card" data-testid="household-gates">
          <h2>Household</h2>
          <p className="small">
            {hh.name} · family code <b>{hh.code}</b>
            {hh.trialEndsAt && <span className="muted"> · trial until {hh.trialEndsAt.slice(0, 10)}</span>}
          </p>
          <label className="inline-label">
            <input
              type="checkbox"
              checked={hh.allowTeenBankLink}
              onChange={(e) =>
                void api<HouseholdInfo>('/api/household/info', 'PATCH', { allowTeenBankLink: e.target.checked })
                  .then((h) => {
                    setHh(h);
                    setMsg('Saved ✓');
                  })
                  .catch((e2: unknown) => setMsg(e2 instanceof Error ? e2.message : 'Could not save'))
              }
            />
            Teens can see a bank account (read-only, a parent links it)
          </label>
          <Link to="/household">Roster, invites and kid PINs →</Link>
          <Link to="/household#kid-pins" data-testid="settings-reset-pin">
            Reset a kid’s PIN →
          </Link>
        </div>
      )}
      {isAdult && hh && <InviteGrownUp />}
      {isAdult && hh && me.isAdmin && <MergeDuplicate />}
      {isAdult && hh && <Modules hh={hh} />}
      {isAdult && hh && <YourData householdName={hh.name} />}
      {!isAdult && (
        <p className="small muted">
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
        </p>
      )}
    </section>
  );
}

/**
 * Phones only deliver web push to an installed app: on iPhone that means
 * Share → Add to Home Screen first (iOS 16.4+); Android/desktop Chrome can
 * install from the browser prompt.
 */
function InstallHint() {
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (standalone) return null;
  return (
    <p className="small" data-testid="install-hint">
      {ios
        ? 'On iPhone, add MyDay to your Home Screen first (Share → Add to Home Screen), open it from there, then turn on notifications.'
        : 'Tip: install MyDay (your browser menu → Install app / Add to Home screen) so reminders arrive like any other app.'}
    </p>
  );
}
