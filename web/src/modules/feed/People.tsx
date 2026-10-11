/**
 * People in the Feed: profiles (cover, avatar, Posts | Media | About), editing your profile (photos go
 * through the same review as every image), Friends (requests, people you may know, your friends) and Settings.
 * Friends are mutual follows; the UI never says "followers".
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { CRISIS_RESOURCES, type CommunityAuthor, type CommunityMe, type CommunityProfile, type FeedPage, type FeedPost, type FriendPerson, type FriendsData, type MediaTile, type PostAudience } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { NavIcon } from '../../components/NavIcon';
import { useSession } from '../../session';
import { signOut } from '../../signout';
import { APP_URL, FEED_APP } from '../../apps';
import { ACHIEVEMENT_ICON, EmptySheet, Gate, ReportButton, uploadPhoto } from '../community/Community';
import { ProviderBadge, ProviderDisclaimer } from './Providers';
import { SupportBox } from '../social/Creator';
import { YourStats } from '../social/Endless';
import { NotificationSettings } from '../social/Notifications';
import { Avatar, Check, FriendButton, Horn, Icon, Name, PillTabs, Sheet, Toggle, TopBar, errText, short, type IconName } from './kit';
import { PostCard } from './PostCard';
import type { ReactNode } from 'react';

/* ======================= Profiles ======================= */

export function PersonPage() {
  const { id } = useParams();
  return (
    <section data-testid="person" className="sc-page feed-page person-page">
      <Gate>{() => <Profile id={id ?? ''} />}</Gate>
    </section>
  );
}

/** Your own profile, at a clean address (/me in the Feed app). */
export function MyProfilePage() {
  return (
    <section data-testid="person" className="sc-page feed-page person-page">
      <Gate>{(me) => (me.profile ? <Profile id={String(me.profile.userId)} /> : null)}</Gate>
    </section>
  );
}

/** Anyone's public profile by @username (/u/<handle>). */
export function HandlePage() {
  const { handle } = useParams();
  const { data, error } = useLoad<{ userId: number }>(`/api/community/handle/${encodeURIComponent(handle ?? '')}`);
  return (
    <section data-testid="person" className="sc-page feed-page person-page">
      <Gate>{() => (error ? <p className="sc-meta">No one here by that name.</p> : data ? <Profile id={String(data.userId)} /> : <p className="sc-meta">Loading…</p>)}</Gate>
    </section>
  );
}

const TABS = [
  { key: 'posts', label: 'Posts' },
  { key: 'media', label: 'Media' },
  { key: 'about', label: 'About' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/** Upload a photo (screened like every image), then save it as your avatar or cover. */
async function savePhoto(p: CommunityProfile, file: File, field: 'avatarId' | 'coverId'): Promise<{ profile: CommunityProfile; underReview: boolean }> {
  const ph = await uploadPhoto(file);
  const profile = await saveProfile(p, { [field]: ph.id });
  return { profile, underReview: ph.review.underReview };
}

/** The profile endpoint takes the whole card: send what's there, with the changes. */
export function saveProfile(p: CommunityProfile, patch: Record<string, unknown>): Promise<CommunityProfile> {
  return api<CommunityProfile>('/api/community/profile', 'PUT', { displayName: p.displayName, bio: p.bio, parentBadge: p.parentBadge, ...patch });
}

function PhotoInput({ onFile, testid }: { onFile: (f: File) => void; testid: string }) {
  return (
    <input
      type="file"
      accept="image/*"
      hidden
      data-testid={testid}
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) onFile(f);
      }}
    />
  );
}

/** The cover: your photo, or the Feed's own (warm paper and the horn). */
function Cover({ p, onPick, busy }: { p: CommunityProfile; onPick?: (f: File) => void; busy?: boolean }) {
  const inner = p.coverUrl ? (
    <img src={p.coverUrl} alt="" />
  ) : (
    <span className="sc-cover-fallback" aria-hidden="true">
      <Horn size={64} />
    </span>
  );
  if (!onPick)
    return (
      <div className="sc-cover" data-testid="profile-cover">
        {inner}
      </div>
    );
  return (
    <label className="sc-cover mine" data-testid="profile-cover" aria-label={p.coverUrl ? 'Change cover photo' : 'Add a cover photo'}>
      {inner}
      <span className="sc-cover-hint">
        <Icon name="camera" size={16} /> {busy ? 'Uploading…' : p.coverUrl ? 'Change cover' : 'Add cover'}
      </span>
      <PhotoInput onFile={onPick} testid="cover-file" />
    </label>
  );
}

function BigAvatar({ p, onPick, busy }: { p: CommunityProfile; onPick?: (f: File) => void; busy?: boolean }) {
  const face = p.avatarUrl ? (
    <img src={p.avatarUrl} alt={`${p.displayName}’s photo`} />
  ) : onPick ? (
    <span className="sc-addphoto" data-testid="add-photo">
      <Icon name="camera" size={26} />
      <small>{busy ? 'Uploading…' : 'Add photo'}</small>
    </span>
  ) : (
    <span className="sc-bigavatar-blank">{p.displayName.slice(0, 1)}</span>
  );
  if (!onPick) return <div className="sc-bigavatar">{face}</div>;
  return (
    <label className="sc-bigavatar mine" aria-label={p.avatarUrl ? 'Change your photo' : 'Add a photo'}>
      {face}
      {p.avatarUrl && (
        <span className="sc-cam-badge" aria-hidden="true">
          <Icon name="camera" size={16} />
        </span>
      )}
      <PhotoInput onFile={onPick} testid="avatar-file" />
    </label>
  );
}

function Profile({ id }: { id: string }) {
  const { data, error, setData } = useLoad<CommunityProfile>(`/api/community/people/${encodeURIComponent(id)}`);
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'posts');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<'avatarId' | 'coverId' | null>(null);
  const [menu, setMenu] = useState(false);
  const confirm = useConfirm();
  // Old consult links (?book=1) land on the plain profile: providers here aren't bookable.
  useEffect(() => {
    if (params.has('book') || params.has('paid')) setParams({}, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="sc-meta">{error}</p>;
  if (!data) return <p className="sc-meta">Loading…</p>;
  const p = data;
  const pro = p.provider;
  const pick = (field: 'avatarId' | 'coverId') => (f: File) => {
    setBusy(field);
    setMsg(null);
    void savePhoto(p, f, field)
      .then((r) => {
        setData(r.profile);
        if (r.underReview) setMsg('Thanks — your photo is being reviewed for safety. It shows once it’s approved.');
      })
      .catch((e: unknown) => setMsg(errText(e, 'Could not add the photo')))
      .finally(() => setBusy(null));
  };
  const line = [p.bio, p.work, p.location].filter(Boolean).join(' · ');
  return (
    <div className="sc-profile">
      <TopBar
        title={p.displayName}
        right={
          p.me ? (
            <Link to="/feed/settings" className="sc-icon-btn" aria-label="Settings" data-testid="settings-link">
              <Icon name="gear" />
            </Link>
          ) : (
            <button type="button" className="sc-icon-btn" aria-label="More" aria-expanded={menu} onClick={() => setMenu(!menu)} data-testid="profile-more">
              <Icon name="more" />
            </button>
          )
        }
      />
      {menu && !p.me && (
        <div className="sc-menu right">
          <ReportButton path={`/api/community/people/${p.userId}/report`} onDone={setMsg} />
          <button
            type="button"
            className="sc-menu-item danger"
            onClick={() =>
              void confirm({ title: `Block ${p.displayName}?`, body: 'You won’t see each other’s posts, and neither of you can add or message the other.', confirmLabel: 'Block', danger: true }).then(
                (y) => void (y && api(`/api/community/people/${p.userId}/block`, 'POST').then(() => setMsg(`Blocked ${p.displayName}. You won’t see each other’s posts.`))),
              )
            }
          >
            Block
          </button>
        </div>
      )}
      <article className="sc-profile-head" data-testid="profile-card">
        <Cover p={p} onPick={p.me ? pick('coverId') : undefined} busy={busy === 'coverId'} />
        <BigAvatar p={p} onPick={p.me ? pick('avatarId') : undefined} busy={busy === 'avatarId'} />
        <h2 className="sc-profile-name">
          {p.displayName}
          {p.verified && <Check size={22} />}
        </h2>
        {p.username && (
          <p className="sc-meta" data-testid="profile-handle">
            @{p.username}
          </p>
        )}
        {pro && <ProviderBadge />}
        {!pro && p.parentBadge && <span className="sc-chip">Parent</span>}
        {line ? <p className="sc-profile-line">{line}</p> : p.me && <p className="sc-profile-line sc-meta">Add a line about you in Edit profile — no kids’ names or schools.</p>}
        <p className="sc-profile-stats" data-testid="follow-counts">
          <Link to={p.me ? '/feed/friends' : '#'} onClick={(e) => !p.me && e.preventDefault()}>
            {short(p.friends)} {p.friends === 1 ? 'friend' : 'friends'}
          </Link>
          {' · '}
          {short(p.posts + p.clips)} posts
          {p.streak > 0 && (
            <span data-testid="profile-streak">
              {' · '}
              {p.streak}-day streak
            </span>
          )}
        </p>
        {p.me ? (
          <div className="sc-profile-actions">
            <Link className="sc-btn" to="/feed/profile/edit" data-testid="edit-profile">
              Edit profile
            </Link>
            {pro ? (
              <Link className="sc-btn outline" to="/business" data-testid="business-link">
                Business suite
              </Link>
            ) : (
              <Link className="sc-btn outline" to="/earnings" data-testid="earnings-link">
                Earnings
              </Link>
            )}
          </div>
        ) : (
          <div className="sc-profile-actions">
            <FriendButton userId={p.userId} rel={p.relationship} onChange={(r) => setData({ ...p, relationship: r, friends: p.friends + (r === 'friends' ? 1 : p.relationship === 'friends' ? -1 : 0) })} />
            <Link className="sc-btn outline" to={`/messages/${p.userId}`} data-testid="profile-message">
              Message
            </Link>
          </div>
        )}
        {pro && <ProviderDisclaimer text={pro.disclaimer} />}
      </article>
      {msg && (
        <p className="sc-toast" role="status" onClick={() => setMsg(null)}>
          {msg}
        </p>
      )}
      <div className="sc-tabs-float">
        <PillTabs tabs={[...TABS]} on={tab} onPick={setTab} testid={(t) => `profile-tab-${t}`} />
      </div>
      {tab === 'posts' && <ProfilePosts p={p} onMsg={setMsg} />}
      {tab === 'media' && <ProfileMedia p={p} onPin={(pin) => setData({ ...p, pinned: pin })} onMsg={setMsg} />}
      {tab === 'about' && <ProfileAbout p={p} />}
    </div>
  );
}

function ProfilePosts({ p, onMsg }: { p: CommunityProfile; onMsg: (m: string) => void }) {
  const posts = useLoad<FeedPage>(`/api/feed?author=${p.userId}`);
  const set = (np: FeedPost): void => {
    if (posts.data) posts.setData({ ...posts.data, posts: posts.data.posts.map((x) => (x.id === np.id ? np : x)) });
  };
  return (
    <div className="sc-list" data-testid="profile-posts">
      {posts.data?.posts.map((x) => (
        <PostCard key={x.id} p={x} onChange={set} onMsg={onMsg} onGone={() => posts.reload()} showAvatar={false} />
      ))}
      {posts.data && !posts.data.posts.length && <EmptySheet title={p.me ? 'Nothing posted yet' : 'Nothing written yet'}>{p.me ? 'Tap + to share a win, a question or a laugh.' : undefined}</EmptySheet>}
    </div>
  );
}

function ProfileMedia({ p, onPin, onMsg }: { p: CommunityProfile; onPin: (pin: CommunityProfile['pinned']) => void; onMsg: (m: string) => void }) {
  const media = useLoad<{ tiles: MediaTile[] }>(`/api/community/people/${p.userId}/media`);
  const tiles = media.data?.tiles ?? [];
  const pin = (t: MediaTile | null): void =>
    void api<{ pinned: CommunityProfile['pinned'] }>('/api/community/profile/pin', 'PUT', t ? { kind: t.kind, id: t.id } : {}).then(
      (r) => {
        onPin(r.pinned);
        media.reload();
      },
      (e: unknown) => onMsg(errText(e, 'Could not pin')),
    );
  return (
    <>
      <div className="sc-grid" data-testid="profile-media">
        {tiles.map((t) => (
          <span key={`${t.kind}${t.id}`} className="sc-tile-wrap">
            <Link to={t.kind === 'clip' ? `/clips?user=${p.userId}&c=${t.id}` : `/feed/post/${t.id}`} className="sc-tile" data-testid={t.kind === 'clip' ? 'clip-tile' : 'media-tile'}>
              {t.imageUrl ? <img src={t.imageUrl} alt="" loading="lazy" /> : <span className="sc-tile-blank" />}
              {t.kind === 'clip' && (
                <small className="sc-tile-views">
                  <Icon name="play" size={13} filled /> {short(t.views ?? 0)}
                </small>
              )}
              {t.pinned && (
                <span className="sc-tile-pin" data-testid="pinned-badge" aria-label="Pinned">
                  <Icon name="pushpin" size={14} filled />
                </span>
              )}
            </Link>
            {p.me && (
              <button type="button" className="sc-tile-pinbtn" onClick={() => pin(t.pinned ? null : t)} aria-label={t.pinned ? 'Unpin' : 'Pin to the top'} data-testid="tile-pin">
                {t.pinned ? 'Unpin' : 'Pin'}
              </button>
            )}
          </span>
        ))}
      </div>
      {media.data && !tiles.length && <EmptySheet title="No photos or clips yet" />}
    </>
  );
}

function ProfileAbout({ p }: { p: CommunityProfile }) {
  const joined = new Date(`${p.joinedOn}T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const pro = p.provider;
  const verifiedOn = pro ? new Date(`${pro.verifiedAt}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return (
    <div className="sc-list" data-testid="profile-about">
      <section className="sc-card sc-about">
        <h3>Intro</h3>
        {p.bio && <p>{p.bio}</p>}
        <p className="sc-meta">Joined {joined}</p>
      </section>
      {(p.work || p.location || p.age !== null) && (
        <section className="sc-card sc-about">
          <h3>Details</h3>
          <ul className="sc-details">
            {p.work && (
              <li>
                <Icon name="briefcase" size={20} /> <span>Work</span> <b>{p.work}</b>
              </li>
            )}
            {p.location && (
              <li>
                <Icon name="pin" size={20} /> <span>Location</span> <b>{p.location}</b>
              </li>
            )}
            {p.age !== null && (
              <li>
                <Icon name="gift" size={20} /> <span>Age</span> <b data-testid="about-age">{p.age}</b>
              </li>
            )}
          </ul>
          {p.me && <small className="sc-meta">Only your age shows — never your date of birth.</small>}
        </section>
      )}
      {pro && (
        <section className="sc-card sc-about" data-testid="provider-credentials">
          <h3>Provider background</h3>
          <ProviderBadge testid="provider-badge-about" />
          <ul className="sc-details" style={{ marginTop: 10 }}>
            <li>
              <Icon name="shield" size={20} /> <span>Specialty</span> <b>{pro.specialty}</b>
            </li>
            {pro.credentials && (
              <li>
                <Icon name="info" size={20} /> <span>Credentials</span> <b>{pro.credentials}</b>
              </li>
            )}
            {pro.licenseStates.length > 0 && (
              <li>
                <Icon name="pin" size={20} /> <span>States</span> <b>{pro.licenseStates.join(', ')} (self-reported)</b>
              </li>
            )}
            <li>
              <Icon name="sun" size={20} /> <span>Verified</span> <b>{verifiedOn}</b>
            </li>
          </ul>
          <small className="sc-meta">The NPI was checked against the public NPI Registry and the OIG exclusion list. {pro.disclaimer}</small>
        </section>
      )}
      {p.interestLabels.length > 0 && (
        <section className="sc-card sc-about">
          <h3>Interests</h3>
          <div className="sc-chips" data-testid="about-interests">
            {p.interestLabels.map((l) => (
              <span key={l} className="sc-chip-outline">
                {l}
              </span>
            ))}
          </div>
        </section>
      )}
      {!p.me && p.mutualFriends.count > 0 && (
        <section className="sc-card sc-about" data-testid="mutual-friends">
          <h3>Mutual friends</h3>
          <p className="sc-stack-row">
            <span className="sc-stack">
              {p.mutualFriends.people.map((a) => (
                <Link key={a.userId} to={`/people/${a.userId}`} aria-label={a.displayName}>
                  <Avatar a={a} size={38} />
                </Link>
              ))}
            </span>
            <span>
              {p.mutualFriends.count} mutual {p.mutualFriends.count === 1 ? 'friend' : 'friends'}
            </span>
          </p>
        </section>
      )}
      {p.achievements.length > 0 && (
        <section className="sc-card sc-about">
          <h3>Achievements</h3>
          <ul className="sc-achievements" data-testid="achievements">
            {p.achievements.map((a) => (
              <li key={a.key}>
                <NavIcon name={ACHIEVEMENT_ICON[a.key] ?? 'star'} size={24} />
                {a.label}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!p.me && <SupportBox userId={p.userId} name={p.displayName} />}
      {p.shopUrl && (
        <a className="sc-card sc-shop" href={p.shopUrl} target="_blank" rel="noopener noreferrer" data-testid="shop-slot">
          <b>Shop</b>
          <small className="sc-meta">{p.displayName}’s storefront ↗</small>
        </a>
      )}
      {p.me && <YourStats />}
    </div>
  );
}

/* ======================= Edit profile ======================= */

export function EditProfilePage() {
  return (
    <section data-testid="edit-profile-page" className="sc-page feed-page">
      <Gate>{(me) => (me.profile ? <EditProfile start={me.profile} /> : null)}</Gate>
    </section>
  );
}

function EditProfile({ start }: { start: CommunityProfile }) {
  const navigate = useNavigate();
  const [p, setP] = useState(start);
  const [f, setF] = useState({
    displayName: start.displayName,
    bio: start.bio,
    work: start.work ?? '',
    location: start.location ?? '',
    dob: start.dob ?? '',
    shopSlug: start.shopSlug ?? '',
    parentBadge: start.parentBadge,
  });
  const [busy, setBusy] = useState<'avatarId' | 'coverId' | 'save' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const pick = (field: 'avatarId' | 'coverId') => (file: File) => {
    setBusy(field);
    void savePhoto(p, file, field)
      .then((r) => {
        setP(r.profile);
        if (r.underReview) setMsg('Your photo is being reviewed for safety — it shows once it’s approved.');
      })
      .catch((e: unknown) => setMsg(errText(e, 'Could not add the photo')))
      .finally(() => setBusy(null));
  };
  return (
    <form
      data-testid="profile-edit"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy('save');
        setMsg(null);
        void api<CommunityProfile>('/api/community/profile', 'PUT', {
          displayName: f.displayName,
          bio: f.bio,
          work: f.work.trim() || null,
          location: f.location.trim() || null,
          dob: f.dob || null,
          shopSlug: f.shopSlug,
          parentBadge: f.parentBadge,
        })
          .then(() => navigate(FEED_APP ? '/me' : `/people/${p.userId}`))
          .catch((e2: unknown) => setMsg(errText(e2, 'Could not save')))
          .finally(() => setBusy(null));
      }}
    >
      <TopBar
        left={
          <button type="button" className="sc-text-btn" onClick={() => navigate(-1)}>
            Cancel
          </button>
        }
        title="Edit profile"
        right={
          <button className="sc-text-btn accent" disabled={busy === 'save'} data-testid="profile-save">
            Save
          </button>
        }
      />
      <div className="sc-profile-head edit">
        <Cover p={p} onPick={pick('coverId')} busy={busy === 'coverId'} />
        <BigAvatar p={p} onPick={pick('avatarId')} busy={busy === 'avatarId'} />
      </div>
      <p className="sc-meta sc-center">Photos are reviewed for safety before they appear. You, not your kids.</p>
      {msg && (
        <p className="sc-toast" role="status">
          {msg}
        </p>
      )}
      <div className="sc-card sc-form">
        <label>
          <span>Name</span>
          <input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required maxLength={24} aria-label="First name" />
        </label>
        <label>
          <span>Bio</span>
          <textarea value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={280} rows={2} placeholder="No kids’ names or schools" aria-label="Bio" />
        </label>
        <label>
          <span>Work</span>
          <input value={f.work} onChange={(e) => setF({ ...f, work: e.target.value })} maxLength={80} placeholder="e.g. Project manager" data-testid="edit-work" />
        </label>
        <label>
          <span>Location</span>
          <input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} maxLength={60} placeholder="City, never an address" data-testid="edit-location" />
        </label>
        <label>
          <span>Birthday</span>
          <input type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} max={new Date().toISOString().slice(0, 10)} data-testid="edit-dob" aria-label="Date of birth (private — your profile shows your age only)" />
        </label>
        <label>
          <span>Shop</span>
          <input value={f.shopSlug} onChange={(e) => setF({ ...f, shopSlug: e.target.value })} maxLength={60} placeholder="Your MonetizeMe storefront slug" autoCapitalize="none" aria-label="Your MonetizeMe shop" />
        </label>
        <div className="sc-form-row">
          <span>Show a “parent” badge</span>
          <Toggle on={f.parentBadge} onChange={(v) => setF({ ...f, parentBadge: v })} label="Show a parent badge" />
        </div>
      </div>
      <p className="sc-meta sc-center">Your birthday stays private — your profile shows your age only.</p>
      <p className="sc-meta sc-center">
        <Link to="/feed/settings/provider">Provider background →</Link>
      </p>
    </form>
  );
}

/* ======================= Friends ======================= */

export function FriendsPage() {
  return (
    <section data-testid="friends" className="sc-page feed-page">
      <TopBar title="Friends" back={false} />
      <Gate>{() => <Friends />}</Gate>
    </section>
  );
}

function PersonRow({ p, children }: { p: FriendPerson; children?: ReactNode }) {
  return (
    <div className="sc-card sc-person" data-testid="friend-row">
      <Link to={`/people/${p.userId}`} className="sc-person-who">
        <Avatar a={p} size={56} />
        <span>
          <Name a={p} link={false} />
          <small className="sc-meta">{p.mutualFriends ? `${p.mutualFriends} mutual ${p.mutualFriends === 1 ? 'friend' : 'friends'}` : p.username ? `@${p.username}` : `${short(p.friends)} ${p.friends === 1 ? 'friend' : 'friends'}`}</small>
        </span>
      </Link>
      {children}
    </div>
  );
}

function Friends() {
  const { data, setData, reload } = useLoad<FriendsData>('/api/friends');
  const [asked, setAsked] = useState<Set<number>>(new Set());
  if (!data) return <p className="sc-meta">Loading…</p>;
  const drop = (id: number): void => setData({ ...data, requests: data.requests.filter((r) => r.userId !== id) });
  return (
    <>
      <h2 className="sc-h2" data-testid="requests-title">
        Friend requests{data.requests.length ? ` (${data.requests.length})` : ''}
      </h2>
      <div className="sc-list" data-testid="friend-requests">
        {data.requests.map((r) => (
          <PersonRow key={r.userId} p={r}>
            <span className="sc-person-acts">
              <button type="button" className="sc-btn small" onClick={() => void api(`/api/community/people/${r.userId}/follow`, 'POST').then(reload)} data-testid="friend-confirm">
                Confirm
              </button>
              <button type="button" className="sc-btn outline small" onClick={() => void api(`/api/friends/${r.userId}/dismiss`, 'POST').then(() => drop(r.userId))} data-testid="friend-delete">
                Delete
              </button>
            </span>
          </PersonRow>
        ))}
        {!data.requests.length && <p className="sc-meta">No requests right now.</p>}
      </div>
      {data.suggestions.length > 0 && (
        <>
          <h2 className="sc-h2">People you may know</h2>
          <div className="sc-list" data-testid="friend-suggestions">
            {data.suggestions.map((s) => (
              <PersonRow key={s.userId} p={s}>
                <FriendButton
                  userId={s.userId}
                  rel={asked.has(s.userId) ? 'requested' : 'none'}
                  onChange={(r) => setAsked((a) => (r === 'requested' ? new Set([...a, s.userId]) : new Set([...a].filter((x) => x !== s.userId))))}
                  compact
                  outline
                  testid="friend-add"
                />
              </PersonRow>
            ))}
          </div>
        </>
      )}
      <h2 className="sc-h2">Your friends{data.friends.length ? ` (${data.friends.length})` : ''}</h2>
      <div className="sc-list" data-testid="friend-list">
        {data.friends.map((f) => (
          <PersonRow key={f.userId} p={f}>
            <Link to={`/messages/${f.userId}`} className="sc-icon-btn" aria-label={`Message ${f.displayName}`}>
              <Icon name="message" />
            </Link>
          </PersonRow>
        ))}
        {!data.friends.length && <p className="sc-meta">When someone confirms your request (or you confirm theirs), you’re friends.</p>}
      </div>
      <p className="sc-meta sc-center">
        <Link to="/invite" data-testid="invite-friends">
          Invite friends to The Feed
        </Link>
      </p>
    </>
  );
}

/* ======================= Settings ======================= */

const MOTION_KEY = 'feed.reduceMotion';

export function reduceMotion(): boolean {
  try {
    return localStorage.getItem(MOTION_KEY) === '1';
  } catch {
    return false;
  }
}

function Row({ icon, label, value, to, onClick, testid, children, href }: { icon: IconName; label: string; value?: string; to?: string; href?: string; onClick?: () => void; testid?: string; children?: ReactNode }) {
  const body = (
    <>
      <Icon name={icon} size={22} />
      <span className="grow">{label}</span>
      {value && <span className="sc-meta">{value}</span>}
      {children ?? <Icon name="chevron" size={18} />}
    </>
  );
  if (to)
    return (
      <Link to={to} className="sc-row-item" data-testid={testid}>
        {body}
      </Link>
    );
  if (href)
    return (
      <a href={href} className="sc-row-item" data-testid={testid}>
        {body}
      </a>
    );
  if (onClick)
    return (
      <button type="button" className="sc-row-item" onClick={onClick} data-testid={testid}>
        {body}
      </button>
    );
  return (
    <div className="sc-row-item" data-testid={testid}>
      {body}
    </div>
  );
}

export function SettingsPage() {
  return (
    <section data-testid="feed-settings" className="sc-page feed-page">
      <TopBar title="Settings" />
      <Gate>{(me) => <Settings me={me} />}</Gate>
    </section>
  );
}

function Settings({ me }: { me: CommunityMe }) {
  const { me: session } = useSession();
  const [sheet, setSheet] = useState<'privacy' | 'blocked' | 'crisis' | 'about' | null>(null);
  const [motion, setMotion] = useState(reduceMotion);
  const [aud, setAud] = useState<PostAudience>(me.profile?.defaultAudience ?? 'public');
  const off = new Set(session.household?.modulesOff ?? []);
  const myday = FEED_APP && APP_URL ? `/api/auth/go?to=myday&next=${session.household ? '/' : '/start'}` : '/start';
  const p = me.profile;
  if (!p) return null;
  return (
    <>
      <h2 className="sc-h3">Account</h2>
      <div className="sc-card sc-rows">
        <Row icon="user" label="Profile" to="/feed/profile/edit" testid="settings-profile" />
        <Row icon="shield" label="Provider background" value={p.provider ? 'Verified' : undefined} to="/feed/settings/provider" testid="settings-provider" />
        <Row icon="lock" label="Privacy" value={aud === 'friends' ? 'Friends only' : 'Public'} onClick={() => setSheet('privacy')} testid="settings-privacy" />
        <Row icon="bell" label="Notifications" to="/feed/settings/notifications" testid="settings-notifications" />
      </div>
      <h2 className="sc-h3">Community</h2>
      <div className="sc-card sc-rows">
        <Row icon="block" label="Blocked accounts" onClick={() => setSheet('blocked')} testid="settings-blocked" />
        <Row icon="lifebuoy" label="Crisis resources" onClick={() => setSheet('crisis')} testid="settings-crisis" />
        <Row icon="village" label="Villages" to="/village" testid="settings-villages" />
        <Row icon="clip" label="Clips" to="/clips" testid="settings-clips" />
        {!FEED_APP && session.household && !off.has('circles') && <Row icon="friends" label="Circles" to="/circles" testid="settings-circles" />}
        <Row icon="gift" label="Invite friends" to="/invite" testid="settings-invite" />
        <Row icon="coins" label="Earnings" to="/earnings" testid="settings-earnings" />
        {p.provider && <Row icon="briefcase" label="Business suite" to="/business" testid="settings-business" />}
        {me.isModerator && <Row icon="shield" label="Moderation queue" to="/community/moderation" testid="settings-moderation" />}
      </div>
      <h2 className="sc-h3">App</h2>
      <div className="sc-card sc-rows">
        <Row icon="sun" label="Appearance" value="Soft Light">
          <span />
        </Row>
        <Row icon="motion" label="Reduce motion">
          <Toggle
            on={motion}
            label="Reduce motion"
            testid="reduce-motion"
            onChange={(v) => {
              setMotion(v);
              try {
                localStorage.setItem(MOTION_KEY, v ? '1' : '0');
              } catch {
                /* a convenience only */
              }
              document.documentElement.classList.toggle('sc-calm', v);
            }}
          />
        </Row>
        <Row icon="info" label="About The Feed" onClick={() => setSheet('about')} testid="settings-about" />
        <Row icon="door" label={FEED_APP && session.household ? 'Open MyDay' : 'Set up MyDay'} href={myday} testid="setup-household" />
      </div>
      <button type="button" className="sc-logout" onClick={() => void signOut()} data-testid="sign-out">
        Log out
      </button>
      {sheet === 'privacy' && (
        <Sheet title="Privacy" onClose={() => setSheet(null)} testid="privacy-sheet">
          <p className="sc-meta">Who sees your new posts by default. You can still choose for each post.</p>
          <div className="sc-rows">
            {(['public', 'friends'] as const).map((a) => (
              <button
                key={a}
                type="button"
                className={aud === a ? 'sc-row-item on' : 'sc-row-item'}
                aria-pressed={aud === a}
                onClick={() => {
                  setAud(a);
                  void saveProfile(p, { defaultAudience: a });
                }}
                data-testid={`privacy-${a}`}
              >
                <Icon name={a === 'public' ? 'globe' : 'friends'} size={22} />
                <span className="grow">{a === 'public' ? 'Public — anyone on The Feed' : 'Friends only'}</span>
                {aud === a && <Icon name="chevron" size={18} />}
              </button>
            ))}
          </div>
          <Findable />
        </Sheet>
      )}
      {sheet === 'blocked' && (
        <Sheet title="Blocked accounts" onClose={() => setSheet(null)} testid="blocked-sheet">
          <BlockedList />
        </Sheet>
      )}
      {sheet === 'crisis' && (
        <Sheet title="Crisis resources" onClose={() => setSheet(null)} testid="crisis-sheet">
          <p className="sc-meta">If you or someone else may be in danger, reach out now:</p>
          <ul className="sc-rows">
            {CRISIS_RESOURCES.map((r) => (
              <li key={r.href}>
                <a className="sc-row-item" href={r.href}>
                  <Icon name="lifebuoy" size={22} />
                  <span className="grow">{r.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      {sheet === 'about' && (
        <Sheet title="About The Feed" onClose={() => setSheet(null)} testid="about-sheet">
          <p>
            <Horn size={40} />
          </p>
          <p>A calm community for adults (18+) living with ADHD — and the people who love them. Free, and public by default; posts are screened for kindness before they appear.</p>
          <p className="sc-row">
            <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
          </p>
        </Sheet>
      )}
    </>
  );
}

/** Contacts matching: whether people who have your email can find you. */
function Findable() {
  const { data, setData } = useLoad<{ findableByEmail: boolean }>('/api/feed/privacy');
  if (!data) return null;
  return (
    <div className="sc-form-row">
      <span>Let people who have my email find me</span>
      <Toggle
        on={data.findableByEmail}
        label="Let people who have my email find me"
        testid="pref-findable"
        onChange={(v) => {
          setData({ findableByEmail: v });
          void api('/api/feed/privacy', 'PUT', { findableByEmail: v });
        }}
      />
    </div>
  );
}

function BlockedList() {
  const { data, reload } = useLoad<{ people: CommunityAuthor[] }>('/api/community/blocks');
  if (!data) return <p className="sc-meta">Loading…</p>;
  if (!data.people.length) return <p className="sc-meta">You haven’t blocked anyone.</p>;
  return (
    <ul className="sc-rows" data-testid="blocked-list">
      {data.people.map((a) => (
        <li key={a.userId} className="sc-row-item">
          <Avatar a={a} size={36} />
          <span className="grow">{a.displayName}</span>
          <button type="button" className="sc-btn ghost small" onClick={() => void api(`/api/community/people/${a.userId}/block`, 'DELETE').then(reload)} data-testid="unblock">
            Unblock
          </button>
        </li>
      ))}
    </ul>
  );
}

export function NotificationSettingsPage() {
  return (
    <section data-testid="notif-settings-page" className="sc-page feed-page">
      <TopBar title="Notifications" />
      <Gate>{() => <NotificationSettings open />}</Gate>
    </section>
  );
}

