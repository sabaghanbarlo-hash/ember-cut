# Ember Cut

A free, instruction-based video editor that runs entirely in your browser. Upload video, audio, or images, describe the edit in plain English, review the generated plan, then run it. Nothing is uploaded to any server — editing happens locally via `ffmpeg.wasm`.

**Live demo:** `https://sabaghanbarlo-hash.github.io/ember-cut/`

## How it works

1. You upload media and type an instruction, e.g. *"Trim clip1 to the first 12 seconds, caption it 'good morning' at the top, lower the background audio to 30%, then speed it up 1.25x."*
2. Your browser sends that instruction (plus your file names, not the files themselves) to **Groq's free API**, which returns a structured JSON edit plan.
3. You review the plan — nothing renders until you click **Run edit**.
4. `ffmpeg.wasm` executes the plan step by step, entirely on your device.
5. You download the result.

## Setup

1. Get a free Groq API key at [console.groq.com/keys](https://console.groq.com/keys) — no credit card required for the free tier.
2. Open the live URL above, paste your Groq key into the left panel (it's stored only in your browser's `localStorage`, never sent anywhere except directly to Groq).

**Never share your Groq API key in chat, email, or anywhere public — paste it only into the app itself.**

## Why `coi-serviceworker.js` is in here

`ffmpeg.wasm` needs `SharedArrayBuffer`, which browsers only allow on "cross-origin isolated" pages (requiring `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` response headers). GitHub Pages doesn't let you set custom headers, so this small service worker (by Guido Zuidhof, MIT licensed) fakes those headers client-side. Don't remove it.

## Style reference analysis (v1.1)

Upload a video whose *style* you want to copy — pacing, cut length, mood, captions. The app:
1. Pulls a still frame every 3 seconds (up to 6 frames) with `ffmpeg.wasm`.
2. Sends each frame to a Groq vision model for a one-sentence description.
3. Synthesizes those into a compact "style profile" (pacing, recommended clip length, caption style, tone, color mood).

That profile is automatically attached to your next **Generate plan** call, so the AI leans on it when deciding clip durations and caption style — but it only ever builds the video from *your own* uploaded media. The reference video itself is never included in the export.

## Supported edit operations (v1)

- Trim / cut
- Concatenate multiple clips
- Text overlay / captions (top, center, bottom)
- Image overlay (watermark/logo, any corner or center)
- Add or replace audio track, or mix two audio tracks
- Volume adjustment
- Speed up / slow down (0.5x–2x)
- Resize
- Extract audio to mp3
- Format conversion
- Still image → video clip (so you can mix photos into a video edit)

## Known limitations — read before you rely on this

- **Not a CapCut replacement.** No auto-captions with word-level sync, no AI b-roll, no template library, no green screen/chroma key (yet), no multi-track timeline UI — this is instruction-in, video-out.
- **Speed and file size.** Browser-based encoding is slower than native apps and struggles with long or 4K source video. Works best under a few minutes of 1080p footage.
- **The AI can misparse ambiguous instructions.** Always read the generated plan before running it — that's why the review step exists.
- **Groq free tier has rate limits.** If plan generation fails with a 429, wait a bit and retry.
- **`atempo` speed range is capped at 0.5x–2x** in ffmpeg (a hard limit of the filter, not this app).
- **Style analysis uses a Groq vision model** (`llama-3.2-90b-vision-preview`). Groq occasionally renames/retires models — if analysis fails with a 404/model error, check [console.groq.com/docs/models](https://console.groq.com/docs/models) for the current vision model name and swap it into `app.js` (`describeFrame`).
- **No transitions yet.** Clips are hard-cut, no crossfades — kept out deliberately since a correct crossfade needs reliable per-clip duration data that this MVP doesn't track.

## Extending it

All editing logic lives in `app.js` in `buildAndRunOp()`. To add a new capability:
1. Add the operation to the JSON schema in `SCHEMA_PROMPT` so the AI knows it exists.
2. Add a `case` in `buildAndRunOp()` that builds the matching `ffmpeg` command.

Ideas for v2: auto-captions via Groq's Whisper endpoint (transcribe → burn in word-synced subtitles — this would fit naturally next to your `mikasan-narrator` karaoke-caption work), crossfade transitions, chroma key, a real drag-and-drop timeline.

## License

MIT. `coi-serviceworker.js` retains its original MIT license from Guido Zuidhof.
