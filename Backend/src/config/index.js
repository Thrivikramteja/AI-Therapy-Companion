import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '127.0.0.1',
  rootDir,
  dataDir: path.join(rootDir, 'data'),
  audioDir: path.join(rootDir, 'data', 'audio'),
  promptsDir: path.join(rootDir, 'data', 'prompts'),
  storagePath: path.resolve(rootDir, process.env.STORAGE_PATH || 'data/db.json'),
  
  // AI / LLM
  llmProvider: process.env.LLM_PROVIDER || 'groq',
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqApiKeyFallback: process.env.GROQ_API_KEY_FALLBACK || '',
  groqChatModel: process.env.GROQ_CHAT_MODEL || 'qwen/qwen3.8-27b',
  groqSttModel: process.env.GROQ_STT_MODEL || 'whisper-large-v3',
  
  // Ollama
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'phi:latest',
  
  // STT & TTS
  sttProvider: process.env.STT_PROVIDER || 'groq',
  ttsEngine: process.env.TTS_ENGINE || 'kokoro',
  
  // Note frequency limiter (takeNote at most once per N responses)
  noteFrequencyLimit: parseInt(process.env.NOTE_FREQUENCY_LIMIT || '3', 10),
  
  // Memory config
  maxActiveMemories: 15,
};
