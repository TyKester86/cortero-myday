/**
 * The Feed's notifications: everything that happened to you, grouped ("Ana and 3 others liked your post"),
 * newest first, with the natural next step (Follow back, Reply). Opening the page marks them seen.
 * Below: push on this device, which kinds ping you, and your quiet hours.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, useLoad } from '../../api';
import { ago } from '../../dates';
import { FeedNav, FeedTitle } from './shell';
import { Gate } from '../community/Community';
import { enableFeedPush, pushSupported, setBadge } from './push';

interface Item {
  key: string;
  kind: string;
  text: string;
  url: string;
  at: string;
  unread: boolean;
  count: number;
  actors: Array<{ userId: number; name: string }>;
  prompt: 'follow_back' | 'reply' | null;
  followsBack: boolean;
}

type Prefs = Record<'push' | 'likes' | 'comments' | 'replies' | 'follows' | 'mentions' | 'dms' | 'villages' | 'milestones', boolean> & {
  quietStart: string;
  quietEnd: string;
  devices: number;
  pushAvailable: boolean;
};

const KINDS: Array<[keyof Prefs, string]> = [
  ['replies', 'Replies to you'],
  ['mentions', 'Mentions'],
  ['dms', 'Messages'],
  ['follows', 'New followers'],
  ['likes', 'Likes'],
  ['comments', 'Comments on your clips'],
  ['villages', 'Village activity'],
  ['milestones', 'Milestones'],
];

export function NotificationsPage() {
  return (
    <section className="feed-page" data-testid="notifications">
      <FeedTitle>Notifications</FeedTitle>
      <FeedNav />
      <Gate>{() => <Inbox />}</Gate>
    </section>
  );
}

function Inbox() {
  const { data, reload } = useLoad<{ items: Item[]; unread: number }>('/api/feed/notifications');
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  // Seen once you've looked: the badge clears.
  useEffect(() => {
    if (!data?.unread) return;
    void api<{ unread: number }>('/api/feed/notifications/read', 'POST').then((r) => {
      setBadge(r.unread);
      window.dispatchEvent(new Event('feed-notifications'));
    });
  }, [data?.unread]);
  return (
    <>
      <ul className="plain notif-list" data-testid="notif-list">
        {data?.items.map((n) => {
          const who = n.actors[0];
          return (
            <li key={n.key} className={n.unread ? 'row-card notif unread' : 'row-card notif'} data-testid="notif-item" data-kind={n.kind}>
              <span className="ring-avatar" aria-hidden="true" style={{ width: 40, height: 40, fontSize: 16 }}>
                {who ? who.name.slice(0, 1) : '★'}
              </span>
              <Link to={n.url} className="grow notif-text">
                {n.text}
                <small className="muted" style={{ display: 'block' }}>
                  {ago(n.at)}
                </small>
              </Link>
              {n.prompt === 'follow_back' && who && !followed.has(who.userId) && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    void api(`/api/community/people/${who.userId}/follow`, 'POST').then(() => {
                      setFollowed(new Set([...followed, who.userId]));
                      reload();
                    })
                  }
                  data-testid="notif-followback"
                >
                  Follow back
                </button>
              )}
              {n.prompt === 'reply' && (
                <Link to={n.url} className="btn ghost small" data-testid="notif-reply">
                  Reply
                </Link>
              )}
            </li>
          );
        })}
        {data && !data.items.length && <li className="muted">Nothing yet. When people reply, follow or like your posts, it shows up here.</li>}
      </ul>
      <NotificationSettings />
    </>
  );
}

function NotificationSettings() {
  const { data: loaded, reload } = useLoad<Prefs>('/api/feed/notifications/prefs');
  const [local, setLocal] = useState<Partial<Prefs>>({});
  const [state, setState] = useState<string | null>(null);
  if (!loaded) return null;
  // Switches move the moment they're tapped; the server catches up.
  const data: Prefs = { ...loaded, ...local };
  const save = (patch: Partial<Prefs>): void => {
    setLocal((l) => ({ ...l, ...patch }));
    void api('/api/feed/notifications/prefs', 'PUT', patch).then(reload);
  };
  const turnOn = async (): Promise<void> => {
    const r = await enableFeedPush().catch(() => 'unsupported' as const);
    setState(r);
    reload();
  };
  return (
    <details className="card notif-prefs" data-testid="notif-prefs">
      <summary>
        <b>Notification settings</b>
      </summary>
      {data.pushAvailable && pushSupported() && (
        <p className="row">
          <span className="grow small">{data.devices ? `Push is on for ${data.devices} device${data.devices === 1 ? '' : 's'}.` : 'Get a ping on this device when someone replies, follows you or messages you.'}</span>
          <button type="button" className="btn small" onClick={() => void turnOn()} data-testid="push-enable">
            {data.devices ? 'Add this device' : 'Turn on'}
          </button>
          {data.devices > 0 && (
            <button type="button" className="link small" onClick={() => void api('/api/feed/push/test', 'POST')} data-testid="push-test">
              Send a test
            </button>
          )}
        </p>
      )}
      {state === 'denied' && <p className="small muted">Notifications are blocked for this site in your browser settings.</p>}
      <label className="inline-label">
        <input type="checkbox" checked={data.push} onChange={(e) => save({ push: e.target.checked })} data-testid="pref-push" /> Push notifications
      </label>
      <fieldset className="notif-kinds" disabled={!data.push}>
        <legend className="small muted">Ping me about</legend>
        {KINDS.map(([k, label]) => (
          <label key={k} className="inline-label">
            <input type="checkbox" checked={!!data[k]} onChange={(e) => save({ [k]: e.target.checked } as Partial<Prefs>)} data-testid={`pref-${k}`} /> {label}
          </label>
        ))}
      </fieldset>
      <p className="row small">
        Quiet hours
        <input type="time" value={data.quietStart} onChange={(e) => save({ quietStart: e.target.value })} aria-label="Quiet from" data-testid="quiet-start" />
        to
        <input type="time" value={data.quietEnd} onChange={(e) => save({ quietEnd: e.target.value })} aria-label="Quiet until" data-testid="quiet-end" />
      </p>
      <p className="small muted">Pings wait until your quiet hours end. Likes and new followers arrive together, a little later, instead of one by one.</p>
    </details>
  );
}
