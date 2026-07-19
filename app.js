/* Ember Cut — instruction-based video editor
   Runs entirely client-side: ffmpeg.wasm does the editing, Groq's free API
   turns your instructions into a structured edit plan. No server, no upload. */

const els = {
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

// ---------- logging ----------
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
    { "op": "format_convert", "input": "<filename>", "output": "<newname with target extension>" }
  ],
  "final_output": "<the filename that is the finished result>"
}

Rules:
- Only use filenames from the provided media list, or names you created earlier as an "output" in a prior step.
- Chain operations in logical order — each step's "input" should be a real input file or a previous step's "output".
- Keep the plan minimal: only include steps the user actually asked for.
- "final_output" must match the output of the last relevant operation.
- If something is ambiguous, make the most reasonable assumption rather than asking a question.`;

async function callGroq(instructionText) {
  const key = els.groqKey.value.trim();
  if (!key) throw new Error('Add your free Groq API key first (left panel).');
  if (mediaFiles.length === 0) throw new Error('Upload at least one media file first.');

  const mediaDescription = mediaFiles
    .map((m) => `- ${m.name} (${m.type || 'unknown type'})`)
    .join('\n');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SCHEMA_PROMPT },
        {
          role: 'user',
          content: `Available media files:\n${mediaDescription}\n\nInstructions: ${instructionText}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error (${res.status}): ${errText.slice(0, 300)}`);
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
    els.planOutput.textContent = `Error: ${err.message}`;
    log(`Plan generation failed: ${err.message}`);
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
    log(`Warning: could not load a web font (${e.message}). Text overlays may fail.`);
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

  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
  log('Loading ffmpeg core (first run only, ~30MB)…');
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });
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
    default:
      throw new Error(`Unknown operation: ${op.op}`);
  }
  log(`Running: ffmpeg ${args.join(' ')}`);
  await ffmpeg.exec(args);
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
    log(`Edit failed: ${err.message}`);
    els.progressLabel.textContent = `Failed: ${err.message}`;
  } finally {
    els.runBtn.disabled = false;
    els.planBtn.disabled = false;
  }
});
