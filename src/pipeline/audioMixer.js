'use strict';

const fs = require('fs');
const path = require('path');

const AMBIENCE_PATH = path.join(
  __dirname,
  '../../assets/ambience/office_24k_mono.pcm'
);

/** @type {Buffer | null} */
let ambienceCache = null;
let ambienceLoaded = false;

function loadAmbiencePcm() {
  if (ambienceLoaded) {
    return ambienceCache;
  }
  ambienceLoaded = true;
  try {
    if (fs.existsSync(AMBIENCE_PATH)) {
      ambienceCache = fs.readFileSync(AMBIENCE_PATH);
    }
  } catch {
    ambienceCache = null;
  }
  return ambienceCache;
}

/**
 * Mix voice PCM16 with a looping bed. Voice is ducked over background.
 * @param {Buffer} voicePcm
 * @param {{ enabled?: boolean, gain?: number, cursor?: number, bed?: Buffer | null }} [state]
 * @returns {{ pcm: Buffer, cursor: number }}
 */
function mixPcm16(voicePcm, state = {}) {
  const voice = Buffer.isBuffer(voicePcm) ? voicePcm : Buffer.alloc(0);
  const enabled = Boolean(state.enabled);
  const bed = state.bed !== undefined ? state.bed : loadAmbiencePcm();
  const gain = Math.min(1, Math.max(0, Number(state.gain) || 0));
  if (!enabled || !bed || bed.length < 2 || gain <= 0 || voice.length < 2) {
    return { pcm: voice, cursor: Number(state.cursor) || 0 };
  }

  const out = Buffer.alloc(voice.length);
  let cursor = Number(state.cursor) || 0;
  const bedLen = bed.length - (bed.length % 2);
  for (let i = 0; i + 1 < voice.length; i += 2) {
    const v = voice.readInt16LE(i);
    const b = bed.readInt16LE(cursor % bedLen);
    cursor = (cursor + 2) % bedLen;
    let mixed = Math.round(v + b * gain);
    if (mixed > 32767) mixed = 32767;
    if (mixed < -32768) mixed = -32768;
    out.writeInt16LE(mixed, i);
  }
  return { pcm: out, cursor };
}

module.exports = {
  AMBIENCE_PATH,
  loadAmbiencePcm,
  mixPcm16,
};
