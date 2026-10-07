import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatAttachment, ChatMessage, ChatMode, ChatSendResponse, ChatState, HanaAction } from '@myday/shared';
import { api, ApiFail, useLoad } from '../../api';
import { useConfirm } from '../../components/Confirm';
import Markdown from '../../components/Markdown';
import { HanaFace } from '../../components/NavIcon';
import { useSession } from '../../session';
import { shrink } from '../health/ProgressPhotos';

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

const MAX_FILES = 4;
const ACCEPT = 'image/*,application/pdf,text/plain,text/csv,text/markdown,.txt,.csv,.md,.pdf';

/** A file being attached to the next message. */
interface Draft {
  key: string;
  name: string;
  mime: string;
  /** A local preview for photos. */
  preview: string | null;
  att: ChatAttachment | null;
  err: string | null;
}

/** Photos are re-encoded on the phone first (smaller, and the location data is dropped). */
async function upload(file: File): Promise<ChatAttachment> {
  let body: Blob = file;
  let type = file.type || 'application/octet-stream';
  if (file.type.startsWith('image/') && file.type !== 'image/gif') {
    try {
      body = await shrink(file);
      type = 'image/jpeg';
    } catch {
      /* a photo the browser can't redraw: send it as it is */
    }
  } else if (!file.type && /\.(txt|md|csv)$/i.test(file.name)) {
    type = file.name.toLowerCase().endsWith('.csv') ? 'text/csv' : file.name.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain';
  }
  const res = await fetch(`/api/chat/attachments?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': type, 'X-MyDay-Upload': '1' },
    body,
  });
  const out = (await res.json().catch(() => null)) as (ChatAttachment & { error?: string }) | null;
  if (!res.ok || !out || !out.id) throw new Error(out?.error ?? 'Couldn’t attach that');
  return out;
}

/** Ask Hana (grown-ups) and the homework tutor (kids + students) share this screen. */
export default function Chat({ mode }: { mode: ChatMode }) {
  const { me } = useSession();
  const { data, error, setData } = useLoad<ChatState>(`/api/chat/${mode}`);
  const [msg, setMsg] = useState('');
  // The message on its way: shown at once, and the Send button is off until it lands.
  const [pending, setPending] = useState<{ text: string; clientId: string; files: Draft[]; retryId?: number } | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // The household used today's Hana messages (Solo/Family): grown-ups get a way to unlimited.
  const [capped, setCapped] = useState(false);
  // Why Hana couldn't answer a message (by its id), shown under it until it's retried.
  const [failNote, setFailNote] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<number | null>(null);
  const [actions, setActions] = useState<HanaAction[]>([]);
  const confirm = useConfirm();
  // B3: /tutor?lecture=ID quizzes from one of the student's own lectures.
  const lectureId = mode === 'tutor' ? new URLSearchParams(window.location.search).get('lecture') : null;
  const end = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLFormElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const canAttach = mode === 'companion' && me.member?.kind === 'adult';

  // The message box grows with what's typed (CSS caps it at ~5 lines, then it scrolls inside).
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [msg, data !== null]);

  // Scroll only when a message is added (not on every refresh), so the page doesn't jump around.
  const count = (data?.history.length ?? 0) + (pending ? 1 : 0);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    if (count) void end.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  // The input bar is fixed to the bottom; the conversation leaves room for it (it grows with attachments).
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty('--send-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--send-h');
    };
  }, [data !== null]);

  // Local photo previews are freed when they're no longer shown.
  const previews = useRef(new Set<string>());
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

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
  const ready = drafts.filter((d) => d.att);
  const uploading = drafts.some((d) => !d.att && !d.err);

  const attach = (list: FileList | null): void => {
    const files = [...(list ?? [])].slice(0, Math.max(0, MAX_FILES - drafts.length));
    if (list && list.length > files.length) setErr(`Up to ${MAX_FILES} files per message`);
    for (const f of files) {
      const key = newClientId();
      const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : null;
      if (preview) previews.current.add(preview);
      setDrafts((d) => [...d, { key, name: f.name || 'Photo', mime: f.type, preview, att: null, err: null }]);
      upload(f).then(
        (att) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, att } : x))),
        (e: unknown) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, err: e instanceof Error ? e.message : 'Couldn’t attach that' } : x))),
      );
    }
    if (picker.current) picker.current.value = '';
  };

  /** Send (or retry: same clientId, so the server reuses the message instead of saving a copy). */
  const deliver = async (text: string, clientId: string, files: Draft[] = [], retryId?: number): Promise<void> => {
    if (pending) return; // one at a time — a second tap or Enter does nothing
    setPending({ text, clientId, files, retryId });
    setErr(null);
    setPicked(null);
    setFailNote(({ [clientId]: _gone, ...rest }) => rest);
    const attachmentIds = files.flatMap((f) => (f.att ? [f.att.id] : []));
    try {
      const r = await api<ChatSendResponse>(`/api/chat/${mode}`, 'POST', {
        message: text,
        clientId,
        ...(retryId ? { retryId } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(lectureId ? { lectureId: Number(lectureId) } : {}),
      });
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
        // It never reached the server (offline, or today's Hana messages are used up): put it back to send again.
        setErr(why);
        setCapped(e2 instanceof ApiFail && e2.code === 'hana_daily_limit');
        setMsg(text);
        setDrafts((d) => [...files, ...d]);
      }
    } finally {
      setPending(null);
    }
  };

  const send = (e: FormEvent): void => {
    e.preventDefault();
    const text = msg.trim();
    if ((!text && !ready.length) || pending || uploading) return;
    setMsg('');
    setDrafts([]);
    void deliver(text, newClientId(), ready);
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
    if (!(await confirm({ title: 'Clear this conversation?', body: 'Every message here is deleted. What Hana remembers about you stays (it’s listed at the top).', confirmLabel: 'Clear', danger: true }))) return;
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

  // When the keyboard opens, keep the latest message in view above the input.
  const onFocus = (): void => {
    window.setTimeout(() => void end.current?.scrollIntoView({ block: 'end' }), 350);
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
      {mode === 'companion' && <HanaKnows refreshKey={data.history.length} />}
      {lectureId && <p className="pill sun">Quiz mode: questions from your lecture</p>}
      {!data.available && <p className="warn">Hana isn’t set up yet — a grown-up needs to add the AI key on the server.</p>}
      <div className="bubbles" data-testid="chat-history">
        {data.history.length === 0 && !pending && <p className="muted small chat-empty">Say hi, or try “what’s on today?”</p>}
        {data.history.map((m, i) => {
          const mine = m.who === 'user';
          const firstOfRun = !mine && data.history[i - 1]?.who !== 'hana';
          const sendingThis = (pending?.clientId === m.clientId && m.clientId !== null) || (pending?.retryId !== undefined && pending.retryId === m.id);
          return (
            <div key={m.id} className={`msg ${mine ? 'me' : 'hana'}${m.failed && !sendingThis ? ' failed' : ''}`} data-testid={mine ? 'msg-me' : 'msg-hana'}>
              {!mine && (firstOfRun ? <HanaFace size={28} /> : <span className="face-gap" />)}
              <div className="msg-body">
                {m.attachments.length > 0 && <Attachments list={m.attachments} />}
                {/* Tap a message to show Delete (links inside Hana's replies still open normally). */}
                {(m.text || !m.attachments.length) && (
                  <div className={mine ? 'bubble me' : 'bubble hana'} onClick={(ev) => (ev.target as HTMLElement).closest('a') || setPicked(picked === m.id ? null : m.id)}>
                    {mine ? m.text : <Markdown text={m.text} />}
                  </div>
                )}
                {mine && m.failed && !sendingThis && (
                  <div className="msg-failed" role="alert" data-testid="msg-failed">
                    <span>{failNote[m.clientId ?? ''] ?? 'Hana couldn’t answer this one.'}</span>
                    <button className="link small" disabled={pending !== null} onClick={() => void deliver(m.text, m.clientId ?? newClientId(), [], m.clientId ? undefined : m.id)} data-testid="msg-retry">
                      Retry
                    </button>
                  </div>
                )}
                {(picked === m.id || (!m.text && m.attachments.length > 0)) && (
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
            {!data.history.some((m) => m.clientId === pending.clientId || m.id === pending.retryId) && (
              <div className="msg me sending">
                <div className="msg-body">
                  {pending.files.length > 0 && (
                    <div className="msg-files">
                      {pending.files.map((f) => (f.preview ? <img key={f.key} className="msg-photo" src={f.preview} alt={f.name} /> : <span key={f.key} className="file-chip">📄 {f.name}</span>))}
                    </div>
                  )}
                  {pending.text && <div className="bubble me">{pending.text}</div>}
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
        {err && <p className="error">{err}</p>}
        {capped && me.member?.kind === 'adult' && (
          <div className="card" data-testid="hana-upgrade">
            <b>Want more Hana?</b>
            <p className="small">Family+ has unlimited Hana for the whole household.</p>
            <a className="btn small" href="/billing">
              See Family+
            </a>
          </div>
        )}
        <div ref={end} className="chat-end" />
      </div>
      <form className="chat-send" onSubmit={send} ref={bar} data-testid="chat-bar">
        <div className="chat-send-in">
          {drafts.length > 0 && (
            <div className="draft-files" data-testid="chat-drafts">
              {drafts.map((d) => (
                <span key={d.key} className={`draft-file${d.err ? ' bad' : ''}`} data-testid="chat-draft" title={d.err ?? d.name}>
                  {d.preview ? <img src={d.preview} alt="" /> : <span aria-hidden="true">📄</span>}
                  <span className="draft-name">{d.err ?? (d.att ? d.name : 'Attaching…')}</span>
                  <button type="button" className="draft-x" aria-label={`Remove ${d.name}`} onClick={() => setDrafts((all) => all.filter((x) => x.key !== d.key))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="chat-send-row">
            {canAttach && (
              <>
                <button type="button" className="attach-btn" aria-label="Attach a photo or file" disabled={!data.available || drafts.length >= MAX_FILES} onClick={() => picker.current?.click()} data-testid="chat-attach">
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.4 11.1l-8.5 8.5a5.5 5.5 0 01-7.8-7.8l8.5-8.5a3.7 3.7 0 015.2 5.2l-8.5 8.5a1.8 1.8 0 01-2.6-2.6l7.8-7.8" />
                  </svg>
                </button>
                <input ref={picker} type="file" accept={ACCEPT} multiple hidden onChange={(e) => attach(e.target.files)} data-testid="chat-file" />
              </>
            )}
            <textarea
              ref={field}
              className="chat-box"
              rows={1}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends (Shift+Enter for a new line), like the one-line box it replaced.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  bar.current?.requestSubmit();
                }
              }}
              onFocus={onFocus}
              placeholder={copy.placeholder}
              maxLength={2000}
              disabled={!data.available}
              aria-label="Message Hana"
              enterKeyHint="send"
            />
            <button className="btn small" disabled={!data.available || pending !== null || uploading || (!msg.trim() && !ready.length)} data-testid="chat-send">
              {pending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

/** Photos and files sent with a message: photos as thumbnails (tap for full size), files as chips. */
function Attachments({ list }: { list: ChatAttachment[] }) {
  return (
    <div className="msg-files" data-testid="msg-files">
      {list.map((a) =>
        a.mime.startsWith('image/') ? (
          <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer">
            <img className="msg-photo" src={a.url} alt={a.name} loading="lazy" data-testid="msg-photo" />
          </a>
        ) : (
          <a key={a.id} className="file-chip" href={a.url} data-testid="msg-file">
            📄 {a.name}
          </a>
        ),
      )}
    </div>
  );
}

interface Knows {
  memories: Array<{ id: number; fact: string; at: string }>;
  reminders: Array<{ id: number; text: string; at: string }>;
}

/** What Hana remembers about you and the reminders she'll send — yours to see, correct and delete. */
function HanaKnows({ refreshKey }: { refreshKey: number }) {
  const { data, reload } = useLoad<Knows>(`/api/hana/memory?r=${refreshKey}`);
  const [editing, setEditing] = useState<{ id: number; fact: string } | null>(null);
  const [adding, setAdding] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!data) return null;
  const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const run = async (p: Promise<unknown>): Promise<void> => {
    setErr(null);
    try {
      await p;
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t save');
    }
  };
  const saveEdit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editing || !editing.fact.trim()) return;
    await run(api(`/api/hana/memory/${editing.id}`, 'PATCH', { fact: editing.fact.trim() }));
    setEditing(null);
  };
  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!adding.trim()) return;
    await run(api('/api/hana/memory', 'POST', { fact: adding.trim() }));
    setAdding('');
  };
  return (
    <details className="card hana-knows" data-testid="hana-knows">
      <summary>
        <b>Hana remembers ({data.memories.length})</b>
        {data.reminders.length > 0 && <span className="muted small"> · {data.reminders.length} reminder{data.reminders.length === 1 ? '' : 's'}</span>}
      </summary>
      <p className="muted small">What she keeps about you between conversations. Fix anything she got wrong, or tell her something to keep.</p>
      {data.memories.length > 0 && (
        <ul className="plain rows">
          {data.memories.map((m) => (
            <li key={m.id} data-testid="hana-memory">
              {editing?.id === m.id ? (
                <form className="inline mem-edit" onSubmit={(e) => void saveEdit(e)}>
                  <input value={editing.fact} onChange={(e) => setEditing({ id: m.id, fact: e.target.value })} maxLength={300} aria-label="What Hana remembers" autoFocus />
                  <button className="btn small" data-testid="hana-memory-save">
                    Save
                  </button>
                  <button type="button" className="link small" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span>{m.fact}</span>
                  <span className="mem-tools">
                    <button className="link small" onClick={() => setEditing({ id: m.id, fact: m.fact })} data-testid="hana-memory-edit">
                      Edit
                    </button>
                    <button className="link danger small" onClick={() => void run(api(`/api/hana/memory/${m.id}`, 'DELETE'))}>
                      Forget
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="inline" onSubmit={(e) => void add(e)}>
        <input value={adding} onChange={(e) => setAdding(e.target.value)} maxLength={300} placeholder="Something Hana should remember…" aria-label="Tell Hana something to remember" />
        <button className="btn small ghost" disabled={!adding.trim()} data-testid="hana-memory-add">
          Add
        </button>
      </form>
      {err && <p className="error small">{err}</p>}
      {data.reminders.length > 0 && (
        <>
          <h3 className="ing-head">Reminders coming up</h3>
          <ul className="plain rows">
            {data.reminders.map((r) => (
              <li key={r.id} data-testid="hana-reminder">
                <span>
                  {r.text} <small className="muted">· {when(r.at)}</small>
                </span>
                <button className="link danger small" onClick={() => void run(api(`/api/hana/reminders/${r.id}`, 'DELETE'))}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
