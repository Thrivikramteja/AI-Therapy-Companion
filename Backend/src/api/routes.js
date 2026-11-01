import express from 'express';
import multer from 'multer';
import { config } from '../config/index.js';
import { storage } from '../memory/storage.js';
import { memoryService } from '../memory/memoryService.js';
import { llmProvider } from '../ai/llmProvider.js';
import { sttService } from '../stt/sttService.js';
import { ttsService } from '../tts/ttsService.js';
import { checkCrisisKeywords } from '../safety/keywords.js';
import { handleCrisisResponse } from '../safety/crisisService.js';

export const router = express.Router();

// Multer storage in memory for audio uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB max
});

// Helper for standardized Section 4.3 error response
function sendError(res, status, code, message, retryable = false) {
  return res.status(status).json({
    error: {
      code,
      message,
      retryable
    }
  });
}

// -------------------------------------------------------------
// 1. GET /health
// -------------------------------------------------------------
router.get('/health', (req, res) => {
  const llmStatus = config.groqApiKey ? `groq (${config.groqChatModel})` : `ollama / local (${config.ollamaModel})`;
  const sttStatus = config.groqApiKey ? `groq (${config.groqSttModel})` : 'mock / fallback';
  const ttsStatus = ttsService.kokoroModel ? 'kokoro (onnx)' : (process.platform === 'darwin' ? 'macOS say' : (process.platform === 'win32' ? 'Windows speech' : 'synthetic/degraded'));

  res.json({
    ok: true,
    llm: llmStatus,
    stt: sttStatus,
    tts: ttsStatus
  });
});

// -------------------------------------------------------------
// 2. POST /session/start
// -------------------------------------------------------------
router.post('/session/start', async (req, res) => {
  try {
    const userId = req.body?.userId || 'local';
    const session = storage.createSession(userId);

    // Load up to 15 active memories
    const activeMemories = memoryService.getActiveMemories(userId);

    // Generate initial greeting
    let greeting = await llmProvider.generateGreeting(activeMemories);

    // Attempt TTS synthesis for greeting speech
    if (greeting && greeting.speech) {
      try {
        const ttsResult = await ttsService.synthesize(greeting.speech);
        greeting.audioUrl = ttsResult.audioUrl;
        if (ttsResult.degraded.length > 0) {
          greeting.degraded = ttsResult.degraded;
        }
      } catch (ttsErr) {
        greeting.audioUrl = null;
        greeting.degraded = ['tts'];
      }

      // Persist greeting in session messages
      storage.addMessage(session.id, 'assistant', greeting.speech);
    }

    res.json({
      sessionId: session.id,
      greeting,
      memoryCount: activeMemories.length
    });
  } catch (err) {
    console.error('[API /session/start] Error:', err);
    sendError(res, 500, 'INTERNAL', 'Failed to start session.');
  }
});

// -------------------------------------------------------------
// 3. POST /stt
// -------------------------------------------------------------
router.post('/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return sendError(res, 400, 'STT_EMPTY', 'No audio file uploaded.', true);
    }

    const text = await sttService.transcribeWav(req.file.buffer, req.file.originalname);
    res.json({ text });
  } catch (err) {
    console.error('[API /stt] Error:', err);
    if (err.code === 'STT_EMPTY') {
      return sendError(res, 400, 'STT_EMPTY', 'No speech detected in audio. Please try again or type.', true);
    }
    return sendError(res, 500, 'STT_FAILED', "I couldn't transcribe that recording. Please try again or type your message.", true);
  }
});

// -------------------------------------------------------------
// 4. POST /chat
// -------------------------------------------------------------
router.post('/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body || {};

    if (!sessionId || typeof sessionId !== 'string') {
      return sendError(res, 400, 'BAD_REQUEST', 'Missing or invalid sessionId.');
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'Missing or empty message.');
    }

    const session = storage.getSession(sessionId);
    if (!session) {
      return sendError(res, 400, 'BAD_REQUEST', 'Unknown sessionId.');
    }

    const userId = session.userId || 'local';

    // 1. SAFETY: Deterministic keyword pre-check BEFORE LLM
    const crisisCheck = checkCrisisKeywords(message);
    if (crisisCheck && crisisCheck.triggered) {
      const crisisResp = handleCrisisResponse(sessionId, crisisCheck.triggerType, userId);
      
      // Persist messages
      storage.addMessage(sessionId, 'user', message);
      storage.addMessage(sessionId, 'assistant', crisisResp.speech);

      // Synthesize audio for scripted crisis response
      try {
        const ttsResult = await ttsService.synthesize(crisisResp.speech);
        crisisResp.audioUrl = ttsResult.audioUrl;
        if (ttsResult.degraded.length > 0) crisisResp.degraded = ttsResult.degraded;
      } catch (ttsErr) {
        crisisResp.audioUrl = null;
        crisisResp.degraded = ['tts'];
      }

      return res.json(crisisResp);
    }

    // 2. Persist user message
    storage.addMessage(sessionId, 'user', message);

    // 3. Enforce note frequency limit (at most once per N assistant replies)
    const existingMessages = storage.getSessionMessages(sessionId);
    const existingNotes = storage.getNotes(userId).filter(n => n.sessionId === sessionId);
    let noteAllowed = true;
    if (existingNotes.length > 0) {
      const assistantMessages = existingMessages.filter(m => m.role === 'assistant');
      const messagesSinceLastNote = assistantMessages.length % config.noteFrequencyLimit;
      if (messagesSinceLastNote !== 0) {
        noteAllowed = false;
      }
    }

    // 4. Load active memories and call LLM
    const activeMemories = memoryService.getActiveMemories(userId);
    let chatResponse = await llmProvider.generateChatResponse(existingMessages, activeMemories, noteAllowed);

    // 5. Check if model marked risk as crisis
    if (chatResponse.risk === 'crisis') {
      chatResponse = handleCrisisResponse(sessionId, 'model_classified_crisis', userId);
    } else {
      chatResponse.resources = null;
    }

    // 6. Save note if takeNote is true and valid note present
    if (chatResponse.takeNote && chatResponse.note) {
      storage.addNote(userId, sessionId, chatResponse.note.category, chatResponse.note.text);
    }

    // 7. Persist assistant message
    storage.addMessage(sessionId, 'assistant', chatResponse.speech);

    // 8. Synthesize TTS
    try {
      const ttsResult = await ttsService.synthesize(chatResponse.speech);
      chatResponse.audioUrl = ttsResult.audioUrl;
      chatResponse.degraded = ttsResult.degraded || [];
    } catch (ttsErr) {
      chatResponse.audioUrl = null;
      chatResponse.degraded = ['tts'];
    }

    res.json(chatResponse);
  } catch (err) {
    console.error('[API /chat] Error:', err);
    sendError(res, 500, 'LLM_FAILED', 'Failed to generate response.', true);
  }
});

// -------------------------------------------------------------
// 5. POST /session/end (Idempotent)
// -------------------------------------------------------------
router.post('/session/end', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      return sendError(res, 400, 'BAD_REQUEST', 'Missing sessionId.');
    }

    const session = storage.getSession(sessionId);
    if (!session) {
      return sendError(res, 400, 'BAD_REQUEST', 'Unknown sessionId.');
    }

    const result = await memoryService.endSession(sessionId);
    res.json({
      ok: true,
      newMemories: result.newMemories || 0
    });
  } catch (err) {
    console.error('[API /session/end] Error:', err);
    sendError(res, 500, 'INTERNAL', 'Failed to end session.');
  }
});

// -------------------------------------------------------------
// 6. GET /sessions?userId=
// -------------------------------------------------------------
router.get('/sessions', (req, res) => {
  const userId = req.query.userId || 'local';
  const sessions = storage.getSessions(userId);
  res.json({ sessions });
});

// -------------------------------------------------------------
// 7. GET /sessions/:sessionId/messages
// -------------------------------------------------------------
router.get('/sessions/:sessionId/messages', (req, res) => {
  const { sessionId } = req.params;
  const session = storage.getSession(sessionId);
  if (!session) {
    return sendError(res, 400, 'BAD_REQUEST', 'Unknown sessionId.');
  }

  const messages = storage.getSessionMessages(sessionId);
  res.json({ messages });
});

// -------------------------------------------------------------
// 8. DELETE /sessions/:sessionId
// -------------------------------------------------------------
router.delete('/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = storage.getSession(sessionId);
  if (!session) {
    return sendError(res, 400, 'BAD_REQUEST', 'Unknown sessionId.');
  }

  storage.deleteSession(sessionId);
  res.json({ ok: true });
});

// -------------------------------------------------------------
// 9. GET /notes?userId=
// -------------------------------------------------------------
router.get('/notes', (req, res) => {
  const userId = req.query.userId || 'local';
  const notes = storage.getNotes(userId);
  res.json({ notes });
});

// -------------------------------------------------------------
// 10. GET /memories?userId=
// -------------------------------------------------------------
router.get('/memories', (req, res) => {
  const userId = req.query.userId || 'local';
  const memories = storage.getMemories(userId);
  res.json({ memories });
});

// -------------------------------------------------------------
// 11. DELETE /memories/:id
// -------------------------------------------------------------
router.delete('/memories/:id', (req, res) => {
  const { id } = req.params;
  const deleted = storage.deleteMemory(id);
  if (!deleted) {
    return sendError(res, 400, 'BAD_REQUEST', 'Unknown memory id.');
  }
  res.json({ ok: true });
});

// -------------------------------------------------------------
// 12. DELETE /data?userId=
// -------------------------------------------------------------
router.delete('/data', (req, res) => {
  const userId = req.query.userId || 'local';
  storage.clearData(userId);
  res.json({ ok: true });
});
