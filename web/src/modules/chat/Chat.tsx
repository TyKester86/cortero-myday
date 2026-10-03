import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage, ChatMode, ChatSendResponse, ChatState, HanaAction } from '@myday/shared';
import { api, useLoad } from '../../api';
import { HanaFace } from '../../components/NavIcon';
import { useSession } from '../../session';

const COPY: Record<ChatMode, { title: string; intro: string; placeholder: string }> = {
  companion: {
    title: 'Ask Hana',
    intro: 'Hana can see your day, your tasks, this week’s meals and the grocery list. One clear next step at a time.',
    placeholder: 'What’s on your mind?',
  },
  tutor: {
    title: 'Homework helper',
    intro: 'Hana helps you figure it out — she won’t just give you the answer. That’s her one rule.',
    placeholder: 'What are you working on?',
  },
};

/** Ask Hana (grown-ups) and the homework tutor (kids + students) share this screen. */
export default function Chat({ mode }: { mode: ChatMode }) {
  const { me } = useSession();
  const { data, error, setData } = useLoad<ChatState>(`/api/chat/${mode}`);
  const [msg, setMsg] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [actions, setActions] = useState<HanaAction[]>([]);
  // B3: /tutor?lecture=ID quizzes from one of the student's own lectures.
  const lectureId = mode === 'tutor' ? new URLSearchParams(window.location.search).get('lecture') : null;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    void end.current?.scrollIntoView({ block: 'end' });
  }, [data, pending]);

  if (mode === 'tutor' && !me.aiAllowed) {
    return (
      <section data-testid="needs-consent">
        <h1>Homework helper</h1>
        <div className="card">
          <p>The helper is an AI, so a grown-up needs to turn it on for you first.</p>
          <p className="small muted">Ask them to open their Family page → “AI helpers for kids under 13”.</p>
        </div>
      </section>
    );
  }
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const copy = COPY[mode];

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const text = msg.trim();
    if (!text) return;
    setMsg('');
    setPending(text);
    setErr(null);
    try {
      const r = await api<ChatSendResponse>(`/api/chat/${mode}`, 'POST', { message: text, ...(lectureId ? { lectureId: Number(lectureId) } : {}) });
      setData({ ...data, history: r.history, pending: [...data.pending, ...r.actions.filter((a) => a.status === 'pending')] });
      setActions(r.actions.filter((a) => a.status !== 'pending'));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'That didn’t go through — try again');
      setMsg(text);
    } finally {
      setPending(null);
    }
  };

  const decide = async (a: HanaAction, verb: 'confirm' | 'cancel'): Promise<void> => {
    try {
      const r = await api<{ action: HanaAction; history: ChatMessage[]; pending: HanaAction[] }>(`/api/hana/actions/${a.id}/${verb}`, 'POST');
      setData({ ...data, history: r.history, pending: r.pending });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'That didn’t go through');
    }
  };

  return (
    <section className="chat">
      <h1 className="chat-title">
        <HanaFace size={44} />
        {copy.title}
      </h1>
      <p className="muted small">{copy.intro}</p>
      {lectureId && <p className="pill sun">Quiz mode: questions from your lecture</p>}
      {!data.available && <p className="warn">Hana isn’t set up yet — a grown-up needs to add the AI key on the server.</p>}
      <div className="bubbles" data-testid="chat-history">
        {data.history.map((m) => (
          <div key={m.id} className={m.who === 'user' ? 'bubble me' : 'bubble hana'}>
            {m.text}
          </div>
        ))}
        {pending && (
          <>
            <div className="bubble me">{pending}</div>
            <div className="bubble hana muted">Thinking…</div>
          </>
        )}
        {actions.map((a) => (
          <div key={a.id} className="bubble hana small" data-testid="hana-action">
            {a.status === 'done' ? '✓' : '⚠'} {a.summary}
          </div>
        ))}
        {data.pending.map((a) => (
          <div key={a.id} className="card" data-testid="hana-pending" role="alertdialog" aria-label={`Confirm: ${a.summary}`}>
            <b>Hana wants to: {a.summary}</b>
            <p className="muted small">Nothing changes until you confirm.</p>
            <div className="confirm-actions">
              <button className="btn small ghost" onClick={() => void decide(a, 'cancel')}>
                Cancel
              </button>
              <button className="btn small danger" onClick={() => void decide(a, 'confirm')}>
                Confirm
              </button>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {err && <p className="error">{err}</p>}
      <form className="inline" onSubmit={(e) => void send(e)}>
        <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={copy.placeholder} maxLength={2000} disabled={!data.available} />
        <button className="btn small" disabled={!data.available || pending !== null}>
          Send
        </button>
      </form>
    </section>
  );
}
