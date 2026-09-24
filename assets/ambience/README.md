# Office ambience asset

- `office_24k_mono.pcm` — raw PCM16 little-endian, mono, 24000 Hz, ~8 s seamless loop.
- Content: self-generated brown-noise HVAC / room tone only (no speech, music, or branding).
- License: original generation script output; not copied from Vapi or any proprietary demo.
- Regenerate: `node scripts/generateOfficeAmbience.js`
- Runtime gain: `OUTBOUND_AMBIENCE_GAIN` (default off via `OUTBOUND_AMBIENCE_ENABLED=false`).
