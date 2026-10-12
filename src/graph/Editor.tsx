import { useRef, useState } from 'react';
import { usePanel } from '../ui';
import { ProfilePanel } from '../ProfilePanel';
import { LorebookPanel } from '../Knowledge';
import type { Graph, GraphNode, NodeTrace } from './types';
import { DEF, NODE_DEFS, readMem, writeMem, listStores } from './nodes';
import { EXAMPLE_GRAPHS } from './defaults';
import { uid } from '../storage';

const W = 200, HEAD = 26, ROW = 22;
const portY = (i: number) => HEAD + 10 + i * ROW;
interface Props { graph: Graph; setGraph: (f: (g: Graph) => Graph) => void; trace: NodeTrace[]; onTestRun: (text: string) => void; busy: boolean; mobile?: boolean; memNs?: string; memLabel?: string; }

export function Editor({ graph, setGraph, trace, onTestRun, busy, mobile = false, memNs, memLabel }: Props) {
  const [palOpen, setPalOpen] = usePanel('palette', mobile);
  const [inspOpen, setInspOpen] = usePanel('inspector', mobile);
  const [zoom, setZoom] = useState(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; z: number; cx: number; cy: number; px: number; py: number } | null>(null);
  const moved = useRef(false);
  const [sel, setSel] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 20, y: 56 });
  const [pending, setPending] = useState<{ node: string; port: string; x: number; y: number } | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [testText, setTestText] = useState('Hello! Remember that my name is Vang.');
  const drag = useRef<{ kind: 'node' | 'pan'; id?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const zoomAt = (nz: number, cx: number, cy: number) => { const z = Math.min(2, Math.max(0.3, nz)); setPan((p) => ({ x: cx - (cx - p.x) * z / zoom, y: cy - (cy - p.y) * z / zoom })); setZoom(z); };
  const canvas = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [, force] = useState(0);

  const toLocal = (e: { clientX: number; clientY: number }) => { const r = canvas.current!.getBoundingClientRect(); return { x: (e.clientX - r.left - pan.x) / zoom, y: (e.clientY - r.top - pan.y) / zoom }; };
  const node = graph.nodes.find((n) => n.id === sel);
  const traceOf = (id: string) => trace.find((t) => t.nodeId === id);
  const outPos = (n: GraphNode, p: string) => ({ x: n.x + W, y: n.y + portY(DEF[n.type]?.outputs.indexOf(p) ?? 0) });
  const inPos = (n: GraphNode, p: string) => ({ x: n.x, y: n.y + portY(DEF[n.type]?.inputs.indexOf(p) ?? 0) });
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => { const dx = Math.max(40, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };

  function onMove(e: React.PointerEvent) {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]; const pc = pinch.current;
      const z = Math.min(2, Math.max(0.3, pc.z * Math.hypot(a.x - b.x, a.y - b.y) / pc.d));
      setPan({ x: pc.cx - (pc.cx - pc.px) * z / pc.z, y: pc.cy - (pc.cy - pc.py) * z / pc.z }); setZoom(z); return;
    }
    const p = toLocal(e); setMouse(p);
    const d = drag.current; if (!d) return;
    let dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true;
    if (d.kind === 'node') { dx /= zoom; dy /= zoom; }
    if (d.kind === 'pan') setPan({ x: d.ox + dx, y: d.oy + dy });
    else setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => n.id === d.id ? { ...n, x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) } : n) }));
  }
  function onDown(e: React.PointerEvent) {
    if (e.isPrimary) { pointers.current.clear(); pinch.current = null; } // drop stale pointers (e.g. lost pointerup)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]; const r = canvas.current!.getBoundingClientRect();
      pinch.current = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z: zoom, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top, px: pan.x, py: pan.y };
      drag.current = null;
    }
  }
  function onUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    drag.current = null;
    if (pending && e.type === 'pointerup') {
      // Touch pointers stay captured by the source element, so find the input port under the finger.
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-in-node]') as HTMLElement | null;
      if (el) connect(el.dataset.inNode!, el.dataset.inPort!);
      else if (moved.current) setPending(null); // dragged to nowhere; a plain tap keeps the wire armed (tap output, then tap input)
    }
  }
  function addNode(type: string) {
    const d = DEF[type]; const id = type + '_' + uid().slice(0, 5);
    setGraph((g) => ({ ...g, nodes: [...g.nodes, { id, type, x: Math.round((-pan.x + (mobile ? 40 : 300)) / zoom + Math.random() * 60), y: Math.round((-pan.y + 150) / zoom + Math.random() * 60), config: { ...d.defaults } }] }));
    setSel(id); if (mobile) setPalOpen(false);
  }
  function connect(to: string, toPort: string) {
    if (!pending || pending.node === to) { setPending(null); return; }
    setGraph((g) => ({ ...g, edges: [...g.edges.filter((e) => !(e.to === to && e.toPort === toPort)), { id: uid(), from: pending.node, fromPort: pending.port, to, toPort }] }));
    setPending(null);
  }
  const setCfg = (k: string, v: unknown) => setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => n.id === sel ? { ...n, config: { ...n.config, [k]: v } } : n) }));
  function del(id: string) { setGraph((g) => ({ ...g, nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.from !== id && e.to !== id) })); setSel(null); }
  function exportJson() {
    const b = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = (graph.name || 'graph').replace(/\W+/g, '-') + '.json'; a.click();
  }
  async function importJson(f: File) {
    try { const g = JSON.parse(await f.text()); if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('not a graph'); setGraph(() => g); setSel(null); }
    catch (e) { alert('Could not load graph: ' + (e as Error).message); }
  }
  const cats = ['io', 'prompt', 'llm', 'memory', 'profile', 'logic'] as const;

  return (
    <div className={'editor' + (mobile ? ' mobile' : '')}>
      {mobile && (palOpen || inspOpen) && <div className="backdrop" onClick={() => { setPalOpen(false); setInspOpen(false); }} />}
      <aside className={'palette drawer left' + (palOpen ? ' open' : ' closed')}>
        <div className="panelhead"><b>Nodes</b><button className="icon x" title="Hide" onClick={() => setPalOpen(false)}>✕</button></div>
        <label className="field col"><span>Graph name</span><input value={graph.name} onChange={(e) => setGraph((g) => ({ ...g, name: e.target.value }))} /></label>
        <label className="field col"><span>Load example</span>
          <select value="" onChange={(e) => { const ex = EXAMPLE_GRAPHS.find((g) => g.name === e.target.value); if (ex && confirm('Replace current graph with "' + ex.name + '"?')) { setGraph(() => JSON.parse(JSON.stringify(ex))); setSel(null); } }}>
            <option value="">Choose…</option>{EXAMPLE_GRAPHS.map((g) => <option key={g.name}>{g.name}</option>)}</select></label>
        <div className="row"><button onClick={exportJson}>Export</button><button onClick={() => fileRef.current?.click()}>Import</button>
          <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} /></div>
        {cats.map((c) => (
          <div key={c}><h4>{c}</h4>
            {NODE_DEFS.filter((d) => d.category === c).map((d) => (
              <button key={d.type} className="pal-item" style={{ borderLeftColor: d.color }} onClick={() => addNode(d.type)}>+ {d.label}</button>))}
          </div>))}
        <h4>Test run</h4>
        <textarea rows={3} value={testText} onChange={(e) => setTestText(e.target.value)} />
        <button className="primary" disabled={busy} onClick={() => onTestRun(testText)}>{busy ? 'Running…' : 'Run as next message'}</button>
        <div className="muted">Sends into the current chat, so the result also shows up in the Chat tab.</div>
      </aside>

      <div ref={canvas} className="canvas"
        onPointerDownCapture={onDown}
        onPointerDown={(e) => { moved.current = false; const t = e.target as Element; if (t === e.currentTarget || t.classList.contains('world') || t.tagName === 'svg') { setSel(null); setPending(null); drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y }; } }}
        onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onWheel={(e) => { const r = canvas.current!.getBoundingClientRect(); zoomAt(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top); }}>
        <div className="canvas-tools">
          <button className={'icon' + (palOpen ? ' on' : '')} title={(palOpen ? 'Hide' : 'Show') + ' node palette'} onClick={() => { if (mobile) setInspOpen(false); setPalOpen((o) => !o); }}>▤<span className="lbl"> Nodes</span></button>
          <button className={'icon' + (inspOpen ? ' on' : '')} title={(inspOpen ? 'Hide' : 'Show') + ' inspector'} onClick={() => { if (mobile) setPalOpen(false); setInspOpen((o) => !o); }}>🔍<span className="lbl"> Inspector</span></button>
          <button className="icon" title="Zoom out" onClick={() => zoomAt(zoom / 1.2, 0, 0)}>−</button>
          <button className="icon" title="Reset view" onClick={() => { setZoom(1); setPan({ x: 20, y: 56 }); }}>{Math.round(zoom * 100)}%</button>
          <button className="icon" title="Zoom in" onClick={() => zoomAt(zoom * 1.2, 0, 0)}>+</button>
          {pending && <span className="pendtag">Tap an input to connect · <button className="link" onClick={() => setPending(null)}>cancel</button></span>}
        </div>
        <div className="world" style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
          <svg className="wires" width="4000" height="3000">
            {graph.edges.map((e) => {
              const a = graph.nodes.find((n) => n.id === e.from), b = graph.nodes.find((n) => n.id === e.to); if (!a || !b) return null;
              const t = traceOf(e.from); const active = t && !t.skipped && !t.error && t.outputs?.[e.fromPort] !== '(skipped branch)';
              return <path key={e.id} d={curve(outPos(a, e.fromPort), inPos(b, e.toPort))} className={'wire' + (active ? ' active' : '')}
                onClick={() => setGraph((g) => ({ ...g, edges: g.edges.filter((x) => x.id !== e.id) }))}><title>Click to delete</title></path>;
            })}
            {pending && <path d={curve({ x: pending.x, y: pending.y }, mouse)} className="wire pending" />}
          </svg>
          {graph.nodes.map((n) => {
            const d = DEF[n.type]; if (!d) return null; const t = traceOf(n.id);
            const st = t ? (t.error ? 'err' : t.skipped ? 'skip' : 'ok') : '';
            const rows = Math.max(d.inputs.length, d.outputs.length, 1);
            return (
              <div key={n.id} className={'gnode ' + st + (sel === n.id ? ' sel' : '')} style={{ left: n.x, top: n.y, width: W, minHeight: HEAD + 20 + rows * ROW }}
                onClick={() => { if (mobile && !moved.current) setInspOpen(true); }} onPointerDown={(e) => { e.stopPropagation(); moved.current = false; setSel(n.id); drag.current = { kind: 'node', id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y }; }}>
                <div className="ghead" style={{ background: d.color }}>{(n.config.name as string) || d.label}
                  {t && <span className="gbadge">{t.error ? 'error' : t.skipped ? 'skipped' : t.durationMs.toFixed(0) + 'ms'}</span>}</div>
                {d.inputs.map((p, i) => (
                  <div key={'i' + p} className="port in" style={{ top: portY(i) - 8 }} data-in-node={n.id} data-in-port={p} onPointerDown={(e) => { e.stopPropagation(); if (pending) connect(n.id, p); }}>
                    <i />{p}</div>))}
                {d.outputs.map((p, i) => (
                  <div key={'o' + p} className="port out" style={{ top: portY(i) - 8 }}
                    onPointerDown={(e) => { e.stopPropagation(); moved.current = false; const o = outPos(n, p); setPending({ node: n.id, port: p, x: o.x, y: o.y }); }}>
                    {p}<i /></div>))}
              </div>);
          })}
        </div>
        <div className="canvas-hint">{mobile ? 'Drag to pan · pinch to zoom · tap output then input to wire · tap wire to delete' : 'Drag (or tap) output → input to connect. Click a wire to delete it. Drag empty space to pan, wheel to zoom.'}</div>
      </div>

      <aside className={'inspector drawer rightside' + (inspOpen ? ' open' : ' closed')}>
        <div className="panelhead"><b>Inspector</b><button className="icon x" title="Hide" onClick={() => setInspOpen(false)}>✕</button></div>
        {!node && <div className="muted">Select a node to edit it. After a run, each node shows what went in and came out.</div>}
        {node && DEF[node.type] && (() => {
          const d = DEF[node.type]; const t = traceOf(node.id); const cfg = { ...d.defaults, ...node.config };
          return (<section>
            <h3 style={{ margin: 0 }}>{d.label} <small className="muted">{node.id}</small></h3>
            {d.fields.map((f) => (
              <label key={f.key} className={'field ' + (f.kind === 'bool' ? 'check' : 'col')}>
                {f.kind === 'bool' ? (<><input type="checkbox" checked={!!cfg[f.key]} onChange={(e) => setCfg(f.key, e.target.checked)} />{f.label}</>) : <span>{f.label}</span>}
                {f.kind === 'text' && <input value={String(cfg[f.key] ?? '')} onChange={(e) => setCfg(f.key, e.target.value)} />}
                {f.kind === 'number' && <input type="number" value={Number(cfg[f.key] ?? 0)} onChange={(e) => setCfg(f.key, Number(e.target.value))} />}
                {f.kind === 'textarea' && <textarea rows={5} value={String(cfg[f.key] ?? '')} onChange={(e) => setCfg(f.key, e.target.value)} />}
                {f.kind === 'select' && <select value={String(cfg[f.key])} onChange={(e) => setCfg(f.key, e.target.value)}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>}
                {f.help && <div className="muted">{f.help}</div>}
              </label>))}
            {(node.type === 'memory_read' || node.type === 'memory_write') && (() => {
              const store = String(cfg.store); const items = readMem(store, memNs);
              return (<div><h4>Store "{store}" ({items.length}) <small className="muted">{memLabel ? 'character: ' + memLabel : 'no character'}</small></h4><pre className="mini">{items.join('\n') || '(empty)'}</pre>
                <button onClick={() => { writeMem(store, [], memNs); force((x) => x + 1); }}>Clear store</button>
                <div className="muted">All stores: {listStores(memNs).join(', ') || 'none'}</div></div>);
            })()}
            {node.type === 'lorebook' && <><LorebookPanel key={'c' + (memNs || '')} ns={memNs} label={memLabel || 'no character'} />{memNs && <LorebookPanel key="g" label="global" />}</>}
            {node.type === 'rag_retrieve' && <div className="muted">Manage documents in 📚 Knowledge (global) or the character editor (per character).</div>}
            {['profile', 'profile_update', 'stats', 'compare'].includes(node.type) && <ProfilePanel key={(memNs || '') + trace.length} ns={memNs} label={memLabel || 'no character (global)'} />}
            <button className="danger" onClick={() => del(node.id)}>Delete node</button>
            <h4>Last run</h4>
            {!t && <div className="muted">Not run yet.</div>}
            {t && (<>
              {t.error && <div className="error">{t.error}</div>}
              <b>inputs</b><pre className="mini">{JSON.stringify(t.inputs, null, 2)}</pre>
              <b>outputs</b><pre className="mini">{t.outputs ? JSON.stringify(t.outputs, null, 2) : t.skipped ? '(skipped)' : '—'}</pre>
            </>)}
          </section>);
        })()}
      </aside>
    </div>
  );
}
