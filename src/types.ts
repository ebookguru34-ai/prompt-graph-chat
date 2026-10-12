export type Role = 'system' | 'user' | 'assistant';
export interface Message { id: string; role: Role; content: string; }
export interface Chat { id: string; title: string; messages: Message[]; updatedAt: number; characterId?: string; }
export interface Samplers {
  temperature: number; top_p: number; top_k: number; min_p: number; rep_pen: number;
  max_length: number; max_context_length: number; stop_sequence: string[];
}
export interface InstructTemplate {
  name: string;
  systemPrefix: string; systemSuffix: string;
  userPrefix: string; userSuffix: string;
  assistantPrefix: string; assistantSuffix: string;
  stop: string[];
}
export interface Settings { koboldUrl: string; useTokenCountApi: boolean; streaming: boolean; useGraph?: boolean; userName?: string; }
