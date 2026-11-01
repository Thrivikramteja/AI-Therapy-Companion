# Suzie Virtual Therapy Companion — Backend Service

Backend service for **Suzie**, an AI-driven desktop virtual wellness companion.
This service handles:
- Structured LLM conversation via Groq / Ollama / local fallbacks
- Speech-To-Text (STT) transcription (WAV multipart upload)
- Text-To-Speech (TTS) 24 kHz mono WAV synthesis (Kokoro-js ONNX / system fallbacks)
- Cross-session durable memory extraction and active memory injection
- Note-taking extraction with frequency throttling
- Multi-layer deterministic keyword & LLM safety checks with scripted crisis intervention
- Session persistence, message logs, and safe data deletion

---

## 1. Requirements

- **Node.js**: >= 20.0.0 (Node 20 pinned via `.nvmrc` and `engines`)
- **npm**: >= 9.0.0
- **Supported OS**: Windows 10/11 (Primary Demo Target) & macOS (Development)

---

## 2. Quick Setup

### On Windows:
1. Clone the repository or extract the `Backend` directory.
2. Ensure Node.js 20+ is installed (`node -v`).
3. Double-click `start.bat` (or run `start.bat` in Command Prompt / PowerShell).
   - This automatically runs `npm ci`, sets up `.env` from `.env.example`, and starts the server on `http://127.0.0.1:3000`.

### On macOS / Linux:
```bash
cd Backend
# Install exact dependencies from package-lock.json
npm ci

# Setup environment config
cp .env.example .env

# Start the server
npm start
```

---

## 3. Configuration (.env)

Edit `.env` as needed:

```ini
PORT=3000
HOST=127.0.0.1

# AI / LLM Configuration
# Providers: groq (default cloud), ollama (local), mock (offline fallback)
LLM_PROVIDER=groq
GROQ_API_KEY=your_groq_api_key_here
GROQ_CHAT_MODEL=llama-3.3-70b-versatile
GROQ_STT_MODEL=whisper-large-v3

# Ollama Local (if running Ollama)
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=phi:latest

# Text-To-Speech Configuration
# Engines: kokoro, system, wav, mock
TTS_ENGINE=kokoro

# Note Taking Throttling
# Suzie is allowed to take notes at most once per N assistant replies
NOTE_FREQUENCY_LIMIT=3

# Persistent Storage Path
STORAGE_PATH=data/db.json
```

*Note:* If `GROQ_API_KEY` is not provided, the backend automatically cascades to local Ollama (if running) or safe, structured therapeutic mock responses, ensuring the backend never crashes during integration.

---

## 4. Running Verification Tests

Run the full end-to-end service stack test:

```bash
npm test
```

This verifies:
1. `GET /health` connectivity
2. `POST /session/start` greeting generation and active memory loading
3. `POST /chat` structured schema compliance, animation enums, and note taking
4. `POST /chat` crisis safety detection, scripted response override, and official resource injection
5. `POST /stt` multipart WAV file transcription
6. `GET /audio/:id.wav` audio download integrity
7. Session persistence, notes retrieval, memory storage, and deletion
8. Stale-session startup recovery and idempotent session finalization

---

## 5. Architecture & File Structure

```
Backend/
├── .env.example          # Environment template
├── .gitignore            # Git exclusion rules per Section 10
├── .nvmrc                # Pinned Node version (20)
├── API.md                # Full API contract documentation
├── package.json          # Node dependencies & engine specification
├── package-lock.json     # Pinned lockfile for npm ci
├── README.md             # This guide
├── start.bat             # 1-click Windows launcher
├── data/
│   ├── audio/            # Generated 24 kHz mono WAV files (served at /audio/:id.wav)
│   ├── crisis_resources.json # Verified emergency helpline numbers
│   └── prompts/
│       └── system_prompt.md  # Suzie persona & guidelines
├── src/
│   ├── server.js         # Express app entry point
│   ├── ai/
│   │   ├── llmProvider.js# Groq, Ollama, & mock provider cascade
│   │   └── schemas.js    # Zod validation schemas & normalizers
│   ├── api/
│   │   └── routes.js     # Express routes for Section 4 endpoints
│   ├── config/
│   │   └── index.js      # Configuration loader
│   ├── memory/
│   │   ├── memoryService.js # Memory extraction & stale session recovery
│   │   └── storage.js    # Persistent atomic JSON storage
│   ├── safety/
│   │   ├── crisisService.js # Scripted crisis intervention & logging
│   │   └── keywords.js   # Deterministic safety pre-check
│   ├── stt/
│   │   └── sttService.js # Speech-to-text handling
│   └── tts/
│       ├── ttsService.js # TTS generation & fallback handling
│       └── wavHelper.js  # 24 kHz mono 16-bit WAV PCM encoder
└── test/
    └── verify_stack.js   # Automated test suite
```

---

## 6. Safety & Crisis Notice

- **Keyword Pre-check:** Runs deterministically *before* any LLM processing. It checks for explicit expressions of self-harm, suicide, and imminent danger.
- **Resource Verification:** Emergency helpline numbers in `data/crisis_resources.json` (such as 988, Tele-MANAS, Crisis Text Line) are confirmed against official sources.
- **Privacy:** User messages that trigger crisis events are never stored in the `safety_events` table; only the event timestamp, session ID, and trigger type are logged.
