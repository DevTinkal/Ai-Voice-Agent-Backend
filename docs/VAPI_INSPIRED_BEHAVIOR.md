# Vapi-like phone agent (owned pipeline)

Behavioral target only — not a Vapi SDK clone. Two audio brains, selected by `VOICE_PIPELINE`.

## `live` (default) — Gemini Live rollback

```text
Twilio μ-law → PCM16k → Gemini Live (Aoede) → PCM24k → μ-law → Twilio
```

WAIT, confirmed barge-in (`speechGate`), RAG `searchKnowledge`, and greeting prime stay on this path.

## `classic` — STT → LLM → TTS

```text
Twilio μ-law → PCM16k → Deepgram Flux (EOT)
  → conversationController (WAIT / BACKCHANNEL / NEW_REQUEST / INCOMPLETE / COMPLETE / NOISE)
  → Gemini text + searchKnowledge
  → ElevenLabs PCM24k
  → optional office ambience mix
  → μ-law → Twilio
```

| Class | Action |
|-------|--------|
| `WAIT` | Existing `enterWaitHold` + one-shot “Yeah, no rush.” if `waitAckSafety` accepts |
| `BACKCHANNEL` | Skip new answer; do not clear WAIT |
| `NEW_REQUEST` / `COMPLETE` | Gemini text + RAG + ElevenLabs |
| `ACK_ONLY` | After open: pure hi/hello → fixed short ack (no re-greet / no RAG open) |
| `INCOMPLETE` | Keep listening (e.g. “This is”) |
| `NOISE` | Drop (includes greeting-echo scraps after open) |

Barge-in: `speechGate` confirm cancels in-flight LLM/TTS and clears Twilio playback.

Turn measurement: `logs/turn-ctrl-latest.log` (`[TURN_CTRL]`, cleared on server start).

Latency: `[CLASSIC_LATENCY]` eot → llm first text → tts first byte.

## Classic brain (dashboard-only)

- Spoken name from dashboard **Agent name** only (`AGENT IDENTITY` + `CONFIGURED CALL CONTEXT`).
- Company facts only via `searchKnowledge` over the dashboard **Agent Prompt** index — never invented; wrapper stays thin (prompt body not inlined).
- Classic LLM wraps `buildAgentSystemInstruction` with phone `CRITICAL VOICE OUTPUT RULES` (same conversational jobs: acknowledge → interpret → answer → one follow-up).
- Company / which-company / identity asks auto-run `searchKnowledge` if the model skips the tool.
- Short Flux scraps (`are you?`) stay `INCOMPLETE` — keep listening.
- **Single open:** primed Twilio Play greeting is recorded in history + dashboard once. After open: ~2.5s echo guard; scraps like “Thank you. This is.” drop; pure “hello” → short mid-call ack only (never a second “Hi I’m …”).

## Env

```text
VOICE_PIPELINE=live|classic
DEEPGRAM_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID
OUTBOUND_AMBIENCE_ENABLED
OUTBOUND_AMBIENCE_GAIN
```

Unset `VOICE_PIPELINE` stays `live`.

## Non-goals

No Vapi SaaS, SIP, billing, or provider marketplace. No removal of Gemini Live until classic soaks on real calls.
No inlining full Agent Prompt into systemInstruction.
