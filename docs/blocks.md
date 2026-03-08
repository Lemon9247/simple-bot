# Block Protocol

Structured content and interactive prompts between the agent and listeners.

## How It Works

```
Agent ──tool call──▶ Extension ──HTTP──▶ Nest API ──broadcast──▶ Listeners
                     Extension ◀──HTTP── Nest API ◀──response── Listener
```

1. **Agent calls a tool** — e.g. `attach({ path: "/tmp/chart.png" })` or `discord_confirm({ text: "Deploy?" })`
2. **Extension POSTs to nest** — `POST /api/block` with the block payload
3. **Kernel broadcasts** — to all listeners on the session, with fallback text
4. **Each listener renders** — CLI shows inline image, Discord sends attachment, etc.

For interactive prompts, the HTTP request **holds open** until the user responds or a timeout expires.

## Block Type

```typescript
interface Block {
    id: string;                       // unique ID
    kind: string;                     // renderer hint
    data: Record<string, unknown>;    // kind-specific payload
    ref?: string;                     // URL to fetch binary data
    fallback: string;                 // plain text fallback
}
```

Binary data (images, files) is stored in a temporary block store. The block carries a `ref` URL; listeners fetch the data only if they need it.

## Display Blocks

| Kind | Data Fields | Rendering |
|------|-------------|-----------|
| `image` | `mimeType`, `filename` | CLI: inline terminal image. Discord: attachment |
| `markdown` | `text` | Markdown rendering |
| `code` | `text`, `language?` | Fenced code block |
| `table` | `columns`, `rows` | Pipe table |
| `progress` | `value`, `total`, `label?` | Progress bar |
| `status` | `items: [{label, value}]` | Status line |

Unknown block kinds render their `fallback` as text.

## Interactive Prompts

| Kind | Data Fields | Response |
|------|-------------|----------|
| `confirm` | `text`, `default?` | `{ value: true/false }` |
| `select` | `text`, `items`, `maxVisible?` | `{ value: "selected" }` |
| `input` | `text`, `placeholder?` | `{ value: "typed text" }` |

Platform-specific: Discord renders `confirm` as buttons and `select` as dropdown menus via `discord_confirm` and `discord_select` tools. CLI renders overlays with keyboard input.

## HTTP Endpoints

```
POST /api/block           — send a block (display or prompt)
POST /api/block/upload    — multipart binary upload (images, files)
POST /api/block/update    — update an existing block
POST /api/block/remove    — remove a block
GET  /api/block/data/:id  — fetch binary data by ref
```

All endpoints require `Authorization: Bearer <SERVER_TOKEN>`.

## WebSocket Protocol (CLI)

**Server → Client:**
```json
{ "type": "block", "id": "img-1", "kind": "image", "data": {...}, "fallback": "..." }
{ "type": "block_update", "id": "img-1", "data": {...} }
{ "type": "block_remove", "id": "img-1" }
{ "type": "prompt", "id": "p-1", "kind": "confirm", "data": {...} }
{ "type": "prompt_cancel", "id": "p-1" }
```

**Client → Server:**
```json
{ "type": "response", "id": "p-1", "value": true }
{ "type": "response", "id": "p-1", "cancelled": true }
```
