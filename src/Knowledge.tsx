import { useEffect, useRef, useState } from 'react';
import { blankEntry, exportLorebook, loadLore, parseLorebook, saveLore, scanLore, type LoreEntry } from './graph/lore';
import { addDoc, dropVectors, embeddedCount, loadDocs, saveDocs, type RagDoc } from './graph/rag';
import { cachedEmbeddings } from './graph/search';
import * as kobold from './kobold';
import { catOn, charOverrides, embeddedPackCount, embedPack, entryOn, listPacks, packSettings, setCharOverride, setPackSettings, type CharOverride, type KnowledgePack } from './graph/packs';
import { installPackFile, uninstallPack } from './graph/packdb';

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
  const [tab, setTab] = useState<'lore' | 'docs' | 'packs'>('lore');
  return (
    <>
      <div className="panelhead"><b>Knowledge (global)</b><button className="icon x" title="Hide" onClick={onClose}>✕</button></div>
      <div className="seg small"><button className={tab === 'lore' ? 'active' : ''} onClick={() => setTab('lore')}>📖 Lorebook</button>
        <button className={tab === 'docs' ? 'active' : ''} onClick={() => setTab('docs')}>📄 Documents</button>
        <button className={tab === 'packs' ? 'active' : ''} onClick={() => setTab('packs')}>📦 Packs</button></div>
      <div className="muted">{tab === 'packs' ? 'Installed knowledge packs. Separate from your own lorebook and documents; turn a pack off and it is never used.'
        : 'Used in every chat. Characters have their own lorebook and documents in the character editor.'}</div>
      {tab === 'lore' ? <LorebookPanel label="global" /> : tab === 'docs' ? <CollectionsPanel label="global" koboldUrl={koboldUrl} /> : <PacksPanel koboldUrl={koboldUrl} />}
    </>
  );
}

/** Knowledge packs: install (.json/.zip), enable, categories, browse, embed, uninstall. */
export function PacksPanel({ koboldUrl }: { koboldUrl: string }) {
  const [packs, setPacks] = useState<KnowledgePack[]>(() => listPacks());
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  async function install(f: File) {
    setBusy(true); setMsg('Installing ' + f.name + '…');
    try { const p = await installPackFile(f); setMsg(`✅ Installed “${p.name}”: ${p.entries.length} entries`); }
    catch (e) { setMsg('❌ Install failed: ' + (e as Error).message); }
    setBusy(false); setPacks(listPacks());
  }
  return (
    <section className="lore">
      <h4>Knowledge packs <small className="muted">{packs.length} installed</small></h4>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()} title="A pgc-knowledge-pack .json, or a .zip containing one">Install pack…</button>
        <input ref={fileRef} type="file" accept=".json,.zip,application/json,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) install(f); }} />
      </div>
      {msg && <div className="muted">{msg}</div>}
      {!packs.length && <div className="muted">No packs. A pack is a read-only lore set (e.g. the Skyrim Oghma Infinium catalog) used by Lorebook and RAG Retrieve nodes while it is on.</div>}
      {packs.map((p) => <PackCard key={p.id} pack={p} koboldUrl={koboldUrl} onRemoved={() => { setPacks(listPacks()); setMsg('Uninstalled ' + p.name); }} />)}
    </section>
  );
}

function PackCard({ pack, koboldUrl, onRemoved }: { pack: KnowledgePack; koboldUrl: string; onRemoved: () => void }) {
  const [st, setSt] = useState(() => packSettings(pack.id));
  const [q, setQ] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const [emb, setEmb] = useState<number | null>(null); const [prog, setProg] = useState<[number, number] | null>(null); const [note, setNote] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { let live = true; embeddedPackCount(pack.id).then((n) => { if (live) setEmb(n); }); return () => { live = false; }; }, [pack.id, prog]);
  const put = (p: Partial<typeof st>) => { setPackSettings(pack.id, p); setSt(packSettings(pack.id)); };
  const setCat = (id: string, on: boolean) => put({ cats: { ...st.cats, [id]: on } });
  const active = pack.entries.filter((e) => entryOn(st, e)).length;
  const groups = (pack.categoryGroups?.length ? pack.categoryGroups : [{ id: 'type', label: 'Categories' }]).map((g) => ({ ...g, cats: pack.categories.filter((c) => c.group === g.id) }))
    .concat([{ id: '_', label: 'Other', cats: pack.categories.filter((c) => !(pack.categoryGroups ?? [{ id: 'type' }]).some((g) => g.id === c.group)) }]).filter((g) => g.cats.length);
  const ql = q.trim().toLowerCase();
  const found = ql ? pack.entries.filter((e) => e.title.toLowerCase().includes(ql) || e.keys.some((k) => k.toLowerCase().includes(ql)) || (e.tags ?? []).some((t) => t.toLowerCase().includes(ql))) : pack.entries;
  async function embed(fresh: boolean) {
    const ac = new AbortController(); abort.current = ac; setNote(''); setProg([0, 1]);
    try { const n = await embedPack(pack.id, (t) => kobold.embeddings(koboldUrl, t, ac.signal), (d, tot) => setProg([d, tot]), ac.signal, fresh); setNote(n ? `✅ Embedded ${n} articles` : 'Already embedded'); }
    catch (e) { setNote((e as Error).name === 'AbortError' ? 'Cancelled (progress kept; Embed resumes)' : '❌ ' + (e as Error).message); }
    abort.current = null; setProg(null);
  }
  return (
    <div className={'loreitem pack' + (st.enabled ? '' : ' off')}>
      <div className="lorehead">
        <label className="check" title="Default for all chats; characters can override (character editor → Knowledge packs)"><input type="checkbox" checked={st.enabled} onChange={(e) => put({ enabled: e.target.checked })} /> On</label>
        <b>{pack.name}</b><span className="muted">{pack.version}</span>{pack.license?.spdx && <span className="tag">{pack.license.spdx}</span>}
        <span className="muted">{active}/{pack.entries.length} entries active</span>
      </div>
      {pack.description && <div className="muted">{pack.description}</div>}
      {groups.map((g) => (
        <div key={g.id} className="packcats">
          <div className="row"><b className="small">{g.label}</b>
            <button className="link" onClick={() => put({ cats: { ...st.cats, ...Object.fromEntries(g.cats.map((c) => [c.id, true])) } })}>all</button>
            <button className="link" onClick={() => put({ cats: { ...st.cats, ...Object.fromEntries(g.cats.map((c) => [c.id, false])) } })}>none</button></div>
          <div className="catgrid">{g.cats.map((c) => (
            <label key={c.id} className="check"><input type="checkbox" checked={catOn(st, c.id)} onChange={(e) => setCat(c.id, e.target.checked)} /> {c.label} <span className="muted">{c.count}</span></label>))}</div>
        </div>))}
      <div className="row wrap">
        <span className="muted">Vectors: {emb ?? '…'}/{pack.entries.length}</span>
        {prog ? <><progress max={prog[1] || 1} value={prog[0]} /> <span className="muted">embedding {prog[0]}/{prog[1]} missing</span><button onClick={() => abort.current?.abort()}>Cancel</button></>
          : <><button onClick={() => embed(false)} title="Compute embeddings for RAG (KoboldCPP /v1/embeddings). Without them RAG uses keyword search for this pack.">Embed</button>
            <button disabled={!emb} onClick={() => embed(true)}>Re-embed</button></>}
        {note && <span className="muted">{note}</span>}
      </div>
      <details><summary className="muted">Browse / search ({pack.entries.length})</summary>
        <input placeholder="Search titles, keys, tags…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="muted">{found.length} match{found.length === 1 ? '' : 'es'}{found.length > 60 ? ', showing 60' : ''}</div>
        <div className="lorelist">{found.slice(0, 60).map((e) => (
          <div key={e.id} className={'loreitem' + (entryOn(st, e) ? '' : ' off')}>
            <div className="lorehead" onClick={() => setOpen(open === e.id ? null : e.id)}><b>{e.title}</b>
              {e.cats.map((c) => <span key={c} className="tag dim">{pack.categories.find((x) => x.id === c)?.label ?? c}</span>)}
              <span className="muted keys">{e.keys.join(', ')}</span></div>
            {open === e.id && <div className="loreform"><div className="small"><b>Basic</b> {e.basic}</div>
              {e.advanced && <div className="small"><b>Advanced</b> {e.advanced}</div>}
              {!!e.advancedClass?.length && <div className="muted small">Specialists: {e.advancedClass.join(', ')}</div>}</div>}
          </div>))}</div>
      </details>
      <details><summary className="muted">License & attribution</summary>
        {pack.license?.notice && <div className="small">{pack.license.notice}</div>}
        {pack.attribution && <div className="small muted">{pack.attribution}</div>}
        {pack.source && <pre className="mini">{JSON.stringify(pack.source, null, 1)}</pre>}
        {pack.license?.text && <details><summary className="muted">Full license text</summary><pre className="mini">{pack.license.text}</pre></details>}
      </details>
      <button className="danger" onClick={async () => { if (confirm(`Uninstall “${pack.name}”? Its data, vectors and settings are removed.`)) { await uninstallPack(pack.id); onRemoved(); } }}>Uninstall</button>
    </div>
  );
}

/** Per-character pack override (inherit the global toggle, or force on/off for this character). */
export function CharPackOverrides({ ns }: { ns: string }) {
  const [o, setO] = useState(() => charOverrides(ns)); const packs = listPacks();
  if (!packs.length) return <div className="muted">No knowledge packs installed (Knowledge → Packs).</div>;
  return (
    <div className="lorelist">{packs.map((p) => (
      <label key={p.id} className="field"><span>{p.name} <small className="muted">(global: {packSettings(p.id).enabled ? 'on' : 'off'})</small></span>
        <select value={o[p.id] ?? 'inherit'} onChange={(e) => { setCharOverride(ns, p.id, e.target.value as CharOverride); setO(charOverrides(ns)); }}>
          <option value="inherit">inherit</option><option value="on">on</option><option value="off">off</option></select></label>))}</div>
  );
}
