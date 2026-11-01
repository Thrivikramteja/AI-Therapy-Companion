import { storage } from './storage.js';
import { llmProvider } from '../ai/llmProvider.js';
import { config } from '../config/index.js';

export class MemoryService {
  /**
   * Retrieves up to 15 active memories for a user, sorted by recency and relevance
   */
  getActiveMemories(userId = 'local') {
    const allMemories = storage.getMemories(userId);
    // Prioritize follow_up, important_event, recurring_concern, then most recent
    const priorityWeights = {
      'follow_up': 5,
      'important_event': 4,
      'recurring_concern': 3,
      'goal': 2,
      'coping_strategy': 1,
      'preference': 1,
      'relevant_context': 1
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
   * Finalizes a session: produces summary, extracts durable memories.
   * Safe and idempotent if called multiple times.
   */
  async endSession(sessionId) {
    const session = storage.getSession(sessionId);
    if (!session) {
      return { ok: false, error: 'Session not found' };
    }

    // Idempotent: if already ended, return existing status without repeating LLM call
    if (session.endedAt) {
      return { ok: true, newMemories: 0, summary: session.summary };
    }

    const messages = storage.getSessionMessages(sessionId);
    const extraction = await llmProvider.extractSessionSummaryAndMemories(messages);

    // Save summary and endedAt
    storage.updateSession(sessionId, {
      endedAt: new Date().toISOString(),
      summary: extraction.summary || `Session ended with ${messages.length} messages.`
    });

    let newMemoriesCount = 0;
    if (Array.isArray(extraction.memories)) {
      for (const mem of extraction.memories) {
        if (mem.text && mem.category) {
          storage.addMemory(session.userId || 'local', mem.category, mem.text);
          newMemoriesCount++;
        }
      }
    }

    return {
      ok: true,
      newMemories: newMemoriesCount,
      summary: extraction.summary
    };
  }

  /**
   * Stale-session recovery on startup: finds sessions with no endedAt,
   * summarises them and extracts memories.
   */
  async recoverStaleSessions() {
    try {
      const staleSessions = storage.getStaleSessions();
      if (staleSessions.length === 0) return;

      console.log(`[MemoryService] Found ${staleSessions.length} stale sessions. Running recovery...`);
      for (const session of staleSessions) {
        try {
          const messages = storage.getSessionMessages(session.id);
          const extraction = await llmProvider.extractSessionSummaryAndMemories(messages);
          storage.updateSession(session.id, {
            endedAt: new Date().toISOString(),
            summary: extraction.summary || `Recovered stale session with ${messages.length} messages.`
          });
          if (Array.isArray(extraction.memories)) {
            for (const mem of extraction.memories) {
              if (mem.text && mem.category) {
                storage.addMemory(session.userId || 'local', mem.category, mem.text);
              }
            }
          }
          console.log(`[MemoryService] Recovered stale session ${session.id}`);
        } catch (sessionErr) {
          console.error(`[MemoryService] Failed to recover stale session ${session.id}:`, sessionErr);
          storage.updateSession(session.id, {
            endedAt: new Date().toISOString(),
            summary: "Session closed during server startup recovery."
          });
        }
      }
    } catch (err) {
      console.error('[MemoryService] Stale session recovery error:', err);
    }
  }
}

export const memoryService = new MemoryService();
