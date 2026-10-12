import type { Message } from '../types';
import type { PipelineContext } from '../pipeline';
import { renderPrompt, estimateTokens } from '../pipeline';
import * as kobold from '../kobold';
import { ensureAssistantCue, stripEcho, turnStops } from '../pipeline/promptSafety';
import type { PortMap } from './types';

export const SKIP = Symbol('skip');
export interface RunEnv { ctx: PipelineContext; dryRun: boolean; finalNodeId?: string; }
export interface FieldDef { key: string; label: string; kind: 'text' | 'textarea' | 'number' | 'bool' | 'select'; options?: string[]; help?: string; }
export interface NodeDef {
  type: string; label: string; color: string; category: 'io' | 'prompt' | 'llm' | 'memory' | 'profile' | 'logic';
  inputs: string[]; outputs: string[]; fields: FieldDef[]; defaults: Record<string, unknown>;
  /** Generation nodes are skipped on dry-run previews. */
  callsLLM?: boolean;
  run: (inp: PortMap, cfg: Record<string, unknown>, env: RunEnv, nodeId: string) => Promise<PortMap> | PortMap;
}

const str = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? (v as Message[]).map((m) => `${m.role}: ${m.content}`).join('\n') : JSON.stringify(v));
/** Placeholders available in every template: {{user}} {{system}} {{char}} {{greeting}}. */
const vars = (env: RunEnv) => ({ user: lastUser(env.ctx.history), system: env.ctx.systemPrompt, char: env.ctx.charName ?? '', greeting: env.ctx.greeting ?? '' });
const lastUser = (h: Message[]) => [...h].reverse().find((m) => m.role === 'user')?.content ?? '';
export const fill = (tpl: string, vars: Record<string, unknown>) => tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => str(vars[k]));
import { readMem, writeMem, listStores, appendMem } from './memory';
export { readMem, writeMem, listStores };
import { bm25Rank, embeddingRank, everyFires, turnNumber } from './search';
import { estimateTokens as estTok } from '../pipeline';
import { loadProfile, profileLines, getPath, fieldValue, fmt, validatePatch, commit, parsePatchText, updateInstruction, applyTick } from './profile';
const profVal = (env: RunEnv, path: string) => { const p = loadProfile(env.ctx.memNs); const f = p.schema.find((x) => x.key === path); return f ? fieldValue(p, f) : getPath(p.values, path); };
/** {{profile}} = all fields, {{profile.<path>}} = one value. */
const fillProfile = (tpl: string, env: RunEnv) => { const p = loadProfile(env.ctx.memNs);
  return tpl.replace(/\{\{\s*profile(?:\.([\w.]+))?\s*\}\}/g, (_, path) => (path ? fmt(profVal(env, path)) : profileLines(p))); };

async function callKobold(env: RunEnv, rawPrompt: string, cfg: Record<string, unknown>, stream: boolean): Promise<string> {
  const s = env.ctx.samplers, t = env.ctx.template, userName = env.ctx.settings.userName || 'User';
  const prompt = ensureAssistantCue(rawPrompt, t, renderPrompt); // never send raw text / an open user turn
  const extraStops = String(cfg.stop ?? '').split('\n').filter(Boolean).map((x) => x.replace(/\\n/g, '\n'));
  const request = {
    prompt, max_length: Number(cfg.max_length) || s.max_length, max_context_length: s.max_context_length,
    temperature: cfg.temperature === '' || cfg.temperature == null ? s.temperature : Number(cfg.temperature),
    top_p: s.top_p, top_k: s.top_k, min_p: s.min_p, rep_pen: s.rep_pen,
    stop_sequence: Array.from(new Set([...turnStops(t, userName), ...s.stop_sequence, ...extraStops].filter(Boolean))),
  };
  const base = env.ctx.settings.koboldUrl;
  let text = '';
  if (stream && env.ctx.settings.streaming) {
    let partial = '';
    try { text = await kobold.generateStream(base, request, (tok) => { partial += tok; env.ctx.onToken?.(tok); }, env.ctx.signal); }
    catch (e) {
      if ((e as Error).name === 'AbortError') text = partial;
      else if (partial) throw e;
      else { text = await kobold.generate(base, request, env.ctx.signal); env.ctx.onToken?.(text); }
    }
  } else {
    text = await kobold.generate(base, request, env.ctx.signal);
    if (stream) env.ctx.onToken?.(text);
  }
  text = stripEcho(text, lastUser(env.ctx.history), userName);
  for (const st of [...request.stop_sequence, t.assistantSuffix].filter((x) => x && x.trim())) { const i = text.indexOf(st); if (i !== -1) text = text.slice(0, i); }
  return text.trim();
}

async function fitPrompt(env: RunEnv, msgs: Message[]) {
  const budget = env.ctx.samplers.max_context_length - env.ctx.samplers.max_length;
  let api = env.ctx.settings.useTokenCountApi;
  const count = async (p: string) => { if (api) { try { return await kobold.tokenCount(env.ctx.settings.koboldUrl, p); } catch { api = false; } } return estimateTokens(p); };
  let m = [...msgs], prompt = renderPrompt(m, env.ctx.template), tokens = await count(prompt), dropped = 0;
  while (tokens > budget) {
    const i = m.findIndex((x) => x.role !== 'system');
    if (i === -1 || m.filter((x) => x.role !== 'system').length <= 1) break;
    m.splice(i, 1); dropped++; prompt = renderPrompt(m, env.ctx.template); tokens = await count(prompt);
  }
  return { prompt, tokens, dropped, method: api ? 'api' : 'estimate' };
}

export const NODE_DEFS: NodeDef[] = [
  { type: 'chat_input', label: 'Chat Input', color: '#3fb950', category: 'io', inputs: [], outputs: ['message', 'history'], fields: [], defaults: {},
    run: (_i, _c, env) => ({ message: lastUser(env.ctx.history), history: env.ctx.history }) },
  { type: 'system_prompt', label: 'System Prompt', color: '#8b949e', category: 'prompt', inputs: [], outputs: ['text'],
    fields: [{ key: 'text', label: 'Text (blank = character / chat system prompt)', kind: 'textarea' }], defaults: { text: '' },
    run: (_i, c, env) => ({ text: String(c.text || '') || env.ctx.systemPrompt }) },
  { type: 'chat_prompt', label: 'Chat Prompt', color: '#6c8cff', category: 'prompt', inputs: ['system', 'history', 'memory'], outputs: ['prompt'],
    fields: [{ key: 'memoryHeader', label: 'Memory header', kind: 'text', help: 'Added to the system message above injected memory.' },
      { key: 'trim', label: 'Trim to context budget', kind: 'bool' }],
    defaults: { memoryHeader: '[Memory]', trim: true },
    run: async (i, c, env) => {
      // history may be a message list or raw text (e.g. a Text Template wired in): text becomes a user turn, never untagged
      const hist = (Array.isArray(i.history) ? i.history as Message[] : i.history != null && str(i.history).trim() ? [{ id: 'h', role: 'user' as const, content: str(i.history) }] : env.ctx.history).filter((m) => m.role !== 'system');
      let sys = str(i.system); const mem = str(i.memory).trim();
      if (mem) sys = (sys ? sys + '\n\n' : '') + (c.memoryHeader ? c.memoryHeader + '\n' : '') + mem;
      const msgs: Message[] = [...(sys ? [{ id: 'system', role: 'system' as const, content: sys }] : []), ...hist];
      if (!c.trim) return { prompt: renderPrompt(msgs, env.ctx.template) };
      const r = await fitPrompt(env, msgs);
      return { prompt: r.prompt, _tokens: r.tokens, _dropped: r.dropped, _method: r.method };
    } },
  { type: 'template', label: 'Text Template', color: '#a371f7', category: 'prompt', inputs: ['a', 'b', 'c'], outputs: ['text'],
    fields: [{ key: 'text', label: 'Template ({{a}} {{b}} {{c}} {{user}} {{system}} {{char}} {{greeting}})', kind: 'textarea' }], defaults: { text: '{{a}}' },
    run: (i, c, env) => ({ text: fill(String(c.text ?? ''), { ...vars(env), ...i }) }) },
  { type: 'instruct_wrap', label: 'Instruct Wrap', color: '#6c8cff', category: 'prompt', inputs: ['system', 'user'], outputs: ['prompt'],
    fields: [{ key: 'prefill', label: 'Assistant prefill', kind: 'text' }], defaults: { prefill: '' },
    run: (i, c, env) => {
      const msgs: Message[] = [];
      if (str(i.system)) msgs.push({ id: 's', role: 'system', content: str(i.system) });
      msgs.push({ id: 'u', role: 'user', content: str(i.user) });
      return { prompt: renderPrompt(msgs, env.ctx.template) + String(c.prefill ?? '') };
    } },
  { type: 'generate', label: 'Kobold Generate', color: '#e5534b', category: 'llm', inputs: ['prompt'], outputs: ['text'], callsLLM: true,
    fields: [{ key: 'temperature', label: 'Temperature (blank = global)', kind: 'text' }, { key: 'max_length', label: 'Max length (0 = global)', kind: 'number' },
      { key: 'stop', label: 'Extra stops (one per line)', kind: 'textarea' }, { key: 'stream', label: 'Stream into chat', kind: 'bool', help: 'Turn on for the node whose text is shown as the reply.' }],
    defaults: { temperature: '', max_length: 0, stop: '', stream: true },
    run: async (i, c, env) => ({ text: await callKobold(env, str(i.prompt), c, !!c.stream) }) },
  { type: 'persona', label: 'Persona (3rd party)', color: '#d29922', category: 'llm', inputs: ['text', 'context'], outputs: ['text'], callsLLM: true,
    fields: [{ key: 'name', label: 'Name', kind: 'text' }, { key: 'system', label: 'Persona system prompt', kind: 'textarea' },
      { key: 'instruction', label: 'Instruction ({{text}} {{context}} {{user}} {{system}} {{char}} {{greeting}})', kind: 'textarea' },
      { key: 'temperature', label: 'Temperature (blank = global)', kind: 'text' }, { key: 'max_length', label: 'Max length (0 = global)', kind: 'number' },
      { key: 'stream', label: 'Stream into chat', kind: 'bool' }],
    defaults: { name: 'Critic', system: 'You are a sharp editor. You improve drafts without changing their meaning.',
      instruction: 'User asked:\n{{user}}\n\nDraft reply:\n{{text}}\n\nRewrite the draft so it is clearer and more accurate. Output only the rewritten reply.', temperature: '', max_length: 0, stream: false },
    run: async (i, c, env) => {
      const msgs: Message[] = [{ id: 's', role: 'system', content: String(c.system ?? '') },
        { id: 'u', role: 'user', content: fill(String(c.instruction ?? ''), { ...vars(env), ...i }) }];
      return { text: await callKobold(env, renderPrompt(msgs, env.ctx.template), c, !!c.stream) };
    } },
  { type: 'memory_read', label: 'Memory Read', color: '#2ea043', category: 'memory', inputs: [], outputs: ['text'],
    fields: [{ key: 'store', label: 'Store name', kind: 'text' }, { key: 'lastN', label: 'Last N entries (0 = all)', kind: 'number' },
      { key: 'joiner', label: 'Join with', kind: 'text' }], defaults: { store: 'notes', lastN: 10, joiner: '\\n' },
    run: (_i, c, env) => { const all = readMem(String(c.store), env.ctx.memNs); const n = Number(c.lastN) || 0; const items = n ? all.slice(-n) : all;
      return { text: items.join(String(c.joiner ?? '\n').replace(/\\n/g, '\n')) }; } },
  { type: 'memory_write', label: 'Memory Write', color: '#2ea043', category: 'memory', inputs: ['text'], outputs: ['text'],
    fields: [{ key: 'store', label: 'Store name', kind: 'text' }, { key: 'mode', label: 'Mode', kind: 'select', options: ['append', 'replace'] },
      { key: 'maxEntries', label: 'Keep at most (0 = unlimited)', kind: 'number' }], defaults: { store: 'notes', mode: 'append', maxEntries: 50 },
    run: (i, c, env) => {
      const t = str(i.text).trim();
      if (t && !env.dryRun && !env.ctx.dryRun) appendMem(String(c.store), t, env.ctx.turnId, c.mode === 'replace' ? 'replace' : 'append', Number(c.maxEntries) || 0, env.ctx.memNs);
      return { text: t };
    } },
  { type: 'profile', label: 'Profile', color: '#f0883e', category: 'profile', inputs: [], outputs: ['text', 'json'],
    fields: [{ key: 'text', label: 'Template ({{profile}} = all fields, {{profile.trust.player}} = one value; also {{char}} {{user}})', kind: 'textarea' }],
    defaults: { text: '[Current state of {{char}}]\n{{profile}}' },
    run: (_i, c, env) => { const p = loadProfile(env.ctx.memNs);
      const vals = Object.fromEntries(p.schema.map((f) => [f.key, fieldValue(p, f)]));
      return { text: fill(fillProfile(String(c.text ?? ''), env), vars(env)), json: JSON.stringify(vals, null, 2) }; } },
  { type: 'profile_update', label: 'Profile Update', color: '#f0883e', category: 'profile', inputs: ['context', 'text'], outputs: ['applied', 'rejected', 'json'], callsLLM: true,
    fields: [{ key: 'temperature', label: 'Temperature', kind: 'text' }, { key: 'max_length', label: 'Max length', kind: 'number' },
      { key: 'extra', label: 'Extra instructions (optional)', kind: 'textarea', help: 'E.g. "Change trust by at most 10 per turn."' }],
    defaults: { temperature: '0.2', max_length: 200, extra: '' },
    run: async (i, c, env) => {
      const p = loadProfile(env.ctx.memNs);
      if (!p.schema.length) return { applied: '(no profile schema; add fields in the character editor)', rejected: '', json: '{}' };
      const msgs: Message[] = [{ id: 's', role: 'system', content: 'You output JSON only.' }, { id: 'u', role: 'user', content: updateInstruction(p, str(i.context), str(i.text), String(c.extra ?? '')) }];
      const out = await callKobold(env, renderPrompt(msgs, env.ctx.template), { ...c, stop: '' }, false);
      let raw: Record<string, unknown>;
      try { raw = parsePatchText(out); } catch (e) { return { applied: '(nothing applied: ' + (e as Error).message + ')', rejected: '', json: '{}', _raw: out }; }
      const v = validatePatch(p, raw, 'llm');
      const cm = env.dryRun ? null : commit(p, v.patch, 'llm', env.ctx.turnId, env.ctx.memNs, 'profile_update');
      return { applied: cm ? Object.entries(cm.after).map(([k, x]) => `${k}: ${fmt(cm.before[k] ?? p.schema.find((f) => f.key === k)?.default)} -> ${fmt(x)}`).join('\n') : '(no changes)',
        rejected: v.rejected.map((r) => `${r.key} (${r.reason})`).join('\n'), json: JSON.stringify(cm?.after ?? {}), _raw: out };
    } },
  { type: 'stats', label: 'Stats', color: '#f0883e', category: 'profile', inputs: [], outputs: ['text', 'json'],
    fields: [{ key: 'keys', label: 'Keys (comma separated; blank = all number fields)', kind: 'text' },
      { key: 'rules', label: 'Per-turn rules, one per line', kind: 'textarea', help: '"energy decay 2" lowers by 2 per turn. "trust.player -> 50 by 1" drifts toward 50 by 1 per turn. Applied once per turn, rolled back with the turn.' }],
    defaults: { keys: '', rules: '' },
    run: (_i, c, env, nodeId) => {
      let errors: string[] = [];
      if (String(c.rules ?? '').trim() && !env.dryRun && env.ctx.turnId) errors = applyTick(env.ctx.memNs, String(c.rules), env.ctx.turnId, nodeId).errors;
      const p = loadProfile(env.ctx.memNs);
      const keys = String(c.keys ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const fields = keys.length ? keys : p.schema.filter((f) => f.type === 'number').map((f) => f.key);
      const vals = Object.fromEntries(fields.map((k) => [k, profVal(env, k)]));
      return { text: Object.entries(vals).map(([k, v]) => `${k}: ${fmt(v)}`).join('\n'), json: JSON.stringify(vals), ...(errors.length ? { _errors: errors.join('; ') } : {}) };
    } },
  { type: 'compare', label: 'Compare', color: '#db61a2', category: 'logic', inputs: ['text'], outputs: ['match', 'else'],
    fields: [{ key: 'path', label: 'Profile path (e.g. trust.player)', kind: 'text' }, { key: 'op', label: 'Operator', kind: 'select', options: ['<', '<=', '>', '>=', '==', '!='] },
      { key: 'value', label: 'Value', kind: 'text' }],
    defaults: { path: 'trust.player', op: '<', value: '20' },
    run: (i, c, env) => {
      const a = profVal(env, String(c.path)), bRaw = String(c.value ?? ''), an = Number(a), bn = Number(bRaw);
      const num = a !== '' && a != null && isFinite(an) && bRaw.trim() !== '' && isFinite(bn);
      const [x, y] = num ? [an, bn] : [fmt(a), bRaw];
      const hit = ({ '<': x < y, '<=': x <= y, '>': x > y, '>=': x >= y, '==': x === y, '!=': x !== y } as Record<string, boolean>)[String(c.op)] ?? false;
      const t = str(i.text) || `${c.path} = ${fmt(a)}`;
      return hit ? { match: t, else: SKIP } : { match: SKIP, else: t };
    } },
  { type: 'every_n', label: 'Every N', color: '#db61a2', category: 'logic', inputs: ['text'], outputs: ['text', 'turn'],
    fields: [{ key: 'mode', label: 'Mode', kind: 'select', options: ['every N turns', 'after turn X', 'once at turn X', 'between X-Y'] },
      { key: 'n', label: 'N (every N turns)', kind: 'number' }, { key: 'offset', label: 'Offset (every N: fire at turns offset+N, offset+2N…)', kind: 'number' },
      { key: 'x', label: 'X', kind: 'number' }, { key: 'y', label: 'Y (between)', kind: 'number' }],
    defaults: { mode: 'every N turns', n: 5, offset: 0, x: 1, y: 10 },
    run: (i, c, env) => {
      const turn = turnNumber(env.ctx.history); // assistant replies so far + 1; regenerate doesn't advance
      const fire = everyFires(String(c.mode), turn, Number(c.n), Number(c.x), Number(c.y), Number(c.offset) || 0);
      const pass = 'text' in i ? i.text : String(turn);
      return fire ? { text: pass, turn: String(turn) } : { text: SKIP, turn: SKIP, _turn: turn };
    } },
  { type: 'manual_trigger', label: 'Manual Trigger', color: '#db61a2', category: 'logic', inputs: ['text'], outputs: ['text'],
    fields: [{ key: 'label', label: 'Button label', kind: 'text' }, { key: 'behavior', label: 'Button behavior', kind: 'select', options: ['arm for next message', 'run now'],
      help: 'Shows a button in the chat bar. Arm: the next message lets input through once. Run now: runs the graph immediately with no new user message.' }],
    defaults: { label: 'Trigger', behavior: 'arm for next message' },
    run: (i, _c, env, nodeId) => {
      if (!env.ctx.armed?.[nodeId]) return { text: SKIP };
      if (!env.dryRun) env.ctx.onTriggerFired?.(nodeId);
      return { text: 'text' in i ? i.text : lastUser(env.ctx.history) };
    } },
  { type: 'json_extract', label: 'JSON Extract', color: '#a371f7', category: 'logic', inputs: ['text'], outputs: ['value', 'all'],
    fields: [{ key: 'paths', label: 'Dot paths, one per line (first = value)', kind: 'textarea' }, { key: 'fallback', label: 'Fallback (missing / no JSON)', kind: 'text' }],
    defaults: { paths: 'mood', fallback: '' },
    run: (i, c) => {
      const paths = String(c.paths ?? '').split('\n').map((x) => x.trim()).filter(Boolean); const fb = String(c.fallback ?? '');
      let obj: Record<string, unknown> | null = null, err = '';
      try { obj = parsePatchText(str(i.text)); } catch (e) { err = (e as Error).message; }
      const get = (pth: string) => { const v = obj ? getPath(obj, pth) : undefined; return v === undefined ? fb : typeof v === 'object' && v !== null && !Array.isArray(v) ? JSON.stringify(v) : fmt(v); };
      return { value: paths.length ? get(paths[0]) : obj ? JSON.stringify(obj) : fb, all: paths.map((x) => `${x}: ${get(x)}`).join('\n'), ...(err ? { _error: err } : {}) };
    } },
  { type: 'summarize', label: 'Summarize', color: '#d29922', category: 'llm', inputs: ['text', 'history'], outputs: ['text'], callsLLM: true,
    fields: [{ key: 'threshold', label: 'Only summarize above N tokens (else pass through)', kind: 'number' },
      { key: 'target', label: 'Target length (words)', kind: 'number' },
      { key: 'instruction', label: 'Instruction ({{text}} {{target}} {{char}} {{user}})', kind: 'textarea' },
      { key: 'store', label: 'Also save to memory store (replace; blank = off)', kind: 'text' },
      { key: 'temperature', label: 'Temperature', kind: 'text' }, { key: 'max_length', label: 'Max length (tokens)', kind: 'number' }],
    defaults: { threshold: 1000, target: 150, instruction: 'Summarize the following conversation in about {{target}} words. Keep names, facts, decisions and open threads. Write plain prose, no preamble.\n\n{{text}}',
      store: '', temperature: '0.3', max_length: 400 },
    run: async (i, c, env) => {
      const src = 'text' in i ? str(i.text) : str(i.history ?? env.ctx.history);
      const tokens = estTok(src);
      if (tokens <= (Number(c.threshold) || 0)) return { text: src, _skippedLLM: `input ~${tokens} tokens ≤ threshold` };
      const msgs: Message[] = [{ id: 'u', role: 'user', content: fill(String(c.instruction ?? ''), { ...vars(env), text: src, target: String(c.target ?? 150) }) }];
      const out = await callKobold(env, renderPrompt(msgs, env.ctx.template), { ...c, stop: '' }, false);
      const store = String(c.store ?? '').trim();
      if (store && out && !env.dryRun) appendMem(store, out, env.ctx.turnId, 'replace', 0, env.ctx.memNs);
      return { text: out, _inputTokens: tokens };
    } },
  { type: 'memory_search', label: 'Memory Search', color: '#2ea043', category: 'memory', inputs: ['query'], outputs: ['text'],
    fields: [{ key: 'store', label: 'Store name', kind: 'text' }, { key: 'topK', label: 'Top K', kind: 'number' },
      { key: 'method', label: 'Method', kind: 'select', options: ['keyword', 'embeddings'], help: 'Embeddings use KoboldCPP /v1/embeddings (load an embeddings model); falls back to keyword on error. Vectors are cached in the browser.' },
      { key: 'joiner', label: 'Join with', kind: 'text' }],
    defaults: { store: 'notes', topK: 3, method: 'keyword', joiner: '\\n' },
    run: async (i, c, env) => {
      const q = 'query' in i ? str(i.query) : lastUser(env.ctx.history);
      const docs = readMem(String(c.store), env.ctx.memNs); const k = Math.max(1, Number(c.topK) || 3);
      const join = String(c.joiner ?? '\n').replace(/\\n/g, '\n');
      if (!q.trim() || !docs.length) return { text: '', _method: 'none' };
      let method = String(c.method), note = '', ranked: { i: number; score: number }[];
      if (method === 'embeddings' && !env.dryRun) {
        try { ranked = await embeddingRank(q, docs, (t) => kobold.embeddings(env.ctx.settings.koboldUrl, t, env.ctx.signal)); }
        catch (e) { method = 'keyword'; note = 'embeddings failed (' + (e as Error).message + '), used keyword'; ranked = bm25Rank(q, docs); }
      } else { if (method === 'embeddings') { method = 'keyword'; note = 'dry run: keyword preview'; } ranked = bm25Rank(q, docs); }
      const top = ranked.slice(0, k);
      return { text: top.map((r) => docs[r.i]).join(join), _method: method, _scores: top.map((r) => r.score.toFixed(3)).join(', '), ...(note ? { _note: note } : {}) };
    } },
  { type: 'merge', label: 'Merge', color: '#a371f7', category: 'logic', inputs: ['a', 'b'], outputs: ['text'],
    fields: [{ key: 'text', label: 'Template ({{a}} {{b}} {{user}} {{system}} {{char}} {{greeting}})', kind: 'textarea' }], defaults: { text: '{{a}}\n\n{{b}}' },
    run: (i, c, env) => ({ text: fill(String(c.text ?? ''), { ...vars(env), ...i }) }) },
  { type: 'regex', label: 'Regex Transform', color: '#a371f7', category: 'logic', inputs: ['text'], outputs: ['text'],
    fields: [{ key: 'pattern', label: 'Pattern', kind: 'text' }, { key: 'flags', label: 'Flags', kind: 'text' }, { key: 'replace', label: 'Replace with', kind: 'text' }],
    defaults: { pattern: '\\s+$', flags: 'g', replace: '' },
    run: (i, c) => ({ text: str(i.text).replace(new RegExp(String(c.pattern ?? ''), String(c.flags ?? '')), String(c.replace ?? '').replace(/\\n/g, '\n')) }) },
  { type: 'condition', label: 'Condition', color: '#db61a2', category: 'logic', inputs: ['text'], outputs: ['match', 'else'],
    fields: [{ key: 'pattern', label: 'Regex (case-insensitive)', kind: 'text' }], defaults: { pattern: 'remember|note' },
    run: (i, c) => { const t = str(i.text); const hit = new RegExp(String(c.pattern ?? ''), 'i').test(t); return hit ? { match: t, else: SKIP } : { match: SKIP, else: t }; } },
  { type: 'chat_output', label: 'Chat Output', color: '#3fb950', category: 'io', inputs: ['text'], outputs: [], fields: [], defaults: {},
    run: (i) => ({ text: str(i.text) }) },
];
export const DEF = Object.fromEntries(NODE_DEFS.map((d) => [d.type, d])) as Record<string, NodeDef>;
