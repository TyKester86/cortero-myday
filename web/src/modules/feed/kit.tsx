/**
 * The Feed's "Soft Card" kit: warm paper background, white cards, one terracotta accent. Icons, avatars,
 * the verified check, page headers, the floating dock, toggles, pill tabs and bottom sheets.
 */
import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import type { CommunityAuthor, CommunityMe, Relationship } from '@myday/shared';
import { api, useLoad } from '../../api';

/* ---------- icons (one stroke family, 24px grid) ---------- */

const PATHS: Record<string, ReactNode> = {
  home: <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />,
  friends: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
      <circle cx="16.5" cy="9" r="2.6" />
      <path d="M15.5 14.2c2.6-.3 4.6 1.3 5 4.3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  user: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.6 18.2c1.2-2.2 3.1-3.3 5.4-3.3s4.2 1.1 5.4 3.3" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  message: <path d="M4.5 18.8V7.5a2.5 2.5 0 0 1 2.5-2.5h10a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H8.3z" />,
  back: <path d="M15 5 8 12l7 7" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>
  ),
  heart: <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z" />,
  comment: <path d="M12 4.5c4.4 0 8 3 8 6.8s-3.6 6.8-8 6.8c-1 0-2-.1-2.9-.4L5 19.5l1.2-3.6C5 14.7 4 13.1 4 11.3 4 7.5 7.6 4.5 12 4.5z" />,
  share: (
    <>
      <path d="M20.5 3.5 10 14" />
      <path d="m20.5 3.5-6.5 17-4-6.5-6.5-4z" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4 17 5-4.5 3.5 3 3-2.5L20 17" />
    </>
  ),
  poll: <path d="M6 20V12M12 20V5M18 20v-6" />,
  smile: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14c.9 1.4 2.1 2 3.5 2s2.6-.6 3.5-2" />
      <path d="M9.2 9.6h.01M14.8 9.6h.01" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
  pushpin: (
    <>
      <path d="M9 4h6l-1 6 3 3H7l3-3z" />
      <path d="M12 13v7" />
    </>
  ),
  send: (
    <>
      <path d="M5 12h13" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.5-2h5L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="12.5" r="3.3" />
    </>
  ),
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  more: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
  pencil: (
    <>
      <path d="M15.5 4.5 19.5 8.5 8.5 19.5H4.5v-4z" />
      <path d="m13 7 4 4" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  down: <path d="m6 9 6 6 6-6" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  shield: <path d="M12 3.5 19 6v5.5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>
  ),
  motion: (
    <>
      <path d="M4 12h9M4 7h12M4 17h6" />
      <circle cx="18" cy="15" r="2.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" />
    </>
  ),
  lifebuoy: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="m6 6 3.5 3.5M14.5 14.5 18 18M18 6l-3.5 3.5M9.5 14.5 6 18" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4.5H6.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1H14" />
      <path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5" />
    </>
  ),
  village: (
    <>
      <path d="M3.5 19.5h17M5 19.5V11l4-3 4 3v8.5M13 19.5v-6l3.5-2.5 3 2.5v6" />
    </>
  ),
  clip: (
    <>
      <rect x="6" y="3.5" width="12" height="17" rx="2.5" />
      <path d="M10.5 9.5v5l4-2.5z" />
    </>
  ),
  gift: (
    <>
      <rect x="4" y="9" width="16" height="11" rx="1.5" />
      <path d="M12 9v11M4 13h16M12 9c-1.5-3-5-3.5-5-1.2C7 9 9 9 12 9zm0 0c1.5-3 5-3.5 5-1.2C17 9 15 9 12 9z" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="12" cy="7" rx="6.5" ry="2.8" />
      <path d="M5.5 7v5c0 1.6 2.9 2.8 6.5 2.8s6.5-1.2 6.5-2.8V7M5.5 12v5c0 1.6 2.9 2.8 6.5 2.8s6.5-1.2 6.5-2.8v-5" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3.5" y="7.5" width="17" height="12" rx="2" />
      <path d="M9 7.5V5.5h6v2M3.5 12.5h17" />
    </>
  ),
  door: (
    <>
      <path d="M6 20.5V4.5h12v16M3.5 20.5h17" />
      <path d="M14.5 12.5h.01" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24, filled = false, className }: { name: IconName; size?: number; filled?: boolean; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** The blue verified check (licensed providers). */
export function Check({ size = 16 }: { size?: number }) {
  return (
    <svg className="sc-check" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Verified">
      <path fill="#3B8FE8" d="m12 1.8 2.5 1.9 3.1-.2 1 3 2.6 1.7-.9 3 .9 3-2.6 1.7-1 3-3.1-.2L12 22.2l-2.5-1.9-3.1.2-1-3-2.6-1.7.9-3-.9-3 2.6-1.7 1-3 3.1.2z" />
      <path fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" d="m8 12.3 2.7 2.7L16.2 9.5" />
    </svg>
  );
}

export function Avatar({ a, size = 44, ring }: { a: Pick<CommunityAuthor, 'avatarUrl' | 'displayName'>; size?: number; ring?: 'unseen' | 'seen' }) {
  const face = a.avatarUrl ? (
    <img src={a.avatarUrl} alt="" className="sc-avatar" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span className="sc-avatar blank" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {a.displayName.slice(0, 1)}
    </span>
  );
  return ring ? <span className={`sc-ring ${ring}`}>{face}</span> : face;
}

export function Name({ a, link = true }: { a: Pick<CommunityAuthor, 'userId' | 'displayName' | 'verified'>; link?: boolean }) {
  const body = (
    <>
      {a.displayName}
      {a.verified && <Check />}
    </>
  );
  return link ? (
    <Link to={`/people/${a.userId}`} className="sc-name">
      {body}
    </Link>
  ) : (
    <b className="sc-name">{body}</b>
  );
}

/** The Feed's mark: the horn, exactly as drawn (public/icons/feed-horn.svg). */
export function Horn({ size = 34 }: { size?: number }) {
  return <img src="/icons/feed-horn.svg" alt="" className="sc-horn feed-horn" width={size} height={size} />;
}

/* ---------- headers ---------- */

/** The Home header: the horn and "The Feed", with icons on the right. */
export function HomeBar({ right }: { right?: ReactNode }) {
  return (
    <header className="sc-bar home" data-testid="feed-header">
      <Horn size={40} />
      <h1 className="sc-wordmark">The Feed</h1>
      <span className="grow" />
      {right}
    </header>
  );
}

/** Every other page: back (and the horn) on the left, the title centered, icons on the right. */
export function TopBar({ title, back = true, right, left }: { title?: ReactNode; back?: boolean | string; right?: ReactNode; left?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="sc-bar" data-testid="feed-header">
      <span className="sc-bar-side">
        {left ??
          (back && (
            <button
              type="button"
              className="sc-icon-btn"
              aria-label="Back"
              data-testid="back"
              onClick={() => (typeof back === 'string' ? navigate(back) : window.history.length > 1 ? navigate(-1) : navigate('/feed'))}
            >
              <Icon name="back" />
            </button>
          ))}
        <Link to="/feed" className="sc-bar-horn" aria-label="The Feed">
          <Horn size={28} />
        </Link>
      </span>
      {title && <h1 className="sc-bar-title">{title}</h1>}
      <span className="sc-bar-side right">{right}</span>
    </header>
  );
}

export function IconLink({ to, icon, label, testid, badge, filled }: { to: string; icon: IconName; label: string; testid?: string; badge?: number; filled?: boolean }) {
  return (
    <Link to={to} className="sc-icon-btn" aria-label={badge ? `${label}, ${badge} new` : label} data-testid={testid}>
      <Icon name={icon} filled={filled} />
      {!!badge && <span className="sc-badge">{badge > 99 ? '99+' : badge}</span>}
    </Link>
  );
}

/* ---------- the dock ---------- */

export function Dock({ profileTo, unread }: { profileTo: string; unread: number }) {
  return (
    <nav className="sc-dock" aria-label="The Feed" data-testid="feed-dock">
      <NavLink to="/feed" end className="sc-dock-item" aria-label="Home" data-testid="dock-home">
        {({ isActive }) => <Icon name="home" size={27} filled={isActive} />}
      </NavLink>
      <NavLink to="/feed/friends" className="sc-dock-item" aria-label="Friends" data-testid="dock-friends">
        <Icon name="friends" size={27} />
      </NavLink>
      <NavLink to="/feed/create" className="sc-dock-create" aria-label="Create a post" data-testid="dock-create">
        <Icon name="plus" size={30} />
      </NavLink>
      <NavLink to={profileTo} className="sc-dock-item" aria-label="Your profile" data-testid="profile-entry">
        <Icon name="user" size={27} />
      </NavLink>
      <NavLink to="/notifications" className="sc-dock-item" aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'} data-testid="notif-bell">
        {({ isActive }) => (
          <>
            <Icon name="bell" size={27} filled={isActive} />
            {unread > 0 && (
              <span className="sc-badge" data-testid="notif-badge">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </>
        )}
      </NavLink>
    </nav>
  );
}

/* ---------- small controls ---------- */

export function Toggle({ on, onChange, label, testid, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; testid?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={on ? 'sc-toggle on' : 'sc-toggle'} onClick={() => onChange(!on)} data-testid={testid} disabled={disabled}>
      <i />
    </button>
  );
}

/** The floating pill of tabs with a terracotta underline (Posts | Media | About). */
export function PillTabs<T extends string>({ tabs, on, onPick, testid }: { tabs: Array<{ key: T; label: string }>; on: T; onPick: (t: T) => void; testid?: (t: T) => string }) {
  return (
    <nav className="sc-pilltabs" role="tablist">
      {tabs.map((t, i) => (
        <span key={t.key} className="sc-pilltab-wrap">
          {i > 0 && <span className="sc-pilltab-sep" aria-hidden="true" />}
          <button type="button" role="tab" aria-selected={on === t.key} aria-pressed={on === t.key} className={on === t.key ? 'sc-pilltab on' : 'sc-pilltab'} onClick={() => onPick(t.key)} data-testid={testid?.(t.key)}>
            {t.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

/** Filter pills (All · People · Posts …): the active one filled terracotta. */
export function Filters<T extends string>({ items, on, onPick, testid }: { items: Array<{ key: T; label: string }>; on: T; onPick: (t: T) => void; testid?: (t: T) => string }) {
  return (
    <div className="sc-filters" role="tablist">
      {items.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={on === t.key} className={on === t.key ? 'sc-filter on' : 'sc-filter'} onClick={() => onPick(t.key)} data-testid={testid?.(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A bottom sheet (in-page; Escape or a tap outside closes it). */
export function Sheet({ title, onClose, children, testid }: { title: string; onClose: () => void; children: ReactNode; testid?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="sc-sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sc-sheet" role="dialog" aria-modal="true" aria-label={title} data-testid={testid}>
        <header className="sc-sheet-head">
          <b>{title}</b>
          <button type="button" className="sc-icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={22} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export const errText = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

/** "1.2k" for big numbers. */
export function short(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
}

/** Short relative time: "now", "5m", "2h", "3d", then the date. */
export function since(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ---------- friends ---------- */

const FRIEND_LABEL: Record<Relationship, string> = { self: '', friends: 'Friends', requested: 'Requested', incoming: 'Confirm', none: 'Add friend' };

/** Add friend → Requested; Confirm (they asked you) → Friends; tapping Friends/Requested undoes it. */
export function FriendButton({
  userId,
  rel,
  onChange,
  compact = false,
  outline = false,
  testid = 'friend-button',
}: {
  userId: number;
  rel: Relationship;
  onChange: (r: Relationship) => void;
  compact?: boolean;
  outline?: boolean;
  testid?: string;
}) {
  if (rel === 'self') return null;
  const on = rel === 'friends' || rel === 'requested';
  const label = compact && rel === 'none' ? 'Add' : FRIEND_LABEL[rel];
  return (
    <button
      type="button"
      className={on ? `sc-btn ghost${compact ? ' small' : ''}` : outline ? 'sc-btn outline accent small' : compact ? 'sc-btn small' : 'sc-btn'}
      data-testid={testid}
      onClick={() =>
        void api(`/api/community/people/${userId}/follow`, on ? 'DELETE' : 'POST').then(() =>
          onChange(on ? (rel === 'friends' ? 'incoming' : 'none') : rel === 'incoming' ? 'friends' : 'requested'),
        )
      }
    >
      {label}
    </button>
  );
}

export const relOf = (followedByMe: boolean, followsMe: boolean): Relationship => (followedByMe && followsMe ? 'friends' : followedByMe ? 'requested' : followsMe ? 'incoming' : 'none');

/** The signed-in person's Feed profile (for avatars on the composer and the stories rail). */
export function useMe(): CommunityMe | null {
  return useLoad<CommunityMe>('/api/community/me').data ?? null;
}
