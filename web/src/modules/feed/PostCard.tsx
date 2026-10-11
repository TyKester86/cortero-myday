/**
 * A post as a Soft Card: the author on the left, the words, a photo or poll, and the quiet action row —
 * heart (long-press for Relate · Helpful · Funny), comments, Share. Delete, pin, Hana and Report sit in "⋯".
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { FEED_FEELINGS, FEED_REACTIONS, type FeedPost, type FeedReaction } from '@myday/shared';
import { api } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { CheckNote, ReportButton, RichText, TrustedCard, VerifyButton } from '../community/Community';
import { Avatar, Icon, Name, errText, short, since } from './kit';
import { ProviderBadge } from './Providers';

const REACTION_FACE: Record<FeedReaction, string> = { like: '♥', relate: 'Same', helpful: 'Helpful', funny: 'Ha' };
const LONG_PRESS_MS = 450;

export function feelingLabel(k: string | null | undefined): string | null {
  return FEED_FEELINGS.find((f) => f.key === k)?.label ?? null;
}

/** The heart: a tap likes; holding it opens the reaction bar. */
export function ReactHeart({ p, onChange }: { p: FeedPost; onChange: (p: FeedPost) => void }) {
  const [bar, setBar] = useState(false);
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!bar) return;
    const away = (e: PointerEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setBar(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [bar]);
  const react = (reaction: FeedReaction): void => {
    setBar(false);
    void api<FeedPost>(`/api/feed/posts/${p.id}/like`, 'POST', { reaction }).then(onChange);
  };
  const mine = p.myReaction ?? (p.likedByMe ? 'like' : null);
  const clear = (): void => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <span className="sc-react" ref={box}>
      <button
        type="button"
        className={mine ? 'sc-act on' : 'sc-act'}
        aria-label={mine ? 'Unlike' : 'Like'}
        aria-pressed={!!mine}
        data-testid="like"
        onPointerDown={() => {
          held.current = false;
          clear();
          timer.current = window.setTimeout(() => {
            held.current = true;
            setBar(true);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={clear}
        onPointerLeave={clear}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (held.current) {
            held.current = false;
            return;
          }
          react(mine && mine !== 'like' ? mine : 'like');
        }}
      >
        <Icon name="heart" size={23} filled={!!mine} />
        <span data-testid="like-count">{short(p.likes)}</span>
        {mine && mine !== 'like' && <small className="sc-react-tag">{REACTION_FACE[mine]}</small>}
      </button>
      {bar && (
        <span className="sc-react-bar" role="menu" aria-label="React" data-testid="reaction-bar">
          {FEED_REACTIONS.map((r) => (
            <button key={r.key} type="button" role="menuitem" className={mine === r.key ? 'on' : ''} onClick={() => react(r.key)} data-testid={`react-${r.key}`}>
              {r.key === 'like' ? <Icon name="heart" size={20} filled /> : null}
              <span>{r.label}</span>
              {!!p.reactions?.[r.key] && <small>{p.reactions[r.key]}</small>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function PollBox({ p, onChange }: { p: FeedPost; onChange: (p: FeedPost) => void }) {
  const poll = p.poll;
  if (!poll) return null;
  const voted = poll.myVote !== null;
  return (
    <div className="sc-poll" data-testid="poll">
      {poll.options.map((o, i) => {
        const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
        return (
          <button
            key={i}
            type="button"
            className={poll.myVote === i ? 'sc-poll-opt mine' : 'sc-poll-opt'}
            onClick={() => void api<{ post: FeedPost }>(`/api/feed/posts/${p.id}/vote`, 'POST', { option: i }).then((r) => onChange(r.post))}
            data-testid="poll-option"
            aria-pressed={poll.myVote === i}
          >
            {voted && <i style={{ width: `${pct}%` }} />}
            <span>{o.text}</span>
            {voted && <b>{pct}%</b>}
          </button>
        );
      })}
      <small className="sc-meta">
        {poll.total} {poll.total === 1 ? 'vote' : 'votes'}
        {voted ? ' · tap another to change your vote' : ''}
      </small>
    </div>
  );
}

async function sharePost(p: FeedPost): Promise<string> {
  const url = `${window.location.origin}/feed/post/${p.id}`;
  const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
  if (nav.share) {
    await nav.share({ title: `${p.author.displayName} on The Feed`, url }).catch(() => undefined);
    return '';
  }
  await navigator.clipboard?.writeText(url).catch(() => undefined);
  return 'Link copied.';
}

export function PostCard({
  p,
  onChange,
  onMsg,
  onGone,
  detail = false,
  showAvatar = true,
}: {
  p: FeedPost;
  onChange: (p: FeedPost) => void;
  onMsg: (m: string) => void;
  onGone: (id: number) => void;
  detail?: boolean;
  showAvatar?: boolean;
}) {
  const confirm = useConfirm();
  const [menu, setMenu] = useState(false);
  const feeling = feelingLabel(p.feeling);
  return (
    <article className={showAvatar ? 'sc-card sc-post' : 'sc-card sc-post bare'} data-testid="feed-post" data-post={p.id}>
      {showAvatar && (
        <Link to={`/people/${p.author.userId}`} className="sc-post-avatar" tabIndex={-1} aria-hidden="true">
          <Avatar a={p.author} size={52} />
        </Link>
      )}
      <div className="sc-post-main">
        <header className="sc-post-head">
          <span className="sc-post-who">
            <Name a={p.author} />
            <span className="sc-meta"> · {since(p.at)}</span>
            {p.author.verified && <ProviderBadge compact />}
            {p.audience === 'friends' && (
              <span className="sc-meta sc-aud" title="Friends only" aria-label="Friends only">
                {' '}
                · <Icon name="friends" size={14} />
              </span>
            )}
          </span>
          {p.status !== 'visible' && <span className="sc-chip warn">Under review</span>}
          <button type="button" className="sc-icon-btn sm" aria-label="More" aria-expanded={menu} onClick={() => setMenu(!menu)} data-testid="post-menu">
            <Icon name="more" size={22} />
          </button>
        </header>
        {(feeling || p.place) && (
          <p className="sc-meta sc-post-tags" data-testid="post-tags">
            {feeling && <>feeling {feeling}</>}
            {feeling && p.place && ' · '}
            {p.place && (
              <>
                <Icon name="pin" size={13} /> {p.place}
              </>
            )}
          </p>
        )}
        {p.body && (
          <p className="sc-post-body">
            <RichText text={p.body} />
          </p>
        )}
        {p.imageUrl && <img src={p.imageUrl} alt="" className="sc-post-img feed-photo" loading="lazy" />}
        <PollBox p={p} onChange={onChange} />
        {p.trusted && <TrustedCard t={p.trusted} />}
        {p.check && <CheckNote c={p.check} />}
        {menu && (
          <div className="sc-menu" data-testid="post-menu-pop">
            {p.mine ? (
              <>
                <button
                  type="button"
                  className="sc-menu-item"
                  onClick={() => {
                    setMenu(false);
                    void api('/api/community/profile/pin', 'PUT', { kind: 'post', id: p.id }).then(
                      () => onMsg('Pinned to the top of your profile.'),
                      (e: unknown) => onMsg(errText(e, 'Could not pin')),
                    );
                  }}
                  data-testid="post-pin"
                >
                  Pin to your profile
                </button>
                <button
                  type="button"
                  className="sc-menu-item danger"
                  onClick={() =>
                    void confirm({ title: 'Delete this post?', confirmLabel: 'Delete', danger: true }).then(
                      (y) => void (y && api(`/api/feed/posts/${p.id}`, 'DELETE').then(() => onGone(p.id))),
                    )
                  }
                >
                  Delete
                </button>
              </>
            ) : (
              <ReportButton path={`/api/feed/posts/${p.id}/report`} onDone={onMsg} />
            )}
            {p.status === 'visible' && !p.check && p.body && <VerifyButton kind="feed" id={p.id} onCheck={(c) => onChange({ ...p, check: c })} />}
          </div>
        )}
        {p.status === 'visible' && (
          <footer className="sc-actions">
            <ReactHeart p={p} onChange={onChange} />
            {detail ? (
              <span className="sc-act static" aria-label={`${p.comments ?? 0} comments`}>
                <Icon name="comment" size={23} />
                <span>{short(p.comments ?? 0)}</span>
              </span>
            ) : (
              <Link to={`/feed/post/${p.id}`} className="sc-act" aria-label={`${p.comments ?? 0} comments`} data-testid="post-comments">
                <Icon name="comment" size={23} />
                <span>{short(p.comments ?? 0)}</span>
              </Link>
            )}
            <button type="button" className="sc-act" onClick={() => void sharePost(p).then((m) => m && onMsg(m))} data-testid="post-share">
              <Icon name="share" size={22} />
              <span>Share</span>
            </button>
          </footer>
        )}
      </div>
    </article>
  );
}
