import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/index.js';

class Storage {
  constructor() {
    this.filePath = config.storagePath;
    this.data = {
      sessions: [],
      messages: [],
      notes: [],
      memories: [],
      safety_events: []
    };
    this.init();
  }

  init() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(raw);
        if (!this.data.sessions) this.data.sessions = [];
        if (!this.data.messages) this.data.messages = [];
        if (!this.data.notes) this.data.notes = [];
        if (!this.data.memories) this.data.memories = [];
        if (!this.data.safety_events) this.data.safety_events = [];
      } else {
        this.persist();
      }
    } catch (err) {
      console.error('[Storage] Error initializing database:', err);
    }
  }

  persist() {
    try {
      const tempPath = `${this.filePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('[Storage] Error persisting database:', err);
    }
  }

  // --- Sessions ---
  getSessions(userId = 'local') {
    return this.data.sessions
      .filter(s => s.userId === userId)
      .map(s => ({
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt || null,
        summary: s.summary || '',
        messageCount: s.messageCount || 0
      }))
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }

  getSession(sessionId) {
    return this.data.sessions.find(s => s.id === sessionId) || null;
  }

  createSession(userId = 'local') {
    const session = {
      id: crypto.randomUUID(),
      userId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      summary: '',
      messageCount: 0
    };
    this.data.sessions.push(session);
    this.persist();
    return session;
  }

  updateSession(sessionId, updates) {
    const session = this.data.sessions.find(s => s.id === sessionId);
    if (!session) return null;
    Object.assign(session, updates);
    this.persist();
    return session;
  }

  deleteSession(sessionId) {
    const initialSessionCount = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(s => s.id !== sessionId);
    this.data.messages = this.data.messages.filter(m => m.sessionId !== sessionId);
    // Notes remain per Section 4.1 unless explicitly deleted
    this.persist();
    return this.data.sessions.length < initialSessionCount;
  }

  getStaleSessions() {
    return this.data.sessions.filter(s => !s.endedAt);
  }

  // --- Messages ---
  getSessionMessages(sessionId) {
    return this.data.messages
      .filter(m => m.sessionId === sessionId)
      .map(m => ({
        id: m.id,
        role: m.role,
        text: m.text,
        createdAt: m.createdAt
      }))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  addMessage(sessionId, role, text) {
    const msg = {
      id: crypto.randomUUID(),
      sessionId,
      role, // 'user' or 'assistant'
      text,
      createdAt: new Date().toISOString()
    };
    this.data.messages.push(msg);
    
    // Update session messageCount
    const session = this.data.sessions.find(s => s.id === sessionId);
    if (session) {
      session.messageCount = (session.messageCount || 0) + 1;
    }
    
    this.persist();
    return msg;
  }

  // --- Notes ---
  getNotes(userId = 'local') {
    return this.data.notes
      .filter(n => n.userId === userId)
      .map(n => ({
        id: n.id,
        sessionId: n.sessionId,
        category: n.category,
        text: n.text,
        createdAt: n.createdAt
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  addNote(userId = 'local', sessionId, category, text) {
    const note = {
      id: crypto.randomUUID(),
      userId,
      sessionId,
      category,
      text,
      createdAt: new Date().toISOString()
    };
    this.data.notes.push(note);
    this.persist();
    return note;
  }

  // --- Memories ---
  getMemories(userId = 'local') {
    return this.data.memories
      .filter(m => m.userId === userId)
      .map(m => ({
        id: m.id,
        category: m.category,
        text: m.text,
        createdAt: m.createdAt
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  addMemory(userId = 'local', category, text) {
    const memory = {
      id: crypto.randomUUID(),
      userId,
      category,
      text,
      createdAt: new Date().toISOString()
    };
    this.data.memories.push(memory);
    this.persist();
    return memory;
  }

  deleteMemory(memoryId) {
    const initialCount = this.data.memories.length;
    this.data.memories = this.data.memories.filter(m => m.id !== memoryId);
    this.persist();
    return this.data.memories.length < initialCount;
  }

  // --- Safety Events ---
  addSafetyEvent(sessionId, triggerType, userId = 'local') {
    const event = {
      id: crypto.randomUUID(),
      sessionId: sessionId || null,
      userId,
      triggerType,
      createdAt: new Date().toISOString()
    };
    this.data.safety_events.push(event);
    this.persist();
    return event;
  }

  // --- Clear Data ---
  clearData(userId = 'local') {
    // Clear all records for this user
    const userSessionIds = new Set(this.data.sessions.filter(s => s.userId === userId).map(s => s.id));
    
    this.data.sessions = this.data.sessions.filter(s => s.userId !== userId);
    this.data.messages = this.data.messages.filter(m => !userSessionIds.has(m.sessionId));
    this.data.notes = this.data.notes.filter(n => n.userId !== userId);
    this.data.memories = this.data.memories.filter(m => m.userId !== userId);
    this.data.safety_events = this.data.safety_events.filter(e => e.userId !== userId);
    
    this.persist();
    return true;
  }
}

export const storage = new Storage();
