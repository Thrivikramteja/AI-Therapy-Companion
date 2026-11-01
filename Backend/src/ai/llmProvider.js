import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { RawLlmOutputSchema, normalizeLlmResponse, SessionEndExtractionSchema } from './schemas.js';

let systemPromptCache = null;

export function getSystemPrompt(activeMemories = []) {
  if (!systemPromptCache) {
    try {
      const promptPath = path.join(config.promptsDir, 'system_prompt.md');
      if (fs.existsSync(promptPath)) {
        systemPromptCache = fs.readFileSync(promptPath, 'utf-8');
      } else {
        systemPromptCache = "You are Suzie, a compassionate virtual therapy companion. Keep replies to 1-3 sentences in JSON format.";
      }
    } catch (err) {
      console.error('[LLM] Failed to read system prompt:', err);
      systemPromptCache = "You are Suzie, a compassionate virtual therapy companion.";
    }
  }

  let prompt = systemPromptCache;
  if (activeMemories && activeMemories.length > 0) {
    prompt += "\n\n## Important Client Background & Active Memories\n" +
      activeMemories.map(m => `- [${m.category}] ${m.text}`).join('\n') +
      "\nUse these memories naturally when relevant to maintain therapeutic continuity.";
  }

  return prompt;
}

// Fallback canned therapy responses
const CANNED_RESPONSES = [
  {
    speech: "I hear you, and it makes complete sense that you'd feel that way. What feels most present for you right now?",
    animation: "talking",
    gesture: "nod",
    takeNote: false,
    note: null,
    risk: "none"
  },
  {
    speech: "Thank you for sharing that with me. It takes courage to open up. Would you like to tell me more about what that brought up for you?",
    animation: "talking",
    gesture: "small_gesture",
    takeNote: false,
    note: null,
    risk: "none"
  },
  {
    speech: "It sounds like you have been carrying quite a heavy load lately. How are you taking care of yourself today?",
    animation: "talking",
    gesture: "head_tilt",
    takeNote: false,
    note: null,
    risk: "none"
  }
];

function getCannedResponse() {
  const choice = CANNED_RESPONSES[Math.floor(Math.random() * CANNED_RESPONSES.length)];
  return { ...choice };
}

export class LlmProvider {
  constructor() {
    this.provider = config.llmProvider;
  }

  async generateChatResponse(messages, activeMemories = [], noteAllowed = true) {
    const systemPrompt = getSystemPrompt(activeMemories);
    
    // Try primary provider, then fallbacks
    let rawResult = null;

    const isRealGroqKey = config.groqApiKey && 
                          config.groqApiKey.startsWith('gsk_') && 
                          config.groqApiKey !== 'your_groq_api_key_here';

    if (isRealGroqKey && config.llmProvider === 'groq') {
      try {
        rawResult = await this.callGroq(messages, systemPrompt);
      } catch (err) {
        console.warn('[LLM] Groq call failed, attempting Ollama fallback:', err.message);
      }
    }

    if (!rawResult) {
      try {
        rawResult = await this.callOllama(messages, systemPrompt);
      } catch (err) {
        console.warn('[LLM] Ollama call failed:', err.message);
      }
    }

    if (!rawResult) {
      console.warn('[LLM] Falling back to structured canned response.');
      rawResult = getCannedResponse();
    }

    // Validate and normalize with Node Zod
    return normalizeLlmResponse(rawResult, noteAllowed);
  }

  async generateGreeting(activeMemories = []) {
    let followUp = null;
    if (activeMemories.length > 0) {
      const candidates = activeMemories.filter(m => m.category === 'follow_up' || m.category === 'important_event');
      followUp = candidates.length > 0 ? candidates[0] : activeMemories[0];
    }

    if (followUp) {
      const speech = `Hello! It's so good to see you again. Last time, you mentioned ${followUp.text}. How has that been going?`;
      return {
        speech,
        animation: "talking",
        gesture: "nod",
        takeNote: false,
        note: null,
        audioUrl: null,
        risk: "none",
        resources: null,
        degraded: []
      };
    }

    return {
      speech: "Hello, welcome in. I'm Suzie. How are you feeling today?",
      animation: "talking",
      gesture: "nod",
      takeNote: false,
      note: null,
      audioUrl: null,
      risk: "none",
      resources: null,
      degraded: []
    };
  }

  async extractSessionSummaryAndMemories(sessionMessages) {
    if (!sessionMessages || sessionMessages.length === 0) {
      return { summary: "Session ended with no messages.", memories: [] };
    }

    const conversationText = sessionMessages
      .map(m => `${m.role.toUpperCase()}: ${m.text}`)
      .join('\n');

    const prompt = `You are a therapeutic memory assistant. Summarize the following session in 1-2 sentences. Also extract 0 to 3 durable memories (key personal facts, goals, or follow-ups). Do NOT extract entire transcripts, only essential facts.
Allowed memory categories: 'important_event', 'recurring_concern', 'goal', 'coping_strategy', 'preference', 'follow_up', 'relevant_context'.

Return strictly JSON:
{
  "summary": "1-2 sentence overview",
  "memories": [
    { "category": "goal", "text": "Wants to sleep by 11pm this week" }
  ]
}

Conversation:
${conversationText}`;

    const isRealGroqKey = config.groqApiKey && 
                          config.groqApiKey.startsWith('gsk_') && 
                          config.groqApiKey !== 'your_groq_api_key_here';

    try {
      if (isRealGroqKey) {
        const res = await this.callGroqGeneric(prompt);
        const parsed = JSON.parse(res);
        const validated = SessionEndExtractionSchema.safeParse(parsed);
        if (validated.success) return validated.data;
      }
      
      const res = await this.callOllamaGeneric(prompt);
      const parsed = JSON.parse(res);
      const validated = SessionEndExtractionSchema.safeParse(parsed);
      if (validated.success) return validated.data;
    } catch (err) {
      console.warn('[LLM] Memory extraction fallback:', err.message);
    }

    // Default heuristic summary if LLM call fails
    return {
      summary: `Completed session with ${sessionMessages.length} exchanges.`,
      memories: []
    };
  }

  async callGroq(messages, systemPrompt) {
    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.slice(-8).map(m => ({ role: m.role, content: m.text }))
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.groqApiKey}`
      },
      body: JSON.stringify({
        model: config.groqChatModel,
        messages: formattedMessages,
        temperature: 0.7,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;
    const parsed = JSON.parse(content);
    return RawLlmOutputSchema.parse(parsed);
  }

  async callOllama(messages, systemPrompt) {
    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.slice(-8).map(m => ({ role: m.role, content: m.text }))
    ];

    const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages: formattedMessages,
        stream: false,
        format: 'json'
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data.message?.content;
    const parsed = JSON.parse(content);
    return RawLlmOutputSchema.parse(parsed);
  }

  async callGroqGeneric(prompt) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.groqApiKey}`
      },
      body: JSON.stringify({
        model: config.groqChatModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      })
    });
    if (!response.ok) throw new Error(`Groq Generic HTTP ${response.status}`);
    const data = await response.json();
    return data.choices[0]?.message?.content;
  }

  async callOllamaGeneric(prompt) {
    const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        format: 'json'
      })
    });
    if (!response.ok) throw new Error(`Ollama Generic HTTP ${response.status}`);
    const data = await response.json();
    return data.message?.content;
  }
}

export const llmProvider = new LlmProvider();
