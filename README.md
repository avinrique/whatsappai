# WhatsApp AI Agent

An AI-powered WhatsApp agent that learns your texting style and replies as you. It builds detailed relationship profiles for each contact, generates replies using a 5-step chain-of-thought engine, and supports scheduled messages, self-chat commands, and a full web dashboard.

## How It Works

1. Connect your WhatsApp by scanning a QR code
2. Import chat history (live fetch or upload `.zip` exports)
3. Build style profiles — the AI analyzes how you text each person
4. Enable auto-reply for specific contacts
5. The AI replies in your exact style: same language, slang, spelling, message length, and mood

```
Message arrives → Store in DB → Debounce (4s) → Describe images (if any)
→ Chain-of-Thought (Think → Decide → Write → Verify → Rewrite)
→ Smart delay (mimics your reply timing) → Send → Store reply
```

## Features

### Chain-of-Thought Reply Engine
Not a simple "generate reply" — it's a 5-step reasoning pipeline:

| Step | What it does |
|------|-------------|
| **Think** | Deep dialogue analysis — traces who said what, what's being responded to, what's expected next |
| **Decide** | Determines intent, length, language, and picks real messages as style templates |
| **Write** | Generates the reply in your exact texting style |
| **Verify** | Quality check — fails if too long, wrong language, repetitive, or sounds like AI |
| **Rewrite** | Fixes failed replies using verifier feedback (up to 2 retries) |

If all retries fail, no message is sent. Better to stay silent than send a bad reply.

### Style Profiler
Builds a comprehensive "relationship document" for each contact by analyzing your chat history:

- **Language & Word Choices** — exact pronouns, verb forms, spelling fingerprints, slang
- **Mood-based patterns** — how you text when happy, annoyed, caring, joking, busy
- **Response patterns** — how you reply to questions, news, jokes, images, plans
- **Conversation dynamics** — who initiates, how chats start and end

Two-pass analysis with verification: first pass extracts patterns, second pass catches everything missed, then a quality audit patches weak sections with real examples.

### Alex — Self-Chat Commands
Text yourself commands ending with a trigger word (default: `alex`):

```
"tell ayush to come at 5, alex"
→ Generates message in your style with Ayush → sends immediately

"send mom a good morning message tomorrow at 8, alex"
→ Schedules for tomorrow 8am → generates at send time

"turn on auto-reply for priya, alex"
→ Enables auto-reply for Priya
```

- Fuzzy contact matching across all WhatsApp contacts
- If multiple contacts match, Alex asks you to pick (just reply with a number)
- Confirmation sent to self-chat after every command

### Auto-Reply
- **Debouncing** — waits 4 seconds after last message, replies to all at once
- **Image understanding** — describes images with vision model before replying
- **Smart delays** — uses your actual reply timing patterns from the style profile
- **Typing simulation** — sends "typing..." indicator, pauses proportional to message length
- **Emergency detection** — flags distress keywords (multi-language) and alerts you

### Scheduler
- Schedule messages for specific times
- Two modes: send literal text, or generate from instruction at send time (style stays fresh)
- Natural language time parsing: "at 8pm", "tomorrow morning", "in 2 hours"
- Persistent — survives restarts

### Web Dashboard
Full-featured dashboard at `http://localhost:3000`:

- **Chats** — browse conversations, view recent messages
- **Import** — import from WhatsApp or upload `.zip` chat exports
- **Auto-Reply** — enable/disable per contact
- **Profiles** — view, edit, and rebuild style documents with profile Q&A
- **Scheduler** — create and manage scheduled messages
- **Settings** — configure LLM provider, model, API keys, trigger word

Real-time updates via Socket.io (incoming messages, import progress, profile building).

### CLI Commands

| Command | Description |
|---------|-------------|
| `/text <name> <msg>` | Send exact message to contact |
| `/reply <#> <msg>` | Reply to a recent chat |
| `/send <phone> <msg>` | Send to phone number |
| `/ask <name> <msg>` | Preview AI reply without sending |
| `/chats` | List recent chats |
| `/history <#> [count]` | Fetch past messages |
| `/import` | Interactive import wizard |
| `/autoreply add/remove/list` | Manage auto-reply contacts |
| `/style <name>` | View or rebuild style profile |
| `/schedule <name> <time> <msg>` | Schedule a message |
| `/schedule list` / `/schedule cancel <id>` | Manage scheduled messages |
| `/stats` | System statistics |
| `/config <key> <value>` | Update configuration |
| `/exclude <name>` | Exclude chat from imports |

## Setup

### Prerequisites
- Node.js 18+
- A WhatsApp account
- OpenAI API key **or** [Ollama](https://ollama.ai) running locally

### Install

```bash
git clone https://github.com/avinrique/whatsappai.git
cd whatsappai
npm install
```

### Configure

Create a `.env` file:

```bash
OPENAI_API_KEY=sk-your-key-here   # Required for OpenAI provider
WEB_PORT=3000                      # Dashboard port (default: 3000)
```

Or use Ollama (no API key needed):

```bash
# Pull a model first
ollama pull gemma3:4b

# Set in .env or dashboard settings
LLM_PROVIDER=ollama
OLLAMA_MODEL=gemma3:4b
OLLAMA_HOST=http://localhost:11434
```

### Run

```bash
node index.js
```

1. Scan the QR code with WhatsApp (Link a Device)
2. Open `http://localhost:3000` for the dashboard
3. Import chat history for contacts you want to auto-reply to
4. Build style profiles
5. Enable auto-reply

## Configuration

All settings can be changed via the dashboard or CLI (`/config`):

| Setting | Default | Description |
|---------|---------|-------------|
| `llmProvider` | `openai` | `openai` or `ollama` |
| `openaiModel` | `gpt-4o` | OpenAI model name |
| `ollamaModel` | `llama3` | Ollama model name |
| `ollamaHost` | `http://localhost:11434` | Ollama server URL |
| `userName` | `Avin` | Your name (used in style prompts) |
| `triggerWord` | `alex` | Self-chat command trigger word |

## Tech Stack

- **WhatsApp**: [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)
- **LLM**: OpenAI GPT-4o / Ollama (any local model)
- **Vector DB**: [LanceDB](https://lancedb.com/) (Rust-backed, embedded)
- **Embeddings**: HuggingFace all-MiniLM-L6-v2 (384-dim, runs locally)
- **Web**: Express 5 + Socket.io
- **Scheduler**: node-schedule
- **Frontend**: Vanilla JS SPA

## Project Structure

```
whatsweb/
├── index.js                    # Entry point — startup, event loops, CLI
├── src/
│   ├── agent/
│   │   ├── chain.js            # 5-step chain-of-thought reply engine
│   │   ├── agent.js            # Reply generation (basic + instruction modes)
│   │   ├── auto-reply.js       # Debouncing, image handling, smart delays
│   │   ├── alex.js             # Self-chat command system
│   │   ├── style-profiler.js   # Relationship document builder
│   │   └── llm.js              # OpenAI / Ollama abstraction
│   ├── data/
│   │   ├── vectordb.js         # LanceDB storage & semantic search
│   │   ├── embeddings.js       # Local embedding model
│   │   ├── importer.js         # WhatsApp chat import
│   │   └── chat-parser.js      # WhatsApp export ZIP parser (all formats)
│   ├── web/
│   │   ├── server.js           # Express + Socket.io
│   │   └── routes/             # REST API (chats, import, autoreply, profiles, scheduler, config, stats)
│   ├── scheduler/
│   │   └── scheduler.js        # Scheduled message execution
│   ├── config/
│   │   └── config.js           # Configuration management
│   └── whatsapp/
│       └── client.js           # WhatsApp client wrapper
├── public/                     # Dashboard frontend (SPA)
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js              # Router
│       ├── api.js              # API client
│       └── components/         # Chats, Import, AutoReply, Profiles, Scheduler, Settings
└── data/                       # Runtime data (gitignored)
    ├── config.json
    ├── style-profiles/
    ├── lancedb/
    └── chain-logs/
```

## License

MIT
