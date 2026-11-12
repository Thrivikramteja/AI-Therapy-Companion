import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { config } from '../src/config/index.js';
import { llmProvider, LlmProvider } from '../src/ai/llmProvider.js';
import { router } from '../src/api/routes.js';
import { storage } from '../src/memory/storage.js';

const originalGetSession = storage.getSession;
const originalGetMemories = storage.getMemories;
const originalAssess = llmProvider.assessCircleCardMemorySuitability;
const originalGenerate = llmProvider.generateCircleControlCards;
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalGroqApiKey = config.groqApiKey;
const originalFallbackKey = config.groqApiKeyFallback;
const originalGroqModel = config.groqChatModel;

const selectedMemory = {
  id: 'memory-one',
  userId: 'owner-one',
  category: 'goal',
  text: 'I am working toward learning guitar.',
  createdAt: '2026-01-01T00:00:00.000Z'
};

const validCards = [{
  text: 'What small step could support this goal?',
  category: 'within_control',
  reflection: 'Small choices can help you move at your own pace.',
  nuanced: false
}];

const validRequest = {
  sessionId: 'active-session',
  consent: true,
  memoryIds: [selectedMemory.id]
};

let fixtureSession;
let fixtureMemories;
let logs;

async function postCards(body = validRequest) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/activities/circle-of-control/personalized-cards`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => server.close(error =>
      error ? reject(error) : resolve()
    ));
  }
}

function providerResponse(content) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('personalized Circle of Control cards', () => {
  beforeEach(() => {
    fixtureSession = { id: 'active-session', userId: 'owner-one', endedAt: null };
    fixtureMemories = [selectedMemory];
    logs = [];
    storage.getSession = id => id === fixtureSession?.id ? fixtureSession : null;
    storage.getMemories = userId =>
      fixtureMemories.filter(memory => memory.userId === userId);
    llmProvider.assessCircleCardMemorySuitability = async () => [
      'an everyday personal goal'
    ];
    llmProvider.generateCircleControlCards = async () => validCards;
    console.error = (...args) => logs.push(args.join(' '));
  });

  afterEach(() => {
    storage.getSession = originalGetSession;
    storage.getMemories = originalGetMemories;
    llmProvider.assessCircleCardMemorySuitability = originalAssess;
    llmProvider.generateCircleControlCards = originalGenerate;
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    config.groqApiKey = originalGroqApiKey;
    config.groqApiKeyFallback = originalFallbackKey;
    config.groqChatModel = originalGroqModel;
  });

  it('rejects missing consent and consent that is not exactly true', async () => {
    const missingConsent = { ...validRequest };
    delete missingConsent.consent;
    const falseConsent = { ...validRequest, consent: false };

    assert.equal((await postCards(missingConsent)).status, 400);
    assert.equal((await postCards(falseConsent)).status, 400);
  });

  it('rejects an unknown session without assessing memories', async () => {
    fixtureSession = null;
    let assessments = 0;
    llmProvider.assessCircleCardMemorySuitability = async () => {
      assessments += 1;
      return [];
    };

    const result = await postCards();

    assert.equal(result.status, 404);
    assert.equal(assessments, 0);
  });

  it('rejects unknown and other-user memory IDs with the same safe error', async () => {
    fixtureMemories.push({
      ...selectedMemory,
      id: 'another-users-memory',
      userId: 'owner-two'
    });

    for (const id of ['unknown-memory', 'another-users-memory']) {
      const result = await postCards({ ...validRequest, memoryIds: [id] });
      assert.equal(result.status, 400);
      assert.equal(result.body.error.message, 'One or more selected memories are unavailable.');
    }
  });

  it('rejects more than three memory IDs and duplicate IDs', async () => {
    const tooMany = {
      ...validRequest,
      memoryIds: ['one', 'two', 'three', 'four']
    };
    const duplicate = {
      ...validRequest,
      memoryIds: [selectedMemory.id, selectedMemory.id]
    };

    assert.equal((await postCards(tooMany)).status, 400);
    assert.equal((await postCards(duplicate)).status, 400);
  });

  it('rejects a client-supplied userId', async () => {
    const result = await postCards({ ...validRequest, userId: 'attacker' });

    assert.equal(result.status, 400);
  });

  it('uses the session owner and selected records only', async () => {
    let scopedUser;
    let assessedTexts;
    storage.getMemories = userId => {
      scopedUser = userId;
      return [selectedMemory];
    };
    llmProvider.assessCircleCardMemorySuitability = async memories => {
      assessedTexts = memories.map(memory => memory.text);
      return ['an everyday personal goal'];
    };
    const result = await postCards({
      ...validRequest,
      memoryIds: [selectedMemory.id]
    });

    assert.equal(result.status, 200);
    assert.equal(scopedUser, 'owner-one');
    assert.deepEqual(assessedTexts, [selectedMemory.text]);
  });

  it('rejects an ended session', async () => {
    fixtureSession.endedAt = '2026-01-01T00:00:00.000Z';

    const result = await postCards();

    assert.equal(result.status, 400);
  });

  it('returns generic cards when suitability assessment fails', async () => {
    llmProvider.assessCircleCardMemorySuitability = async () => {
      throw new Error(selectedMemory.text);
    };
    let generations = 0;
    llmProvider.generateCircleControlCards = async () => {
      generations += 1;
      return validCards;
    };

    const result = await postCards();

    assert.deepEqual(result.body, { personalized: false, cards: [] });
    assert.equal(generations, 0);
    assert.equal(logs.join('\n').includes(selectedMemory.text), false);
  });

  it('returns generic cards when generation fails', async () => {
    llmProvider.generateCircleControlCards = async () => {
      throw new Error('provider failure');
    };

    const result = await postCards();

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { personalized: false, cards: [] });
  });

  it('returns generic cards for invalid categories and malformed cards', async () => {
    for (const cards of [
      [{ ...validCards[0], category: 'maybe' }],
      [{ text: '', category: 'within_control', reflection: 'x', nuanced: false }],
      [{ ...validCards[0], unexpected: true }]
    ]) {
      llmProvider.generateCircleControlCards = async () => cards;
      const result = await postCards();
      assert.deepEqual(result.body, { personalized: false, cards: [] });
    }
  });

  it('returns validated cards on successful generation', async () => {
    const result = await postCards();

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { personalized: true, cards: validCards });
  });

  it('returns an empty fallback when no memories are selected or eligible', async () => {
    let assessments = 0;
    llmProvider.assessCircleCardMemorySuitability = async () => {
      assessments += 1;
      return [];
    };
    const noSelection = await postCards({ ...validRequest, memoryIds: [] });
    const noEligibleMemories = await postCards();

    assert.deepEqual(noSelection.body, { personalized: false, cards: [] });
    assert.deepEqual(noEligibleMemories.body, { personalized: false, cards: [] });
    assert.equal(assessments, 1);
  });

  it('does not persist generated cards or create activity messages or memories', async () => {
    let writes = 0;
    const originalWrites = {
      addMessage: storage.addMessage,
      addNote: storage.addNote,
      addMemory: storage.addMemory
    };
    storage.addMessage = storage.addNote = storage.addMemory = () => {
      writes += 1;
    };
    try {
      await postCards();
    } finally {
      Object.assign(storage, originalWrites);
    }

    assert.equal(writes, 0);
  });

  it('screens sensitive memories locally and excludes uncertain assessments', async () => {
    config.groqApiKey = 'gsk_unit_test_key';
    config.groqApiKeyFallback = '';
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls += 1;
      return providerResponse({
        assessments: [{
          index: 0,
          eligible: false,
          confidence: 'uncertain',
          context: ''
        }]
      });
    };
    const provider = new LlmProvider();

    const sensitive = await provider.assessCircleCardMemorySuitability([
      { text: 'I experienced trauma and abuse.' }
    ]);
    const ambiguous = await provider.assessCircleCardMemorySuitability([
      { text: 'I have a difficult personal situation.' }
    ]);

    assert.deepEqual(sensitive, []);
    assert.deepEqual(ambiguous, []);
    assert.equal(providerCalls, 1);
  });

  it('sends only approved high-level context to the card-generation request', async () => {
    config.groqApiKey = 'gsk_unit_test_key';
    config.groqApiKeyFallback = '';
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (requests.length === 1) {
        return providerResponse({
          assessments: [{
            index: 0,
            eligible: true,
            confidence: 'high',
            context: 'an everyday personal goal'
          }]
        });
      }
      return providerResponse({ cards: validCards });
    };
    const provider = new LlmProvider();

    const approved = await provider.assessCircleCardMemorySuitability([
      selectedMemory
    ]);
    const cards = await provider.generateCircleControlCards(approved);

    assert.deepEqual(approved, ['an everyday personal goal']);
    assert.deepEqual(cards, validCards);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].messages[1].content.includes(selectedMemory.text), true);
    assert.equal(requests[1].messages[1].content.includes(selectedMemory.text), false);
    assert.equal(requests[1].messages[1].content.includes('an everyday personal goal'), true);
  });
});
