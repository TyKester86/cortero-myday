/**
 * The Feed app's first run, right after the profile: what you're into → villages to join → people to follow →
 * bring your people. Nobody lands in an empty feed. Every step can be skipped; it never comes back once done.
 */
import { useEffect, useState } from 'react';
import { FEED_INTERESTS, type FeedOnboarding as Onboarding, type FeedSuggestion } from '@myday/shared';
import { api, useLoad } from '../../api';
import { FeedHorn } from '../../components/NavIcon';
import { count } from '../../format';

type Step = 'interests' | 'villages' | 'people' | 'invite';
const STEPS: Step[] = ['interests', 'villages', 'people', 'invite'];

export function FeedOnboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('interests');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { data, reload } = useLoad<Onboarding>('/api/feed/onboarding');
  const [joined, setJoined] = useState<Set<string> | null>(null);
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  // Villages your interests point to start ticked (plus any you're already in).
  useEffect(() => {
    if (step === 'villages' && data && joined === null) setJoined(new Set(data.villages.filter((v) => v.joined || v.suggested).map((v) => v.slug)));
  }, [step, data, joined]);
  const finish = async (): Promise<void> => {
    await api('/api/feed/onboarding/done', 'POST').catch(() => undefined);
    onDone();
  };
  const next = async (): Promise<void> => {
    if (step === 'interests') {
      await api('/api/feed/onboarding', 'PUT', { interests: [...picked] });
      reload();
      setJoined(null);
      setStep('villages');
    } else if (step === 'villages' && data) {
      const want = joined ?? new Set<string>();
      await Promise.all(
        data.villages.map((v) =>
          want.has(v.slug) && !v.joined ? api(`/api/villages/${v.slug}/members`, 'POST') : !want.has(v.slug) && v.joined ? api(`/api/villages/${v.slug}/members`, 'DELETE') : null,
        ),
      );
      reload();
      setStep('people');
    } else if (step === 'people') setStep('invite');
    else await finish();
  };
  const follow = async (p: FeedSuggestion): Promise<void> => {
    const on = followed.has(p.userId);
    await api(`/api/community/people/${p.userId}/follow`, on ? 'DELETE' : 'POST');
    const s = new Set(followed);
    if (on) s.delete(p.userId);
    else s.add(p.userId);
    setFollowed(s);
  };
  const link = `${window.location.origin}/?join=1`;
  const share = async (): Promise<void> => {
    const text = 'I’m on The Feed — a calm community for ADHD adults. Come find me:';
    if (navigator.share) {
      await navigator.share({ title: 'The Feed', text, url: link }).catch(() => undefined);
      return;
    }
    await navigator.clipboard?.writeText(`${text} ${link}`).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  const n = STEPS.indexOf(step) + 1;
  return (
    <section className="card onboarding" data-testid="feed-onboarding" aria-labelledby="onb-title">
      <div className="onb-top">
        <FeedHorn tile size={40} />
        <small className="muted">
          Step {n} of {STEPS.length}
        </small>
        <span className="grow" />
        <button type="button" className="link small" onClick={() => void finish()} data-testid="onb-skip">
          Skip for now
        </button>
      </div>
      {step === 'interests' && (
        <>
          <h2 id="onb-title">What are you into?</h2>
          <p className="muted small">Pick a few. We’ll point you to the right villages and people.</p>
          <div className="chips onb-chips" role="group" aria-label="Interests">
            {FEED_INTERESTS.map((i) => (
              <button
                key={i.key}
                type="button"
                className={picked.has(i.key) ? 'chip on' : 'chip'}
                aria-pressed={picked.has(i.key)}
                onClick={() => {
                  const s = new Set(picked);
                  if (s.has(i.key)) s.delete(i.key);
                  else s.add(i.key);
                  setPicked(s);
                }}
                data-testid={`interest-${i.key}`}
              >
                {i.label}
              </button>
            ))}
          </div>
        </>
      )}
      {step === 'villages' && (
        <>
          <h2 id="onb-title">Join your villages</h2>
          <p className="muted small">Small groups around one part of life. Their conversations come to you.</p>
          <ul className="plain onb-list" data-testid="onb-villages">
            {data?.villages.map((v) => {
              const on = joined?.has(v.slug) ?? false;
              return (
                <li key={v.slug} className="row-card">
                  <span className="grow">
                    <b>{v.name}</b>
                    {v.suggested && <span className="pill">For you</span>}
                    <small className="muted" style={{ display: 'block' }}>
                      {v.description} · {count(v.members, 'member')}
                    </small>
                  </span>
                  <button
                    type="button"
                    className={on ? 'btn small' : 'btn ghost small'}
                    aria-pressed={on}
                    onClick={() => {
                      const s = new Set(joined ?? []);
                      if (on) s.delete(v.slug);
                      else s.add(v.slug);
                      setJoined(s);
                    }}
                    data-testid={`onb-village-${v.slug}`}
                  >
                    {on ? 'Joined' : 'Join'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {step === 'people' && (
        <>
          <h2 id="onb-title">People you might like</h2>
          <p className="muted small">Follow a few to fill your feed. You can unfollow anytime.</p>
          <ul className="plain onb-list" data-testid="onb-people">
            {data?.people.map((p) => (
              <li key={p.userId} className="row-card">
                <span className="ring-avatar" aria-hidden="true" style={{ width: 44, height: 44, fontSize: 18 }}>
                  {p.displayName.slice(0, 1)}
                </span>
                <span className="grow">
                  <b>{p.displayName}</b> {p.username && <small className="muted">@{p.username}</small>}
                  <small className="muted" style={{ display: 'block' }}>
                    {p.reason} · {count(p.followers, 'follower')}
                  </small>
                </span>
                <button type="button" className={followed.has(p.userId) ? 'btn small' : 'btn ghost small'} aria-pressed={followed.has(p.userId)} onClick={() => void follow(p)} data-testid="onb-follow">
                  {followed.has(p.userId) ? 'Following' : 'Follow'}
                </button>
              </li>
            ))}
            {data && !data.people.length && <li className="muted">You’re early — the Feed is just getting going. Invite your people next.</li>}
          </ul>
        </>
      )}
      {step === 'invite' && (
        <>
          <h2 id="onb-title">Bring your people</h2>
          <p className="muted small">The Feed is better with friends who get it. Send them your link — it’s free, 18+.</p>
          <div className="onb-invite">
            <input readOnly value={link} aria-label="Your invite link" onFocus={(e) => e.target.select()} data-testid="onb-invite-link" />
            <button type="button" className="btn" onClick={() => void share()} data-testid="onb-share">
              {copied ? 'Copied' : 'Share'}
            </button>
          </div>
        </>
      )}
      <div className="onb-actions">
        {step !== 'interests' && (
          <button type="button" className="link" onClick={() => setStep(STEPS[STEPS.indexOf(step) - 1] ?? 'interests')}>
            Back
          </button>
        )}
        <span className="grow" />
        <button type="button" className="btn" onClick={() => void next()} data-testid="onb-next">
          {step === 'invite' ? 'Go to my feed' : 'Next'}
        </button>
      </div>
    </section>
  );
}
