import type { PipelineContext } from '../pipeline';
import type { Graph, NodeTrace, PortMap } from './types';
import { DEF, SKIP } from './nodes';

const clean = (v: unknown): unknown => (v === SKIP ? '(skipped branch)' : JSON.parse(JSON.stringify(v ?? null)));
const cleanMap = (m: PortMap) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, clean(v)]));

export function topoOrder(g: Graph): string[] {
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) if (indeg.has(e.to) && indeg.has(e.from)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const q = g.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id), out: string[] = [];
  while (q.length) {
    const id = q.shift()!; out.push(id);
    for (const e of g.edges.filter((x) => x.from === id)) { indeg.set(e.to, (indeg.get(e.to) ?? 0) - 1); if (indeg.get(e.to) === 0) q.push(e.to); }
  }
  if (out.length !== g.nodes.length) throw new Error('Graph has a cycle. Remove a connection that loops back.');
  return out;
}

/** Execute the graph. Returns ctx with prompt/output filled so the chat UI keeps working. */
export async function runGraph(g: Graph, ctx: PipelineContext, onTrace?: (t: NodeTrace[]) => void) {
  const order = topoOrder(g);
  const outputs = new Map<string, PortMap>();
  const trace: NodeTrace[] = [];
  const env = { ctx, dryRun: !!ctx.dryRun };
  let final: string | undefined, lastPrompt = '', promptTokens = 0, dropped = 0, method: 'api' | 'estimate' = 'estimate';
  for (const id of order) {
    const node = g.nodes.find((n) => n.id === id)!; const def = DEF[node.type];
    const label = (node.config.name as string) || def?.label || node.type;
    if (!def) { trace.push({ nodeId: id, label, inputs: {}, outputs: null, durationMs: 0, error: 'Unknown node type ' + node.type }); continue; }
    const inEdges = g.edges.filter((e) => e.to === id);
    const inputs: PortMap = {};
    for (const e of inEdges) inputs[e.toPort] = outputs.get(e.from)?.[e.fromPort] ?? SKIP;
    const skip = inEdges.length > 0 && inEdges.every((e) => inputs[e.toPort] === SKIP) || Object.values(inputs).some((v) => v === SKIP && inEdges.length === 1);
    if (skip || (env.dryRun && def.callsLLM)) {
      outputs.set(id, Object.fromEntries(def.outputs.map((p) => [p, env.dryRun && !skip ? `(${label} output)` : SKIP])));
      trace.push({ nodeId: id, label, inputs: cleanMap(inputs), outputs: null, durationMs: 0, skipped: true }); onTrace?.([...trace]); continue;
    }
    for (const k of Object.keys(inputs)) if (inputs[k] === SKIP) delete inputs[k];
    const t0 = performance.now();
    try {
      const out = await def.run(inputs, { ...def.defaults, ...node.config }, env, id);
      outputs.set(id, out);
      if (typeof out.prompt === 'string') { lastPrompt = out.prompt; if (typeof out._tokens === 'number') { promptTokens = out._tokens; dropped = Number(out._dropped) || 0; method = out._method as 'api' | 'estimate'; } }
      if (node.type === 'chat_output') final = String(out.text ?? '');
      trace.push({ nodeId: id, label, inputs: cleanMap(inputs), outputs: cleanMap(out), durationMs: performance.now() - t0 });
      onTrace?.([...trace]);
    } catch (e) {
      trace.push({ nodeId: id, label, inputs: cleanMap(inputs), outputs: null, durationMs: performance.now() - t0, error: (e as Error).message });
      onTrace?.([...trace]);
      if ((e as Error).name === 'AbortError') break;
      throw Object.assign(e as Error, { trace });
    }
  }
  return { ctx: { ...ctx, prompt: lastPrompt, output: final ?? '', promptTokens: promptTokens || Math.ceil(lastPrompt.length / 4), droppedMessages: dropped, tokenMethod: method }, trace };
}
