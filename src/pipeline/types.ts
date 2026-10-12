import type { InstructTemplate, Message, Samplers, Settings } from '../types';
/** Context object passed through every pipeline step. Steps return a new (shallow-copied) context. */
export interface PipelineContext {
  // inputs
  systemPrompt: string;
  history: Message[];          // chat messages (user/assistant), oldest first
  template: InstructTemplate;
  samplers: Samplers;
  settings: Settings;
  // produced by steps
  messages?: Message[];        // buildMessages
  prompt?: string;             // applyTemplate / trimContext
  droppedMessages?: number;    // trimContext
  promptTokens?: number;       // trimContext
  tokenMethod?: 'api' | 'estimate';
  request?: Record<string, unknown>; // generate (body sent)
  rawOutput?: string;          // generate
  streamed?: boolean;
  output?: string;             // postProcess
  // runtime (not serialized in trace)
  signal?: AbortSignal;
  onToken?: (t: string) => void;
  dryRun?: boolean;
  turnId?: string;
  charName?: string;           // active character name ({{char}})
  greeting?: string;           // active character greeting ({{greeting}})
  memNs?: string;              // memory namespace (character id); undefined = legacy global stores             // id of the assistant reply being generated (tags memory writes)            // stop before generate (for preview)
}
export interface PipelineStep {
  name: string;
  run: (ctx: PipelineContext) => Promise<PipelineContext> | PipelineContext;
  skipOnDryRun?: boolean;
}
export interface TraceEntry { step: string; input: unknown; output: unknown; durationMs: number; error?: string; skipped?: boolean; }
