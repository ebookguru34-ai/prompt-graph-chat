# Prompt Graph Nodes Reference

Data flows left to right along wires. Nodes run in dependency order. A node only runs once all of its wired inputs are ready. A branch that a Condition skips is skipped all the way downstream.

Kobold Generate and Persona are the only nodes that call the LLM. Dry-run previews skip them.

---

## I/O

### Chat Input
- **Inputs:** none
- **Outputs:** `message` (the latest user message) and `history` (the full chat history)
- Starting point for the user's turn. Usually you only need `history`, which goes into Chat Prompt. Chat Prompt already adds the user's message from the history, so wiring `message` in as well duplicates it.

### Chat Output
- **Inputs:** `text`
- The final reply that appears in the chat. Only wire your **speaking** LLM into this, never the subconscious or analysis call.

---

## Prompt building

### System Prompt
- **Outputs:** `text`
- **Config:** Text. If you leave it blank, it uses the active **character's** system prompt (see *Characters* below), or the global system prompt from the chat settings when the chat has no character.
- A block of static text. Use it for character sheets, rules and instructions. You can have as many as you like.

### Text Template
- **Inputs:** `a`, `b`, `c`
- **Outputs:** `text`
- **Config:** a template that uses these placeholders:
  - `{{a}}`, `{{b}}` and `{{c}}` are whatever is wired into those inputs
  - `{{user}}` is the latest user message (no wire needed)
  - `{{system}}` is the resolved system prompt: the character's prompt, or the global one when there's no character
  - `{{char}}` is the active character's name (empty when there's no character)
  - `{{greeting}}` is the active character's greeting, with `{{char}}`/`{{user}}` filled in
- Combines several texts into one, for example two system prompts into a single system input. An input that isn't referenced in the template is ignored.

### Chat Prompt
- **Inputs:** `system`, `history`, `memory`
- **Outputs:** `prompt`, a fully formatted prompt for the model
- **Config:**
  - Memory header (default `[Memory]`): placed above the memory text.
  - Trim to context budget: drops the oldest messages until the prompt fits within max context minus max length.
- Builds a multi-turn chat prompt. The structure is `system`, then the memory header and `memory` (both appended to the system message), then the chat history. If `history` isn't wired, it uses the live chat history. Any system messages in the history are removed.

### Instruct Wrap
- **Inputs:** `system`, `user`
- **Outputs:** `prompt`
- **Config:** Assistant prefill, which is text added after the assistant tag, for example `Mara's feelings:`
- Builds a single one-shot exchange (system, then user, then assistant) with no chat history. Good for side tasks like analysis, summarizing or the subconscious pass.

---

## LLM

### Kobold Generate
- **Inputs:** `prompt`
- **Outputs:** `text`
- **Config:**
  - Temperature (blank uses the global setting)
  - Max length (0 uses the global setting)
  - Extra stops (one per line)
  - Stream into chat: turn this **on only for the node whose text is the reply**, and off for hidden passes.
- Sends the prompt to KoboldCPP and returns the completion. Stop sequences and the template's end tag are stripped from the result.

### Persona (3rd party)
- **Inputs:** `text`, `context`
- **Outputs:** `text`
- **Config:**
  - Name
  - Persona system prompt
  - Instruction, which can use `{{text}}`, `{{context}}`, `{{user}}`, `{{system}}`, `{{char}}` and `{{greeting}}`
  - Temperature
  - Max length
  - Stream
- Calls the LLM as a separate character. It builds its own system and user prompt with no chat history. Use it for a critic, narrator, subconscious or judge. By default it acts as an editor that rewrites a draft reply.

---

## Memory
Memory stores are saved in the browser (localStorage) and keep their contents between sessions. You can view or clear a store from the inspector.

**Per-character memory.** Each character has its own stores. In a chat with a character, a store named `notes` is saved under `pgc.mem.<characterId>.notes`, so two characters never see each other's memories. Chats with **no character** use the original keys (`pgc.mem.notes`), so existing memory keeps working. The editor inspector shows the stores of the character in the currently open chat. Rollback on regenerate/edit/delete works the same way inside character stores.

### Memory Read
- **Outputs:** `text`
- **Config:**
  - Store name (default `notes`)
  - Last N entries (0 means all)
  - Join with (default a newline)
- Reads entries from a store as text. Usually it feeds the Chat Prompt's `memory` input.

### Memory Write
- **Inputs:** `text`
- **Outputs:** `text` (passes the input through)
- **Config:**
  - Store name
  - Mode: `append` adds an entry, `replace` keeps only the latest one
  - Keep at most N entries
- Saves text to a store. It doesn't write during dry runs. Example: write the subconscious output to an `inner` store to build up an inner monologue.
- Each entry is tagged with the chat turn (the assistant reply) that wrote it. When you **regenerate** a reply, **delete** a message, or **edit and resend** a message, entries written by the affected turn(s), plus any later turns that get removed, are rolled back automatically before the graph runs again. In `replace` mode the previous value is restored. Entries from older versions are kept as untagged entries and never get rolled back. If "Keep at most N" has already trimmed older entries, rollback can't bring them back.

---

## Profile (dynamic character state)
Each character has a **profile**: fields you define, their current values, and a history of every change. It's saved at `pgc.profile.<characterId>`; chats without a character share `pgc.profile._global`. Edit it under 🎭 → Edit → *Dynamic profile*, or in the inspector when a profile node is selected.

- **Fields:** `key` is a dot path (e.g. `trust.player`), plus a type (`text`, `number`, `list` or `map`), a description (shown to the LLM), min/max for numbers, a default, and 🔒 *locked* (the LLM can't change it, but you can).
- **Commits:** every change is stored as `{turn, ts, source: llm|user|rule, patch, before, after}`. When you **regenerate**, **edit and resend**, or **delete**, the commits from the removed turns are undone, the same way as memory. They stay in the history marked *rolled back*. *Revert to here* undoes every change after the chosen commit.

### Profile
- **Outputs:** `text`, `json` (all values)
- **Config:** a template. `{{profile}}` lists every field as `key: value`, and `{{profile.trust.player}}` inserts one value. `{{char}}`/`{{user}}` also work. The default is `[Current state of {{char}}]` followed by `{{profile}}`.
- Feed it into the system prompt (e.g. through Merge) so the character knows its current state.

### Profile Update (LLM)
- **Inputs:** `context` (e.g. the user message), `text` (e.g. the reply)
- **Outputs:** `applied` (`key: old -> new` lines), `rejected` (keys and why), `json`
- **Config:** temperature (default 0.2), max length, extra instructions
- Asks the model for a JSON patch only, giving it the editable fields with their types and ranges, the current values and the exchange. The parser is forgiving: it strips `<think>` and code fences, takes the first JSON object, and allows trailing commas. Every key is checked against the schema: unknown and locked keys are rejected, numbers are clamped to min/max, and deltas like `"+5"`/`"-3"` are allowed. Lists accept a full array, `"+item"`/`"-item"`, or `{add, remove}`. Maps are merged, and `null` deletes a key. Accepted changes are committed with the current turn. It never streams and is skipped in dry runs.

### Stats
- **Outputs:** `text` (`key: value` lines), `json`
- **Config:** keys (comma separated; blank means all number fields), and per-turn rules, one per line:
  - `energy decay 2` lowers the value by 2 each turn (clamped to min)
  - `trust.player -> 50 by 1` moves the value 1 per turn toward 50
- Rules run once per turn as a `rule` commit, which is rolled back with the turn. They don't run in dry runs.

## Logic

### Merge
- **Inputs:** `a`, `b`
- **Outputs:** `text`
- **Config:** Template (default `{{a}}\n\n{{b}}`)
- Joins two texts. It's a smaller version of Text Template. Besides `{{a}}` and `{{b}}`, it also accepts `{{user}}`, `{{system}}`, `{{char}}` and `{{greeting}}`.

### Regex Transform
- **Inputs:** `text`
- **Outputs:** `text`
- **Config:**
  - Pattern
  - Flags (default `g`)
  - Replace with (`\n` is allowed)
- Find and replace on the text. Useful patterns:
  - `<think>[\s\S]*?</think>` replaced with nothing strips reasoning tags.
  - `^\s+|\s+$` replaced with nothing trims whitespace.

### Condition
- **Inputs:** `text`
- **Outputs:** `match`, `else`
- **Config:** Regex (case-insensitive, default `remember|note`)
- Routes the text to `match` if the pattern is found, otherwise to `else`. The branch that isn't taken is skipped downstream, including any LLM calls on it.

---

### Compare
- **Inputs:** `text` (optional, passed through)
- **Outputs:** `match`, `else`
- **Config:** profile path, operator (`<` `<=` `>` `>=` `==` `!=`), value
- Branches on a profile value, e.g. `trust.player < 20`. It compares as numbers when both sides are numeric, and as text otherwise. The unused branch is skipped, like Condition.

## Recipe: subconscious, then speaker

```
Chat Input.history ─────────────────────────────┐
System Prompt (subconscious rules) ─► Chat Prompt A ─► Generate #1 (stream OFF, temp ~1.0)
                                                          │ text
                                                          ▼  (optional Regex: strip <think>)
System Prompt (Mara character) ─► Chat Prompt B.system   Chat Prompt B.memory  (header "[Inner guidance — never mention]")
Chat Input.history ─────────────► Chat Prompt B.history
Chat Prompt B ─► Generate #2 (stream ON, temp ~0.7) ─► Chat Output
```

## Characters
The 🎭 library holds roleplay characters. Each one has a name, an optional avatar, a system prompt (character sheet), a greeting, optional example dialogue, an optional default graph, and its own memory stores.

- **Prompt resolution.** In a chat with a character, the system prompt is the character sheet with `{{char}}`/`{{user}}` replaced (`{{user}}` is "Your name" in Settings). If there's example dialogue, it is appended under an `[Example dialogue]` header. Blank System Prompt nodes and `{{system}}` use this. Without a character, the global system prompt is used.
- **Greeting.** A new chat with a character starts with the greeting as the first assistant message.
- **Default graph.** If the character has a default graph (an example graph or a saved copy of an editor graph), its chats run that graph instead of the one in the editor.
- **Import/export.** Export saves our own JSON. Import accepts our JSON and SillyTavern/TavernAI cards: JSON (V1 fields, or V2/V3 with `data{...}`) and PNG cards (a `chara` or `ccv3` text chunk). Description, personality and scenario go into the system prompt, `first_mes` becomes the greeting, `mes_example` becomes the example dialogue, and the PNG becomes the avatar.

## Example graph: Dynamic profile
Chat Input → Chat Prompt. System Prompt + Profile → Merge → Chat Prompt `system`. Chat Prompt → Generate → Chat Output. Generate's reply plus the user's message → Profile Update. Load it from *Load example* in the editor, then add fields (or click *Add example fields*) in the character's profile.
