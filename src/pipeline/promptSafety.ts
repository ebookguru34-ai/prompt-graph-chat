import type { InstructTemplate, Message } from '../types';

/** Stop sequences that keep the model from writing the user's turn: template stops, the user prefix,
 *  and plain "User:" / "<name>:" turn tags. */
export function turnStops(t: InstructTemplate, userName = 'User'): string[] {
  const up = t.userPrefix.trim();
  const names = Array.from(new Set(['User', userName.trim()].filter(Boolean)));
  return Array.from(new Set([...t.stop, up, ...names.map((n) => '\n' + n + ':')].filter((x) => x && x.trim())));
}

/** True if `prompt` was already rendered with the instruct template. */
export function isRendered(prompt: string, t: InstructTemplate) {
  return [t.assistantPrefix, t.userPrefix, t.userSuffix, t.systemPrefix].map((x) => x.trim()).some((x) => x && prompt.includes(x));
}

/** Make sure a prompt ends with the assistant cue. Raw text (e.g. a Text Template wired straight into
 *  Generate) is wrapped as a user turn; a rendered prompt ending in an open user turn is closed. */
export function ensureAssistantCue(prompt: string, t: InstructTemplate, render: (m: Message[], t: InstructTemplate) => string): string {
  if (!prompt.trim()) return prompt;
  if (!isRendered(prompt, t)) return render([{ id: 'u', role: 'user', content: prompt.trim() }], t);
  const ap = t.assistantPrefix;
  if (!ap || prompt.endsWith(ap) || prompt.trimEnd().endsWith(ap.trim())) return prompt;
  // Rendered, but the assistant cue isn't last. If the last turn opened is the assistant's (e.g. Instruct Wrap
  // prefill), the model continues it on purpose; otherwise close the user turn and cue the assistant.
  const lastA = prompt.lastIndexOf(ap.trim()), lastU = prompt.lastIndexOf(t.userPrefix.trim()), lastUS = t.userSuffix.trim() ? prompt.lastIndexOf(t.userSuffix.trim()) : -1;
  if (lastA > lastU && lastA > lastUS) return prompt;
  const closed = t.userSuffix.trim() && lastUS > lastU ? prompt : prompt.trimEnd() + t.userSuffix;
  return closed + ap;
}

/** Remove a leading echo of the user's message (model repeating/continuing it) from the reply. */
export function stripEcho(text: string, lastUser: string, userName = 'User'): string {
  let out = text.trimStart();
  for (const n of Array.from(new Set(['User', userName]))) if (out.startsWith(n + ':')) out = out.slice(n.length + 1).trimStart();
  const u = lastUser.trim();
  if (u.length >= 2 && out.startsWith(u)) out = out.slice(u.length).replace(/^[\s:,.!?-]+/, (m) => (m.trim() ? '' : m)).trimStart();
  return out;
}
