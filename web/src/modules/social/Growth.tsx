/**
 * Finding your people: "People you may know" (mutual follows, shared interests), contacts you choose to share
 * (checked against the Feed, never stored), your invite link, and one-tap village invites.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import type { FeedSuggestion } from '@myday/shared';
import { api, useLoad } from '../../api';
import { count } from '../../format';
import { FeedNav, FeedTitle } from './shell';

type Person = FeedSuggestion & { followedByMe?: boolean };

function PersonRow({ p, onFollow, on }: { p: Person; onFollow: () => void; on: boolean }) {
  return (
    <li className="row-card" data-testid="pymk-person">
      <span className="ring-avatar" aria-hidden="true" style={{ width: 40, height: 40, fontSize: 16 }}>
        {p.displayName.slice(0, 1)}
      </span>
      <Link to={`/people/${p.userId}`} className="grow notif-text">
        <b>{p.displayName}</b> {p.username && <small className="muted">@{p.username}</small>}
        <small className="muted" style={{ display: 'block' }}>
          {p.reason}
        </small>
      </Link>
      <button type="button" className={on ? 'btn small' : 'btn ghost small'} onClick={onFollow} aria-pressed={on} data-testid="pymk-follow">
        {on ? 'Following' : 'Follow'}
      </button>
    </li>
  );
}

/** In the feed: people you may know, and a way to look through your contacts. */
export function PeopleRail() {
  const { data } = useLoad<{ people: FeedSuggestion[] }>('/api/feed/suggestions?limit=5');
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  const [contacts, setContacts] = useState(false);
  const toggle = (id: number): void => {
    const on = followed.has(id);
    void api(`/api/community/people/${id}/follow`, on ? 'DELETE' : 'POST').then(() => {
      const s = new Set(followed);
      if (on) s.delete(id);
      else s.add(id);
      setFollowed(s);
    });
  };
  if (!data?.people.length && !contacts) {
    return (
      <section className="card pymk" data-testid="pymk">
        <b>Find your people</b>
        <button type="button" className="btn ghost small" onClick={() => setContacts(true)} data-testid="pymk-contacts">
          Look through your contacts
        </button>
      </section>
    );
  }
  return (
    <section className="card pymk" data-testid="pymk" aria-label="People you may know">
      <div className="row">
        <b className="grow">People you may know</b>
        <button type="button" className="link small" onClick={() => setContacts(!contacts)} data-testid="pymk-contacts">
          {contacts ? 'Close' : 'From your contacts'}
        </button>
      </div>
      {contacts ? (
        <ContactsFinder />
      ) : (
        <ul className="plain onb-list">
          {data?.people.map((p) => <PersonRow key={p.userId} p={p} on={followed.has(p.userId)} onFollow={() => toggle(p.userId)} />)}
        </ul>
      )}
    </section>
  );
}

interface ContactsApi {
  select: (props: string[], opts: { multiple: boolean }) => Promise<Array<{ email?: string[] }>>;
}

/**
 * Contacts, only when you choose: your phone's contact picker (you pick who), or addresses you paste. They're
 * checked against the Feed and thrown away — never stored.
 */
export function ContactsFinder() {
  const picker = (navigator as Navigator & { contacts?: ContactsApi }).contacts;
  const [text, setText] = useState('');
  const [found, setFound] = useState<Person[] | null>(null);
  const [checked, setChecked] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  const look = async (emails: string[]): Promise<void> => {
    setMsg(null);
    try {
      const r = await api<{ people: Person[]; checked: number }>('/api/feed/contacts/match', 'POST', { emails });
      setFound(r.people);
      setChecked(r.checked);
      setFollowed(new Set(r.people.filter((p) => p.followedByMe).map((p) => p.userId)));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not look those up');
    }
  };
  const pick = async (): Promise<void> => {
    if (!picker) return;
    const chosen = await picker.select(['email'], { multiple: true }).catch(() => []);
    await look(chosen.flatMap((c) => c.email ?? []));
  };
  return (
    <div className="contacts-finder" data-testid="contacts-finder">
      <p className="small muted">We check these addresses against the Feed to find people you know — then forget them. Nothing is saved, and nobody is told.</p>
      {picker && (
        <button type="button" className="btn small" onClick={() => void pick()} data-testid="contacts-pick">
          Choose from your contacts
        </button>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void look(text.split(/[\s,;]+/).filter(Boolean));
        }}
      >
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Or paste email addresses" aria-label="Email addresses" data-testid="contacts-paste" />
        <button className="btn ghost small" data-testid="contacts-find">
          Find
        </button>
      </form>
      {msg && <p className="error small">{msg}</p>}
      {found && (
        <>
          <p className="small muted" role="status" data-testid="contacts-result">
            {found.length ? `${count(found.length, 'person', 'people')} you know ${found.length === 1 ? 'is' : 'are'} here.` : `None of those ${count(checked, 'address', 'addresses')} are on the Feed yet — invite them!`}
          </p>
          <ul className="plain onb-list">
            {found.map((p) => (
              <PersonRow
                key={p.userId}
                p={p}
                on={followed.has(p.userId)}
                onFollow={() =>
                  void api(`/api/community/people/${p.userId}/follow`, followed.has(p.userId) ? 'DELETE' : 'POST').then(() => {
                    const s = new Set(followed);
                    if (s.has(p.userId)) s.delete(p.userId);
                    else s.add(p.userId);
                    setFollowed(s);
                  })
                }
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Your invite link: a rich preview when shared, and they land connected to you. */
export function InvitePage() {
  return (
    <section className="feed-page" data-testid="invite-page">
      <FeedTitle>Invite friends</FeedTitle>
      <FeedNav />
      <InviteBox />
      <section className="card">
        <b>Already on the Feed?</b>
        <ContactsFinder />
      </section>
    </section>
  );
}

export function InviteBox() {
  const { data } = useLoad<{ link: string; joined: number }>('/api/feed/invite');
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  const text = 'Come find me on The Feed — a calm, supportive community for ADHD adults. Free, 18+.';
  const share = async (): Promise<void> => {
    if (navigator.share) {
      await navigator.share({ title: 'The Feed', text, url: data.link }).catch(() => undefined);
      return;
    }
    await navigator.clipboard?.writeText(`${text} ${data.link}`).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <section className="card invite-box" data-testid="invite-box">
      <b>Your invite link</b>
      <p className="small muted">When a friend joins from it, you’re connected right away — and you’ll hear about it.</p>
      <div className="onb-invite">
        <input readOnly value={data.link} aria-label="Your invite link" onFocus={(e) => e.target.select()} data-testid="invite-link" />
        <button type="button" className="btn" onClick={() => void share()} data-testid="invite-share">
          {copied ? 'Copied' : 'Share'}
        </button>
      </div>
      <p className="small muted" data-testid="invite-joined">
        {data.joined ? `${count(data.joined, 'friend')} joined from your link.` : 'Nobody has joined from it yet.'}
      </p>
    </section>
  );
}

/** One tap: invite your people (you follow them, or they follow you) to this village. */
export function VillageInvite({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { data } = useLoad<{ village: string; people: Array<{ userId: number; displayName: string; username: string | null; invited: boolean }> }>(`/api/villages/${slug}/invitees`);
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const [done, setDone] = useState<number | null>(null);
  if (!data) return null;
  const sel = picked ?? new Set(data.people.filter((p) => !p.invited).map((p) => p.userId));
  const send = async (): Promise<void> => {
    const r = await api<{ invited: number }>(`/api/villages/${slug}/invite`, 'POST', { userIds: [...sel] });
    setDone(r.invited);
  };
  return (
    <div className="card village-invite" data-testid="village-invite">
      <div className="row">
        <b className="grow">Invite to {data.village}</b>
        <button type="button" className="link small" onClick={onClose}>
          Close
        </button>
      </div>
      {done !== null ? (
        <p role="status" data-testid="village-invited">
          {done ? `Invited ${count(done, 'person', 'people')}.` : 'They’ve all been invited already.'}
        </p>
      ) : data.people.length ? (
        <>
          <ul className="plain onb-list">
            {data.people.map((p) => (
              <li key={p.userId} className="row-card">
                <label className="inline-label grow">
                  <input
                    type="checkbox"
                    checked={sel.has(p.userId)}
                    disabled={p.invited}
                    onChange={() => {
                      const s = new Set(sel);
                      if (s.has(p.userId)) s.delete(p.userId);
                      else s.add(p.userId);
                      setPicked(s);
                    }}
                  />{' '}
                  {p.displayName} {p.invited && <small className="muted">· invited</small>}
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="btn" disabled={!sel.size} onClick={() => void send()} data-testid="village-invite-send">
            Invite {sel.size ? count(sel.size, 'person', 'people') : ''}
          </button>
        </>
      ) : (
        <p className="small muted">Everyone you’re connected with is already here — or follow a few people first.</p>
      )}
    </div>
  );
}
