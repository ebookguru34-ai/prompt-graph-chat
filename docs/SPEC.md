# Prompt Graph Studio — Spec v0.1

A visual node editor for building and testing LLM prompt chains, memory streams and third-party prompting, running against KoboldCPP.

## 1. Goals
- Wire prompt logic visually instead of in code.
- Run the graph on every chat message and inspect every node's input/output.
- Compare memory strategies and multi-persona setups side by side.
- Non-goals for v0: auth, multi-user, cloud hosting, tool calling.

## 2. Backend: KoboldCPP
- Native API: `POST http://localhost:5001/api/v1/generate`
  - Body: `prompt`, `max_length`, `max_context_length`, `temperature`, `top_p`, `top_k`, `rep_pen`, `stop_sequence[]`
  - Returns `results[0].text`
- Streaming (later): `POST /api/extra/generate/stream` (SSE)
- Token counting: `POST /api/extra/tokencount`
- Health/model: `GET /api/v1/model`
- A tiny local proxy forwards `/api/*` to the Kobold URL to avoid CORS issues.

## 3. Core concepts
- **Graph**: nodes + edges, saved as JSON.
- **Node**: typed unit with input ports, output ports and config.
- **Run**: one execution of the graph, triggered by a chat message. Produces a trace.
- **Context**: per-run variables (`{{user_input}}`, `{{history}}`, node outputs by id).
- **Memory store**: named, persistent across runs (per session).

## 4. Node types
### v0 (MVP)
| Node | Inputs | Outputs | Config |
|---|---|---|---|
| Chat Input | — | `text` | — |
| Prompt Template | any vars | `prompt` | template text with `{{var}}` slots |
| Kobold Generate | `prompt` | `text` | samplers, max_length, stop sequences |
| Chat Output | `text` | — | display name/persona |

### v1
| Node | Purpose |
|---|---|
| Memory Write | append text to a named store |
| Memory Read | read store: last N, full, or summary |
| Rolling Summary | LLM-summarizes history when over a token budget |
| Persona (third party) | wraps a generate call with its own system prompt, e.g. critic, editor, narrator |
| Router / Condition | branch on regex, keyword, or an LLM yes/no classification |
| Merge / Join | combine multiple texts with a template |
| Transform | trim, regex replace, JSON extract |
| Note | comment-only, not executed |

### v2
- Vector Recall (embeddings + similarity search)
- Loop / Retry-until (e.g. critique, rewrite until score ≥ X)
- Sub-graph (reuse a graph as one node)
- Variables / constants panel

## 5. Graph file format
```json
{
  "version": 1,
  "name": "critic-rewrite",
  "settings": { "koboldUrl": "http://localhost:5001" },
  "nodes": [
    { "id": "in",   "type": "chat_input", "pos": [0, 0] },
    { "id": "tpl",  "type": "prompt_template", "pos": [240, 0],
      "config": { "template": "### Instruction:\n{{user_input}}\n### Response:\n" } },
    { "id": "gen",  "type": "kobold_generate", "pos": [480, 0],
      "config": { "max_length": 200, "temperature": 0.7, "stop_sequence": ["###"] } },
    { "id": "out",  "type": "chat_output", "pos": [720, 0] }
  ],
  "edges": [
    { "from": "in.text",    "to": "tpl.user_input" },
    { "from": "tpl.prompt", "to": "gen.prompt" },
    { "from": "gen.text",   "to": "out.text" }
  ],
  "memory": { "stores": ["log", "summary"] }
}
```

## 6. Execution model
1. User sends a message; Chat Input node emits it.
2. Engine topologically sorts nodes reachable from inputs (cycles only via explicit Loop nodes).
3. Each node runs when all required inputs resolve; independent branches run in parallel.
4. Each node writes a trace entry: inputs, resolved prompt, config, output, tokens, duration, errors.
5. Chat Output nodes post to the chat pane (multiple outputs = multiple speakers).
6. Memory Write nodes persist at the end of the run.

## 7. UI layout
- **Left**: node palette (drag onto canvas).
- **Center**: canvas (pan, zoom, wire ports, multi-select).
- **Right**: inspector for the selected node (config + last input/output).
- **Bottom or side**: chat pane + run trace timeline (click a step to highlight its node).
- **Top bar**: graph name, save/load JSON, Kobold URL + connection status, run/stop.

## 8. Tech stack
- Vite + React + TypeScript
- React Flow for the canvas
- Zustand for state
- localStorage for graphs and memory in v0; IndexedDB later
- Small Node proxy for KoboldCPP

## 9. Milestones
1. **M0**: canvas + 4 MVP nodes + chat pane + trace. One linear chain works end to end.
2. **M1**: memory read/write, rolling summary, persona node, router.
3. **M2**: save/load/share graphs, starter templates (critic-rewrite, narrator + character, summary memory).
4. **M3**: streaming, token budgets per node, vector recall, sub-graphs.

## 10. Open questions
- Should "third party prompting" also mean a second, independent Kobold instance or model?
- Should memory be per chat session, per graph, or global?
- Do you want a raw prompt preview that shows the exact final text sent to Kobold (recommended: yes)?
