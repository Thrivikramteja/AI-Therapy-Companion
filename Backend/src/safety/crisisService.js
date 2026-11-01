import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { storage } from '../memory/storage.js';

let cachedResources = null;

export function getCrisisResources() {
  if (cachedResources) return cachedResources;
  try {
    const filePath = path.join(config.dataDir, 'crisis_resources.json');
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      cachedResources = JSON.parse(raw);
      return cachedResources;
    }
  } catch (err) {
    console.error('[CrisisService] Error reading crisis resources:', err);
  }

  // Built-in fallback in case file is unreadable
  return [
    { label: "988 Suicide & Crisis Lifeline", contact: "Call or text 988 (24/7)" },
    { label: "Crisis Text Line", contact: "Text HOME to 741741" }
  ];
}

export const SCRIPTED_CRISIS_SPEECH = 
  "I hear how much pain you're in, and I want you to be safe. I cannot provide emergency support, but you don't have to carry this alone. Please reach out to one of the crisis resources shown right now.";

export function handleCrisisResponse(sessionId, triggerType, userId = 'local') {
  // 1. Record safety event (timestamp, session, trigger type, NO full text)
  storage.addSafetyEvent(sessionId, triggerType, userId);

  // 2. Build official resources
  const resources = getCrisisResources();

  // 3. Return crisis response matching Section 4.2
  return {
    speech: SCRIPTED_CRISIS_SPEECH,
    animation: "talking",
    gesture: "none",
    takeNote: false,
    note: null,
    audioUrl: null, // Will be filled by TTS or left null with degraded
    risk: "crisis",
    resources: resources,
    degraded: []
  };
}
