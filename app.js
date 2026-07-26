/* Ember Cut — instruction-based video editor
   Runs entirely client-side: ffmpeg.wasm does the editing, Groq's free API
   turns your instructions into a structured edit plan. No server, no upload. */

const els = {
  refDropzone: document.getElementById('refDropzone'),
  refFileInput: document.getElementById('refFileInput'),
  refFileName: document.getElementById('refFileName'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  styleOutput: document.getElementById('styleOutput'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  mediaList: document.getElementById('mediaList'),
  groqKey: document.getElementById('groqKey'),
  instructions: document.getElementById('instructions'),
  planBtn: document.getElementById('planBtn'),
  runBtn: document.getElementById('runBtn'),
  planOutput: document.getElementById('planOutput'),
  logOutput: document.getElementById('logOutput'),
  previewVideo: document.getElementById('previewVideo'),
  stageEmpty: document.getElementById('stageEmpty'),
  downloadBtn: document.getElementById('downloadBtn'),
  progressWrap: document.getElementById('progressWrap'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
};

let mediaFiles = [];   // { id, file, name, type }
let currentPlan = null;
let ffmpeg = null;
let ffmpegLoaded = false;
let referenceFile = null;
let styleProfile = null;

// ---------- logging ----------
function errText(err) {
  if (err === null || err === undefined) return 'unknown error (no details provided)';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === 'object') {
    if (err.message) return err.message;
    try { return JSON.stringify(err); } catch (e) { /* fall through */ }
  }
  try { return String(err); } catch (e) { return 'unknown error'; }
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  els.logOutput.textContent += `[${t}] ${msg}\n`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

// ---------- Groq key persistence ----------
els.groqKey.value = localStorage.getItem('emberCut_groqKey') || '';
els.groqKey.addEventListener('input', () => {
  localStorage.setItem('emberCut_groqKey', els.groqKey.value.trim());
});

// ---------- media handling ----------
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); });
els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  handleFiles(e.dataTransfer.files);
});
els.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function handleFiles(fileList) {
  for (const file of fileList) {
    const id = crypto.randomUUID();
    const name = safeName(file.name);
    mediaFiles.push({ id, file, name, type: file.type });
  }
  renderMediaList();
}

function renderMediaList() {
  els.mediaList.innerHTML = '';
  for (const m of mediaFiles) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'm-name';
    label.textContent = `${m.name} (${m.type.split('/')[0] || 'file'})`;
    const remove = document.createElement('button');
    remove.className = 'm-remove';
    remove.textContent = '✕';
    remove.onclick = () => {
      mediaFiles = mediaFiles.filter((x) => x.id !== m.id);
      renderMediaList();
    };
    li.appendChild(label);
    li.appendChild(remove);
    els.mediaList.appendChild(li);
  }
}

// ---------- reference video: upload + style analysis ----------
els.refDropzone.addEventListener('click', () => els.refFileInput.click());
els.refDropzone.addEventListener('dragover', (e) => { e.preventDefault(); });
els.refDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) setReferenceFile(e.dataTransfer.files[0]);
});
els.refFileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) setReferenceFile(e.target.files[0]);
});

function setReferenceFile(file) {
  referenceFile = file;
  els.refFileName.textContent = `Reference: ${file.name}`;
  els.analyzeBtn.disabled = false;
  styleProfile = null;
  els.styleOutput.style.display = 'none';
}

// Grabs sample frames straight from the video element via <canvas>, instead of loading
// the whole reference video into ffmpeg.wasm's WASM memory just to sample a few frames.
// That old approach could exhaust available memory (especially on mobile browsers) on
// anything but a very short/small reference video.
async function extractReferenceFrames(file) {
  log('Reading reference video…');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('Could not read the reference video. Try a different file or format.')), { once: true });
    });

    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error('Could not determine the reference video\'s duration.');
    }

    // downscale so each frame's base64 payload stays small (keeps memory and the
    // Groq vision request size down)
    const maxDim = 480;
    const scale = Math.min(1, maxDim / Math.max(video.videoWidth || maxDim, video.videoHeight || maxDim));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((video.videoWidth || maxDim) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || maxDim) * scale));
    const ctx = canvas.getContext('2d');

    const timestamps = [];
    for (let t = 0; t < duration && timestamps.length < 6; t += 3) timestamps.push(t);
    if (timestamps.length === 0) timestamps.push(0);

    const frames = [];
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      log(`Grabbing frame ${i + 1}/${timestamps.length}…`);
      await new Promise((resolve, reject) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked, { once: true });
        video.addEventListener('error', () => reject(new Error('Error reading a frame from the reference video.')), { once: true });
        video.currentTime = Math.min(t, Math.max(0, duration - 0.05));
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({
        dataUrl: canvas.toDataURL('image/jpeg', 0.7),
        timestampSeconds: t,
      });
    }

    if (frames.length === 0) throw new Error('Could not extract any frames from the reference video.');
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function describeFrame(dataUrl, key) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'qwen/qwen3.6-27b',
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'In one short sentence, describe this video frame: subject, composition, any visible on-screen text, mood and color.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Groq vision error (${res.status}): ${errBody.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '(no description)';
}

async function synthesizeStyleProfile(describedFrames, key) {
  const descText = describedFrames.map((f) => `t=${f.timestampSeconds}s: ${f.description}`).join('\n');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `You analyze a sequence of frame descriptions sampled every 3 seconds from a reference video and output a JSON style profile ONLY — no prose, no markdown fences. Schema:
{
  "pacing": "fast|medium|slow",
  "recommended_clip_duration_seconds": <number, how long each cut/segment seems to run>,
  "caption_style": "<describe on-screen text placement and tone if any is visible in the frames, else 'none observed'>",
  "tone": "<a few words>",
  "color_mood": "<a few words>",
  "summary": "<1-2 sentence description of the overall visual style to imitate>"
}`,
        },
        { role: 'user', content: `Frame descriptions:\n${descText}` },
      ],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Groq API error (${res.status}): ${errBody.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

els.analyzeBtn.addEventListener('click', async () => {
  const key = els.groqKey.value.trim();
  if (!key) { alert('Add your free Groq API key first (below).'); return; }
  if (!referenceFile) return;

  els.analyzeBtn.disabled = true;
  els.styleOutput.style.display = 'block';
  els.styleOutput.textContent = 'Extracting frames…';

  try {
    const frames = await extractReferenceFrames(referenceFile);
    const described = [];
    for (const f of frames) {
      els.styleOutput.textContent = `Describing frame ${described.length + 1}/${frames.length}…`;
      const description = await describeFrame(f.dataUrl, key);
      described.push({ timestampSeconds: f.timestampSeconds, description });
    }
    els.styleOutput.textContent = 'Synthesizing style profile…';
    styleProfile = await synthesizeStyleProfile(described, key);
    els.styleOutput.textContent = JSON.stringify(styleProfile, null, 2);
    log('Reference style analyzed — it will now inform your next generated plan.');
  } catch (err) {
    els.styleOutput.textContent = `Error: ${errText(err)}`;
    styleProfile = null;
    log(`Style analysis failed: ${errText(err)}`);
  } finally {
    els.analyzeBtn.disabled = false;
  }
});

// ---------- Groq: instructions -> edit plan ----------
const SCHEMA_PROMPT = `You are a video editing planner. Convert the user's plain-language instructions
into a strict JSON edit plan for an ffmpeg-based executor. Respond with ONLY valid JSON, no prose, no markdown fences.

Schema:
{
  "operations": [
    { "op": "trim", "input": "<filename>", "start": <seconds:number>, "end": <seconds:number>, "output": "<newname>" },
    { "op": "concat", "inputs": ["<filename>", "<filename>", ...], "output": "<newname>" },
    { "op": "text_overlay", "input": "<filename>", "text": "<string>", "position": "top|center|bottom", "fontsize": <number, default 42>, "output": "<newname>" },
    { "op": "image_overlay", "input": "<filename>", "image": "<filename>", "position": "top-left|top-right|bottom-left|bottom-right|center", "output": "<newname>" },
    { "op": "add_audio", "input": "<filename>", "audio": "<filename>", "mode": "replace|mix", "output": "<newname>" },
    { "op": "set_volume", "input": "<filename>", "volume": <0.0-2.0>, "output": "<newname>" },
    { "op": "speed", "input": "<filename>", "factor": <0.5-2.0>, "output": "<newname>" },
    { "op": "resize", "input": "<filename>", "width": <number>, "height": <number>, "output": "<newname>" },
    { "op": "extract_audio", "input": "<filename>", "output": "<newname ending in .mp3>" },
    { "op": "format_convert", "input": "<filename>", "output": "<newname with target extension>" },
    { "op": "image_to_clip", "input": "<filename, a still image>", "duration": <seconds:number>, "output": "<newname ending in .mp4>" }
  ],
  "final_output": "<the filename that is the finished result>"
}

Rules:
- Only use filenames from the provided media list, or names you created earlier as an "output" in a prior step.
- Any still image (jpg/png/etc.) MUST be converted to a clip with "image_to_clip" before it can be used in "concat", "text_overlay", or as a final output.
- Chain operations in logical order — each step's "input" should be a real input file or a previous step's "output".
- Keep the plan minimal: only include steps the user actually asked for.
- "final_output" must match the output of the last relevant operation.
- If a "style reference" is provided, use its pacing and recommended clip duration as a guide for trim/image_to_clip durations, and its caption style as a guide for any text_overlay, but build the video ONLY from the user's own uploaded files.
- If something is ambiguous, make the most reasonable assumption rather than asking a question.`;

async function callGroq(instructionText) {
  const key = els.groqKey.value.trim();
  if (!key) throw new Error('Add your free Groq API key first (left panel).');
  if (mediaFiles.length === 0) throw new Error('Upload at least one media file first.');

  const mediaDescription = mediaFiles
    .map((m) => `- ${m.name} (${m.type || 'unknown type'})`)
    .join('\n');

  const styleContext = styleProfile
    ? `\n\nStyle reference (extracted from an example video — that video is NOT among your available files, do not reference it directly, only imitate its style using the files below):\n${JSON.stringify(styleProfile)}`
    : '';

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SCHEMA_PROMPT },
        {
          role: 'user',
          content: `Available media files:\n${mediaDescription}\n\nInstructions: ${instructionText}${styleContext}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Groq API error (${res.status}): ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  let plan;
  try {
    plan = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('The model returned invalid JSON. Try rephrasing your instructions, or click Generate plan again.');
  }
  if (!plan.operations || !plan.final_output) {
    throw new Error('The plan is missing required fields. Try again.');
  }
  return plan;
}

els.planBtn.addEventListener('click', async () => {
  els.planBtn.disabled = true;
  els.runBtn.disabled = true;
  els.planOutput.textContent = 'Thinking…';
  try {
    const plan = await callGroq(els.instructions.value.trim());
    currentPlan = plan;
    els.planOutput.textContent = JSON.stringify(plan, null, 2);
    els.runBtn.disabled = false;
    log('Plan generated. Review it, then click "Run edit".');
  } catch (err) {
    els.planOutput.textContent = `Error: ${errText(err)}`;
    log(`Plan generation failed: ${errText(err)}`);
  } finally {
    els.planBtn.disabled = false;
  }
});

// ---------- font loading for text_overlay ----------
let fontLoadedName = null;
async function ensureFont() {
  if (fontLoadedName) return fontLoadedName;
  try {
    const cssRes = await fetch('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600&display=swap');
    const css = await cssRes.text();
    const match = css.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/);
    if (!match) throw new Error('Could not locate font URL.');
    const fontRes = await fetch(match[1]);
    const fontBytes = new Uint8Array(await fontRes.arrayBuffer());
    await ffmpeg.writeFile('overlay-font.ttf', fontBytes);
    fontLoadedName = 'overlay-font.ttf';
    log('Loaded caption font.');
  } catch (e) {
    log(`Warning: could not load a web font (${errText(e)}). Text overlays may fail.`);
    fontLoadedName = null;
  }
  return fontLoadedName;
}

// ---------- ffmpeg loading ----------
async function ensureFFmpeg() {
  if (ffmpegLoaded) return;
  const { FFmpeg } = FFmpegWASM;
  const { toBlobURL } = FFmpegUtil;
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => log(message));
  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
    els.progressFill.style.width = pct + '%';
    els.progressLabel.textContent = `Working… ${pct}%`;
  });

  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  const classWorkerURL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js';
  log('Loading ffmpeg core (first run only, ~30MB)…');
  try {
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      // browsers refuse to construct a Worker from a cross-origin script URL directly —
      // fetching it as a blob first makes it same-origin from the page's point of view
      classWorkerURL: await toBlobURL(classWorkerURL, 'text/javascript'),
    });
  } catch (err) {
    throw new Error(`ffmpeg.load() failed: ${errText(err)}`);
  }
  ffmpegLoaded = true;
  log('ffmpeg ready.');
}

function escapeDrawtext(text) {
  return text.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function positionExpr(position, kind) {
  // kind: 'text' uses text_w/text_h, 'image' uses w/h/W/H
  if (kind === 'text') {
    switch (position) {
      case 'top': return { x: '(w-text_w)/2', y: '40' };
      case 'bottom': return { x: '(w-text_w)/2', y: 'h-text_h-40' };
      default: return { x: '(w-text_w)/2', y: '(h-text_h)/2' };
    }
  }
  switch (position) {
    case 'top-left': return { x: '20', y: '20' };
    case 'top-right': return { x: 'W-w-20', y: '20' };
    case 'bottom-left': return { x: '20', y: 'H-h-20' };
    case 'bottom-right': return { x: 'W-w-20', y: 'H-h-20' };
    default: return { x: '(W-w)/2', y: '(H-h)/2' };
  }
}

async function buildAndRunOp(op) {
  const args = [];
  switch (op.op) {
    case 'trim': {
      args.push('-i', op.input, '-ss', String(op.start), '-to', String(op.end),
        '-c:v', 'libx264', '-c:a', 'aac', op.output);
      break;
    }
    case 'concat': {
      const filterParts = op.inputs.map((_, i) => `[${i}:v][${i}:a]`).join('');
      op.inputs.forEach((inp) => args.push('-i', inp));
      args.push('-filter_complex', `${filterParts}concat=n=${op.inputs.length}:v=1:a=1[v][a]`,
        '-map', '[v]', '-map', '[a]', op.output);
      break;
    }
    case 'text_overlay': {
      const font = await ensureFont();
      const pos = positionExpr(op.position || 'bottom', 'text');
      const fontfileArg = font ? `fontfile=${font}:` : '';
      const drawtext = `drawtext=${fontfileArg}text='${escapeDrawtext(op.text)}':x=${pos.x}:y=${pos.y}:fontsize=${op.fontsize || 42}:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=12`;
      args.push('-i', op.input, '-vf', drawtext, '-c:a', 'copy', op.output);
      break;
    }
    case 'image_overlay': {
      const pos = positionExpr(op.position || 'bottom-right', 'image');
      args.push('-i', op.input, '-i', op.image, '-filter_complex',
        `[0:v][1:v]overlay=${pos.x}:${pos.y}`, op.output);
      break;
    }
    case 'add_audio': {
      if (op.mode === 'mix') {
        args.push('-i', op.input, '-i', op.audio, '-filter_complex',
          '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[a]',
          '-map', '0:v', '-map', '[a]', '-c:v', 'copy', op.output);
      } else {
        args.push('-i', op.input, '-i', op.audio, '-map', '0:v', '-map', '1:a',
          '-c:v', 'copy', '-shortest', op.output);
      }
      break;
    }
    case 'set_volume': {
      args.push('-i', op.input, '-filter:a', `volume=${op.volume}`, '-c:v', 'copy', op.output);
      break;
    }
    case 'speed': {
      const f = Math.min(2, Math.max(0.5, op.factor));
      args.push('-i', op.input, '-filter_complex',
        `[0:v]setpts=${(1 / f).toFixed(4)}*PTS[v];[0:a]atempo=${f}[a]`,
        '-map', '[v]', '-map', '[a]', op.output);
      break;
    }
    case 'resize': {
      args.push('-i', op.input, '-vf', `scale=${op.width}:${op.height}`, '-c:a', 'copy', op.output);
      break;
    }
    case 'extract_audio': {
      args.push('-i', op.input, '-vn', '-c:a', 'libmp3lame', op.output);
      break;
    }
    case 'format_convert': {
      args.push('-i', op.input, '-c:v', 'libx264', '-c:a', 'aac', op.output);
      break;
    }
    case 'image_to_clip': {
      const dur = op.duration || 4;
      args.push('-loop', '1', '-i', op.input, '-t', String(dur), '-vf',
        'scale=1280:-2:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p',
        '-c:v', 'libx264', '-r', '30', op.output);
      break;
    }
    default:
      throw new Error(`Unknown operation: ${op.op}`);
  }
  log(`Running: ffmpeg ${args.join(' ')}`);
  const exitCode = await ffmpeg.exec(args);
  // ffmpeg.exec() resolves with an exit code instead of throwing — a nonzero code
  // means the step actually failed, even though nothing threw. Catch that here so a
  // failed step can't silently fall through to a broken/incomplete export.
  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed on the "${op.op}" step (exit code ${exitCode}). Check the log above for ffmpeg's own error output.`);
  }
}

els.runBtn.addEventListener('click', async () => {
  if (!currentPlan) return;
  els.runBtn.disabled = true;
  els.planBtn.disabled = true;
  els.progressWrap.hidden = false;
  els.downloadBtn.hidden = true;
  els.progressFill.style.width = '0%';
  els.progressLabel.textContent = 'Starting…';

  try {
    await ensureFFmpeg();

    // write all uploaded media into ffmpeg's virtual filesystem
    const { fetchFile } = FFmpegUtil;
    for (const m of mediaFiles) {
      log(`Writing ${m.name} into working memory…`);
      await ffmpeg.writeFile(m.name, await fetchFile(m.file));
    }

    for (const op of currentPlan.operations) {
      await buildAndRunOp(op);
    }

    const data = await ffmpeg.readFile(currentPlan.final_output);
    if (!data || data.byteLength < 1000) {
      throw new Error(`Export produced an unexpectedly small file (${data ? data.byteLength : 0} bytes) — something went wrong in the pipeline. Check the log above.`);
    }
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);

    els.previewVideo.src = url;
    els.previewVideo.style.display = 'block';
    els.stageEmpty.hidden = true;
    els.downloadBtn.href = url;
    els.downloadBtn.hidden = false;
    els.progressLabel.textContent = 'Done.';
    log('Export complete.');
  } catch (err) {
    log(`Edit failed: ${errText(err)}`);
    els.progressLabel.textContent = `Failed: ${errText(err)}`;
  } finally {
    els.runBtn.disabled = false;
    els.planBtn.disabled = false;
  }
});
