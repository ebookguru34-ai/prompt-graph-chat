import { useRef, useState } from 'react';
import type { Graph } from './graph/types';
import { EXAMPLE_GRAPHS } from './graph/defaults';
import { listStores } from './graph/memory';
import { ProfilePanel } from './ProfilePanel';
import { CollectionsPanel, LorebookPanel } from './Knowledge';
import { saveLore } from './graph/lore';
import { blankCharacter, characterFromJson, characterFromPng, exportCharacter, newCharId, resizeImage, type Character } from './charData';

interface Props {
  characters: Character[]; setCharacters: (f: (c: Character[]) => Character[]) => void;
  currentGraph: Graph; onStartChat: (charId: string) => void; onClose: () => void; activeCharId?: string; koboldUrl: string;
}

export function Avatar({ c, size = 32 }: { c?: Character | null; size?: number }) {
  if (c?.avatar) return <img className="avatar" src={c.avatar} alt="" style={{ width: size, height: size }} />;
  return <span className="avatar ph" style={{ width: size, height: size, fontSize: size * 0.45 }}>{(c?.name || '?').slice(0, 1).toUpperCase()}</span>;
}

const download = (name: string, text: string) => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name.replace(/\W+/g, '-') + '.json'; a.click();
};

export function CharacterLibrary({ characters, setCharacters, currentGraph, onStartChat, onClose, activeCharId, koboldUrl }: Props) {
  const [editing, setEditing] = useState<Character | null>(null);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null), avRef = useRef<HTMLInputElement>(null);

  async function importFile(f: File) {
    try {
      let c: Character;
      if (f.type === 'image/png' || /\.png$/i.test(f.name)) { c = characterFromPng(new Uint8Array(await f.arrayBuffer())); c.avatar = await resizeImage(f); }
      else c = characterFromJson(JSON.parse(await f.text()));
      const book = c.lorebook; delete c.lorebook;
      if (book?.length) saveLore(book, c.id);
      setCharacters((cs) => [...cs, c]); setMsg('Imported ' + c.name + (book?.length ? ` with ${book.length} lorebook entries` : '')); setEditing(c);
    } catch (e) { setMsg('Import failed: ' + (e as Error).message); }
  }
  function save() {
    if (!editing) return;
    const c = { ...editing, name: editing.name.trim() || 'Unnamed', updatedAt: Date.now() };
    setCharacters((cs) => (cs.some((x) => x.id === c.id) ? cs.map((x) => (x.id === c.id ? c : x)) : [...cs, c])); setEditing(null);
  }
  const set = <K extends keyof Character>(k: K, v: Character[K]) => setEditing((e) => (e ? { ...e, [k]: v } : e));
  const graphValue = !editing?.graph ? '' : EXAMPLE_GRAPHS.some((g) => g.name === editing.graph!.name) ? 'ex:' + editing.graph.name : 'snap';

  return (
    <>
      <div className="panelhead"><b>{editing ? 'Edit character' : 'Characters'}</b><button className="icon x" title="Hide" onClick={onClose}>✕</button></div>
      {!editing && (<>
        <div className="row">
          <button className="primary" onClick={() => setEditing(blankCharacter())}>+ New</button>
          <button onClick={() => fileRef.current?.click()} title="Import our JSON or a SillyTavern/TavernAI card (.json or .png)">Import…</button>
          <input ref={fileRef} type="file" accept=".json,.png,application/json,image/png" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); }} />
        </div>
        {msg && <div className="muted">{msg}</div>}
        <div className="charlist">
          {characters.length === 0 && <div className="muted">No characters yet. Create one or import a SillyTavern card (PNG or JSON).</div>}
          {characters.map((c) => (
            <div key={c.id} className={'charitem' + (c.id === activeCharId ? ' active' : '')}>
              <Avatar c={c} size={40} />
              <div className="charinfo"><b>{c.name}</b><span className="muted">{(c.greeting || c.system).slice(0, 70)}</span>
                <div className="charbtns">
                  <button className="primary" onClick={() => onStartChat(c.id)}>Chat</button>
                  <button onClick={() => setEditing(c)}>Edit</button>
                  <button onClick={() => setCharacters((cs) => [...cs, { ...c, id: newCharId(), name: c.name + ' (copy)', updatedAt: Date.now() }])}>Duplicate</button>
                  <button onClick={() => download(c.name, exportCharacter(c))}>Export</button>
                  <button className="danger" onClick={() => { if (confirm(`Delete character "${c.name}"? Chats with it stay but use no character. Its memory stores are kept.`)) setCharacters((cs) => cs.filter((x) => x.id !== c.id)); }}>Delete</button>
                </div></div>
            </div>))}
        </div>
      </>)}
      {editing && (
        <section className="charform">
          <div className="row"><Avatar c={editing} size={64} />
            <div className="col">
              <button onClick={() => avRef.current?.click()}>Upload avatar…</button>
              {editing.avatar && <button className="link" onClick={() => set('avatar', undefined)}>Remove avatar</button>}
              <input ref={avRef} type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { try { set('avatar', await resizeImage(f)); } catch (er) { setMsg((er as Error).message); } } }} />
            </div></div>
          <label className="field col"><span>Name</span><input value={editing.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="field col"><span>System prompt / character sheet ({'{{char}}'} and {'{{user}}'} are replaced)</span>
            <textarea rows={8} value={editing.system} onChange={(e) => set('system', e.target.value)} /></label>
          <label className="field col"><span>Greeting (first message of a new chat)</span>
            <textarea rows={4} value={editing.greeting} onChange={(e) => set('greeting', e.target.value)} /></label>
          <label className="field col"><span>Example dialogue (optional, added under [Example dialogue])</span>
            <textarea rows={5} value={editing.examples} onChange={(e) => set('examples', e.target.value)} /></label>
          <label className="field col"><span>TTS voice override (blank = global voice, e.g. af_bella, bm_george)</span>
            <input value={editing.voice ?? ''} placeholder="(use global voice)" onChange={(e) => set('voice', e.target.value || undefined)} /></label>
          <label className="field col"><span>Default graph</span>
            <select value={graphValue} onChange={(e) => {
              const v = e.target.value;
              if (!v) set('graph', null);
              else if (v === 'snap-now') set('graph', JSON.parse(JSON.stringify(currentGraph)));
              else if (v.startsWith('ex:')) set('graph', JSON.parse(JSON.stringify(EXAMPLE_GRAPHS.find((g) => g.name === v.slice(3)))));
            }}>
              <option value="">Current editor graph</option>
              {EXAMPLE_GRAPHS.map((g) => <option key={g.name} value={'ex:' + g.name}>Example: {g.name}</option>)}
              {graphValue === 'snap' && <option value="snap">Saved copy: {editing.graph?.name}</option>}
              <option value="snap-now">Save a copy of the current editor graph ({currentGraph.name})</option>
            </select></label>
          <div className="muted">Memory stores for this character: {listStores(editing.id).join(', ') || 'none yet'} (kept separate from other characters).</div>
          <details className="profwrap"><summary>Dynamic profile (fields, values, history)</summary><ProfilePanel ns={editing.id} label={editing.name} /></details>
          <details className="profwrap"><summary>Lorebook (keyword world info)</summary><LorebookPanel key={editing.id} ns={editing.id} label={editing.name} /></details>
          <details className="profwrap"><summary>Documents (RAG collection)</summary><CollectionsPanel key={editing.id} ns={editing.id} label={editing.name} koboldUrl={koboldUrl} /></details>
          <div className="row"><button className="primary" onClick={save}>Save</button><button onClick={() => setEditing(null)}>Cancel</button></div>
        </section>)}
    </>
  );
}
