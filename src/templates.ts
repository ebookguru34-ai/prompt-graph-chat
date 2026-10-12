import type { InstructTemplate, Samplers } from './types';
export const TEMPLATE_PRESETS: InstructTemplate[] = [
  { name: 'Alpaca', systemPrefix: '', systemSuffix: '\n\n', userPrefix: '### Instruction:\n', userSuffix: '\n\n',
    assistantPrefix: '### Response:\n', assistantSuffix: '\n\n', stop: ['### Instruction:', '### Response:'] },
  { name: 'ChatML', systemPrefix: '<|im_start|>system\n', systemSuffix: '<|im_end|>\n', userPrefix: '<|im_start|>user\n',
    userSuffix: '<|im_end|>\n', assistantPrefix: '<|im_start|>assistant\n', assistantSuffix: '<|im_end|>\n',
    stop: ['<|im_end|>', '<|im_start|>'] },
  { name: 'Llama 3', systemPrefix: '<|start_header_id|>system<|end_header_id|>\n\n', systemSuffix: '<|eot_id|>',
    userPrefix: '<|start_header_id|>user<|end_header_id|>\n\n', userSuffix: '<|eot_id|>',
    assistantPrefix: '<|start_header_id|>assistant<|end_header_id|>\n\n', assistantSuffix: '<|eot_id|>',
    stop: ['<|eot_id|>', '<|start_header_id|>'] },
  { name: 'Mistral', systemPrefix: '[INST] ', systemSuffix: '\n\n', userPrefix: '[INST] ', userSuffix: ' [/INST]',
    assistantPrefix: '', assistantSuffix: '</s>', stop: ['[INST]', '</s>'] },
];
export const DEFAULT_SAMPLERS: Samplers = {
  temperature: 0.7, top_p: 0.92, top_k: 40, min_p: 0.05, rep_pen: 1.1,
  max_length: 300, max_context_length: 4096, stop_sequence: [],
};
