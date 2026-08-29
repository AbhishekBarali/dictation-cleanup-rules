# Installing it

Wiring the four passes into an existing dictation app. Read `spec/SPEC.md` for the
algorithms; this file is about integration.

## 1. Decide what you actually need

You probably do not need all four.

| Pass | Skip it if |
|---|---|
| 1 vocabulary | your users have no jargon, **or** your recogniser accepts a bias prompt (use that instead, see below) |
| 2 filler/stutter | nothing. Take this one. It is the cheapest win in the whole pipeline |
| 4 spoken emoji | your users are not writing chat messages |
| 5 user rules | you have no settings UI to author them in |

Pass 2 alone gets most of the benefit for a few hundred lines.

**Do not build a pass for work your recogniser already does.** Parakeet, Nemotron
and current Whisper builds already handle punctuation, capitalisation, filler
sounds in some configurations, and number formatting. Speak "the deposit is three
hundred dollars, um, and the meeting is at nine thirty" into Parakeet and you get
"The deposit is $300 and the meeting is at 9:30" with no model involved. Test your
own recogniser's raw output before writing a pass that duplicates it.

## 2. Copy the data, not the code

`data/filler_words.json` and `data/emoji_aliases.json` are plain JSON with no
schema games. Load them at startup, or codegen them into your binary if you want
zero I/O.

Both files are the tables that produced the SpeakoFlow numbers. If you change them,
you have changed the pipeline, and your results will diverge from the benchmark.
That is fine, but track it.

## 3. Insert the stages in order

```
transcript = asr.transcribe(audio)

# --- pre-model ---
if vocabulary and not asr_took_bias_prompt:
    transcript = apply_vocabulary(transcript, vocabulary, threshold=0.18)

transcript = filter_transcript(transcript, lang=app_language,
                               custom_filler_words=user_setting)  # None | list

# --- model, optional, allowed to fail ---
if cleanup_enabled:
    try:
        result = model_cleanup(transcript, timeout=...)
        if result:
            transcript = result
    except (Timeout, ModelError):
        pass          # keep the pre-model text, do not surface an error

# --- post-model ---
if spoken_emoji_enabled:
    transcript = expand_spoken_emoji(transcript)

if replacements_enabled and rules:
    transcript = apply_replacements(transcript, rules)

deliver(transcript)
```

Three things about that shape:

**Stages 1 and 2 run before the model** so the model reads less and reasons about
less. **Stages 4 and 5 run after** so the user's own rules are the final authority.
**The model's failure is not the user's problem**: on timeout, the pre-model text
ships.

If you genuinely need replacements to run *before* the model, move that single
block. It is one call, and the spec calls out the consequence: the model can then
undo them.

### Where this lives in SpeakoFlow, for reference

| Stage | File |
|---|---|
| 1, 2 | `src-tauri/src/managers/transcription.rs`, at the end of `transcribe()` and again on the streaming finalise path |
| 3, 4, 5 | `src-tauri/src/actions.rs`, in the post-processing block |

Both the batch and streaming paths apply stages 1 and 2. If you have two
transcription paths, you need the passes on both, or your live text and your final
text disagree.

## 4. Bias the decoder instead, if you can

If your recogniser accepts a hot-word or bias prompt, feed the user's vocabulary
there and **skip stage 1**. Biasing the decoder means the right word is transcribed
in the first place; stage 1 only ever repairs a word the decoder already got wrong.

SpeakoFlow does exactly this: Whisper-family models get the vocabulary as
`initial_prompt` and stage 1 is skipped for them. Non-Whisper engines get stage 1.
Running both double-corrects and can overshoot.

## 5. Settings to expose

| Setting | Type | Default |
|---|---|---|
| word correction threshold | float | `0.18` |
| custom vocabulary | list of exact spellings | empty |
| custom filler words | **three-valued**: unset / list / empty list | unset |
| app language | BCP-47-ish tag, `pt-BR` resolves to `pt` | system |
| spoken emoji enabled | bool | `false` |
| replacements enabled | bool | `false` |
| replacement rules | ordered list | empty |

The threshold is worth exposing but not worth prominence. Lower is stricter.
Above roughly `0.35` it starts matching words that only vaguely rhyme.

**Model the filler setting as three-valued.** Unset means "use the language
default", a list means "use this instead", an empty list means "off". If you store
it as a plain array, you cannot express "off" and "default" separately, and users
who clear the field get the default back instead of the pass turning off.

## 6. Verify before you ship

```bash
cd reference/python && python -m pytest      # the suite you are porting against
```

Then run `conformance/cases.json` against your own implementation, per stage, in
isolation. Every case is a fixed input/output pair from the SpeakoFlow Rust tests.
Byte for byte, or it is not a port.

Then check the two failure modes that conformance cannot catch:

- **Live and final agree.** Dictate a sentence with a filler word and watch the
  live overlay, if you have one. If live shows "um" and the final text does not,
  fine. If they disagree on anything else, you applied the stages on one path only.
- **A clean sentence is untouched.** Dictate "This is a completely normal
  sentence." and confirm the output is byte identical. The passes are supposed to
  do nothing most of the time, and a pass that always changes something is worse
  than no pass.
