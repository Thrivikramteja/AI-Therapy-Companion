import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { router } from '../src/api/routes.js';
import { llmProvider } from '../src/ai/llmProvider.js';
import { memoryService } from '../src/memory/memoryService.js';
import { storage } from '../src/memory/storage.js';
import { ttsService } from '../src/tts/ttsService.js';

const originalMethods = {};
const originalGenerateChatResponse = llmProvider.generateChatResponse;
const originalGetActiveMemories = memoryService.getActiveMemories;
const originalSynthesize = ttsService.synthesize;
const storageMethods = [
  'getSession',
  'addMessage',
  'getSessionMessages',
  'getNotes',
  'getMemories',
  'addNote'
];

function installChatStorage({ notes = [], memories = [] } = {}) {
  const session = { id: 'chat-note-session', userId: 'chat-note-user' };
  const messages = [];
  const savedNotes = [];
  for (const name of storageMethods) originalMethods[name] = storage[name];

  storage.getSession = id => id === session.id ? session : null;
  storage.addMessage = (sessionId, role, text) => {
    const message = { id: `message-${messages.length}`, sessionId, role, text };
    messages.push(message);
    return message;
  };
  storage.getSessionMessages = () => [...messages];
  storage.getNotes = () => [...notes, ...savedNotes];
  storage.getMemories = () => memories;
  storage.addNote = (userId, sessionId, category, text) => {
    const note = { userId, sessionId, category, text };
    savedNotes.push(note);
    return note;
  };

  return { session, savedNotes };
}

async function postChat(message) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'chat-note-session', message })
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => server.close(error =>
      error ? reject(error) : resolve()
    ));
  }
}

describe('chat note persistence', () => {
  beforeEach(() => {
    memoryService.getActiveMemories = () => [];
    ttsService.synthesize = async () => ({ audioUrl: null, degraded: [] });
  });

  afterEach(() => {
    llmProvider.generateChatResponse = originalGenerateChatResponse;
    memoryService.getActiveMemories = originalGetActiveMemories;
    ttsService.synthesize = originalSynthesize;
    for (const [name, method] of Object.entries(originalMethods)) {
      storage[name] = method;
      delete originalMethods[name];
    }
  });

  it('saves a new note and preserves the writing-animation response signal', async () => {
    const { savedNotes } = installChatStorage();
    llmProvider.generateChatResponse = async () => ({
      speech: 'Happy early birthday!',
      animation: 'talking',
      gesture: 'nod',
      takeNote: true,
      note: { category: 'important_event', text: "User's birthday is tomorrow." },
      risk: 'none',
      resources: null,
      degraded: []
    });

    const { status, body } = await postChat('My birthday is tomorrow.');

    assert.equal(status, 200);
    assert.equal(savedNotes.length, 1);
    assert.equal(savedNotes[0].category, 'important_event');
    assert.equal(body.takeNote, true);
    assert.deepEqual(body.note, savedNotes[0] && {
      category: savedNotes[0].category,
      text: savedNotes[0].text
    });
  });

  it('suppresses an already saved note with normalized matching text', async () => {
    const duplicate = {
      userId: 'chat-note-user',
      sessionId: 'previous-session',
      category: 'important_event',
      text: 'User has an interview next Friday.'
    };
    const { savedNotes } = installChatStorage({ notes: [duplicate] });
    llmProvider.generateChatResponse = async () => ({
      speech: 'I remember you have an interview coming up.',
      animation: 'talking',
      gesture: 'nod',
      takeNote: true,
      note: { category: 'important_event', text: '  USER   has an interview next Friday  ' },
      risk: 'none',
      resources: null,
      degraded: []
    });

    const { status, body } = await postChat('I have an interview next Friday.');

    assert.equal(status, 200);
    assert.equal(savedNotes.length, 0);
    assert.equal(body.takeNote, false);
    assert.equal(body.note, null);
  });

  it('does not duplicate information already stored in long-term memory', async () => {
    const { savedNotes } = installChatStorage({
      memories: [{
        text: 'User is preparing for an important interview.'
      }]
    });
    llmProvider.generateChatResponse = async () => ({
      speech: 'That sounds important.',
      animation: 'talking',
      gesture: 'nod',
      takeNote: true,
      note: { category: 'important_event', text: 'user is preparing for an important interview.' },
      risk: 'none',
      resources: null,
      degraded: []
    });

    const { status, body } = await postChat('My interview is next week.');

    assert.equal(status, 200);
    assert.equal(savedNotes.length, 0);
    assert.equal(body.takeNote, false);
    assert.equal(body.note, null);
  });

  it('honors an explicit request not to remember something', async () => {
    const { savedNotes } = installChatStorage();
    llmProvider.generateChatResponse = async () => ({
      speech: 'I understand.',
      animation: 'talking',
      gesture: 'nod',
      takeNote: true,
      note: { category: 'important_event', text: 'User has an exam coming up.' },
      risk: 'none',
      resources: null,
      degraded: []
    });

    const { status, body } = await postChat(
      'I have an exam coming up, but please do not remember it.'
    );

    assert.equal(status, 200);
    assert.equal(savedNotes.length, 0);
    assert.equal(body.takeNote, false);
    assert.equal(body.note, null);
  });
});
