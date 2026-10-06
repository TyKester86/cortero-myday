import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage, ChatMode, ChatSendResponse, ChatState, HanaAction } from '@myday/shared';
import { api, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import { HanaFace } from '../../components/NavIcon';
import { useSession } from '../../session';

const newClientId = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

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
  // The message on its way: shown at once, and the Send button is off until it lands.
  const [pending, setPending] = useState<{ text: string; clientId: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Why Hana couldn't answer a message (by its id), shown under it until it's retried.
  const [failNote, setFailNote] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<number | null>(null);
  const [actions, setActions] = useState<HanaAction[]>([]);
  const confirm = useConfirm();
  // B3: /tutor?lecture=ID quizzes from one of the student's own lectures.
  const lectureId = mode === 'tutor' ? new URLSearchParams(window.location.search).get('lecture') : null;
  const end = useRef<HTMLDivElement>(null);
  // Scroll only when a message is added (not on every refresh), so the page doesn't jump around.
  const count = (data?.history.length ?? 0) + (pending ? 1 : 0);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    if (count) void end.current?.scrollIntoView({ block: 'nearest' });
  }, [count]);

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

  /** Send (or retry: same clientId, so the server reuses the message instead of saving a copy). */
  const deliver = async (text: string, clientId: string): Promise<void> => {
    if (pending) return; // one at a time — a second tap or Enter does nothing
    setPending({ text, clientId });
    setErr(null);
    setPicked(null);
    setFailNote(({ [clientId]: _gone, ...rest }) => rest);
    try {
      const r = await api<ChatSendResponse>(`/api/chat/${mode}`, 'POST', { message: text, clientId, ...(lectureId ? { lectureId: Number(lectureId) } : {}) });
      setData({ ...data, history: r.history, pending: [...data.pending, ...r.actions.filter((a) => a.status === 'pending')] });
      setActions(r.actions.filter((a) => a.status !== 'pending'));
    } catch (e2) {
      const why = e2 instanceof Error ? e2.message : 'That didn’t go through';
      // The server kept the message, marked as not answered: reload so it shows with Retry.
      const fresh = await api<ChatState>(`/api/chat/${mode}`).catch(() => null);
      if (fresh && fresh.history.some((m) => m.clientId === clientId)) {
        setData({ ...data, history: fresh.history });
        setFailNote((n) => ({ ...n, [clientId]: why }));
      } else {
        // It never reached the server (offline): put it back to send again.
        setErr(why);
        setMsg(text);
      }
    } finally {
      setPending(null);
    }
  };

  const send = (e: FormEvent): void => {
    e.preventDefault();
    const text = msg.trim();
    if (!text || pending) return;
    setMsg('');
    void deliver(text, newClientId());
  };

  const remove = async (m: ChatMessage): Promise<void> => {
    try {
      const r = await api<{ history: ChatMessage[] }>(`/api/chat/${mode}/messages/${m.id}`, 'DELETE');
      setData({ ...data, history: r.history });
      setPicked(null);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Couldn’t delete that');
    }
  };

  const clearAll = async (): Promise<void> => {
    if (!(await confirm({ title: 'Clear this conversation?', body: 'Every message here is deleted. What Hana remembers about you stays (it’s listed below the chat).', confirmLabel: 'Clear', danger: true }))) return;
    const r = await api<{ history: ChatMessage[] }>(`/api/chat/${mode}`, 'DELETE');
    setData({ ...data, history: r.history });
    setActions([]);
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
      <div className="chat-head">
        <h1 className="chat-title">
          <HanaFace size={44} />
          {copy.title}
        </h1>
        {data.history.length > 0 && (
          <button className="link small" onClick={() => void clearAll()} data-testid="chat-clear">
            Clear chat
          </button>
        )}
      </div>
      <p className="muted small">{copy.intro}</p>
      {lectureId && <p className="pill sun">Quiz mode: questions from your lecture</p>}
      {!data.available && <p className="warn">Hana isn’t set up yet — a grown-up needs to add the AI key on the server.</p>}
      <div className="bubbles" data-testid="chat-history">
        {data.history.length === 0 && !pending && <p className="muted small chat-empty">Say hi, or try “what’s on today?”</p>}
        {data.history.map((m, i) => {
          const mine = m.who === 'user';
          const firstOfRun = !mine && data.history[i - 1]?.who !== 'hana';
          const sendingThis = pending?.clientId === m.clientId && m.clientId !== null;
          return (
            <div key={m.id} className={`msg ${mine ? 'me' : 'hana'}${m.failed && !sendingThis ? ' failed' : ''}`} data-testid={mine ? 'msg-me' : 'msg-hana'}>
              {!mine && (firstOfRun ? <HanaFace size={28} /> : <span className="face-gap" />)}
              <div className="msg-body">
                {/* Tap a message to show Delete (links inside Hana's replies still open normally). */}
                <div className={mine ? 'bubble me' : 'bubble hana'} onClick={(ev) => (ev.target as HTMLElement).closest('a') || setPicked(picked === m.id ? null : m.id)}>
                  {mine ? m.text : <Linked text={m.text} />}
                </div>
                {mine && m.failed && !sendingThis && (
                  <div className="msg-failed" role="alert" data-testid="msg-failed">
                    <span>{failNote[m.clientId ?? ''] ?? 'Hana couldn’t answer this one.'}</span>
                    <button className="link small" disabled={pending !== null} onClick={() => void deliver(m.text, m.clientId ?? newClientId())} data-testid="msg-retry">
                      Retry
                    </button>
                  </div>
                )}
                {picked === m.id && (
                  <div className="msg-tools">
                    <button className="link danger small" onClick={() => void remove(m)} data-testid="msg-delete">
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {pending && (
          <>
            {!data.history.some((m) => m.clientId === pending.clientId) && (
              <div className="msg me sending">
                <div className="msg-body">
                  <div className="bubble me">{pending.text}</div>
                </div>
              </div>
            )}
            <div className="msg hana" data-testid="hana-thinking" aria-live="polite">
              <HanaFace size={28} />
              <div className="msg-body">
                <div className="bubble hana thinking">
                  <span className="sr-only">Hana is thinking</span>
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
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
      <form className="inline chat-send" onSubmit={send}>
        <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={copy.placeholder} maxLength={2000} disabled={!data.available} aria-label="Message Hana" />
        <button className="btn small" disabled={!data.available || pending !== null || !msg.trim()} data-testid="chat-send">
          {pending ? 'Sending…' : 'Send'}
        </button>
      </form>
      {mode === 'companion' && <HanaKnows refreshKey={data.history.length} />}
    </section>
  );
}

/** Hana's replies with https links made tappable (checkout links, booking links). */
function Linked({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(https:\/\/[^\s<>"]+[^\s<>".,;:!?)])/);
  return (
    <>
      {parts.map((p, n) =>
        n % 2 ? (
          <a key={n} href={p} target="_blank" rel="noopener noreferrer">
            {p.length > 48 ? `${p.slice(0, 45)}…` : p}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}

interface Knows {
  memories: Array<{ id: number; fact: string; at: string }>;
  reminders: Array<{ id: number; text: string; at: string }>;
}

/** What Hana remembers about you and the reminders she'll send — yours to see and delete. */
function HanaKnows({ refreshKey }: { refreshKey: number }) {
  const { data, reload } = useLoad<Knows>(`/api/hana/memory?r=${refreshKey}`);
  if (!data || (!data.memories.length && !data.reminders.length)) return null;
  const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <details className="card" data-testid="hana-knows">
      <summary>
        <b>What Hana remembers ({data.memories.length}) · reminders ({data.reminders.length})</b>
      </summary>
      {data.reminders.length > 0 && (
        <>
          <h3 className="ing-head">Reminders coming up</h3>
          <ul className="plain rows">
            {data.reminders.map((r) => (
              <li key={r.id} data-testid="hana-reminder">
                <span>
                  {r.text} <small className="muted">· {when(r.at)}</small>
                </span>
                <button className="link danger small" onClick={() => void api(`/api/hana/reminders/${r.id}`, 'DELETE').then(reload)}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.memories.length > 0 && (
        <>
          <h3 className="ing-head">Things she remembers about you</h3>
          <ul className="plain rows">
            {data.memories.map((m) => (
              <li key={m.id} data-testid="hana-memory">
                <span>{m.fact}</span>
                <button className="link danger small" onClick={() => void api(`/api/hana/memory/${m.id}`, 'DELETE').then(reload)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
