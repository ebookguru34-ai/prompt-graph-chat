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

### Summarize (LLM)
- **Inputs:** `text` or `history` (if neither is wired, it uses the chat history)
- **Outputs:** `text`
- **Config:** token threshold, target length (words), instruction (`{{text}}`, `{{target}}`, `{{char}}`, `{{user}}`), optional memory store, temperature, max length
- If the input is at or below the threshold (estimated as chars/4), it is passed through unchanged and the LLM isn't called. Above the threshold it asks for a summary of about the target length.
- With a store set, the summary is saved in `replace` mode, tagged with the turn, so regenerate/edit/delete restore the previous summary.
- It never streams and is skipped in dry runs.

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

### Memory Search
- **Inputs:** `query` (optional; defaults to the latest user message)
- **Outputs:** `text` (the best-matching entries joined together)
- **Config:** store, Top K, method (`keyword` or `embeddings`), join with
- **Keyword** uses BM25-style ranking with no extra downloads.
- **Embeddings** calls KoboldCPP's OpenAI-compatible `/v1/embeddings` through the local proxy (load an embeddings model in KoboldCPP). Vectors are cached in the browser (`pgc.emb.<hash>`), so each entry is embedded only once. On any error it falls back to keyword, and the trace notes why. Live previews (dry runs) always use keyword.
- It searches the active character's stores, the same as Memory Read.

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

### Every N
- **Inputs:** `text` (optional, passed through unchanged; history works too)
- **Outputs:** `text`, `turn`
- **Config:** mode and its numbers:
  - `every N turns`: fires at turns offset+N, offset+2N, …
  - `after turn X`: fires on every turn after X
  - `once at turn X`: fires only at turn X
  - `between X-Y`: fires from X to Y, inclusive
- The turn number is the number of assistant messages already in the chat plus one (a character greeting counts). It's worked out from the history, so **regenerate doesn't advance it**. When it doesn't fire, everything downstream is skipped.

### Manual Trigger
- **Inputs:** `text` (optional; defaults to the latest user message)
- **Outputs:** `text`
- **Config:** button label, plus a behavior:
  - `arm for next message`: pressing the button arms it (●, highlighted) and pressing again disarms it. On the next message it lets its input through once, then disarms. When it isn't armed, its branch is skipped.
  - `run now`: runs the graph immediately with no new user message. If a Chat Output is reached, the reply is added as an assistant message. Otherwise only memory/profile change, and a short notice appears. Those writes are tagged with the last message, so rollback still covers them.
- Every Manual Trigger in the graph the chat runs gets a button above the message box.

### JSON Extract
- **Inputs:** `text`
- **Outputs:** `value` (first path), `all` (`path: value` lines)
- **Config:** dot paths (one per line), fallback
- Finds the first JSON object in the text, using the same forgiving parser as Profile Update (it strips `<think>` and code fences). A missing path, or no JSON at all, gives the fallback.

### Lorebook
- **Inputs:** `text` (optional, scanned together with the chat)
- **Outputs:** `text` (matched entries under the header), `fired` (one line per matched entry: ✓ included / ✗ over budget, with the reason)
- **Config:** books (`character + global`, `character`, `global`), scan last N messages (default 4), token budget (default 500, 0 = unlimited), header (default `[World info]`), joiner
- Keyword world info. The node scans the last N chat messages, plus the wired text, against every enabled entry of the active character's lorebook and the global lorebook. An entry fires when any of its keys appears, or always when it's **always on**.
  - Keys are case-insensitive unless the entry is case-sensitive.
  - **Whole word** (the default) means `sword` doesn't fire on `swords`.
  - A key written `/like this/i` is a regex.
- Matched entries are sorted by **priority** (high first; ties keep book order, character before global). They're added while the joined text fits the token budget; an entry that doesn't fit is skipped and the next one is tried.
- Edit books in 📚 **Knowledge** (global) and in the character editor (per character).
- **Knowledge packs:** pack (`all enabled`, `none`, `selected` + comma-separated pack ids) and pack knowledge level (`basic`, `advanced`). See [Knowledge packs](#knowledge-packs). With `none`, or with no pack on, the node behaves exactly as without packs.
  - Pack articles fire on their title, aliases and retrieval phrases (case-insensitive, whole word) at priority 50, below the default 100 of your own entries, so your lore wins the budget. `fired` shows them as `(pack:<id>)`.

### RAG Retrieve
- **Inputs:** `query` (optional; defaults to the latest user message)
- **Outputs:** `text` (best chunks under the header), `sources` (`✓ doc #chunk (scope) score` per hit)
- **Config:** collections (`character + global`, `character`, `global`), method (`hybrid`, `embeddings`, `keyword`), add last N earlier messages to the query, top K (4), min score (0), token budget (600), header (`[Reference]`), joiner
- Semantic search over document collections.
  - **Embeddings:** chunks are embedded with KoboldCPP's `/v1/embeddings` (through the proxy; load an embeddings model). Vectors are cached per chunk text hash (`pgc.emb.*`).
  - **Hybrid** (default): `0.7 × cosine + 0.3 × BM25 / best BM25`.
  - **Keyword:** BM25 only. If embeddings fail (no model loaded), the node falls back to keyword automatically and notes it in the trace. Dry runs always use keyword.
- Hits below the min score are dropped. Top K are added while they fit the budget. With keyword search, the min score applies to raw BM25 scores, which aren't 0–1.
- **Knowledge packs:** pack (`all enabled`, `none`, `selected` + comma-separated pack ids) and pack knowledge level (`basic`, `advanced`). See [Knowledge packs](#knowledge-packs). With `none`, or with no pack on, the node behaves exactly as without packs.
  - Each pack article is one chunk. It is scored on title + keys + text and injects only the text. Its vector comes from `title + aliases + basic text` and is cached per article checksum.
  - Missing pack vectors: if up to 64 articles lack vectors they are embedded on the fly; otherwise those articles score by keyword only (cosine 0) and the trace notes it. Embed the pack in Knowledge → Packs first.

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

## Knowledge: lorebooks and documents
The 📚 button in the chat view opens the **global** lorebook and document collection, which are used in every chat. Each character also has its own lorebook and documents in the character editor. Storage keys: `pgc.lore.<charId|_global>` and `pgc.rag.<charId|_global>`.

- **Lorebook entries:** title, keys, content, enabled, always on, priority, case-sensitive, whole word.
  - **Import:** SillyTavern world info JSON, or a V2/V3 card JSON with `character_book`.
  - **Export:** SillyTavern world info JSON.
  - Importing a character card (JSON or PNG) also imports its `character_book` into that character's lorebook, and our character export includes the lorebook.
  - The editor has a test box that shows which entries fire for a piece of text.
- **Documents:** import `.txt` / `.md` files or paste text.
  - Chunking: text is split into chunks at markdown headings and paragraphs, packed up to the chunk size (default 800 chars), and long paragraphs are split by sentence. Each chunk carries an overlap (default 100 chars) of the previous one, plus its section heading.
  - The list shows chunks and embedded counts per document, with **Embed all**, **Re-embed** (drops cached vectors first), **Delete** and a chunk preview.

## Example graph: Lorebook + RAG
Lorebook (last 4 messages) and RAG Retrieve (hybrid, the user's message plus the previous message) → Merge → Chat Prompt `memory` (header blank, since both nodes add their own). System Prompt and the history feed Chat Prompt as usual → Generate → Chat Output.

## Example graph: Dynamic profile
Chat Input → Chat Prompt. System Prompt + Profile → Merge → Chat Prompt `system`. Chat Prompt → Generate → Chat Output. Generate's reply plus the user's message → Profile Update. Load it from *Load example* in the editor, then add fields (or click *Add example fields*) in the character's profile.

## Example graph: Long chat: rolling summary + recall
Every user message is saved to `notes` (Memory Write). Every 5 turns, **Every N** passes the history to **Summarize**, which, once the chat is over about 600 tokens, writes a summary to the `summary` store. Each reply's system prompt (Text Template) combines the system prompt, the latest summary (Memory Read, last 1), and the notes most relevant to the new message (**Memory Search**, keyword, top 3).

## Knowledge packs
Read-only lore sets you install, separate from your own lorebooks and documents. Example: the Skyrim **Oghma Infinium** catalog from CHIM / HerikaServer (1,562 articles), built with `tools/oghma_to_pack.py` from the graph compiler repo.

- **Install:** 📚 Knowledge → 📦 Packs → *Install pack…* (a `pgc-knowledge-pack` `.json`, or a `.zip` containing one). Installing a pack with the same id replaces it. Pack data and vectors are stored in IndexedDB (`pgc-packs`), not localStorage.
- **On / off:** each pack has a global toggle (on after install). In the character editor, *Knowledge packs* sets a per-character override: `inherit`, `on` or `off`.
- **Categories:** checkboxes per category with entry counts, grouped by topic type (books, figures & gods, spells, items, armor & weapons, artifacts, creatures), locations (one per hold, plus Solstheim and other) and knowledge tier (general vs esoteric). An article is used only if all its categories are on.
- **Knowledge level** is a node option. `basic` uses what an ordinary person knows (Oghma `topic_desc_basic`); `advanced` uses the specialist text (`topic_desc`).
- **Embed:** computes vectors for RAG through KoboldCPP, with a progress bar and *Cancel*. It resumes where it stopped, and only missing checksums are embedded. *Re-embed* starts over.
- **Browse:** search titles, keys and tags; click an article for its basic and advanced text. *License & attribution* shows the pack's source, license notice and full license text.
- **Uninstall** removes the pack data, its vectors, its settings and every character override for it.
- **Off means off.** A pack that is off, deselected by the node (`packs: none`), overridden off for the character, or has all its categories off adds nothing. It doesn't fire lore, doesn't join the RAG corpus (so it doesn't shift BM25 scores) and makes no embedding calls.
- Settings keys: `pgc.packs.settings` (`{id: {enabled, cats}}`) and `pgc.packs.char.<charId>` (`{id: "on"|"off"}`).
