/**
 * Helper to encode raw PCM samples (Float32Array or Int16Array) into 
 * standard 24 kHz mono 16-bit PCM WAV format.
 */

export function createWavBuffer(samples, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = Buffer.alloc(totalSize);

  // RIFF identifier
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(totalSize - 8, 4);
  buffer.write('WAVE', 8);

  // format chunk identifier
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // format chunk size
  buffer.writeUInt16LE(1, 20);  // PCM format = 1
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk identifier
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // write 16-bit PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s;
    if (samples instanceof Float32Array) {
      // Clamp float between -1.0 and 1.0
      s = Math.max(-1, Math.min(1, samples[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    } else {
      s = samples[i];
    }
    buffer.writeInt16LE(Math.round(s), offset);
    offset += 2;
  }

  return buffer;
}

/**
 * Generates a soft harmonic tone as an audio fallback if local TTS cannot synthesize.
 */
export function generateFallbackPcm(durationSec = 2.0, sampleRate = 24000) {
  const numSamples = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(numSamples);
  const freq = 340; // Soft warm vocal pitch

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Gentle envelope fade in and fade out
    let env = 1.0;
    if (t < 0.1) env = t / 0.1;
    if (t > durationSec - 0.2) env = Math.max(0, (durationSec - t) / 0.2);

    samples[i] = 0.15 * env * (
      Math.sin(2 * Math.PI * freq * t) +
      0.3 * Math.sin(2 * Math.PI * (freq * 1.5) * t)
    );
  }

  return createWavBuffer(samples, sampleRate);
}
