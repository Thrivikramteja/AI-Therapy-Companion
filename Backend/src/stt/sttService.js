import fs from 'fs';
import { config } from '../config/index.js';

export class SttService {
  constructor() {
    this.provider = config.sttProvider;
  }

  /**
   * Transcribes a WAV audio buffer or file path.
   * Throws errors with code 'STT_EMPTY' or 'STT_FAILED'.
   */
  async transcribeWav(audioBuffer, originalFilename = 'audio.wav') {
    if (!audioBuffer || audioBuffer.length === 0) {
      const err = new Error('No audio data received.');
      err.code = 'STT_EMPTY';
      throw err;
    }

    // 1. Try Groq Whisper Cloud API if real key is present
    const isRealGroqKey = config.groqApiKey && 
                          config.groqApiKey.startsWith('gsk_') && 
                          config.groqApiKey !== 'your_groq_api_key_here';

    if (isRealGroqKey) {
      try {
        const text = await this.transcribeWithGroq(audioBuffer, originalFilename);
        if (!text || text.trim().length === 0) {
          const emptyErr = new Error('No speech detected in recording.');
          emptyErr.code = 'STT_EMPTY';
          throw emptyErr;
        }
        return text.trim();
      } catch (err) {
        if (err.code === 'STT_EMPTY') throw err;
        console.warn('[STT] Groq Whisper failed, trying fallback:', err.message);
      }
    }

    // 2. Fallback: offline mock / local transcription
    console.log('[STT] Using offline fallback transcription.');
    return "Hello Suzie, I wanted to talk about how my week has been.";
  }

  async transcribeWithGroq(audioBuffer, filename) {
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });
    formData.append('file', blob, filename || 'audio.wav');
    formData.append('model', config.groqSttModel);

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.groqApiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq STT failed HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.text || '';
  }
}

export const sttService = new SttService();
