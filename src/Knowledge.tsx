import { useRef, useState } from 'react';
import { blankEntry, exportLorebook, loadLore, parseLorebook, saveLore, scanLore, type LoreEntry } from './graph/lore';
import { addDoc, dropVectors, embeddedCount, loadDocs, saveDocs, type RagDoc } from './graph/rag';
import { cachedEmbeddings } from './graph/search';
import * as kobold from './kobold';

const download = (name: string, text: string) => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name.replace(/\W+/g, '-') + '.json'; a.click();
};

/** Lorebook editor for one namespace (character id, or undefined = global). */
export function LorebookPanel({ ns, label }: { ns?: string; label: string }) {
  const [entries, setEntries] = useState<LoreEntry[]>(() => loadLore(ns));
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState(''); const [test, setTest] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const put = (next: LoreEntry[]) => { setEntries(next); saveLore(next, ns); };
  const upd = (id: string, p: Partial<LoreEntry>) => put(entries.map((e) => (e.id === id ? { ...e, ...p } : e)));
  async function importFile(f: File) {
    try { const got = parseLorebook(JSON.parse(await f.text())); put([...entries, ...got]); setMsg(`Imported ${got.length} entries from ${f.name}`); }
    catch (e) { setMsg('Import failed: ' + (e as Error).message); }
  }
  const scan = test.trim() ? scanLore(test, ns, { scope: ns ? 'character' : 'global', depth: 0, budget: 0, header: '', joiner: '\n' }) : null;
  return (
    <section className="lore">
      <h4>Lorebook — {label} <small className="muted">pgc.lore.{ns || '_global'} · {entries.length} entries</small></h4>
      <div className="row">
        <button className="primary" onClick={() => { const e = blankEntry(); put([...entries, e]); setOpen(e.id); }}>+ Entry</button>
        <button onClick={() => fileRef.current?.click()} title="SillyTavern world info JSON, a V2/V3 card JSON with character_book, or our export">Import…</button>
        <button disabled={!entries.length} onClick={() => download('lorebook-' + label, exportLorebook(entries, label))}>Export</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); }} />
      </div>
      {msg && <div className="muted">{msg}</div>}
      {!entries.length && <div className="muted">No entries. An entry is injected when one of its keys appears in the recent chat (or always, if “always on”).</div>}
      <div className="lorelist">
        {[...entries].sort((a, b) => b.priority - a.priority).map((e) => (
          <div key={e.id} className={'loreitem' + (e.enabled ? '' : ' off')}>
            <div className="lorehead" onClick={() => setOpen(open === e.id ? null : e.id)}>
              <input type="checkbox" checked={e.enabled} title="Enabled" onClick={(ev) => ev.stopPropagation()} onChange={(ev) => upd(e.id, { enabled: ev.target.checked })} />
              <b>{e.title || '(untitled)'}</b>{e.constant && <span className="tag">always</span>}
              <span className="muted keys">{e.keys.join(', ') || (e.constant ? '' : 'no keys')}</span><span className="muted">p{e.priority}</span>
            </div>
            {open === e.id && (
              <div className="loreform">
                <label className="field col"><span>Title</span><input value={e.title} onChange={(ev) => upd(e.id, { title: ev.target.value })} /></label>
                <label className="field col"><span>Keys (comma separated; /regex/i allowed)</span>
                  <input value={e.keys.join(', ')} onChange={(ev) => upd(e.id, { keys: ev.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></label>
                <label className="field col"><span>Content</span><textarea rows={5} value={e.content} onChange={(ev) => upd(e.id, { content: ev.target.value })} /></label>
                <div className="row wrap">
                  <label className="field"><span>Priority</span><input type="number" value={e.priority} onChange={(ev) => upd(e.id, { priority: Number(ev.target.value) || 0 })} /></label>
                  <label className="check"><input type="checkbox" checked={e.constant} onChange={(ev) => upd(e.id, { constant: ev.target.checked })} /> Always on</label>
                  <label className="check"><input type="checkbox" checked={e.caseSensitive} onChange={(ev) => upd(e.id, { caseSensitive: ev.target.checked })} /> Case-sensitive</label>
                  <label className="check"><input type="checkbox" checked={e.wholeWord} onChange={(ev) => upd(e.id, { wholeWord: ev.target.checked })} /> Whole word</label>
                </div>
                <button className="danger" onClick={() => { if (confirm(`Delete entry "${e.title}"?`)) put(entries.filter((x) => x.id !== e.id)); }}>Delete entry</button>
              </div>)}
          </div>))}
      </div>
      <label className="field col"><span>Test: which entries fire for this text?</span><input value={test} placeholder="e.g. we walk to the old forge" onChange={(e) => setTest(e.target.value)} /></label>
      {scan && <pre className="mini">{scan.fired.map((f) => `✓ ${f.title}: ${f.reason}`).join('\n') || '(nothing fires)'}</pre>}
    </section>
  );
}

/** Document collection manager (RAG) for one namespace. */
export function CollectionsPanel({ ns, label, koboldUrl }: { ns?: string; label: string; koboldUrl: string }) {
  const [docs, setDocs] = useState<RagDoc[]>(() => loadDocs(ns));
  const [size, setSize] = useState(800); const [overlap, setOverlap] = useState(100);
  const [paste, setPaste] = useState(''); const [pname, setPname] = useState('');
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false); const [, force] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const reload = () => setDocs(loadDocs(ns));
  async function importFiles(fs: FileList) {
    let n = 0; for (const f of Array.from(fs)) { addDoc(ns, f.name, await f.text(), size, overlap); n++; }
    reload(); setMsg(`Added ${n} document(s). Click “Embed” to compute vectors (or they are computed on first use).`);
  }
  async function embed(list: RagDoc[], fresh: boolean) {
    setBusy(true); setMsg('Embedding…');
    try {
      for (const d of list) { if (fresh) dropVectors(d); await cachedEmbeddings(d.chunks, (t) => kobold.embeddings(koboldUrl, t)); }
      setMsg('✅ Embedded ' + list.reduce((n, d) => n + d.chunks.length, 0) + ' chunks');
    } catch (e) { setMsg('❌ Embeddings failed: ' + (e as Error).message + ' (RAG falls back to keyword search)'); }
    setBusy(false); force((x) => x + 1);
  }
  return (
    <section className="lore">
      <h4>Documents — {label} <small className="muted">pgc.rag.{ns || '_global'}</small></h4>
      <div className="row wrap">
        <label className="field"><span>Chunk size (chars)</span><input type="number" value={size} onChange={(e) => setSize(Number(e.target.value) || 800)} /></label>
        <label className="field"><span>Overlap</span><input type="number" value={overlap} onChange={(e) => setOverlap(Number(e.target.value) || 0)} /></label>
      </div>
      <div className="row">
        <button className="primary" onClick={() => fileRef.current?.click()}>Import .txt / .md…</button>
        <input ref={fileRef} type="file" multiple accept=".txt,.md,.markdown,text/plain,text/markdown" hidden onChange={(e) => { const f = e.target.files; if (f?.length) importFiles(f).finally(() => { e.target.value = ''; }); }} />
        <button disabled={busy || !docs.length} onClick={() => embed(docs, false)}>Embed all</button>
      </div>
      <details><summary>Paste text</summary>
        <input placeholder="Document name" value={pname} onChange={(e) => setPname(e.target.value)} />
        <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste notes, a wiki page, rules…" />
        <button disabled={!paste.trim()} onClick={() => { addDoc(ns, pname.trim() || 'Pasted ' + new Date().toLocaleString(), paste, size, overlap); setPaste(''); setPname(''); reload(); }}>Add document</button>
      </details>
      {msg && <div className="muted">{msg}</div>}
      {!docs.length && <div className="muted">No documents. RAG Retrieve searches these by meaning (embeddings) and keywords.</div>}
      <div className="lorelist">
        {docs.map((d) => { const e = embeddedCount(d); return (
          <div key={d.id} className="loreitem">
            <div className="lorehead"><b>{d.name}</b><span className="muted">{d.chunks.length} chunks · {e}/{d.chunks.length} embedded</span></div>
            <div className="row">
              <button disabled={busy} onClick={() => embed([d], true)}>Re-embed</button>
              <button className="danger" onClick={() => { if (confirm(`Delete "${d.name}"?`)) { const next = docs.filter((x) => x.id !== d.id); saveDocs(next, ns); setDocs(next); } }}>Delete</button>
            </div>
            <details><summary className="muted">Preview chunks</summary><pre className="mini">{d.chunks.map((c, i) => `#${i + 1}\n${c}`).join('\n\n———\n\n')}</pre></details>
          </div>); })}
      </div>
    </section>
  );
}

/** Global knowledge drawer: lorebook + document collections not tied to a character. */
export function KnowledgeDrawer({ onClose, koboldUrl }: { onClose: () => void; koboldUrl: string }) {
  const [tab, setTab] = useState<'lore' | 'docs'>('lore');
  return (
    <>
      <div className="panelhead"><b>Knowledge (global)</b><button className="icon x" title="Hide" onClick={onClose}>✕</button></div>
      <div className="seg small"><button className={tab === 'lore' ? 'active' : ''} onClick={() => setTab('lore')}>📖 Lorebook</button>
        <button className={tab === 'docs' ? 'active' : ''} onClick={() => setTab('docs')}>📄 Documents</button></div>
      <div className="muted">Used in every chat. Characters have their own lorebook and documents in the character editor.</div>
      {tab === 'lore' ? <LorebookPanel label="global" /> : <CollectionsPanel label="global" koboldUrl={koboldUrl} />}
    </>
  );
}
