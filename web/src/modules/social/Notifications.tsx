/**
 * The Feed's notifications: everything that happened to you, grouped ("Ana and 3 others liked your post"),
 * newest first, with the natural next step (Follow back, Reply). Opening the page marks them seen.
 * Below: push on this device, which kinds ping you, and your quiet hours.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, useLoad } from '../../api';
import { Avatar, Icon, IconLink, since, TopBar } from '../feed/kit';
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
  actors: Array<{ userId: number; name: string; avatarUrl: string | null }>;
  prompt: 'follow_back' | 'reply' | null;
  followsBack: boolean;
}

type Prefs = Record<'push' | 'likes' | 'comments' | 'replies' | 'follows' | 'mentions' | 'dms' | 'villages' | 'milestones' | 'digests' | 'digestEmail', boolean> & {
  quietStart: string;
  quietEnd: string;
  devices: number;
  pushAvailable: boolean;
};

const KINDS: Array<[keyof Prefs, string]> = [
  ['replies', 'Replies to you'],
  ['mentions', 'Mentions'],
  ['dms', 'Messages'],
  ['follows', 'Friend requests'],
  ['likes', 'Likes'],
  ['comments', 'Comments'],
  ['villages', 'Village activity'],
  ['milestones', 'Milestones'],
];

export function NotificationsPage() {
  return (
    <section className="sc-page feed-page" data-testid="notifications">
      <TopBar title="Notifications" back={false} right={<IconLink to="/feed/settings/notifications" icon="gear" label="Notification settings" testid="notif-settings" />} />
      <Gate>{() => <Inbox />}</Gate>
    </section>
  );
}

/** "Ana and 2 others liked your post": the people in bold. */
function NoticeText({ text }: { text: string }) {
  const m = text.match(/^(.+?) (liked|commented|replied|sent|accepted|mentioned|started|joined|invited|is now)(\b[\s\S]*)$/);
  if (!m) return <>{text}</>;
  return (
    <span>
      <b>{m[1]}</b> {m[2]}
      {m[3]}
    </span>
  );
}

function Inbox() {
  const { data, reload } = useLoad<{ items: Item[]; unread: number }>('/api/feed/notifications');
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  // What was new when you opened the page stays marked "New" while you look; the badge clears.
  const [fresh] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!data) return;
    for (const n of data.items) if (n.unread) fresh.add(n.key);
    if (!data.unread) return;
    void api<{ unread: number }>('/api/feed/notifications/read', 'POST').then((r) => {
      setBadge(r.unread);
      window.dispatchEvent(new Event('feed-notifications'));
    });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = data?.items ?? [];
  const isNew = (n: Item): boolean => n.unread || fresh.has(n.key);
  const row = (n: Item) => {
    const who = n.actors[0];
    return (
      <li key={n.key} className={isNew(n) ? 'sc-card sc-notif unread' : 'sc-card sc-notif'} data-testid="notif-item" data-kind={n.kind}>
        {who ? (
          <Avatar a={{ displayName: who.name, avatarUrl: who.avatarUrl }} size={48} />
        ) : (
          <span className="sc-avatar blank" aria-hidden="true" style={{ width: 48, height: 48 }}>
            <Icon name="bell" size={22} />
          </span>
        )}
        <Link to={n.url} className="grow sc-notif-text">
          <NoticeText text={n.text} />
          <small className="sc-meta">{since(n.at)}</small>
        </Link>
        {n.prompt === 'follow_back' && who && !followed.has(who.userId) && (
          <button
            type="button"
            className="sc-btn small"
            onClick={() =>
              void api(`/api/community/people/${who.userId}/follow`, 'POST').then(() => {
                setFollowed(new Set([...followed, who.userId]));
                reload();
              })
            }
            data-testid="notif-followback"
          >
            {n.kind === 'friend_request' ? 'Confirm' : 'Add friend'}
          </button>
        )}
        {n.prompt === 'reply' && (
          <Link to={n.url} className="sc-btn outline small" data-testid="notif-reply">
            Reply
          </Link>
        )}
        {isNew(n) && <span className="sc-dot" aria-label="New" />}
      </li>
    );
  };
  const now = items.filter(isNew);
  const earlier = items.filter((n) => !isNew(n));
  return (
    <ul className="plain sc-list" data-testid="notif-list">
      {now.length > 0 && <li className="sc-h3">New</li>}
      {now.map(row)}
      {earlier.length > 0 && <li className="sc-h3">Earlier</li>}
      {earlier.map(row)}
      {data && !items.length && <li className="sc-meta">Nothing yet. When people comment, add you as a friend or like your posts, it shows up here.</li>}
    </ul>
  );
}

export function NotificationSettings({ open = false }: { open?: boolean }) {
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
    <details className="sc-card notif-prefs" data-testid="notif-prefs" open={open}>
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
      <fieldset className="notif-kinds">
        <legend className="small muted">When you’ve been away a couple of days</legend>
        <label className="inline-label">
          <input type="checkbox" checked={data.digests} onChange={(e) => save({ digests: e.target.checked })} data-testid="pref-digests" /> A “what you missed” ping
        </label>
        <label className="inline-label">
          <input type="checkbox" checked={data.digestEmail} onChange={(e) => save({ digestEmail: e.target.checked })} data-testid="pref-digest-email" /> …and email
        </label>
      </fieldset>
    </details>
  );
}
