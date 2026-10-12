import { useState } from 'react';
import { EXAMPLE_SCHEMA, commit, fieldValue, fmt, loadProfile, revertTo, saveProfile, validatePatch, type FieldType, type ProfileField } from './graph/profile';

/** Schema editor + manual values + recent commits for one profile namespace (character id, or undefined = global). */
export function ProfilePanel({ ns, label }: { ns?: string; label: string }) {
  const [, force] = useState(0); const refresh = () => force((x) => x + 1);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [showAll, setShowAll] = useState(false);
  const p = loadProfile(ns);
  const setSchema = (f: (s: ProfileField[]) => ProfileField[]) => { const q = loadProfile(ns); q.schema = f(q.schema); saveProfile(q, ns); refresh(); };
  const upd = (i: number, k: keyof ProfileField, v: unknown) => setSchema((s) => s.map((x, j) => (j === i ? { ...x, [k]: v === '' ? undefined : v } : x)));
  const toText = (f: ProfileField, v: unknown) => (f.type === 'map' ? JSON.stringify(v ?? {}) : f.type === 'list' ? (Array.isArray(v) ? v.join(', ') : '') : fmt(v));
  function saveValues() {
    const q = loadProfile(ns); const raw: Record<string, unknown> = {};
    try {
      for (const [k, t] of Object.entries(drafts)) {
        const f = q.schema.find((x) => x.key === k); if (!f) continue;
        raw[k] = f.type === 'map' ? JSON.parse(t || '{}') : f.type === 'list' ? t.split(',').map((x) => x.trim()).filter(Boolean) : f.type === 'number' ? Number(t) : t;
      }
    } catch (e) { setMsg('❌ ' + (e as Error).message); return; }
    const v = validatePatch(q, raw, 'user'); const c = commit(q, v.patch, 'user', undefined, ns, 'manual edit');
    setDrafts({}); setMsg((c ? '✅ Saved ' + Object.keys(c.after).join(', ') : 'No changes') + (v.rejected.length ? ' · rejected: ' + v.rejected.map((r) => `${r.key} (${r.reason})`).join(', ') : '')); refresh();
  }
  const commits = [...p.commits].reverse().slice(0, showAll ? 200 : 15);
  return (
    <section className="profile">
      <h4>Profile — {label} <small className="muted">pgc.profile.{ns || '_global'}</small></h4>
      <div className="ptable">
        <div className="phead"><span>key (dot path)</span><span>type</span><span>min</span><span>max</span><span>default</span><span title="LLM can't change">🔒</span><span /></div>
        {p.schema.map((f, i) => (
          <div key={i} className="pfield">
            <div className="prow">
              <input value={f.key} title="key (dot path)" placeholder="key.path" onChange={(e) => upd(i, 'key', e.target.value.replace(/[^\w.]/g, ''))} />
              <select value={f.type} onChange={(e) => upd(i, 'type', e.target.value as FieldType)}>{['text', 'number', 'list', 'map'].map((t) => <option key={t}>{t}</option>)}</select>
              <input type="number" disabled={f.type !== 'number'} placeholder="min" title="min" value={f.min ?? ''} onChange={(e) => upd(i, 'min', e.target.value === '' ? '' : Number(e.target.value))} />
              <input type="number" disabled={f.type !== 'number'} placeholder="max" title="max" value={f.max ?? ''} onChange={(e) => upd(i, 'max', e.target.value === '' ? '' : Number(e.target.value))} />
              <input value={f.default === undefined ? '' : toText(f, f.default)} placeholder="default" title="default value" onChange={(e) => { const t = e.target.value;
                upd(i, 'default', t === '' ? '' : f.type === 'number' ? Number(t) : f.type === 'list' ? t.split(',').map((x) => x.trim()).filter(Boolean) : f.type === 'map' ? (() => { try { return JSON.parse(t); } catch { return f.default; } })() : t); }} />
              <input type="checkbox" checked={!!f.locked} title="Locked: the LLM can't change it" onChange={(e) => upd(i, 'locked', e.target.checked || '')} />
              <button className="x" title="Remove field" onClick={() => setSchema((s) => s.filter((_, j) => j !== i))}>×</button>
            </div>
            <input className="pdesc" value={f.description ?? ''} placeholder="description (shown to the LLM)" onChange={(e) => upd(i, 'description', e.target.value)} />
          </div>))}
      </div>
      <div className="row">
        <button onClick={() => setSchema((s) => [...s, { key: 'new_field', type: 'text' }])}>+ Field</button>
        {!p.schema.length && <button onClick={() => setSchema(() => JSON.parse(JSON.stringify(EXAMPLE_SCHEMA)))}>Add example fields</button>}
      </div>
      {!!p.schema.length && (<>
        <h4>Values</h4>
        {p.schema.map((f) => (
          <label key={f.key} className="field"><span>{f.locked ? '🔒 ' : ''}{f.key}</span>
            <input value={drafts[f.key] ?? toText(f, fieldValue(p, f))} onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))} /></label>))}
        <div className="row"><button className="primary" disabled={!Object.keys(drafts).length} onClick={saveValues}>Save values</button>
          {!!Object.keys(drafts).length && <button onClick={() => setDrafts({})}>Discard</button>}</div>
      </>)}
      {msg && <div className="muted">{msg}</div>}
      <h4>Recent commits ({p.commits.length})</h4>
      {!p.commits.length && <div className="muted">No changes yet.</div>}
      <div className="commits">
        {commits.map((c) => (
          <div key={c.id} className={'commit' + (c.rolledBack ? ' rb' : '')}>
            <div className="chead"><b className={'src ' + c.source}>{c.source}</b> <span className="muted">{new Date(c.ts).toLocaleString()}{c.turn ? ' · turn ' + c.turn.slice(0, 6) : ''}{c.rolledBack ? ' · rolled back (' + c.rolledBack.reason + ')' : ''}</span>
              <span className="spacer" />{!c.rolledBack && c.id !== p.commits[p.commits.length - 1]?.id && <button className="link" title="Undo every later change" onClick={() => { if (confirm('Revert the profile to the state right after this commit?')) { setMsg(`Reverted ${revertTo(ns, c.id)} commit(s).`); refresh(); } }}>revert to here</button>}</div>
            <pre className="mini">{Object.keys(c.after).map((k) => `${k}: ${fmt(c.before[k]) || '∅'} → ${fmt(c.after[k]) || '∅'}`).join('\n')}</pre>
          </div>))}
      </div>
      {p.commits.length > 15 && <button className="link" onClick={() => setShowAll((x) => !x)}>{showAll ? 'Show fewer' : 'Show all'}</button>}
    </section>
  );
}
