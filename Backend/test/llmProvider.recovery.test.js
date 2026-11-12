import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { config } from '../src/config/index.js';
import { LlmProvider } from '../src/ai/llmProvider.js';

const originalFetch = globalThis.fetch;
const originalGroqApiKey = config.groqApiKey;
const originalGroqApiKeyFallback = config.groqApiKeyFallback;
const originalLlmProvider = config.llmProvider;

const validOutput = {
  speech: 'A helpful response.',
  animation: 'talking',
  gesture: 'none',
  takeNote: false,
  note: null,
  risk: 'none'
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function formatFailure(failedGeneration, code = 'json_validate_failed') {
  return jsonResponse({
    error: {
      code,
      failed_generation: failedGeneration
    }
  }, 400);
}

function setupProvider(fetchHandler, { ollamaFails = false } = {}) {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return fetchHandler(url, options, requests.length);
  };

  const provider = new LlmProvider();
  let ollamaCalls = 0;
  provider.callOllama = async () => {
    ollamaCalls += 1;
    if (ollamaFails) throw new Error('Ollama unavailable in test');
    return { ...validOutput, speech: 'Ollama fallback.' };
  };

  return { provider, requests, get ollamaCalls() { return ollamaCalls; } };
}

describe('Groq structured-output recovery', () => {
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
  });

  it('uses strict schema mode for a valid response without fallback', async () => {
    const testContext = setupProvider(() =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify(validOutput) } }] })
    );

    const result = await testContext.provider.generateChatResponse([
      { role: 'user', text: 'Hello' }
    ]);

    assert.equal(result.speech, validOutput.speech);
    assert.equal(testContext.requests.length, 1);
    assert.equal(testContext.requests[0].body.response_format.type, 'json_schema');
    assert.equal(testContext.requests[0].body.response_format.json_schema.strict, true);
    assert.equal(testContext.ollamaCalls, 0);
  });

  it('recovers Groq plain-text failed_generation without retry or fallback', async () => {
    const speech = 'I’m here to listen. What’s on your mind about your ETS?';
    const testContext = setupProvider(() => formatFailure(speech));

    const result = await testContext.provider.generateChatResponse([
      { role: 'user', text: 'I want to talk.' }
    ]);

    assert.equal(result.speech, speech);
    assert.equal(result.animation, 'talking');
    assert.equal(result.gesture, 'none');
    assert.equal(result.takeNote, false);
    assert.equal(result.note, null);
    assert.equal(testContext.requests.length, 1);
    assert.equal(testContext.ollamaCalls, 0);
  });

  it('recovers the commentary tool wrapper from Groq tool_use_failed', async () => {
    const speech = 'It sounds like you’re planning to chat after your walk—looking forward to hearing how it went.';
    const failedGeneration = JSON.stringify({
      name: 'commentary',
      arguments: {
        speech,
        animation: 'talking',
        gesture: 'nod',
        takeNote: false,
        note: null,
        risk: 'none'
      }
    });
    const testContext = setupProvider(() =>
      formatFailure(failedGeneration, 'tool_use_failed')
    );

    const result = await testContext.provider.generateChatResponse([
      { role: 'user', text: 'I am going for a walk.' }
    ]);

    assert.equal(result.speech, speech);
    assert.equal(result.animation, 'talking');
    assert.equal(result.gesture, 'nod');
    assert.equal(result.takeNote, false);
    assert.equal(result.note, null);
    assert.equal(result.risk, 'none');
    assert.equal(testContext.requests.length, 1);
    assert.equal(testContext.ollamaCalls, 0);
  });

  it('rejects unknown wrapper names and malformed wrapper arguments', async () => {
    const invalidGenerations = [
      JSON.stringify({
        name: 'unknown_tool',
        arguments: { ...validOutput }
      }),
      JSON.stringify({
        name: 'commentary',
        arguments: { ...validOutput, animation: 'running' }
      })
    ];

    for (const failedGeneration of invalidGenerations) {
      const testContext = setupProvider((_url, _options, call) => call === 1
        ? formatFailure(failedGeneration, 'tool_use_failed')
        : jsonResponse({ choices: [{ message: { content: JSON.stringify({
            speech: 'Missing risk.',
            animation: 'talking',
            gesture: 'none',
            takeNote: false,
            note: null
          }) } }] })
      );

      const result = await testContext.provider.generateChatResponse([
        { role: 'user', text: 'Respond.' }
      ]);

      assert.equal(result.speech, 'Ollama fallback.');
      assert.equal(testContext.requests.length, 2);
      assert.equal(testContext.ollamaCalls, 1);
    }
  });

  it('retries once in JSON Object Mode when failed_generation is not recoverable', async () => {
    const testContext = setupProvider((_url, _options, call) => call === 1
      ? formatFailure('{"speech": }')
      : jsonResponse({ choices: [{ message: { content: JSON.stringify({
          ...validOutput,
          speech: 'Recovered on retry.'
        }) } }] })
    );

    const result = await testContext.provider.generateChatResponse([
      { role: 'user', text: 'Please respond.' }
    ]);

    assert.equal(result.speech, 'Recovered on retry.');
    assert.equal(testContext.requests.length, 2);
    assert.deepEqual(testContext.requests[1].body.response_format, {
      type: 'json_object'
    });
    assert.match(testContext.requests[1].body.messages[0].content, /Corrective instruction/);
    assert.equal(testContext.ollamaCalls, 0);
  });

  it('trims and limits oversized note text without discarding speech', async () => {
    const longNote = ` ${'n'.repeat(170)} `;
    const testContext = setupProvider(() => jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        ...validOutput,
        speech: 'Speech remains available.',
        takeNote: true,
        note: { category: 'goal', text: longNote }
      }) } }]
    }));

    const result = await testContext.provider.generateChatResponse([
      { role: 'user', text: 'I have a goal.' }
    ]);

    assert.equal(result.speech, 'Speech remains available.');
    assert.equal(result.note.text.length, 160);
    assert.equal(testContext.requests.length, 1);
  });

  it('discards an invalid note category but preserves speech', async () => {
    const testContext = setupProvider(() => jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        ...validOutput,
        speech: 'Speech remains available.',
        takeNote: true,
        note: { category: 'unknown', text: 'Some note.' }
      }) } }]
    }));

    const result = await testContext.provider.generateChatResponse([
      { role: 'user', text: 'Respond to me.' }
    ]);

    assert.equal(result.speech, 'Speech remains available.');
    assert.equal(result.takeNote, false);
    assert.equal(result.note, null);
  });

  it('rejects missing risk in JSON Object Mode and falls back', async () => {
    const testContext = setupProvider((_url, _options, call) => call === 1
      ? formatFailure('{"speech": }')
      : jsonResponse({ choices: [{ message: { content: JSON.stringify({
          speech: 'Missing risk.',
          animation: 'talking',
          gesture: 'none',
          takeNote: false,
          note: null
        }) } }] })
    );

    const result = await testContext.provider.generateChatResponse([
      { role: 'user', text: 'Respond.' }
    ]);

    assert.equal(result.speech, 'Ollama fallback.');
    assert.equal(testContext.requests.length, 2);
    assert.equal(testContext.ollamaCalls, 1);
  });

  it('preserves fallback behavior after both formatting attempts fail', async () => {
    const testContext = setupProvider(() => formatFailure('{"speech": }'), {
      ollamaFails: true
    });

    const result = await testContext.provider.generateChatResponse([
      { role: 'user', text: 'Respond.' }
    ]);

    assert.equal(testContext.requests.length, 2);
    assert.equal(testContext.ollamaCalls, 1);
    assert.ok(result.speech.length > 0);
  });

  it('does not retry real provider errors such as HTTP 401', async () => {
    const testContext = setupProvider(() =>
      jsonResponse({ error: { message: 'Unauthorized' } }, 401)
    );

    const result = await testContext.provider.generateChatResponse([
      { role: 'user', text: 'Respond.' }
    ]);

    assert.equal(testContext.requests.length, 1);
    assert.equal(testContext.ollamaCalls, 1);
    assert.equal(result.speech, 'Ollama fallback.');
  });

  it('keeps session memory extraction on its existing generic Groq call', async () => {
    const extraction = {
      summary: 'The client discussed a personal goal.',
      memories: [{ category: 'goal', text: 'Practice daily.' }]
    };
    const testContext = setupProvider((_url, _options, call) => jsonResponse({
      choices: [{ message: { content: JSON.stringify(extraction) } }]
    }));

    const result = await testContext.provider.extractSessionSummaryAndMemories([
      { role: 'user', text: 'I want to practice daily.' }
    ]);

    assert.deepEqual(result, extraction);
    assert.equal(testContext.requests.length, 1);
    assert.deepEqual(testContext.requests[0].body.response_format, {
      type: 'json_object'
    });
    assert.equal(testContext.requests[0].body.messages[0].role, 'user');
    assert.equal(testContext.ollamaCalls, 0);
  });
});
