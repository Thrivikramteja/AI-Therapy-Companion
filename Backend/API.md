# Suzie Virtual Therapy Companion — Backend API Specification

This document mirrors Section 4 of the Master Team Plan v2 and serves as the single source of truth for all API contracts between the Backend (Member 3) and Unity (Member 4 and Member 2).

- **Base URL:** `http://127.0.0.1:3000` (Configurable in Unity)
- **Content-Type:** `application/json` (UTF-8)
- **Timestamps:** ISO-8601 UTC strings (`YYYY-MM-DDTHH:mm:ss.sssZ`)
- **Default User ID:** `"local"`

---

## 1. Endpoints Overview

| Endpoint | Method | Request Payload | Response Payload | Description |
|---|---|---|---|---|
| `/health` | `GET` | *None* | `{ "ok": true, "llm": "...", "stt": "...", "tts": "..." }` | Health check (no secrets exposed) |
| `/session/start` | `POST` | `{ "userId": "local" }` | `{ "sessionId": "...", "greeting": ChatResponse \| null, "memoryCount": 0 }` | Starts a session, loads up to 15 memories, generates greeting |
| `/stt` | `POST` | `multipart/form-data` with field `audio` (16-bit mono WAV) | `{ "text": "..." }` | Speech-to-text transcription |
| `/chat` | `POST` | `{ "sessionId": "...", "message": "..." }` | `ChatResponse` | Main conversation exchange |
| `/session/end` | `POST` | `{ "sessionId": "..." }` | `{ "ok": true, "newMemories": 2 }` | Summarizes session and extracts durable memories (**Idempotent**) |
| `/sessions` | `GET` | Query param `?userId=local` | `{ "sessions": [ { "id", "startedAt", "endedAt", "summary", "messageCount" } ] }` | Lists all past sessions for user |
| `/sessions/:sessionId/messages` | `GET` | *None* | `{ "messages": [ { "id", "role": "user\|assistant", "text", "createdAt" } ] }` | Returns message history for a session |
| `/sessions/:sessionId` | `DELETE` | *None* | `{ "ok": true }` | Deletes session and its messages (notes remain) |
| `/notes` | `GET` | Query param `?userId=local` | `{ "notes": [ { "id", "sessionId", "category", "text", "createdAt" } ] }` | Returns saved therapeutic notes |
| `/memories` | `GET` | Query param `?userId=local` | `{ "memories": [ { "id", "category", "text", "createdAt" } ] }` | Returns long-term active memories |
| `/memories/:id` | `DELETE` | *None* | `{ "ok": true }` | Deletes a specific memory |
| `/data` | `DELETE` | Query param `?userId=local` | `{ "ok": true }` | Clears all data for user (sessions, messages, notes, memories, safety events) |
| `/audio/:id.wav` | `GET` | *None* | Audio binary (`audio/wav`) | Serves 24 kHz mono 16-bit PCM WAV for avatar speech playback |

---

## 2. ChatResponse Specification

Returned by `POST /chat` and inside `POST /session/start` (in `greeting`):

```json
{
  "speech": "string (1-3 sentences, max ~400 chars)",
  "animation": "talking | listening | thinking | idle",
  "gesture": "none | nod | small_gesture | head_tilt",
  "takeNote": false,
  "note": null,
  "audioUrl": "/audio/abc123.wav",
  "risk": "none | concern | crisis",
  "resources": null,
  "degraded": []
}
```

### Field Definitions:
- `speech`: Spoken therapist dialogue (1 to 3 sentences, maximum ~400 characters).
- `animation`: Avatar post-speech state (`"talking"`, `"listening"`, `"thinking"`, `"idle"`).
- `gesture`: Upper body gesture to trigger (`"none"`, `"nod"`, `"small_gesture"`, `"head_tilt"`).
- `takeNote`: Boolean indicating whether Suzie should play her note-taking animation.
- `note`: `null` OR `{ "category": "...", "text": "..." }` (text max 160 characters). `takeNote` is `true` only when `note` is non-null.
  - Allowed note categories:
    `important_event`, `automatic_thought`, `explicitly_stated_emotion`, `goal`, `coping_strategy`, `follow_up`, `preference`, `safety_concern`.
- `audioUrl`: Relative URL path to WAV file (e.g. `/audio/uuid.wav`), or `null` if TTS failed.
- `risk`: Risk assessment level: `"none"`, `"concern"`, or `"crisis"`.
- `resources`: `null`, except when `risk` is `"crisis"`, in which case it is an array:
  `[ { "label": "...", "contact": "..." } ]`.
- `degraded`: List of degraded services used for this response, e.g. `["tts"]`.

---

## 3. Error Responses

All non-2xx responses adhere to the standard schema:

```json
{
  "error": {
    "code": "STT_FAILED",
    "message": "I couldn't transcribe that recording. Please try again or type your message.",
    "retryable": true
  }
}
```

### Standard Error Codes:
- `BAD_REQUEST`: Invalid input format, missing parameters, or unknown IDs.
- `RATE_LIMITED`: Upstream provider rate limit reached.
- `STT_EMPTY`: Audio recording contained no detectable speech.
- `STT_FAILED`: Speech-to-text service encountered an error.
- `LLM_FAILED`: AI provider call failed or returned unrecoverable data.
- `TTS_FAILED`: Audio synthesis failed (usually degrades gracefully with `audioUrl: null` rather than 500).
- `INTERNAL`: Unexpected backend server error.

---

## 4. Unity C# DTOs (Newtonsoft JSON)

Member 4 can copy these directly into Unity:

```csharp
using System;
using System.Collections.Generic;

[Serializable]
public class HealthResponseDto {
    public bool ok;
    public string llm;
    public string stt;
    public string tts;
}

[Serializable]
public class SessionStartResponseDto {
    public string sessionId;
    public ChatResponseDto greeting;
    public int memoryCount;
}

[Serializable]
public class ChatResponseDto {
    public string speech;
    public string animation;
    public string gesture;
    public bool takeNote;
    public NoteDto note;                 // null allowed
    public string audioUrl;              // null allowed
    public string risk;
    public List<ResourceDto> resources;  // null allowed
    public List<string> degraded;
}

[Serializable]
public class NoteDto {
    public string id;
    public string sessionId;
    public string category;
    public string text;
    public string createdAt;
}

[Serializable]
public class ResourceDto {
    public string label;
    public string contact;
}

[Serializable]
public class SttResponseDto {
    public string text;
}

[Serializable]
public class SessionEndResponseDto {
    public bool ok;
    public int newMemories;
}

[Serializable]
public class SessionItemDto {
    public string id;
    public string startedAt;
    public string endedAt;
    public string summary;
    public int messageCount;
}

[Serializable]
public class SessionsListResponseDto {
    public List<SessionItemDto> sessions;
}

[Serializable]
public class MessageItemDto {
    public string id;
    public string role;
    public string text;
    public string createdAt;
}

[Serializable]
public class MessagesListResponseDto {
    public List<MessageItemDto> messages;
}

[Serializable]
public class MemoryItemDto {
    public string id;
    public string category;
    public string text;
    public string createdAt;
}

[Serializable]
public class MemoriesListResponseDto {
    public List<MemoryItemDto> memories;
}

[Serializable]
public class NotesListResponseDto {
    public List<NoteDto> notes;
}

[Serializable]
public class ApiErrorEnvelopeDto {
    public ApiErrorDto error;
}

[Serializable]
public class ApiErrorDto {
    public string code;
    public string message;
    public bool retryable;
}
```

---

## 5. Safety & Crisis Protocol
When user input triggers crisis safety patterns (or the LLM detects imminent self-harm/suicide):
1. The backend overrides any LLM text with a pre-scripted, supportive message:
   `"I hear how much pain you're in, and I want you to be safe. I cannot provide emergency support, but you don't have to carry this alone. Please reach out to one of the crisis resources shown right now."`
2. `risk` is set to `"crisis"`.
3. `resources` contains verified crisis helplines.
4. `takeNote` is forced to `false`.
5. A `safety_events` record is saved (timestamp, session, trigger type — user text is NEVER retained in the safety log).
