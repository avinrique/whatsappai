# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

WhatsApp AI Agent — learns your texting style from chat history and auto-replies as you. Uses a 5-step chain-of-thought pipeline (Think → Decide → Write → Verify → Rewrite) to generate replies that match your exact style per contact.

## Commands

```bash
# Run the app (starts WhatsApp client + web dashboard on port 3000)
node index.js

# Install dependencies
npm install
```

There are no test, lint, or build scripts configured. The project runs directly with Node.js (CommonJS modules).

## Architecture

### Entry Point & Event Flow

`index.js` is the entry point. It initializes config, creates the WhatsApp client, starts the Express web server, and sets up three event loops:
- `client.on('message')` → stores message in vectordb → runs auto-reply debounce pipeline
- `client.on('message_create')` → handles outgoing messages, Alex self-chat commands
- `rl.on('line')` → CLI command handler

### Agent Layer (`src/agent/`)

The reply pipeline has two modes:
- **Chain-of-thought** (`chain.js`) — primary path for auto-replies. Five separate LLM calls: `think()` → `decide()` → `write()` → `verify()` → `rewrite()`. If verify fails all retries, returns `null` and NO message is sent.
- **Basic** (`agent.js`) — fallback if chain fails. Single LLM call. Also handles instruction-mode generation for scheduled messages (`generateFromInstruction`).

`auto-reply.js` orchestrates the full flow: debounces incoming messages (4s window), describes images via vision API, runs chain-of-thought, simulates typing delay, sends reply.

`style-profiler.js` builds per-contact "relationship documents" by analyzing chat history in chunks. Two-pass analysis with verification. Documents are stored as markdown files in `data/style-profiles/`.

`alex.js` handles self-chat commands (messages to yourself ending with trigger word). Supports fuzzy contact matching, message sending, scheduling, and auto-reply toggling.

### LLM Abstraction (`src/agent/llm.js`)

`callLLM()` routes to OpenAI or Ollama based on config. Falls back to Ollama if no OpenAI key. Vision variants (`callLLMWithVision`) support both providers. Uses the `openai` npm package for OpenAI and raw `fetch` for Ollama's `/api/chat` endpoint.

### Data Layer (`src/data/`)

- `vectordb.js` — LanceDB (embedded, Rust-backed). 384-dim vectors. Stores all messages with embeddings for semantic search. Has a `queryRows()` abstraction that tries LanceDB's `.query()` API first, falls back to fetching all rows + JS filtering.
- `embeddings.js` — HuggingFace `all-MiniLM-L6-v2` running locally via `@huggingface/transformers`.
- `importer.js` / `chat-parser.js` — WhatsApp chat import from live fetch or `.zip` export files. Parser handles multiple date/time formats.

### Web Layer (`src/web/`)

Express 5 + Socket.io. `server.js` creates the server, mounts route modules, and bridges WhatsApp events to Socket.io for real-time updates.

REST API routes under `/api/`: `chats`, `import`, `autoreply`, `profiles`, `scheduler`, `config`, `stats`.

Frontend is a vanilla JS SPA in `public/` — `app.js` handles routing, `api.js` is the API client, `components/` has one file per page.

### Config (`src/config/config.js`)

JSON file at `data/config.json`. Loaded once at startup, written on every `set()`. Manages auto-reply contact list, LLM settings, scheduler state. Key settings: `llmProvider`, `openaiModel`, `ollamaModel`, `userName`, `triggerWord`.

### Runtime Data (`data/`)

Gitignored. Contains `config.json`, `lancedb/` (vector database), `style-profiles/` (markdown docs + meta JSON), `chain-logs/` (per-reply debug logs), `uploads/` (temp import files).

## Key Design Rules

- If the chain-of-thought verifier rejects all retries, return `null` — never send a bad message. Callers check for `null` and skip sending.
- Auto-reply filler detection: single words under 8 chars are filtered from style stats to prevent feedback loops.
- Messages tagged `[AI-GENERATED]` in conversation flow are excluded from style examples.
- Emergency keywords trigger Socket.io alerts and allow longer replies (up to 15 words).
- Outgoing messages are stored with ID prefixes (`auto_`, `web_`, `out_`) — duplicate detection checks both ID and content.
