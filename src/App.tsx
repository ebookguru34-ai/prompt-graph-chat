import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chat, InstructTemplate, Message, Samplers, Settings } from './types';
import { DEFAULT_SAMPLERS, TEMPLATE_PRESETS } from './templates';
import { load, save, uid } from './storage';
import * as kobold from './kobold';
import { DEFAULT_PIPELINE, runPipeline, type PipelineContext, type TraceEntry } from './pipeline';
import { runGraph } from './graph/runner';
import { rollbackTurns, retagTurn } from './graph/profile'; // memory + profile rollback
import { DEFAULT_GRAPH } from './graph/defaults';
import { Editor } from './graph/Editor';
import type { Graph, NodeTrace } from './graph/types';
import { useIsMobile, usePanel } from './ui';
import { DEFAULT_TTS, SentenceStreamer, TtsPlayer, cleanForSpeech, splitSentences, type TtsSettings } from './tts';
import { TtsPanel } from './TtsPanel';
import { CharacterLibrary, Avatar } from './Characters';
import { characterSystemPrompt, substChar, type Character } from './charData';

const newChat = (): Chat => ({ id: uid(), title: 'New chat', messages: [], updatedAt: Date.now() });
const DEFAULT_SETTINGS: Settings = { koboldUrl: 'http://localhost:5001', useTokenCountApi: true, streaming: true, useGraph: true, userName: 'User' };

export default function App() {
  const [chats, setChats] = useState<Chat[]>(() => load('chats', [newChat()]));
  const [activeId, setActiveId] = useState<string>(() => load('activeId', ''));
  const [systemPrompt, setSystemPrompt] = useState(() => load('systemPrompt', 'You are a helpful assistant.'));
  const [templateName, setTemplateName] = useState(() => load('templateName', 'ChatML'));
  const [customTpl, setCustomTpl] = useState<InstructTemplate>(() => load('customTpl', { ...TEMPLATE_PRESETS[0], name: 'Custom' }));
  const [samplers, setSamplers] = useState<Samplers>(() => load('samplers', DEFAULT_SAMPLERS));
  const [samplerPresets, setSamplerPresets] = useState<Record<string, Samplers>>(() => load('samplerPresets', {}));
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...load('settings', DEFAULT_SETTINGS) }));
  const [graph, setGraphState] = useState<Graph>(() => load('graph', DEFAULT_GRAPH));
  const setGraph = (f: (g: Graph) => Graph) => setGraphState(f);
  const [nodeTrace, setNodeTrace] = useState<NodeTrace[]>([]);
  const [view, setView] = useState<'chat' | 'editor'>(() => load('view', 'chat'));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [preview, setPreview] = useState<{ prompt: string; tokens: number; method: string; dropped: number; label: string }>();
  const [panel, setPanel] = useState<'samplers' | 'template' | 'settings'>('samplers');
  const [showRaw, setShowRaw] = useState(true);
  const [showTrace, setShowTrace] = useState(false);
  const [conn, setConn] = useState('');
  const mobile = useIsMobile();
  const [chatsOpen, setChatsOpen] = usePanel('chats', mobile);
  const [rightOpen, setRightOpen] = usePanel('right', mobile);
  const [sysOpen, setSysOpen] = useState<boolean>(() => load('sysOpen', true));
  useEffect(() => { save('sysOpen', sysOpen); }, [sysOpen]);
  const [libOpen, setLibOpen] = usePanel('library', mobile, false);
  const [picking, setPicking] = useState(false);
  const [characters, setCharactersState] = useState<Character[]>(() => load('characters', []));
  const setCharacters = (f: (c: Character[]) => Character[]) => setCharactersState(f);
  useEffect(() => { save('characters', characters); }, [characters]);
  const closeDrawers = () => { setChatsOpen(false); setRightOpen(false); setLibOpen(false); };
  const only = (which: 'chats' | 'right' | 'lib') => { if (!mobile) return; if (which !== 'chats') setChatsOpen(false); if (which !== 'right') setRightOpen(false); if (which !== 'lib') setLibOpen(false); };
  const [tts, setTtsState] = useState<TtsSettings>(() => ({ ...DEFAULT_TTS, ...load('tts', DEFAULT_TTS) }));
  const setTts = (f: (t: TtsSettings) => TtsSettings) => setTtsState(f);
  useEffect(() => { save('tts', tts); }, [tts]);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const ttsRef = useRef({ s: tts, voice: tts.voice });
  const playerRef = useRef<TtsPlayer | null>(null);
  if (!playerRef.current) playerRef.current = new TtsPlayer(() => ttsRef.current, (st) => { setSpeakingId(st.playingId); if (st.error) setError('TTS: ' + st.error); });
  const player = playerRef.current;
  /** Speak a whole message now (speaker button / non-streamed replies). */
  function speakMessage(id: string, text: string) {
    const [chunks] = splitSentences(cleanForSpeech(text, tts), true);
    if (!chunks.length) return;
    player.unlock(); player.speak(id, chunks);
  }
  const [armed, setArmed] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState('');
  useEffect(() => { if (!toast) return; const h = setTimeout(() => { setToast(''); }, 4000); return () => { clearTimeout(h); }; }, [toast]);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const chat = chats.find((c) => c.id === activeId) ?? chats[0];
  const activeChar = chat?.characterId ? characters.find((c) => c.id === chat.characterId) ?? null : null;
  const userName = settings.userName?.trim() || 'User';
  const effectiveSystem = activeChar ? characterSystemPrompt(activeChar, userName) : systemPrompt;
  const runGraphDef = activeChar?.graph ?? graph;
  ttsRef.current = { s: tts, voice: activeChar?.voice?.trim() || tts.voice };
  const template = templateName === 'Custom' ? customTpl : TEMPLATE_PRESETS.find((t) => t.name === templateName) ?? TEMPLATE_PRESETS[0];

  useEffect(() => { save('chats', chats); }, [chats]);
  useEffect(() => { save('activeId', chat?.id); }, [chat?.id]);
  useEffect(() => { save('systemPrompt', systemPrompt); }, [systemPrompt]);
  useEffect(() => { save('templateName', templateName); }, [templateName]);
  useEffect(() => { save('customTpl', customTpl); }, [customTpl]);
  useEffect(() => { save('samplers', samplers); }, [samplers]);
  useEffect(() => { save('samplerPresets', samplerPresets); }, [samplerPresets]);
  useEffect(() => { save('settings', settings); }, [settings]);
  useEffect(() => { save('graph', graph); }, [graph]);
  useEffect(() => { save('view', view); }, [view]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat?.messages]);

  const updateChat = useCallback((id: string, fn: (c: Chat) => Chat) =>
    setChats((cs) => cs.map((c) => (c.id === id ? { ...fn(c), updatedAt: Date.now() } : c))), []);

  const baseCtx = (history: Message[]): PipelineContext => ({ systemPrompt: effectiveSystem, history, template, samplers, settings,
    armed, charName: activeChar?.name, greeting: activeChar ? substChar(activeChar.greeting, activeChar.name, userName) : undefined, memNs: activeChar?.id });
  /** New chat, optionally with a character: its greeting becomes the first assistant message. */
  function startChat(charId?: string) {
    const ch = charId ? characters.find((c) => c.id === charId) : undefined;
    const c: Chat = { ...newChat(), characterId: ch?.id, title: ch ? ch.name : 'New chat' };
    const g = ch ? substChar(ch.greeting, ch.name, userName).trim() : '';
    if (g) c.messages = [{ id: uid(), role: 'assistant', content: g }];
    setChats((cs) => [c, ...cs]); setActiveId(c.id); setPicking(false); setView('chat');
    if (mobile) closeDrawers();
  }

  // Live preview of "next request" prompt (dry run, debounced)
  useEffect(() => {
    if (busy || !chat) return;
    const h = setTimeout(async () => {
      const hist = input.trim() ? [...chat.messages, { id: 'pending', role: 'user' as const, content: input }] : chat.messages;
      try {
        const { ctx } = await execute({ ...baseCtx(hist), dryRun: true }, false);
        setPreview({ prompt: ctx.prompt ?? '', tokens: ctx.promptTokens ?? 0, method: ctx.tokenMethod ?? '', dropped: ctx.droppedMessages ?? 0, label: 'next request (preview)' });
      } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, chat?.messages, systemPrompt, template, samplers, settings, busy, graph, activeChar]);

  const toTrace = (t: NodeTrace[]): TraceEntry[] => t.map((n) => ({ step: n.label + ' (' + n.nodeId + ')', input: n.inputs, output: n.outputs, durationMs: n.durationMs, error: n.error, skipped: n.skipped }));
  async function execute(ctx: PipelineContext, live: boolean) {
    if (settings.useGraph) {
      const r = await runGraph(runGraphDef, ctx, live ? (t) => { setNodeTrace(t); setTrace(toTrace(t)); } : undefined);
      return r;
    }
    return runPipeline(DEFAULT_PIPELINE, ctx, live ? setTrace : undefined);
  }
  /** Run the graph and append the reply. `runNow`: Manual Trigger "run now" pass (no new user message);
   *  if it produces no chat output the placeholder is dropped and its memory/profile writes are re-tagged
   *  to the last message, so rollback still works. */
  async function runGeneration(chatId: string, history: Message[], opts: { runNow?: string } = {}) {
    const runArmed = opts.runNow ? { ...armed, [opts.runNow]: true } : armed;
    const fired: string[] = [];
    setError(''); setBusy(true);
    const asstId = uid();
    updateChat(chatId, (c) => ({ ...c, messages: [...history, { id: asstId, role: 'assistant', content: '' }] }));
    const ac = new AbortController(); abortRef.current = ac;
    const live = tts.enabled && tts.autoPlay;
    let streamed = false;
    const streamer = live ? new SentenceStreamer(tts, (sentence) => { player.enqueue(sentence); }) : null;
    if (live) player.begin(asstId);
    const onToken = (t: string) => { streamed = true; streamer?.push(t); updateChat(chatId, (c) => ({ ...c, messages: c.messages.map((m) => m.id === asstId ? { ...m, content: m.content + t } : m) })); };
    try {
      const { ctx } = await execute({ ...baseCtx(history), armed: runArmed, onTriggerFired: (id) => { fired.push(id); }, signal: ac.signal, onToken, turnId: asstId }, true);
      if (fired.length) setArmed((a) => { const n = { ...a }; for (const id of fired) delete n[id]; return n; }); // disarm after firing
      if (live && !ac.signal.aborted) {
        if (streamed) streamer!.end(); else { const [chunks] = splitSentences(cleanForSpeech(ctx.output ?? '', tts), true); chunks.forEach((c) => { player.enqueue(c); }); }
        player.finish();
      } else if (live) player.stop();
      setPreview({ prompt: ctx.prompt ?? '', tokens: ctx.promptTokens ?? 0, method: ctx.tokenMethod ?? '', dropped: ctx.droppedMessages ?? 0, label: 'last request (sent)' });
      if (opts.runNow && !(ctx.output ?? '').trim()) {
        updateChat(chatId, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== asstId) }));
        retagTurn(asstId, history[history.length - 1]?.id);
        setToast('Graph ran (no chat output): memory/profile updated.');
      } else updateChat(chatId, (c) => ({ ...c, messages: c.messages.map((m) => m.id === asstId ? { ...m, content: ctx.output ?? '' } : m) }));
    } catch (e) {
      setError((e as Error).message); player.stop();
      updateChat(chatId, (c) => ({ ...c, messages: c.messages.filter((m) => !(m.id === asstId && !m.content)) }));
    } finally { setBusy(false); abortRef.current = null; }
  }

  function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || busy || !chat) return;
    player.stop(); if (tts.enabled) player.unlock(); // unlock audio inside the tap (mobile)
    const msg: Message = { id: uid(), role: 'user', content: text };
    const history = [...chat.messages, msg];
    if (chat.title === 'New chat') updateChat(chat.id, (c) => ({ ...c, title: msg.content.slice(0, 40) }));
    if (override === undefined) setInput(''); setNodeTrace([]); runGeneration(chat.id, history);
  }
  const triggers = settings.useGraph ? runGraphDef.nodes.filter((n) => n.type === 'manual_trigger') : [];
  function pressTrigger(id: string, behavior: string) {
    if (behavior === 'run now') {
      if (busy || !chat) return;
      player.stop(); if (tts.enabled) player.unlock(); setNodeTrace([]);
      runGeneration(chat.id, chat.messages, { runNow: id });
    } else setArmed((a) => ({ ...a, [id]: !a[id] }));
  }
  function regenerate() {
    if (busy || !chat) return;
    const msgs = [...chat.messages];
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
    if (!msgs.length) return;
    player.stop(); if (tts.enabled) player.unlock();
    rollbackTurns(chat.messages.slice(msgs.length).map((m) => m.id));
    runGeneration(chat.id, msgs);
  }
  /** Delete a message and everything after it; roll back memory written by removed replies. */
  function deleteFrom(id: string) {
    if (busy || !chat) return;
    const i = chat.messages.findIndex((m) => m.id === id); if (i < 0) return;
    player.stop();
    rollbackTurns(chat.messages.slice(i).map((m) => m.id));
    updateChat(chat.id, (c) => ({ ...c, messages: c.messages.slice(0, i) }));
  }
  /** Edit a user message and resend: later turns are removed and their memory rolled back first. */
  function editResend(id: string) {
    if (busy || !chat) return;
    const i = chat.messages.findIndex((m) => m.id === id); if (i < 0) return;
    const old = chat.messages[i];
    const text = window.prompt('Edit message', old.content);
    if (text === null || !text.trim()) return;
    player.stop(); if (tts.enabled) player.unlock();
    rollbackTurns(chat.messages.slice(i).map((m) => m.id));
    const history = [...chat.messages.slice(0, i), { ...old, content: text.trim() }];
    setNodeTrace([]); runGeneration(chat.id, history);
  }
  async function stop() { player.stop(); abortRef.current?.abort(); await kobold.abort(settings.koboldUrl); }
  async function testConn() {
    setConn('Testing…');
    try { setConn('✅ Connected: ' + (await kobold.getModel(settings.koboldUrl))); }
    catch (e) { setConn('❌ ' + (e as Error).message); }
  }
  const setS = <K extends keyof Samplers>(k: K, v: Samplers[K]) => setSamplers((s) => ({ ...s, [k]: v }));
  const num = (k: keyof Samplers, step: number) => (
    <label className="field" key={k}><span>{k}</span>
      <input type="number" step={step} value={samplers[k] as number} onChange={(e) => setS(k, Number(e.target.value) as never)} /></label>);

  const budget = samplers.max_context_length - samplers.max_length;

  return (
    <div className="shell">
    <nav className="topnav">
      {view === 'chat' && <button className={'icon' + (chatsOpen ? ' on' : '')} title={(chatsOpen ? 'Hide' : 'Show') + ' chat list'} aria-label="Toggle chat list"
        onClick={() => { only('chats'); setChatsOpen((o) => !o); }}>☰</button>}
      {view === 'chat' && <button className={'icon' + (libOpen ? ' on' : '')} title={(libOpen ? 'Hide' : 'Show') + ' character library'} aria-label="Toggle character library"
        onClick={() => { only('lib'); setLibOpen((o) => !o); }}>🎭</button>}
      <span className="title">Prompt Graph Chat</span>
      <div className="seg">
        <button className={view === 'chat' ? 'active' : ''} onClick={() => { setView('chat'); }}>💬<span className="lbl"> Chat</span></button>
        <button className={view === 'editor' ? 'active' : ''} onClick={() => { closeDrawers(); setView('editor'); }}>🧩<span className="lbl"> Graph editor</span></button>
      </div>
      <span className="spacer" />
      <label className="check graphtoggle" title={'Chat runs graph: ' + (settings.useGraph ? graph.name : 'built-in pipeline')}><input type="checkbox" checked={!!settings.useGraph} onChange={(e) => setSettings((s) => ({ ...s, useGraph: e.target.checked }))} /><span className="lbl">Chat runs graph: <b>{settings.useGraph ? runGraphDef.name : 'built-in pipeline'}</b></span><span className="sm">Graph</span></label>
      {view === 'chat' && <button className={'icon' + (rightOpen ? ' on' : '')} title={(rightOpen ? 'Hide' : 'Show') + ' prompt & settings panel'} aria-label="Toggle settings panel"
        onClick={() => { only('right'); setRightOpen((o) => !o); }}>⚙</button>}
    </nav>
    {view === 'editor' && <Editor memNs={activeChar?.id} memLabel={activeChar?.name} mobile={mobile} graph={graph} setGraph={setGraph} trace={nodeTrace} busy={busy} onTestRun={(t) => send(t)} />}
    {view === 'editor' && error && <div className="error">⚠ {error}</div>}
    <div className={'app' + (mobile ? ' mobile' : '')} style={view === 'chat' ? undefined : { display: 'none' }}>
      {mobile && (chatsOpen || rightOpen || libOpen) && <div className="backdrop" onClick={closeDrawers} />}
      <aside className={'sidebar drawer left' + (chatsOpen ? ' open' : ' closed')}>
        <div className="panelhead"><b>Chats</b><button className="icon x" title="Hide" onClick={() => setChatsOpen(false)}>✕</button></div>
        <button className="primary" onClick={() => { if (characters.length) setPicking((p) => !p); else startChat(); }}>+ New chat</button>
        {picking && (
          <div className="picker">
            <div className="muted">Start a chat with…</div>
            <button className="pickitem" onClick={() => startChat()}><Avatar c={null} size={28} /> No character</button>
            {characters.map((ch) => <button key={ch.id} className="pickitem" onClick={() => startChat(ch.id)}><Avatar c={ch} size={28} /> {ch.name}</button>)}
          </div>)}
        <div className="chatlist">
          {[...chats].sort((a, b) => b.updatedAt - a.updatedAt).map((c) => (
            <div key={c.id} className={'chatitem' + (c.id === chat?.id ? ' active' : '')} onClick={() => { setActiveId(c.id); if (mobile) setChatsOpen(false); }}>
              {c.characterId && <Avatar c={characters.find((x) => x.id === c.characterId)} size={22} />}<span>{c.title}</span>
              <button className="x" title="Delete" onClick={(e) => { e.stopPropagation();
                setChats((cs) => { const r = cs.filter((x) => x.id !== c.id); return r.length ? r : [newChat()]; }); }}>×</button>
            </div>))}
        </div>
      </aside>

      <aside className={'library drawer left' + (libOpen ? ' open' : ' closed')}>
        <CharacterLibrary characters={characters} setCharacters={setCharacters} currentGraph={graph} activeCharId={activeChar?.id}
          onStartChat={(id) => startChat(id)} onClose={() => setLibOpen(false)} />
      </aside>

      <main className="main">
        {activeChar && (
          <div className="charheader"><Avatar c={activeChar} size={36} /><div><b>{activeChar.name}</b>
            <div className="muted">Character prompt in use{activeChar.graph ? ' · graph: ' + activeChar.graph.name : ''} · memory: own stores</div></div>
            <span className="spacer" /><button className="link" onClick={() => { only('lib'); setLibOpen(true); }}>Library</button></div>)}
        {!activeChar && <div className={'sysprompt' + (sysOpen ? '' : ' collapsed')}>
          <button className="link sp-toggle" onClick={() => setSysOpen((o) => !o)}>{sysOpen ? '▾' : '▸'} System prompt{!sysOpen && systemPrompt ? <span className="muted"> — {systemPrompt.slice(0, 60)}</span> : null}</button>
          {sysOpen && <textarea rows={2} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />}
        </div>}
        <div className="messages">
          {chat?.messages.length === 0 && <div className="empty">Send a message to start. Template: {template.name}</div>}
          {chat?.messages.map((m) => (
            <div key={m.id} className={'msg ' + m.role}>
              <div className="role">{m.role === 'assistant' && activeChar ? <><Avatar c={activeChar} size={20} /> {activeChar.name}</> : m.role}
                {tts.enabled && m.role === 'assistant' && m.content && <button className={'link speak' + (speakingId === m.id ? ' on' : '')} title={speakingId === m.id ? 'Stop' : 'Read aloud'}
                  aria-label={speakingId === m.id ? 'Stop speaking' : 'Read aloud'} onClick={() => { if (speakingId === m.id) player.stop(); else speakMessage(m.id, m.content); }}>{speakingId === m.id ? '⏹' : '🔊'}</button>}
                {!busy && <span className="msgactions">
                  {m.role === 'user' && <button className="link" title="Edit and resend" onClick={() => editResend(m.id)}>edit</button>}
                  <button className="link" title="Delete this and later messages" onClick={() => deleteFrom(m.id)}>delete</button>
                </span>}</div>
              <div className="content">{m.content || (busy ? '…' : '')}</div>
            </div>))}
          <div ref={endRef} />
        </div>
        {error && <div className="error">⚠ {error}</div>}
        {!!triggers.length && (
          <div className="triggerbar">
            {triggers.map((n) => { const beh = String(n.config.behavior ?? 'arm for next message'); const on = !!armed[n.id];
              return <button key={n.id} className={'trigger' + (on ? ' armed' : '') + (beh === 'run now' ? ' now' : '')} disabled={beh === 'run now' && busy}
                title={beh === 'run now' ? 'Run the graph now (no new message)' : on ? 'Armed for the next message (tap to disarm)' : 'Arm for the next message'}
                onClick={() => pressTrigger(n.id, beh)}>{beh === 'run now' ? '▶' : on ? '●' : '○'} {String(n.config.label || 'Trigger')}</button>; })}
          </div>)}
        {toast && <div className="toast" onClick={() => setToast('')}>{toast}</div>}
        <div className="composer">
          <textarea rows={mobile ? 1 : 3} placeholder={mobile ? 'Message' : 'Message (Enter to send, Shift+Enter newline)'} value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !mobile) { e.preventDefault(); send(); } }} />
          <div className="actions">
            {busy ? <button className="danger" onClick={stop}>Stop</button> : <button className="primary" onClick={() => send()}>Send</button>}
            <button onClick={regenerate} title="Regenerate last reply" disabled={busy || !chat?.messages.some((m) => m.role === 'user')}>Regenerate</button>
          </div>
        </div>
        <div className="statusbar">
          <span className={preview && preview.tokens > budget ? 'warn' : ''}>
            Prompt: {preview?.tokens ?? 0} tok<span className="lbl"> ({preview?.method === 'api' ? 'tokencount API' : 'chars/4 est.'})</span> / {budget}<span className="lbl"> budget (ctx {samplers.max_context_length} − gen {samplers.max_length})</span>
          </span>
          {!!preview?.dropped && <span className="warn">Trimmed {preview.dropped} oldest message(s)</span>}
          <span className="spacer" />
          <button className="link" onClick={() => setShowRaw((v) => !v)}>{showRaw ? 'Hide' : 'Show'} raw prompt</button>
          <button className="link" onClick={() => setShowTrace((v) => !v)}>{showTrace ? 'Hide' : 'Show'} trace</button>
        </div>
        {showTrace && (
          <div className="trace">
            {trace.length === 0 && <div className="muted">No run yet.</div>}
            {trace.map((t, i) => (
              <details key={i} className={t.error ? 'err' : ''}>
                <summary>{t.step} — {t.skipped ? 'skipped' : `${t.durationMs.toFixed(1)} ms`}{t.error ? ` — ERROR: ${t.error}` : ''}</summary>
                <div className="io"><div><b>input</b><pre>{JSON.stringify(t.input, null, 2)}</pre></div>
                  <div><b>output</b><pre>{JSON.stringify(t.output, null, 2)}</pre></div></div>
              </details>))}
          </div>)}
      </main>

      <aside className={'right drawer rightside' + (rightOpen ? ' open' : ' closed')}>
        <div className="panelhead"><b>Prompt &amp; settings</b><button className="icon x" title="Hide" onClick={() => setRightOpen(false)}>✕</button></div>
        {showRaw && (
          <section className="raw">
            <h3>Raw prompt <small>{preview?.label}</small></h3>
            <pre>{preview?.prompt}</pre>
          </section>)}
        <div className="tabs">
          {(['samplers', 'template', 'settings'] as const).map((p) => (
            <button key={p} className={panel === p ? 'active' : ''} onClick={() => setPanel(p)}>{p}</button>))}
        </div>
        {panel === 'samplers' && (
          <section>
            {num('temperature', 0.05)}{num('top_p', 0.01)}{num('top_k', 1)}{num('min_p', 0.01)}{num('rep_pen', 0.01)}
            {num('max_length', 16)}{num('max_context_length', 256)}
            <label className="field col"><span>extra stop sequences (one per line, \n allowed)</span>
              <textarea rows={3} value={samplers.stop_sequence.map((s) => s.replace(/\n/g, '\\n')).join('\n')}
                onChange={(e) => setS('stop_sequence', e.target.value.split('\n').filter(Boolean).map((s) => s.replace(/\\n/g, '\n')))} /></label>
            <div className="muted">Template stops also applied: {template.stop.join('  ')}</div>
            <h4>Presets</h4>
            <div className="row">
              <button onClick={() => { const n = prompt('Preset name?'); if (n) setSamplerPresets((p) => ({ ...p, [n]: samplers })); }}>Save as…</button>
              <button onClick={() => setSamplers(DEFAULT_SAMPLERS)}>Reset</button>
            </div>
            {Object.keys(samplerPresets).map((n) => (
              <div key={n} className="row preset"><span>{n}</span>
                <button onClick={() => setSamplers(samplerPresets[n])}>Load</button>
                <button onClick={() => setSamplerPresets((p) => { const c = { ...p }; delete c[n]; return c; })}>Delete</button></div>))}
          </section>)}
        {panel === 'template' && (
          <section>
            <label className="field"><span>Instruct template</span>
              <select value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
                {[...TEMPLATE_PRESETS.map((t) => t.name), 'Custom'].map((n) => <option key={n}>{n}</option>)}</select></label>
            {templateName !== 'Custom' && <button onClick={() => { setCustomTpl({ ...template, name: 'Custom' }); setTemplateName('Custom'); }}>Copy to Custom</button>}
            {(['systemPrefix', 'systemSuffix', 'userPrefix', 'userSuffix', 'assistantPrefix', 'assistantSuffix'] as const).map((k) => (
              <label key={k} className="field col"><span>{k}</span>
                <textarea rows={2} disabled={templateName !== 'Custom'} value={template[k]}
                  onChange={(e) => setCustomTpl((t) => ({ ...t, [k]: e.target.value }))} /></label>))}
            <label className="field col"><span>stop sequences (one per line)</span>
              <textarea rows={2} disabled={templateName !== 'Custom'} value={template.stop.join('\n')}
                onChange={(e) => setCustomTpl((t) => ({ ...t, stop: e.target.value.split('\n').filter(Boolean) }))} /></label>
          </section>)}
        {panel === 'settings' && (
          <section>
            <label className="field col"><span>Your name ({'{{user}}'} in character sheets &amp; greetings)</span>
              <input value={settings.userName ?? ''} placeholder="User" onChange={(e) => setSettings((s) => ({ ...s, userName: e.target.value }))} /></label>
            <label className="field col"><span>KoboldCPP URL</span>
              <input value={settings.koboldUrl} onChange={(e) => setSettings((s) => ({ ...s, koboldUrl: e.target.value }))} /></label>
            <button onClick={testConn}>Test connection</button>
            {conn && <div className={conn.startsWith('❌') ? 'error' : 'ok'}>{conn}</div>}
            <label className="check"><input type="checkbox" checked={settings.streaming} onChange={(e) => setSettings((s) => ({ ...s, streaming: e.target.checked }))} /> Streaming (falls back automatically)</label>
            <label className="check"><input type="checkbox" checked={settings.useTokenCountApi} onChange={(e) => setSettings((s) => ({ ...s, useTokenCountApi: e.target.checked }))} /> Use tokencount API (else chars/4)</label>
            <div className="muted">Requests go via the local proxy at /kobold/* which forwards to this URL.</div>
            <TtsPanel tts={tts} setTts={setTts} testing={speakingId === 'tts-test'} charName={activeChar?.name} charVoice={activeChar?.voice}
              onTest={() => { if (speakingId === 'tts-test') player.stop(); else speakMessage('tts-test', activeChar ? `Hello, I am ${activeChar.name}. This is my voice.` : 'Hello! This is a test of local text to speech.'); }} />
          </section>)}
      </aside>
    </div>
    </div>
  );
}
