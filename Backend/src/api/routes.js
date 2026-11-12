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
import {
  PersonalizedCardRequestSchema,
  CircleControlCardsSchema
} from '../ai/schemas.js';

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

const greetingLocks = new Map();

function normalizeGreetingText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeNoteText(text) {
  return normalizeGreetingText(text).replace(/[.,!?;:]/g, '').replace(/\s+/g, ' ');
}

function explicitlyRefusesNote(text) {
  return /\b(?:please\s+)?(?:do not|don't|never)\s+(?:want\s+you\s+to\s+)?(?:remember|save|record|store|keep)\b/i.test(text);
}

function prepareGreetingContext(context) {
  if (!context || typeof context.text !== 'string') return null;
  const originalText = context.text.trim();
  if (!originalText) return null;

  const reminder = originalText.match(
    /^\s*(?:(?:please\s+)?remember\s+to\s+)?(?:ask\s+about|follow\s+up\s+on|check\s+in\s+about)\s+(.+?)\s+next\s+(?:session|time)[.!?]*\s*$/i
  );
  const topic = reminder?.[1]?.trim().replace(/[.!?]+$/, '').trim();
  const text = topic || originalText;
  if (!text || (reminder && /^(?:it|that|this|them|things?)$/i.test(text))) {
    return null;
  }

  if (text.length < (reminder ? 3 : 8)) return null;

  return {
    ...context,
    text,
    textKey: normalizeGreetingText(originalText),
    reminderLabel: reminder ? originalText : null
  };
}

async function withUserGreetingLock(userId, action) {
  const previous = greetingLocks.get(userId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  greetingLocks.set(userId, queued);

  await previous;
  try {
    return await action();
  } finally {
    release();
    if (greetingLocks.get(userId) === queued) {
      greetingLocks.delete(userId);
    }
  }
}

export function selectGreetingContext(notes, memories, sessions, currentSessionId) {
  const usedSourceIds = new Set();
  const usedTextKeys = new Set();
  const completedSessionIds = new Set(
    sessions
      .filter(session =>
        session.id !== currentSessionId &&
        typeof session.endedAt === 'string' &&
        Number.isFinite(Date.parse(session.endedAt))
      )
      .map(session => session.id)
  );

  for (const session of sessions) {
    if (session.id === currentSessionId) continue;
    if (
      session.greetingFollowUpSourceType &&
      session.greetingFollowUpSourceId
    ) {
      usedSourceIds.add(
        `${session.greetingFollowUpSourceType}:${session.greetingFollowUpSourceId}`
      );
    }
    if (session.greetingFollowUpTextKey) {
      usedTextKeys.add(session.greetingFollowUpTextKey);
    }
  }

  const recentNote = [...notes]
    .filter(note =>
      note.sessionId !== currentSessionId &&
      completedSessionIds.has(note.sessionId) &&
      typeof note.createdAt === 'string' &&
      Number.isFinite(Date.parse(note.createdAt))
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(note => ({ ...note, type: 'note' }))
    .map(prepareGreetingContext)
    .find(context =>
      context &&
      !usedSourceIds.has(`${context.type}:${context.id}`) &&
      !usedTextKeys.has(context.textKey)
    );

  const candidates = memories
    .map(memory => ({ ...memory, type: 'memory' }))
    .map(prepareGreetingContext)
    .filter(context =>
      context &&
      !usedSourceIds.has(`${context.type}:${context.id}`) &&
      !usedTextKeys.has(context.textKey)
    );

  const source = recentNote || candidates[0] || null;
  const sourceTextKey = source ? source.textKey : null;
  return {
    source: source && {
      type: source.type,
      id: source.id,
      text: source.text,
      category: source.category,
      textKey: sourceTextKey,
      reminderLabel: source.reminderLabel
    },
    relatedMemories: candidates
      .filter(memory =>
        (!source || (source.type !== 'memory' || memory.id !== source.id)) &&
        memory.textKey !== sourceTextKey
      )
      .slice(0, 3)
      .map(({ id, category, text, textKey, reminderLabel }) => ({
        id,
        category,
        text,
        textKey,
        reminderLabel
      }))
  };
}

// -------------------------------------------------------------
// 1. GET /health
// -------------------------------------------------------------
router.get('/health', (req, res) => {
  const llmStatus = config.groqApiKey || config.groqApiKeyFallback
    ? `groq (${config.groqChatModel})`
    : `ollama / local (${config.ollamaModel})`;
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
  console.log('[API] POST /session/start invoked');
  try {
    const userId = req.body?.userId || 'local';
    const session = storage.createSession(userId);

    const { greeting, memoryCount } = await withUserGreetingLock(userId, async () => {
      const userSessions = storage.getSessions(userId)
        .map(({ id }) => storage.getSession(id))
        .filter(Boolean);
      const recentNotes = storage.getNotes(userId);
      const activeMemories = memoryService.getActiveMemories(userId);
      const activeMemoryIds = new Set(activeMemories.map(memory => memory.id));
      const greetingMemories = [
        ...activeMemories,
        ...storage.getMemories(userId).filter(memory => !activeMemoryIds.has(memory.id))
      ];
      const greetingContext = selectGreetingContext(
        recentNotes,
        greetingMemories,
        userSessions,
        session.id
      );

      const { greeting, source } = await llmProvider.generateGreeting(greetingContext);
      if (source) {
        storage.updateSession(session.id, {
          greetingFollowUpSourceType: source.type,
          greetingFollowUpSourceId: source.id,
          greetingFollowUpTextKey: source.textKey
        });
      }

      return { greeting, memoryCount: activeMemories.length };
    });

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
      memoryCount
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

    const text = await sttService.transcribeWav(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );
    res.json({ text });
  } catch (err) {
    console.error('[API /stt] Error:', err);
    if (err.code === 'STT_EMPTY') {
      return sendError(res, 400, 'STT_EMPTY', 'No speech detected in audio. Please try again or type.', true);
    }
    if (err.code === 'STT_UNAVAILABLE') {
      return sendError(res, 503, 'STT_UNAVAILABLE', 'Speech transcription is unavailable. Please try again later.', true);
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

    if (explicitlyRefusesNote(message)) {
      chatResponse.takeNote = false;
      chatResponse.note = null;
    }

    // 6. Save note if takeNote is true and valid note present
    if (chatResponse.takeNote && chatResponse.note) {
      const noteTextKey = normalizeNoteText(chatResponse.note.text);
      const duplicateNote = storage.getNotes(userId).some(note =>
        normalizeNoteText(note.text) === noteTextKey
      ) || storage.getMemories(userId).some(memory =>
        normalizeNoteText(memory.text) === noteTextKey
      );
      if (duplicateNote) {
        chatResponse.takeNote = false;
        chatResponse.note = null;
      } else {
        storage.addNote(userId, sessionId, chatResponse.note.category, chatResponse.note.text);
      }
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
  console.log('[API] POST /session/end invoked');
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
// 9. POST /activities/circle-of-control/personalized-cards
// -------------------------------------------------------------
router.post('/activities/circle-of-control/personalized-cards', async (req, res) => {
  const parsedRequest = PersonalizedCardRequestSchema.safeParse(req.body);
  if (!parsedRequest.success) {
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid personalized card request.');
  }

  const { sessionId, memoryIds } = parsedRequest.data;
  const session = storage.getSession(sessionId);
  if (!session) {
    return sendError(res, 404, 'BAD_REQUEST', 'Unknown session.');
  }
  if (session.endedAt) {
    return sendError(res, 400, 'BAD_REQUEST', 'Session is not active.');
  }

  const fallback = () => res.json({ personalized: false, cards: [] });
  if (memoryIds.length === 0) return fallback();

  const userId = session.userId || 'local';
  const userMemories = storage.getMemories(userId);
  const memoriesById = new Map(userMemories.map(memory => [memory.id, memory]));
  const selectedMemories = memoryIds.map(id => memoriesById.get(id));
  if (selectedMemories.some(memory => !memory)) {
    return sendError(
      res,
      400,
      'BAD_REQUEST',
      'One or more selected memories are unavailable.'
    );
  }

  let eligibleContexts;
  try {
    eligibleContexts = await llmProvider.assessCircleCardMemorySuitability(
      selectedMemories.map(memory => ({ text: memory.text }))
    );
  } catch {
    console.error('[API] Personalized card suitability assessment failed; using generic cards.');
    return fallback();
  }

  if (!Array.isArray(eligibleContexts) || eligibleContexts.length === 0) {
    return fallback();
  }

  try {
    const cards = await llmProvider.generateCircleControlCards(eligibleContexts);
    const validatedCards = CircleControlCardsSchema.safeParse({ cards });
    if (!validatedCards.success) {
      console.error('[API] Personalized card output failed validation; using generic cards.');
      return fallback();
    }
    return res.json({
      personalized: true,
      cards: validatedCards.data.cards
    });
  } catch {
    console.error('[API] Personalized card generation failed; using generic cards.');
    return fallback();
  }
});

// -------------------------------------------------------------
// 10. GET /notes?userId=
// -------------------------------------------------------------
router.get('/notes', (req, res) => {
  const userId = req.query.userId || 'local';
  const notes = storage.getNotes(userId);
  res.json({ notes });
});

// -------------------------------------------------------------
// 11. GET /memories?userId=
// -------------------------------------------------------------
router.get('/memories', (req, res) => {
  const userId = req.query.userId || 'local';
  const memories = storage.getMemories(userId);
  res.json({ memories });
});

// -------------------------------------------------------------
// 12. DELETE /memories/:id
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
// 13. DELETE /data?userId=
// -------------------------------------------------------------
router.delete('/data', (req, res) => {
  const userId = req.query.userId || 'local';
  storage.clearData(userId);
  res.json({ ok: true });
});
