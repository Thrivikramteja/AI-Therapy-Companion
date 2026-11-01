import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from '../config/index.js';
import { createWavBuffer, generateFallbackPcm } from './wavHelper.js';

const execAsync = promisify(exec);

export class TtsService {
  constructor() {
    this.audioDir = config.audioDir;
    this.kokoroModel = null;
    this.kokoroLoading = false;
    this.initAudioDir();
    this.cleanupOldAudio();
    this.initKokoro();
  }

  initAudioDir() {
    if (!fs.existsSync(this.audioDir)) {
      fs.mkdirSync(this.audioDir, { recursive: true });
    }
  }

  cleanupOldAudio(maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
      if (!fs.existsSync(this.audioDir)) return;
      const files = fs.readdirSync(this.audioDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith('.wav')) continue;
        const filePath = path.join(this.audioDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (err) {
      console.warn('[TTS] Audio cleanup warning:', err.message);
    }
  }

  async initKokoro() {
    if (this.kokoroLoading || this.kokoroModel) return;
    this.kokoroLoading = true;
    try {
      // Dynamic import to avoid crash if optionalDependency not available
      const kokoro = await import('kokoro-js');
      if (kokoro && kokoro.KokoroTTS) {
        console.log('[TTS] Kokoro-js package found. Loading model (kokoro-v0_19)...');
        this.kokoroModel = await kokoro.KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
          dtype: "fp32"
        });
        console.log('[TTS] Kokoro model loaded successfully.');
      }
    } catch (err) {
      console.log('[TTS] Kokoro-js not initialized (will use fallback or degraded mode):', err.message);
      this.kokoroModel = null;
    } finally {
      this.kokoroLoading = false;
    }
  }

  /**
   * Synthesizes text to 24 kHz mono WAV and saves to audioDir.
   * Returns { audioUrl, degraded }
   */
  async synthesize(text) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return { audioUrl: null, degraded: ['tts'] };
    }

    const audioId = crypto.randomUUID();
    const fileName = `${audioId}.wav`;
    const outputPath = path.join(this.audioDir, fileName);

    // 1. Try Kokoro-js if loaded
    if (this.kokoroModel) {
      try {
        const audio = await this.kokoroModel.generate(text, {
          voice: "af_sarah" // Calm, supportive female voice
        });
        // Kokoro outputs 24kHz audio samples
        const wavBuffer = createWavBuffer(audio.audio, audio.sampling_rate || 24000);
        fs.writeFileSync(outputPath, wavBuffer);
        return { audioUrl: `/audio/${fileName}`, degraded: [] };
      } catch (err) {
        console.warn('[TTS] Kokoro generation failed, trying fallback:', err.message);
      }
    }

    // 2. Try macOS 'say' command if running on Mac
    if (process.platform === 'darwin') {
      try {
        const aiffPath = path.join(this.audioDir, `${audioId}.aiff`);
        // Use say to generate aiff, then afconvert to 24kHz mono 16-bit WAV
        await execAsync(`say -o "${aiffPath}" "${text.replace(/"/g, '\\"')}"`);
        await execAsync(`afconvert -f WAVE -d LEI16@24000 -c 1 "${aiffPath}" "${outputPath}"`);
        if (fs.existsSync(aiffPath)) fs.unlinkSync(aiffPath);
        if (fs.existsSync(outputPath)) {
          return { audioUrl: `/audio/${fileName}`, degraded: [] };
        }
      } catch (macErr) {
        console.warn('[TTS] Mac say fallback failed:', macErr.message);
      }
    }

    // 3. Try Windows PowerShell speech synth if on Windows
    if (process.platform === 'win32') {
      try {
        const cleanText = text.replace(/"/g, '`"');
        const psCmd = `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.SetOutputToWaveFile('${outputPath}'); $synth.Speak('${cleanText}'); $synth.Dispose();`;
        await execAsync(`powershell -Command "${psCmd}"`);
        if (fs.existsSync(outputPath)) {
          return { audioUrl: `/audio/${fileName}`, degraded: [] };
        }
      } catch (winErr) {
        console.warn('[TTS] Windows PowerShell TTS failed:', winErr.message);
      }
    }

    // 4. If all audio generation fails, follow Section 4.2 / 7:
    // "If TTS fails, return audioUrl: null and degraded: ["tts"]"
    console.warn('[TTS] TTS unavailable. Returning audioUrl: null and degraded: ["tts"]');
    return { audioUrl: null, degraded: ['tts'] };
  }
}

export const ttsService = new TtsService();
