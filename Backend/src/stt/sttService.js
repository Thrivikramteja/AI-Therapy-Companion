import { config } from '../config/index.js';

export class SttService {
  constructor() {
    this.provider = config.sttProvider;
  }

  async transcribeWav(
    audioBuffer,
    originalFilename = 'audio.wav',
    mimeType = 'audio/wav'
  ) {
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
      const err = new Error('Groq API key is missing. Configure GROQ_API_KEY.');
      err.code = 'STT_UNAVAILABLE';
      throw err;
    }

    try {
      const text = await this.transcribeWithGroq(
        audioBuffer,
        originalFilename,
        mimeType
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

  async transcribeWithGroq(audioBuffer, originalFilename, mimeType) {
    const formData = new FormData();
    formData.append('model', config.groqSttModel);
    formData.append(
      'file',
      new Blob([audioBuffer], { type: mimeType || 'audio/wav' }),
      originalFilename || 'audio.wav'
    );

    const response = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.groqApiKey}`
        },
        body: formData
      }
    );

    if (!response.ok) {
      throw new Error(
        `Groq STT HTTP ${response.status}: ${await response.text()}`
      );
    }

    const result = await response.json();
    return result.text;
  }
}

export const sttService = new SttService();
