
import { storage } from './storage.js';
import { llmProvider } from '../ai/llmProvider.js';
import { config } from '../config/index.js';

// Maps notebook categories to supported long-term memory categories.
const NOTE_TO_MEMORY_CATEGORY = {
  important_event: 'important_event',
  automatic_thought: 'relevant_context',
  explicitly_stated_emotion: 'relevant_context',
  goal: 'goal',
  coping_strategy: 'coping_strategy',
  follow_up: 'follow_up',
  preference: 'preference',
  safety_concern: 'relevant_context'
};

const VALID_MEMORY_CATEGORIES = new Set([
  'important_event',
  'recurring_concern',
  'goal',
  'coping_strategy',
  'preference',
  'follow_up',
  'relevant_context'
]);

function normalizeMemoryText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export class MemoryService {

  /**
   * Retrieves up to 15 active memories for a user,
   * sorted by relevance and recency.
   */
  getActiveMemories(userId = 'local') {
    const allMemories = storage.getMemories(userId);

    const priorityWeights = {
      follow_up: 5,
      important_event: 4,
      recurring_concern: 3,
      goal: 2,
      coping_strategy: 1,
      preference: 1,
      relevant_context: 1
    };

    return [...allMemories]
      .sort((a, b) => {
        const weightA = priorityWeights[a.category] || 0;
        const weightB = priorityWeights[b.category] || 0;

        if (weightB !== weightA) return weightB - weightA;

        return new Date(b.createdAt) - new Date(a.createdAt);
      })
      .slice(0, config.maxActiveMemories);
  }

  /**
   * Saves explicitly written notes and LLM-extracted memories.
   * Explicit notes are processed first so their information
   * is not dependent on the LLM rediscovering it.
   */
  saveSessionMemories(userId, sessionNotes, extractedMemories) {

    const existingMemories = storage.getMemories(userId);

    const existingTexts = new Set(
      existingMemories.map(m => normalizeMemoryText(m.text))
    );

    const noteMemories = (sessionNotes || [])
      .map(note => ({
        category: NOTE_TO_MEMORY_CATEGORY[note.category],
        text: note.text
      }));

    const candidates = [
      ...noteMemories,
      ...(Array.isArray(extractedMemories) ? extractedMemories : [])
    ];

    let newMemoriesCount = 0;

    for (const memory of candidates) {

      if (!memory.text || !memory.category) continue;

      if (!VALID_MEMORY_CATEGORIES.has(memory.category)) continue;

      const text = memory.text.trim();
      const normalizedText = normalizeMemoryText(text);

      if (!normalizedText || existingTexts.has(normalizedText)) {
        continue;
      }

      storage.addMemory(userId, memory.category, text);

      existingTexts.add(normalizedText);
      newMemoriesCount++;
    }

    return newMemoriesCount;
  }

  /**
   * Finalizes a session: produces summary and extracts
   * durable memories, including explicitly saved notes.
   * Safe and idempotent.
   */
  async endSession(sessionId) {

    const session = storage.getSession(sessionId);

    if (!session) {
      return { ok: false, error: 'Session not found' };
    }

    // Do not process an already-ended session again.
    if (session.endedAt) {
      return {
        ok: true,
        newMemories: 0,
        summary: session.summary
      };
    }

    const userId = session.userId || 'local';

    const messages = storage.getSessionMessages(sessionId);

    // Retrieve notebook entries belonging to this session.
    const sessionNotes = storage.getNotes(userId)
      .filter(note => note.sessionId === sessionId);

    // LLM extracts additional information and a session summary.
    const extraction =
      await llmProvider.extractSessionSummaryAndMemories(messages);

    // Save explicit notes first, then additional LLM memories.
    const newMemoriesCount = this.saveSessionMemories(
      userId,
      sessionNotes,
      extraction.memories
    );

    // Mark the session ended after memory storage succeeds.
    storage.updateSession(sessionId, {
      endedAt: new Date().toISOString(),
      summary: extraction.summary ||
        `Session ended with ${messages.length} messages.`
    });

    return {
      ok: true,
      newMemories: newMemoriesCount,
      summary: extraction.summary
    };
  }

  /**
   * Recovers stale sessions during backend startup.
   * Also promotes saved notes into long-term memories.
   */
  async recoverStaleSessions() {

    try {

      const staleSessions = storage.getStaleSessions();

      if (staleSessions.length === 0) return;

      console.log(
        `[MemoryService] Found ${staleSessions.length} stale sessions. Running recovery...`
      );

      for (const session of staleSessions) {

        try {

          const userId = session.userId || 'local';

          const messages = storage.getSessionMessages(session.id);

          const sessionNotes = storage.getNotes(userId)
            .filter(note => note.sessionId === session.id);

          const extraction =
            await llmProvider.extractSessionSummaryAndMemories(messages);

          const newMemoriesCount = this.saveSessionMemories(
            userId,
            sessionNotes,
            extraction.memories
          );

          storage.updateSession(session.id, {
            endedAt: new Date().toISOString(),
            summary: extraction.summary ||
              `Recovered stale session with ${messages.length} messages.`
          });

          console.log(
            `[MemoryService] Recovered stale session ${session.id}. ` +
            `New memories: ${newMemoriesCount}`
          );

        } catch (sessionErr) {

          console.error(
            `[MemoryService] Failed to recover stale session ${session.id}:`,
            sessionErr
          );

          // Leave the session open so a subsequent recovery can retry.
          // Previously saved memories are protected by duplicate checking.
        }
      }

    } catch (err) {

      console.error(
        '[MemoryService] Stale session recovery error:',
        err
      );
    }
  }
}

export const memoryService = new MemoryService();
