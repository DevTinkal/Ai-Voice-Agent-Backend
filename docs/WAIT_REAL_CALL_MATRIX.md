# WAIT real-call test matrix

Use after deploying WAIT reliability changes. Watch backend logs for `[WAIT_TRACE]`.

## How to record each attempt

| Field | Source |
|-------|--------|
| Spoken phrase | What you said |
| Gemini transcript | `text=` / `normalized=` on `[WAIT_TRACE]` STREAMING/FINAL |
| Detector | `detected=true/false` |
| Action | `action=` (ENTER_WAIT_EARLY, KEEP_WAITING, DEFER_FLUSH_PREFIX, RESUME_MEANINGFUL, …) |
| waiting | `waiting_after` / `waitPhase` |
| Playback clear | `playbackCleared=true` / `[TWILIO_CLEAR]` |
| Dashboard | Shows “Waiting for caller to continue…” |
| Resume | Next meaningful utterance → `action=RESUME_MEANINGFUL` |

Classify misses:

- **Code miss**: Gemini transcript contains wait/hold but `action` never ENTER → file a bug, keep fixing.
- **ASR miss**: transcript is `de` / garbage while you said wait → document only; no second STT.

## Phrase matrix

For each phrase, test: AI silent | AI speaking | barge-in over AI.

- wait
- wait wait
- wait a second
- wait a minute
- please wait
- hold on
- hold on a second
- hang on
- one moment
- give me a second

Also: WAIT then silence; WAIT then question; WAIT twice; background noise; WAIT then `de`.

## Success criteria (per clearly recognized phrase)

1. Early `[WAIT_TRACE]` STREAMING/ENTER with `detected=true`
2. `waitPhase=WAITING` / `waiting=true`
3. Twilio clear
4. No AI_STREAMING while waiting
5. Dashboard stays Waiting
6. Noise does not resume
7. Duplicate WAIT keeps WAITING (one `audioStreamEnd`)
8. Meaningful speech resumes
9. No hangup / no re-greet / no second STT
