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

    async transcribeWav(audioBuffer, originalFilename = 'audio.wav') {
      if (!audioBuffer || audioBuffer.length === 0) {
          const err = new Error('No audio data received.');
          err.code = 'STT_EMPTY';
          throw err;
      }

      const hasValidKey =
          config.groqApiKey &&
          config.groqApiKey.startsWith('gsk_') &&
          config.groqApiKey !== 'your_groq_api_key_here';

      if (!hasValidKey) {
          const err = new Error(
              'Groq API key is missing. Configure GROQ_API_KEY.'
          );
          err.code = 'STT_UNAVAILABLE';
          throw err;
      }

      try {
          const text = await this.transcribeWithGroq(
              audioBuffer,
              originalFilename
          );

          if (!text || !text.trim()) {
              const err = new Error('No speech detected.');
              err.code = 'STT_EMPTY';
              throw err;
          }

          return text.trim();

      } catch (err) {
          console.error('[STT] Transcription failed:', err.message);
          throw err;
      }
  }
}

export const sttService = new SttService();
