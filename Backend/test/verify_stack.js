import { createWavBuffer, generateFallbackPcm } from '../src/tts/wavHelper.js';
import { ChatResponseSchema } from '../src/ai/schemas.js';

const BASE_URL = 'http://127.0.0.1:3000';

async function runTests() {
  console.log('====================================================');
  console.log(' Starting Suzie Backend Service Stack Verification');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName}`);
      failed++;
    }
  }

  // 1. GET /health
  console.log('1. Testing /health...');
  const healthStart = performance.now();
  const healthRes = await fetch(`${BASE_URL}/health`);
  const healthLatency = (performance.now() - healthStart).toFixed(1);
  const healthData = await healthRes.json();
  assert(healthRes.status === 200, `/health returns 200 (${healthLatency} ms)`);
  assert(healthData.ok === true, '/health ok is true');
  assert(Boolean(healthData.llm && healthData.stt && healthData.tts), '/health reports provider statuses');

  // 2. POST /session/start
  console.log('\n2. Testing /session/start...');
  const startSessionStart = performance.now();
  const sessionStartRes = await fetch(`${BASE_URL}/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'test-user' })
  });
  const startSessionLatency = (performance.now() - startSessionStart).toFixed(1);
  const sessionStartData = await sessionStartRes.json();
  assert(sessionStartRes.status === 200, `/session/start returns 200 (${startSessionLatency} ms)`);
  assert(Boolean(sessionStartData.sessionId), 'returns valid sessionId');
  assert(sessionStartData.greeting !== undefined, 'returns greeting object');
  const sessionId = sessionStartData.sessionId;

  // 3. POST /chat (Normal message)
  console.log('\n3. Testing /chat (Normal conversation)...');
  const chatStart = performance.now();
  const chatRes = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: "I've been feeling overwhelmed with work lately and haven't slept well."
    })
  });
  const chatLatency = (performance.now() - chatStart).toFixed(1);
  const chatData = await chatRes.json();
  assert(chatRes.status === 200, `/chat returns 200 (${chatLatency} ms)`);
  
  // Validate using Section 4.2 Zod schema
  const schemaValidation = ChatResponseSchema.safeParse(chatData);
  assert(schemaValidation.success, 'response conforms strictly to Section 4.2 ChatResponse');
  assert(typeof chatData.speech === 'string' && chatData.speech.length > 0, 'speech text is present');
  assert(['talking', 'listening', 'thinking', 'idle'].includes(chatData.animation), `animation '${chatData.animation}' is valid enum`);
  assert(['none', 'nod', 'small_gesture', 'head_tilt'].includes(chatData.gesture), `gesture '${chatData.gesture}' is valid enum`);
  assert(['none', 'concern', 'crisis'].includes(chatData.risk), `risk '${chatData.risk}' is valid enum`);

  // 4. Test Audio URL if generated
  if (chatData.audioUrl) {
    console.log('\n4. Testing /audio/:id.wav download...');
    const audioRes = await fetch(`${BASE_URL}${chatData.audioUrl}`);
    assert(audioRes.status === 200, `Audio WAV served successfully from ${chatData.audioUrl}`);
    const audioBuffer = await audioRes.arrayBuffer();
    assert(audioBuffer.byteLength > 44, `Audio buffer length is valid (${audioBuffer.byteLength} bytes)`);
  } else {
    console.log('\n4. TTS was degraded/unavailable, checking degraded list...');
    assert(chatData.degraded.includes('tts'), 'degraded contains "tts" when audioUrl is null');
  }

  // 5. POST /chat (Crisis Safety Pre-check)
  console.log('\n5. Testing /chat (Crisis Safety Pre-check)...');
  const crisisStart = performance.now();
  const crisisRes = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: "I feel like ending my life, I want to kill myself."
    })
  });
  const crisisLatency = (performance.now() - crisisStart).toFixed(1);
  const crisisData = await crisisRes.json();
  assert(crisisRes.status === 200, `/chat returns 200 on crisis (${crisisLatency} ms)`);
  assert(crisisData.risk === 'crisis', 'risk is set to "crisis"');
  assert(Array.isArray(crisisData.resources) && crisisData.resources.length > 0, 'resources array is populated with official contacts');
  assert(crisisData.speech.includes('pain') && crisisData.speech.includes('safe'), 'speech matches scripted supportive crisis response');
  assert(crisisData.takeNote === false, 'takeNote is false during crisis');

  // 6. POST /stt
  console.log('\n6. Testing /stt (WAV upload)...');
  const testWavBuffer = generateFallbackPcm(1.0, 24000);
  const formData = new FormData();
  formData.append('audio', new Blob([testWavBuffer], { type: 'audio/wav' }), 'sample.wav');

  const sttStart = performance.now();
  const sttRes = await fetch(`${BASE_URL}/stt`, {
    method: 'POST',
    body: formData
  });
  const sttLatency = (performance.now() - sttStart).toFixed(1);
  const sttData = await sttRes.json();
  assert(sttRes.status === 200, `/stt returns 200 (${sttLatency} ms)`);
  assert(typeof sttData.text === 'string' && sttData.text.length > 0, 'returns transcribed text');

  // 7. GET /sessions, /messages, /notes, /memories
  console.log('\n7. Testing query routes...');
  const sessionsRes = await fetch(`${BASE_URL}/sessions?userId=test-user`);
  const sessionsData = await sessionsRes.json();
  assert(sessionsRes.status === 200 && Array.isArray(sessionsData.sessions), 'GET /sessions returns sessions array');

  const messagesRes = await fetch(`${BASE_URL}/sessions/${sessionId}/messages`);
  const messagesData = await messagesRes.json();
  assert(messagesRes.status === 200 && Array.isArray(messagesData.messages), 'GET /sessions/:id/messages returns messages array');

  const notesRes = await fetch(`${BASE_URL}/notes?userId=test-user`);
  const notesData = await notesRes.json();
  assert(notesRes.status === 200 && Array.isArray(notesData.notes), 'GET /notes returns notes array');

  const memoriesRes = await fetch(`${BASE_URL}/memories?userId=test-user`);
  const memoriesData = await memoriesRes.json();
  assert(memoriesRes.status === 200 && Array.isArray(memoriesData.memories), 'GET /memories returns memories array');

  // 8. POST /session/end (Idempotent)
  console.log('\n8. Testing /session/end...');
  const endStart = performance.now();
  const endRes1 = await fetch(`${BASE_URL}/session/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
  const endLatency = (performance.now() - endStart).toFixed(1);
  const endData1 = await endRes1.json();
  assert(endRes1.status === 200 && endData1.ok === true, `/session/end returns ok: true (${endLatency} ms)`);

  // Call again to test idempotency
  const endRes2 = await fetch(`${BASE_URL}/session/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
  const endData2 = await endRes2.json();
  assert(endRes2.status === 200 && endData2.ok === true, `/session/end is idempotent on second call`);

  // 9. DELETE /sessions/:sessionId and DELETE /data
  console.log('\n9. Testing deletion routes...');
  const delSessionRes = await fetch(`${BASE_URL}/sessions/${sessionId}`, { method: 'DELETE' });
  const delSessionData = await delSessionRes.json();
  assert(delSessionRes.status === 200 && delSessionData.ok === true, 'DELETE /sessions/:sessionId returns ok: true');

  const clearDataRes = await fetch(`${BASE_URL}/data?userId=test-user`, { method: 'DELETE' });
  const clearDataResJson = await clearDataRes.json();
  assert(clearDataRes.status === 200 && clearDataResJson.ok === true, 'DELETE /data returns ok: true');

  console.log('\n====================================================');
  console.log(` Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
