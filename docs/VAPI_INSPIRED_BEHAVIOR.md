# Vapi-inspired conversational behavior (Gemini Live + Twilio)

Behavioral inspiration only — not a Vapi SDK, STT, or pipeline replacement.
Wording for deliverables: **Vapi-inspired natural conversational behavior implemented on the existing Gemini Live + Twilio architecture** (not “Vapi parity”).

## Conversation functions (primary lever)

```text
Caller → understand → acknowledge when useful → rephrase if needed
  → searchKnowledge if factual → natural spoken answer → one useful follow-up
```

| Job | Examples of surface behavior (not a fixed script) |
|-----|---------------------------------------------------|
| Acknowledge | “Oh, gotcha.” / “Sure.” / “Yeah.” |
| Interpret imperfect speech | “Oh, okay, so you mean the cost?” |
| Transition into answer | “Okay, so…” |
| Answer + follow-up | Answer from RAG, then one next question |
| Latest intent | Topic switch / “actually…” wins immediately |
| Backchannel | Alone “yeah”/“okay” ≠ new turn; “yeah, but…” = new ask |

Sparse fillers (`uh`/`um`/`so`/`like`) are **style options**, never forced every turn. Never expose chain-of-thought.

## Mapping to existing stack

| Observable behavior | Our component |
|---------------------|---------------|
| Natural pause / endpointing feel | Gemini Live VAD + prompt (no VAD retune in this task) |
| Real interruption | Confirmed barge-in (`speechGate` + live session) |
| Backchannel vs interrupt | Prompt/policy + barge-in for audio clear |
| WAIT hold | `waitIntent` + WAIT state; **one-shot short hold ack** then silence |
| Facts | Agent Prompt + `searchKnowledge` only |
| Greeting / ambience | Existing greeting prime + Play/Connect + ambience (unchanged) |

## WAIT one-shot ack safety

```text
First WAIT enter → waitAckBudget=1 → buffer AI PCM/transcript
  → if short hold-ack only → play once → budget=0 → SILENT
  → if answer/RAG/follow-up leak → suppress → budget=0 → SILENT
```

- Not a general AI pass-through
- No `searchKnowledge` while WAITING
- No large hardcoded phrase allowlist — policy guides Gemini; `waitAckSafety` heuristics reject leaks
- Repeat WAIT does not reset budget

## Explicit non-goals

No second STT, Vapi SDK, ConversationRelay, Krisp, artificial delays, company hardcoding, Puck/VAD/ambience/greeting-prime/RAG redesign.
