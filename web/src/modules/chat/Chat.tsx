import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMode, ChatSendResponse, ChatState } from '@myday/shared';
import { api, useLoad } from '../../api';

const COPY: Record<ChatMode, { title: string; intro: string; placeholder: string }> = {
  companion: {
    title: '💬 Ask Hana',
    intro: 'Hana can see your day, your tasks, this week’s meals and the grocery list. One clear next step at a time.',
    placeholder: 'What’s on your mind?',
  },
  tutor: {
    title: '📚 Homework helper',
    intro: 'Hana helps you figure it out — she won’t just give you the answer. That’s her one rule.',
    placeholder: 'What are you working on?',
  },
};

/** Ask Hana (grown-ups) and the homework tutor (kids + students) share this screen. */
export default function Chat({ mode }: { mode: ChatMode }) {
  const { data, error, setData } = useLoad<ChatState>(`/api/chat/${mode}`);
  const [msg, setMsg] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [data, pending]);

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
      const r = await api<ChatSendResponse>(`/api/chat/${mode}`, 'POST', { message: text });
      setData({ ...data, history: r.history });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'That didn’t go through — try again');
      setMsg(text);
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="chat">
      <h1>{copy.title}</h1>
      <p className="muted small">{copy.intro}</p>
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
