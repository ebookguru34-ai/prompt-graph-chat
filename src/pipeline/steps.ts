import type { Message } from '../types';
import type { PipelineContext, PipelineStep } from './types';
import * as kobold from '../kobold';
import { ensureAssistantCue, stripEcho, turnStops } from './promptSafety';

/** 1. Assemble ordered message list: system first, then history. */
export const buildMessages: PipelineStep = {
  name: 'buildMessages',
  run: (ctx) => {
    const sys: Message[] = ctx.systemPrompt.trim() ? [{ id: 'system', role: 'system', content: ctx.systemPrompt }] : [];
    return { ...ctx, messages: [...sys, ...ctx.history.filter((m) => m.role !== 'system')] };
  },
};

/** Pure render of messages with a template; ends with the assistant prefix to cue the reply. */
export function renderPrompt(messages: Message[], t: PipelineContext['template']): string {
  let out = '';
  for (const m of messages) {
    if (m.role === 'system') out += t.systemPrefix + m.content + t.systemSuffix;
    else if (m.role === 'user') out += t.userPrefix + m.content + t.userSuffix;
    else out += t.assistantPrefix + m.content + t.assistantSuffix;
  }
  return out + t.assistantPrefix;
}

/** 2. Render with instruct template. */
export const applyTemplate: PipelineStep = {
  name: 'applyTemplate',
  run: (ctx) => ({ ...ctx, prompt: renderPrompt(ctx.messages ?? [], ctx.template) }),
};

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** 3. Drop oldest non-system messages until prompt + max_length fits max_context_length. */
export const trimContext: PipelineStep = {
  name: 'trimContext',
  run: async (ctx) => {
    const budget = ctx.samplers.max_context_length - ctx.samplers.max_length;
    let method: 'api' | 'estimate' = ctx.settings.useTokenCountApi ? 'api' : 'estimate';
    const count = async (p: string) => {
      if (method === 'api') {
        try { return await kobold.tokenCount(ctx.settings.koboldUrl, p); } catch { method = 'estimate'; }
      }
      return estimateTokens(p);
    };
    let msgs = [...(ctx.messages ?? [])];
    let prompt = renderPrompt(msgs, ctx.template);
    let tokens = await count(prompt);
    let dropped = 0;
    while (tokens > budget) {
      const idx = msgs.findIndex((m) => m.role !== 'system');
      // keep system prompt and the latest message at minimum
      if (idx === -1 || msgs.filter((m) => m.role !== 'system').length <= 1) break;
      msgs.splice(idx, 1); dropped++;
      prompt = renderPrompt(msgs, ctx.template);
      tokens = await count(prompt);
    }
    return { ...ctx, messages: msgs, prompt, droppedMessages: dropped, promptTokens: tokens, tokenMethod: method };
  },
};

/** 4. Call Kobold (stream, fall back to non-stream). */
export const generate: PipelineStep = {
  name: 'generate',
  skipOnDryRun: true,
  run: async (ctx) => {
    const s = ctx.samplers;
    const stop = Array.from(new Set([...turnStops(ctx.template, ctx.settings.userName || 'User'), ...s.stop_sequence].filter(Boolean)));
    const request = {
      prompt: ensureAssistantCue(ctx.prompt ?? '', ctx.template, renderPrompt), max_length: s.max_length, max_context_length: s.max_context_length,
      temperature: s.temperature, top_p: s.top_p, top_k: s.top_k, min_p: s.min_p, rep_pen: s.rep_pen, stop_sequence: stop,
    };
    const base = ctx.settings.koboldUrl;
    if (ctx.settings.streaming) {
      let partial = '';
      try {
        const text = await kobold.generateStream(base, request, (t) => { partial += t; ctx.onToken?.(t); }, ctx.signal);
        return { ...ctx, request, rawOutput: text, streamed: true };
      } catch (e) {
        if ((e as Error).name === 'AbortError') return { ...ctx, request, rawOutput: partial, streamed: true };
        if (partial) throw e; // stream broke mid-way; don't duplicate
        console.warn('Streaming failed, falling back to non-streaming:', e);
      }
    }
    const text = await kobold.generate(base, request, ctx.signal);
    ctx.onToken?.(text);
    return { ...ctx, request, rawOutput: text, streamed: false };
  },
};

/** 5. Clean output: strip stop sequences / template tokens and trim. */
export const postProcess: PipelineStep = {
  name: 'postProcess',
  skipOnDryRun: true,
  run: (ctx) => {
    const lastUser = [...ctx.history].reverse().find((m) => m.role === 'user')?.content ?? '';
    let out = stripEcho(ctx.rawOutput ?? '', lastUser, ctx.settings.userName || 'User');
    const stops = [...turnStops(ctx.template, ctx.settings.userName || 'User'), ...ctx.samplers.stop_sequence, ctx.template.assistantSuffix].filter((x) => x && x.trim());
    for (const st of stops) { const i = out.indexOf(st); if (i !== -1) out = out.slice(0, i); }
    return { ...ctx, output: out.trim() };
  },
};

export const DEFAULT_PIPELINE: PipelineStep[] = [buildMessages, applyTemplate, trimContext, generate, postProcess];
