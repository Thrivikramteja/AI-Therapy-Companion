import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { config } from '../src/config/index.js';
import { LlmProvider } from '../src/ai/llmProvider.js';

const originalFetch = globalThis.fetch;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;
const originalConfig = {
  groqApiKey: config.groqApiKey,
  groqApiKeyFallback: config.groqApiKeyFallback,
  llmProvider: config.llmProvider
};

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

function groqResponse(output) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify(output) } }]
  });
}

function installFetch(handler) {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({
      url,
      options,
      body: JSON.parse(options.body)
    });
    return handler(requests.at(-1), requests.length);
  };
  return requests;
}

describe('Groq account fallback', () => {
  beforeEach(() => {
    config.groqApiKey = 'gsk_primary_test_key';
    config.groqApiKeyFallback = 'gsk_secondary_test_key';
    config.llmProvider = 'groq';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    config.groqApiKey = originalConfig.groqApiKey;
    config.groqApiKeyFallback = originalConfig.groqApiKeyFallback;
    config.llmProvider = originalConfig.llmProvider;
  });

  it('does not use the secondary account when the primary succeeds', async () => {
    const requests = installFetch(() => groqResponse(validOutput));
    const result = await new LlmProvider().generateChatResponse([
      { role: 'user', text: 'Hello.' }
    ]);

    assert.equal(result.speech, validOutput.speech);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer gsk_primary_test_key');
  });

  for (const status of [401, 429]) {
    it(`uses the secondary account after primary HTTP ${status}`, async () => {
      const requests = installFetch((_request, call) =>
        call === 1
          ? jsonResponse({ error: { message: 'account issue' } }, status)
          : groqResponse({ ...validOutput, speech: 'Secondary succeeded.' })
      );
      const result = await new LlmProvider().generateChatResponse([
        { role: 'user', text: 'Please respond.' }
      ]);

      assert.equal(result.speech, 'Secondary succeeded.');
      assert.equal(requests.length, 2);
      assert.equal(requests[1].options.headers.Authorization, 'Bearer gsk_secondary_test_key');
    });
  }

  it('uses the secondary account for personalized greetings after a network failure', async () => {
    const requests = installFetch((_request, call) => call === 1
      ? Promise.reject(new TypeError('fetch failed'))
      : groqResponse({
          ...validOutput,
          speech: 'How did your interview go?'
        })
    );

    const result = await new LlmProvider().generateGreeting({
      source: {
        type: 'note',
        id: 'interview-note',
        category: 'important_event',
        text: 'User had an interview scheduled.'
      }
    });

    assert.equal(result.greeting.speech, 'How did your interview go?');
    assert.equal(result.source.id, 'interview-note');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.headers.Authorization, 'Bearer gsk_secondary_test_key');
  });

  it('sends identical payloads and generation parameters to both accounts', async () => {
    const requests = installFetch((_request, call) =>
      call === 1
        ? jsonResponse({ error: { message: 'rate limited' } }, 429)
        : groqResponse(validOutput)
    );

    await new LlmProvider().generateChatResponse([
      { role: 'user', text: 'I have an interview next Friday.' }
    ]);

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].body, requests[0].body);
    assert.equal(requests[1].url, requests[0].url);
    assert.equal(requests[1].options.method, requests[0].options.method);
    assert.equal(requests[1].options.headers['Content-Type'], requests[0].options.headers['Content-Type']);
    assert.notEqual(
      requests[1].options.headers.Authorization,
      requests[0].options.headers.Authorization
    );
  });

  it('uses the secondary account for a clearly identified project permission error', async () => {
    const requests = installFetch((_request, call) =>
      call === 1
        ? jsonResponse({ error: { code: 'project_not_found' } }, 403)
        : groqResponse(validOutput)
    );

    const result = await new LlmProvider().generateChatResponse([
      { role: 'user', text: 'Hello.' }
    ]);

    assert.equal(result.speech, validOutput.speech);
    assert.equal(requests.length, 2);
  });

  it('continues to Ollama when both Groq accounts fail', async () => {
    const requests = installFetch((_request, call) =>
      jsonResponse({ error: { message: 'unavailable' } }, call === 1 ? 401 : 503)
    );
    const provider = new LlmProvider();
    provider.callOllama = async () => ({ ...validOutput, speech: 'Ollama response.' });

    const result = await provider.generateChatResponse([
      { role: 'user', text: 'Hello.' }
    ]);

    assert.equal(result.speech, 'Ollama response.');
    assert.equal(requests.length, 2);
  });

  it('supports primary-only and secondary-only configuration', async () => {
    config.groqApiKeyFallback = '';
    let requests = installFetch(() => groqResponse(validOutput));
    await new LlmProvider().generateChatResponse([{ role: 'user', text: 'Hi.' }]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer gsk_primary_test_key');

    config.groqApiKey = '';
    config.groqApiKeyFallback = 'gsk_secondary_test_key';
    requests = installFetch(() => groqResponse(validOutput));
    await new LlmProvider().generateChatResponse([{ role: 'user', text: 'Hi.' }]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer gsk_secondary_test_key');
  });

  it('retries the secondary account after a primary network failure', async () => {
    const requests = installFetch(() => {
      if (requests.length === 1) throw new TypeError('fetch failed');
      return groqResponse({ ...validOutput, speech: 'Secondary recovered the request.' });
    });
    const provider = new LlmProvider();

    const result = await provider.generateChatResponse([
      { role: 'user', text: 'Hello.' }
    ]);

    assert.equal(result.speech, 'Secondary recovered the request.');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.headers.Authorization, 'Bearer gsk_secondary_test_key');
  });

  for (const [status, error] of [
    [400, { code: 'bad_request' }],
    [503, { message: 'provider unavailable' }]
  ]) {
    it(`uses the secondary account after ordinary HTTP ${status}`, async () => {
      const requests = installFetch(() => jsonResponse({ error }, status));
      const provider = new LlmProvider();
      provider.callOllama = async () => ({ ...validOutput, speech: 'Ollama response.' });
      const result = await provider.generateChatResponse([
        { role: 'user', text: 'Hello.' }
      ]);

      assert.equal(result.speech, 'Ollama response.');
      assert.equal(requests.length, 2);
      assert.equal(requests[0].options.headers.Authorization, 'Bearer gsk_primary_test_key');
      assert.equal(requests[1].options.headers.Authorization, 'Bearer gsk_secondary_test_key');
    });
  }

  it('logs both network failures with diagnostics but redacts credentials', async () => {
    const requests = installFetch(() => {
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED'
      });
      throw error;
    });
    const output = [];
    console.error = (...args) => output.push(args.map(String).join(' '));
    const provider = new LlmProvider();
    provider.callOllama = async () => ({ ...validOutput });

    await provider.generateChatResponse([{ role: 'user', text: 'Hello.' }]);

    assert.equal(requests.length, 2);
    assert.match(output.join('\n'), /ECONNREFUSED/);
    assert.equal(output.join('\n').includes('gsk_primary_test_key'), false);
    assert.equal(output.join('\n').includes('gsk_secondary_test_key'), false);
  });

  it('keeps JSON-format recovery on the primary account', async () => {
    const requests = installFetch((_request, call) => call === 1
      ? jsonResponse({
          error: {
            code: 'json_validate_failed',
            failed_generation: '{"speech": }'
          }
        }, 400)
      : groqResponse({ ...validOutput, speech: 'Recovered without account fallback.' })
    );

    const result = await new LlmProvider().generateChatResponse([
      { role: 'user', text: 'Please respond.' }
    ]);

    assert.equal(result.speech, 'Recovered without account fallback.');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.headers.Authorization, 'Bearer gsk_primary_test_key');
    assert.deepEqual(requests[1].body.response_format, { type: 'json_object' });
  });

  it('preserves tool_use_failed recovery without using the secondary account', async () => {
    const failedGeneration = JSON.stringify({
      name: 'commentary',
      arguments: {
        ...validOutput,
        speech: 'Recovered from the structured response.'
      }
    });
    const requests = installFetch(() => jsonResponse({
      error: { code: 'tool_use_failed', failed_generation: failedGeneration }
    }, 400));

    const result = await new LlmProvider().generateChatResponse([
      { role: 'user', text: 'Please respond.' }
    ]);

    assert.equal(result.speech, 'Recovered from the structured response.');
    assert.equal(requests.length, 1);
  });

  it('does not print either credential in logs', async () => {
    const requests = installFetch((_request, call) =>
      jsonResponse({ error: { message: 'unavailable' } }, call === 1 ? 401 : 503)
    );
    const logs = [];
    console.error = (...args) => logs.push(args.join(' '));
    const provider = new LlmProvider();
    provider.callOllama = async () => ({ ...validOutput });

    await provider.generateChatResponse([{ role: 'user', text: 'Hello.' }]);

    assert.equal(requests.length, 2);
    assert.equal(logs.join('\n').includes('gsk_primary_test_key'), false);
    assert.equal(logs.join('\n').includes('gsk_secondary_test_key'), false);
  });

  it('uses secondary account fallback for memory-generation requests', async () => {
    const extraction = { summary: 'A concise summary.', memories: [] };
    const requests = installFetch((_request, call) =>
      call === 1
        ? jsonResponse({ error: { message: 'unauthorized' } }, 401)
        : jsonResponse({
            choices: [{ message: { content: JSON.stringify(extraction) } }]
          })
    );

    const result = await new LlmProvider().extractSessionSummaryAndMemories([
      { role: 'user', text: 'A completed conversation.' }
    ]);

    assert.deepEqual(result, extraction);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].body, requests[1].body);
  });

  it('falls back to Ollama for memory generation after both Groq accounts fail', async () => {
    const extraction = { summary: 'Ollama summary.', memories: [] };
    const requests = installFetch((_request, call) =>
      jsonResponse({ error: { code: 'unavailable' } }, call === 1 ? 502 : 503)
    );
    const provider = new LlmProvider();
    let ollamaCalls = 0;
    provider.callOllamaGeneric = async () => {
      ollamaCalls += 1;
      return JSON.stringify(extraction);
    };

    const result = await provider.extractSessionSummaryAndMemories([
      { role: 'user', text: 'A completed conversation.' }
    ]);

    assert.deepEqual(result, extraction);
    assert.equal(requests.length, 2);
    assert.equal(ollamaCalls, 1);
  });
});

describe('automatic note-taking decisions', () => {
  beforeEach(() => {
    config.groqApiKey = 'gsk_primary_test_key';
    config.groqApiKeyFallback = '';
    config.llmProvider = 'groq';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    config.groqApiKey = originalConfig.groqApiKey;
    config.groqApiKeyFallback = originalConfig.groqApiKeyFallback;
    config.llmProvider = originalConfig.llmProvider;
  });

  async function generateFor(userText, output, noteAllowed = true, activeMemories = []) {
    const requests = installFetch(() => groqResponse(output));
    const result = await new LlmProvider().generateChatResponse(
      [{ role: 'user', text: userText }],
      activeMemories,
      noteAllowed
    );
    return { result, request: requests[0].body };
  }

  const noteResponse = (category, text) => ({
    ...validOutput,
    takeNote: true,
    note: { category, text }
  });

  it('accepts a proactive birthday note without an explicit save request', async () => {
    const { result, request } = await generateFor(
      'My birthday is tomorrow.',
      noteResponse('important_event', "User's birthday is tomorrow.")
    );

    assert.equal(result.takeNote, true);
    assert.deepEqual(result.note, {
      category: 'important_event',
      text: "User's birthday is tomorrow."
    });
    assert.match(request.messages[0].content, /Proactively note personally meaningful events/i);
    assert.match(request.messages[0].content, /current user message itself is not a duplicate/i);
  });

  for (const [label, userText, category, noteText] of [
    ['examination', 'I have an examination next week.', 'important_event', 'User has an examination next week.'],
    ['interview', 'I have an interview next Friday and I am nervous.', 'important_event', 'User has an interview next Friday.'],
    ['recurring concern', 'I keep worrying about the conflict with my sister.', 'explicitly_stated_emotion', 'User is repeatedly worried about conflict with their sister.']
  ]) {
    it(`preserves a suitable ${label} note`, async () => {
      const { result } = await generateFor(
        userText,
        noteResponse(category, noteText),
        false
      );

      assert.equal(result.takeNote, true);
      assert.equal(result.note.category, category);
      assert.equal(result.note.text, noteText);
    });
  }

  it('does not create notes for casual lunch or a simple greeting', async () => {
    for (const text of ['Nothing much, just had lunch.', 'Hello, how are you?']) {
      const { result } = await generateFor(text, validOutput, false);
      assert.equal(result.takeNote, false);
      assert.equal(result.note, null);
    }
  });

  it('keeps explicit remember requests and valid note limits', async () => {
    const longText = `User's birthday is tomorrow. ${'Extra detail. '.repeat(20)}`;
    const { result } = await generateFor(
      'Please remember that my birthday is tomorrow.',
      noteResponse('important_event', longText)
    );

    assert.equal(result.takeNote, true);
    assert.equal(result.note.text.length, 160);
    assert.equal(result.note.category, 'important_event');
  });

  it('respects a response that declines to remember information', async () => {
    const { result } = await generateFor(
      'I have an exam coming up, but please do not remember it.',
      validOutput
    );

    assert.equal(result.takeNote, false);
    assert.equal(result.note, null);
  });

  it('retains the routine note frequency limit for lower-priority categories', async () => {
    const { result } = await generateFor(
      'I prefer tea.',
      noteResponse('preference', 'User prefers tea.'),
      false
    );

    assert.equal(result.takeNote, false);
    assert.equal(result.note, null);
  });
});
