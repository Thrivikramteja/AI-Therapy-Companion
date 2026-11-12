import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { config } from '../src/config/index.js';
import { llmProvider, LlmProvider } from '../src/ai/llmProvider.js';
import { memoryService } from '../src/memory/memoryService.js';
import { storage } from '../src/memory/storage.js';
import { ttsService } from '../src/tts/ttsService.js';
import { router, selectGreetingContext } from '../src/api/routes.js';

const originalFetch = globalThis.fetch;
const originalGroqApiKey = config.groqApiKey;
const originalGroqApiKeyFallback = config.groqApiKeyFallback;
const originalLlmProvider = config.llmProvider;
const originalStorageMethods = {};
const originalMemoryGetActiveMemories = memoryService.getActiveMemories;
const originalGenerateGreeting = llmProvider.generateGreeting;
const originalSynthesize = ttsService.synthesize;
const sessionStartStorageMethods = [
  'createSession',
  'getSessions',
  'getSession',
  'getNotes',
  'getMemories',
  'updateSession',
  'addMessage'
];

function installSessionStartStorage({ sessions, notes }) {
  for (const name of sessionStartStorageMethods) {
    originalStorageMethods[name] ??= storage[name];
  }
  storage.createSession = userId => {
    const created = {
      id: `new-${sessions.length + 1}`,
      userId,
      startedAt: new Date().toISOString(),
      endedAt: null
    };
    sessions.push(created);
    return created;
  };
  storage.getSessions = userId =>
    sessions.filter(item => item.userId === userId).map(({ id }) => ({ id }));
  storage.getSession = id => sessions.find(item => item.id === id) || null;
  storage.getNotes = userId => notes.filter(item => item.userId === userId);
  storage.getMemories = () => [];
  storage.updateSession = (id, updates) => {
    const target = sessions.find(item => item.id === id);
    if (!target) return null;
    Object.assign(target, updates);
    return target;
  };
  storage.addMessage = () => ({ id: 'greeting-message' });
}

const session = (id, endedAt = '2026-11-03T10:00:00.000Z', extras = {}) => ({
  id,
  userId: 'test-user',
  startedAt: '2026-11-03T09:00:00.000Z',
  endedAt,
  ...extras
});

const note = (id, sessionId, text, createdAt, category = 'follow_up') => ({
  id,
  sessionId,
  text,
  createdAt,
  category
});

const memory = (id, text, category = 'follow_up') => ({
  id,
  text,
  category,
  createdAt: '2026-11-03T08:00:00.000Z'
});

describe('memory-aware session greetings', () => {
  beforeEach(() => {
    config.groqApiKey = 'gsk_unit_test_key';
    config.groqApiKeyFallback = '';
    config.llmProvider = 'groq';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    config.groqApiKey = originalGroqApiKey;
    config.groqApiKeyFallback = originalGroqApiKeyFallback;
    config.llmProvider = originalLlmProvider;
    llmProvider.generateGreeting = originalGenerateGreeting;
    memoryService.getActiveMemories = originalMemoryGetActiveMemories;
    ttsService.synthesize = originalSynthesize;
    for (const [name, method] of Object.entries(originalStorageMethods)) {
      storage[name] = method;
      delete originalStorageMethods[name];
    }
  });

  it('prefers the newest suitable unused note over older notes and memories', () => {
    const result = selectGreetingContext(
      [
        note('old', 'ended-1', 'A useful old topic from the client.', '2026-11-01T10:00:00Z'),
        note('new', 'ended-2', 'A newer upcoming examination.', '2026-11-03T10:00:00Z')
      ],
      [memory('memory-1', 'A highly relevant follow-up memory.')],
      [session('ended-1'), session('ended-2')],
      'current'
    );

    assert.equal(result.source.id, 'new');
    assert.equal(result.source.type, 'note');
  });

  it('excludes notes from open sessions and the session currently starting', () => {
    const missingEndedSession = session('missing-ended');
    delete missingEndedSession.endedAt;
    const result = selectGreetingContext(
      [
        note('open-note', 'open-session', 'An open session topic.', '2026-11-04T10:00:00Z'),
        note('missing-ended-note', 'missing-ended', 'A session with no completion date.', '2026-11-04T09:00:00Z'),
        note('invalid-ended-note', 'invalid-ended', 'A session with an invalid date.', '2026-11-04T08:00:00Z'),
        note('current-note', 'current', 'A current session topic.', '2026-11-04T11:00:00Z'),
        note('completed-note', 'ended-session', 'A completed session topic.', '2026-11-02T10:00:00Z')
      ],
      [],
      [
        session('open-session', null),
        missingEndedSession,
        session('invalid-ended', 'not-a-date'),
        session('ended-session', '2026-11-03T10:00:00.000Z'),
        session('current', null)
      ],
      'current'
    );

    assert.equal(result.source.id, 'completed-note');
  });

  it('extracts an internal reminder topic and passes only that topic to Groq', async () => {
    const context = selectGreetingContext(
      [note('pet-reminder', 'ended', 'Ask about pets next session', '2026-11-03T10:00:00Z')],
      [memory('memory-reminder', 'Ask about the examination next session')],
      [session('ended')],
      'current'
    );
    let requestBody;
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          speech: 'How have your pets been doing?',
          animation: 'talking',
          gesture: 'nod',
          takeNote: false,
          note: null,
          risk: 'none'
        }) } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await new LlmProvider().generateGreeting({
      source: context.source,
      relatedMemories: context.relatedMemories
    });

    const promptContext = JSON.parse(requestBody.messages[1].content);
    assert.deepEqual(promptContext.primaryContext, {
      category: 'follow_up',
      type: 'internal_reminder_topic',
      topic: 'pets'
    });
    assert.deepEqual(promptContext.additionalMemories, [{
      category: 'follow_up',
      type: 'internal_reminder_topic',
      topic: 'the examination'
    }]);
    assert.equal(requestBody.messages[1].content.includes('Ask about pets next session'), false);
    assert.equal(result.greeting.speech, 'How have your pets been doing?');
    assert.equal(result.source.id, context.source.id);
  });

  it('rejects generated speech that repeats an internal reminder instruction', async () => {
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.messages[1].content.includes('Ask about pets next session'), false);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          speech: 'Ask about pets next session.',
          animation: 'talking',
          gesture: 'none',
          takeNote: false,
          note: null,
          risk: 'none'
        }) } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await new LlmProvider().generateGreeting({
      source: {
        type: 'note',
        id: 'pet-reminder',
        category: 'follow_up',
        text: 'pets',
        textKey: 'ask about pets next session',
        reminderLabel: 'Ask about pets next session'
      }
    });

    assert.equal(result.source, null);
    assert.equal(result.greeting.speech, "Hello, welcome in. I'm Suzie. How are you feeling today?");
  });

  it('skips a previously used note and its duplicate memory text', () => {
    const usedText = 'We discussed preparing for an important appointment.';
    const result = selectGreetingContext(
      [
        note('used-note', 'ended-1', usedText, '2026-11-03T10:00:00Z'),
        note('next-note', 'ended-2', 'A different useful topic from last time.', '2026-11-02T10:00:00Z')
      ],
      [memory('duplicate-memory', `  ${usedText.toLowerCase()}  `)],
      [
        session('ended-1', '2026-11-03T12:00:00Z', {
          greetingFollowUpSourceType: 'note',
          greetingFollowUpSourceId: 'used-note',
          greetingFollowUpTextKey: usedText.toLowerCase()
        }),
        session('ended-2')
      ],
      'current'
    );

    assert.equal(result.source.id, 'next-note');
    assert.equal(result.relatedMemories.some(item => item.id === 'duplicate-memory'), false);
  });

  it('selects a relevant memory when no suitable unused note exists', () => {
    const result = selectGreetingContext(
      [note('placeholder', 'ended', 'Ask about it next session.', '2026-11-03T10:00:00Z')],
      [memory('pet-memory', 'The client has a pet dog named Suzie.')],
      [session('ended')],
      'current'
    );

    assert.equal(result.source.id, 'pet-memory');
    assert.equal(result.source.type, 'memory');
  });

  it('returns no context when notes and memories are unavailable or already used', () => {
    const result = selectGreetingContext(
      [],
      [memory('used-memory', 'A previous context that was already used.')],
      [session('previous', '2026-11-03T12:00:00Z', {
        greetingFollowUpSourceType: 'memory',
        greetingFollowUpSourceId: 'used-memory',
        greetingFollowUpTextKey: 'a previous context that was already used.'
      })],
      'current'
    );

    assert.equal(result.source, null);
    assert.deepEqual(result.relatedMemories, []);
  });

  it('asks Groq for a natural greeting and preserves the greeting response contract', async () => {
    const speech = 'You mentioned an examination was coming up. How did it go?';
    let requestBody;
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          speech,
          animation: 'talking',
          gesture: 'nod',
          takeNote: true,
          note: { category: 'follow_up', text: 'Do not save this.' },
          risk: 'none'
        }) } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const source = {
      type: 'note',
      id: 'exam-note',
      category: 'important_event',
      text: 'User had an upcoming examination and was worried about the result.',
      textKey: 'user had an upcoming examination and was worried about the result.'
    };
    const result = await new LlmProvider().generateGreeting({
      source,
      relatedMemories: [memory('related', 'The client has been working toward a degree.')]
    });

    assert.equal(result.greeting.speech, speech);
    assert.notEqual(result.greeting.speech, source.text);
    assert.equal(result.greeting.animation, 'talking');
    assert.equal(result.greeting.takeNote, false);
    assert.equal(result.greeting.note, null);
    assert.equal(result.greeting.risk, 'none');
    assert.equal(result.source.id, source.id);
    assert.match(requestBody.messages[0].content, /natural follow-up/i);
    const context = JSON.parse(requestBody.messages[1].content);
    assert.equal(context.primaryContext.text, source.text);
    assert.equal(context.additionalMemories.length, 1);
    assert.equal(requestBody.messages.length, 2);
  });

  it('returns the generic greeting without calling Groq when no context exists', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('Unexpected provider request');
    };

    const result = await new LlmProvider().generateGreeting();
    assert.equal(result.greeting.speech, "Hello, welcome in. I'm Suzie. How are you feeling today?");
    assert.equal(result.source, null);
    assert.equal(fetchCalls, 0);
  });

  it('uses the existing Ollama fallback for a personalized greeting when Groq fails', async () => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 });
    const provider = new LlmProvider();
    provider.callOllama = async () => ({
      speech: 'How did the conversation with your friend go?',
      animation: 'talking',
      gesture: 'nod',
      takeNote: true,
      note: { category: 'follow_up', text: 'Not saved.' },
      risk: 'none'
    });

    const source = {
      type: 'note',
      id: 'friend-note',
      category: 'follow_up',
      text: 'User planned to talk with a friend.',
      textKey: 'user planned to talk with a friend.'
    };
    const result = await provider.generateGreeting({ source });

    assert.equal(result.greeting.speech, 'How did the conversation with your friend go?');
    assert.equal(result.greeting.takeNote, false);
    assert.equal(result.greeting.note, null);
    assert.equal(result.source.id, 'friend-note');
  });

  it('returns the generic greeting when both personalized providers fail', async () => {
    globalThis.fetch = async () => new Response('Service unavailable', { status: 503 });
    const provider = new LlmProvider();
    provider.callOllama = async () => {
      throw new Error('Ollama unavailable in test');
    };

    const result = await provider.generateGreeting({
      source: {
        type: 'memory',
        id: 'memory-1',
        category: 'follow_up',
        text: 'A prior useful topic.',
        textKey: 'a prior useful topic.'
      }
    });

    assert.equal(result.greeting.speech, "Hello, welcome in. I'm Suzie. How are you feeling today?");
    assert.equal(result.source, null);
  });

  it('persists the selected source on the newly created session without changing the API greeting shape', async () => {
    const currentSession = session('new-session', null);
    const previousSession = session('previous-session');
    const availableMethods = {
      createSession: () => currentSession,
      getSessions: () => [
        { id: previousSession.id },
        { id: currentSession.id }
      ],
      getSession: id => id === previousSession.id ? previousSession : currentSession,
      getNotes: () => [
        note('selected-note', previousSession.id, 'An upcoming discussion with a friend.', '2026-11-03T10:00:00Z')
      ],
      updateSession: (_id, updates) => Object.assign(currentSession, updates),
      addMessage: () => ({ id: 'greeting-message' })
    };
    for (const [name, replacement] of Object.entries(availableMethods)) {
      originalStorageMethods[name] = storage[name];
      storage[name] = replacement;
    }
    memoryService.getActiveMemories = () => [];
    llmProvider.generateGreeting = async ({ source }) => ({
      source,
      greeting: {
        speech: 'How did the conversation with your friend go?',
        animation: 'talking',
        gesture: 'nod',
        takeNote: false,
        note: null,
        risk: 'none'
      }
    });
    ttsService.synthesize = async () => ({ audioUrl: null, degraded: [] });

    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'test-user' })
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.greeting.speech, 'How did the conversation with your friend go?');
      assert.equal(Object.hasOwn(body.greeting, 'source'), false);
      assert.equal(currentSession.greetingFollowUpSourceType, 'note');
      assert.equal(currentSession.greetingFollowUpSourceId, 'selected-note');
      assert.equal(
        currentSession.greetingFollowUpTextKey,
        'an upcoming discussion with a friend.'
      );
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('does not persist a source when the generic greeting is returned', async () => {
    const sessions = [];
    installSessionStartStorage({ sessions, notes: [] });
    memoryService.getActiveMemories = () => [];
    ttsService.synthesize = async () => ({ audioUrl: null, degraded: [] });

    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'generic-user' })
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.greeting.speech, "Hello, welcome in. I'm Suzie. How are you feeling today?");
      assert.equal(
        Object.hasOwn(sessions.find(item => item.userId === 'generic-user'), 'greetingFollowUpSourceId'),
        false
      );
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('serializes concurrent starts for one user and consumes distinct sources', async () => {
    const sessions = [
      session('previous-1'),
      session('previous-2')
    ];
    sessions.forEach(item => {
      item.userId = 'same-user';
    });
    const notes = [
      { ...note('latest-note', 'previous-1', 'A recent useful topic for follow-up.', '2026-11-03T12:00:00Z'), userId: 'same-user' },
      { ...note('older-note', 'previous-2', 'An older useful topic for follow-up.', '2026-11-02T12:00:00Z'), userId: 'same-user' }
    ];
    installSessionStartStorage({ sessions, notes });
    memoryService.getActiveMemories = () => [];
    ttsService.synthesize = async () => ({ audioUrl: null, degraded: [] });
    const selected = [];
    let activeGenerators = 0;
    let maxActiveGenerators = 0;
    llmProvider.generateGreeting = async ({ source }) => {
      activeGenerators += 1;
      maxActiveGenerators = Math.max(maxActiveGenerators, activeGenerators);
      selected.push(source.id);
      await new Promise(resolve => setTimeout(resolve, 25));
      activeGenerators -= 1;
      return {
        source,
        greeting: {
          speech: `Following up on ${source.text}`,
          animation: 'talking',
          gesture: 'nod',
          takeNote: false,
          note: null,
          risk: 'none',
          audioUrl: null,
          resources: null,
          degraded: []
        }
      };
    };

    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/session/start`;
      const start = () => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'same-user' })
      });
      const [first, second] = await Promise.all([start(), start()]);

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(maxActiveGenerators, 1);
      assert.deepEqual(selected.sort(), ['latest-note', 'older-note']);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('does not block a different user while one user is generating a greeting', async () => {
    const sessions = [session('prior-a'), session('prior-b')];
    sessions[0].userId = 'user-a';
    sessions[1].userId = 'user-b';
    const notes = [
      { ...note('note-a', 'prior-a', 'A useful topic for person A.', '2026-11-03T12:00:00Z'), userId: 'user-a' },
      { ...note('note-b', 'prior-b', 'A useful topic for person B.', '2026-11-03T12:00:00Z'), userId: 'user-b' }
    ];
    installSessionStartStorage({ sessions, notes });
    memoryService.getActiveMemories = () => [];
    ttsService.synthesize = async () => ({ audioUrl: null, degraded: [] });
    let activeGenerators = 0;
    let maxActiveGenerators = 0;
    let releaseBoth;
    const bothEntered = new Promise(resolve => {
      releaseBoth = resolve;
    });
    llmProvider.generateGreeting = async ({ source }) => {
      activeGenerators += 1;
      maxActiveGenerators = Math.max(maxActiveGenerators, activeGenerators);
      if (activeGenerators === 2) releaseBoth();
      let timeout;
      try {
        await Promise.race([
          bothEntered,
          new Promise(resolve => {
            timeout = setTimeout(resolve, 500);
          })
        ]);
      } finally {
        clearTimeout(timeout);
      }
      activeGenerators -= 1;
      return {
        source,
        greeting: {
          speech: 'A relevant question.',
          animation: 'talking',
          gesture: 'nod',
          takeNote: false,
          note: null,
          risk: 'none',
          audioUrl: null,
          resources: null,
          degraded: []
        }
      };
    };

    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/session/start`;
      const start = userId => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      const [responseA, responseB] = await Promise.all([start('user-a'), start('user-b')]);

      assert.equal(responseA.status, 200);
      assert.equal(responseB.status, 200);
      assert.equal(maxActiveGenerators, 2);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('releases the user lock after source persistence throws', async () => {
    const sessions = [session('previous')];
    sessions[0].userId = 'retry-user';
    const notes = [
      { ...note('retry-note', 'previous', 'A useful recent topic to discuss.', '2026-11-03T12:00:00Z'), userId: 'retry-user' }
    ];
    installSessionStartStorage({ sessions, notes });
    memoryService.getActiveMemories = () => [];
    ttsService.synthesize = async () => ({ audioUrl: null, degraded: [] });
    let failPersistence = true;
    storage.updateSession = (id, updates) => {
      if (failPersistence) {
        failPersistence = false;
        throw new Error('Simulated persistence failure');
      }
      const target = sessions.find(item => item.id === id);
      Object.assign(target, updates);
      return target;
    };
    llmProvider.generateGreeting = async ({ source }) => ({
      source,
      greeting: {
        speech: 'How did that go?',
        animation: 'talking',
        gesture: 'nod',
        takeNote: false,
        note: null,
        risk: 'none',
        audioUrl: null,
        resources: null,
        degraded: []
      }
    });

    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/session/start`;
      const start = () => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'retry-user' })
      });
      const failed = await start();
      assert.equal(failed.status, 500);

      let timeout;
      let succeeding;
      try {
        succeeding = await Promise.race([
          start(),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('User greeting lock was not released')),
              1000
            );
          })
        ]);
      } finally {
        clearTimeout(timeout);
      }
      assert.equal(succeeding.status, 200);
      const persisted = sessions.find(item => item.greetingFollowUpSourceId === 'retry-note');
      assert.ok(persisted);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
