const TEXT = {
  prompt: 'Ser du noe som skiller seg ut?',
  revealPrompt: 'Se hva KI-modellen fant',
  showFinding: 'Vis KI-funnet.',
  revealCaption: 'Dette er området KI-modellen har markert som svulst.',
  hideOverlay: 'Skjul markering',
  showOverlay: 'Vis markering',
  toExplore: 'Bla i snittene.',
  open3d: 'Se svulsten i 3D',
  toReport: 'Generer KI-rapport.',
  /* Once the draft exists, the same explore button reopens it instead. */
  showReport: 'Vis KI-rapporten',
  backExplore: 'Tilbake til snittene',
  patientReport: [
    'MR av hodet',
    'MR-bildene viser en svulst i området mellom lillehjernen og hjernestammen, med utbredelse inn mot den indre øregangen. Funnet passer med et vestibularisschwannom.',
    'Svulsten påvirker vevet rundt i liten grad.',
    'Svulstens volum er beregnet til {volume} ved hjelp av kunstig intelligens (KI).',
    'Konklusjon:',
    'Funnene passer med vestibularisschwannom. Beregnet tumorvolum er {volume}.'
  ],
  reportTitle: 'KI-generert rapportutkast.',
  reportVersionPro: 'Faglig versjon',
  reportVersionPatient: 'Pasientvennlig versjon',
  listenReport: 'Lytt til rapporten',
  pauseReport: 'Pause rapporten',
  playAudio: 'Spill av lyd',
  pauseAudio: 'Pause lyd',
  hideSkull: 'Skjul skallen',
  showSkull: 'Vis skallen',
  volume: 'Volum beregnet fra KI-markeringen: {volume}.',
  restart: 'Start på nytt',
  sliceAlt: 'MR-snitt av hjernen uten markering',
  meshAlt: '3D-modell av svulsten',
  viewerFallback: '3D-visning utilgjengelig i denne nettleseren.',
  loadError: 'Kunne ikke laste demodata. Last siden på nytt.',
  analyzingTitle: 'KI-modellen analyserer …',
  analyzingSub: 'Animasjonen viser trinnene modellen går gjennom. Resultatet er regnet ut på forhånd.',
  skipAnalysis: 'Hopp over analysen',
  sliceLabel: 'Snitt {k} / {n}',
  analyzeSteps: [
    'Normaliserer bildene …',
    'Kjører encoder …',
    'Analyserer 3D-blokker …',
    'Dekoder segmentering …',
    'Beregner tumorvolum …'
  ]
};

const FALLBACK_ASSETS = {
  slice: 'assets/slice.png',
  overlay: 'assets/overlay.png',
  mesh: 'assets/tumor.glb',
  brainTumor: 'assets/brain_tumor.glb'
};

const FALLBACK_STACK = {
  sliceUrl: 'assets/slices/slice_%03d.png',
  overlayUrl: 'assets/slices/overlay_%03d.png',
  count: 1,
  best: 0,
  overlayRange: [0, 0]
};

const ANALYZE_MS = 5000;
const ANALYZE_REDUCED_MS = 1200;
const REPORT_MS = 3000;
/* Kiosk attract reset: five idle minutes returns the demo to its first screen. */
const IDLE_MS = 300000;
/* Wheel pixels consumed per slice step: one mouse notch (100 px in Chromium) is one
   slice, while a trackpad flick steps instead of flying through the stack. */
const WHEEL_STEP = 100;
/* Approximate pixels per unit for DOM_DELTA_LINE (1) and DOM_DELTA_PAGE (2). */
const WHEEL_UNIT_PX = { 1: 16, 2: WHEEL_STEP };

let caseData = null;
let state = 'inspect';
let overlayShown = true;
let curK = 0;
let viewer = null;
let showBrain = true;
let analyzeTimer = null;
let analyzeRaf = null;
let analyzeStart = 0;
let idleTimer = null;
let reportGenerationTimer = null;
let patientReport = false;
/* The draft types itself out once per version per visit: switching back and
   forth after that is instant, and a restart makes both type again. */
let typedVersions = { pro: false, patient: false };
let reportGenerated = false;
let wheelAccum = 0;
let syncReportAudioLabel = () => {};
let syncPatientAudioLabel = () => {};

const el = (id) => document.getElementById(id);

function detectWebgl() {
  try {
    const canvas = document.createElement('canvas');
    const gl = window.WebGLRenderingContext &&
      (canvas.getContext('webgl2') || canvas.getContext('webgl'));
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (err) {
    return false;
  }
}

/* Probed once at boot: each probe costs a real WebGL context. */
const WEBGL_OK = detectWebgl();
const REDUCED_MOTION = !!(window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function label(key) {
  const custom = caseData && caseData.labels;
  if (custom && typeof custom[key] === 'string' && custom[key].trim()) return custom[key];
  return TEXT[key];
}

function asset(key) {
  const fromCase = caseData && caseData.assets && caseData.assets[key];
  return typeof fromCase === 'string' && fromCase.trim() ? fromCase : FALLBACK_ASSETS[key];
}

function stackInfo() {
  return Object.assign({}, FALLBACK_STACK, (caseData && caseData.stack) || {});
}

function stackUrl(kind, k) {
  const s = stackInfo();
  return s[kind].replace('%03d', String(k).padStart(3, '0'));
}

function hasOverlay(k) {
  const [lo, hi] = stackInfo().overlayRange;
  return k >= lo && k <= hi;
}

function volumeText() {
  const v = (caseData && caseData.volume) || {};
  const display = typeof v.display === 'string' ? v.display : '';
  const unit = typeof v.unit === 'string' ? v.unit : '';
  /* Non-breaking space: the number and its unit must never wrap apart. */
  return `${display}\u00a0${unit}`.trim();
}

function failLoad() {
  document.body.classList.add('load-failed');
  const box = el('load-error');
  box.textContent = label('loadError');
  box.hidden = false;
}

function preload(url) {
  const img = new Image();
  img.src = url;
}

function preloadSlice(k) {
  const s = stackInfo();
  if (k < 0 || k >= s.count) return;
  preload(stackUrl('sliceUrl', k));
  if (hasOverlay(k)) preload(stackUrl('overlayUrl', k));
}

function preloadAssets() {
  for (const key of ['slice', 'overlay']) preload(asset(key));
  /* Warm both 3D models (about 1.6 MB together): the dialog opens on the
     head-plus-tumor scene and the skull toggle swaps to the tumor alone. */
  for (const key of ['brainTumor', 'mesh']) {
    const url = asset(key);
    if (url) fetch(url).catch(() => {});
  }
  const best = stackInfo().best;
  for (let d = -2; d <= 2; d++) preloadSlice(best + d);
}

function applyLabels() {
  el('inspect-h').textContent = label('prompt');
  el('reveal-h').textContent = label('revealPrompt');
  el('analyzing-h').textContent = label('analyzingTitle');
  el('btn-to-reveal').textContent = label('showFinding');
  el('btn-to-explore').textContent = label('toExplore');
  el('btn-open-3d').textContent = label('open3d');
  el('btn-report-3d').textContent = label('open3d');
  el('btn-back-explore').textContent = label('backExplore');
  syncReportEntry();
  el('btn-restart').textContent = label('restart');
  el('btn-skip-analysis').textContent = label('skipAnalysis');
  el('reveal-caption').textContent = label('revealCaption');
  el('btn-patient-report').textContent = label('reportVersionPatient');
  el('btn-brain-toggle').textContent = showBrain ? label('hideSkull') : label('showSkull');
  el('patient-audio-toggle').textContent = label('playAudio');
  el('patient-report-audio-toggle').textContent = label('listenReport');

  el('analyzing-sub').textContent = label('analyzingSub');

  const report = (caseData && caseData.report) || {};
  el('report-h').textContent = report.title || label('reportTitle');
  el('inspect-img').alt = label('sliceAlt');

  el('volume-line').textContent = label('volume').replace('{volume}', volumeText());
}

/* The explore primary button generates the draft once, then reopens it. */
function syncReportEntry() {
  el('btn-to-report').textContent = reportGenerated ? label('showReport') : label('toReport');
}

/* The report is long on a phone, so every entry and every version switch starts
   at the top rather than wherever the visitor had scrolled to.

   The jump is instant, not smooth: the whole panel is replaced either way, so
   there is no position to carry over, and a smooth scroll is unreliable here.
   The patient version is the taller one, so switching off it shortens the page,
   and the scroll offset Chromium clamps after that relayout cancels an animation
   already in flight - which left the visitor stranded at the old bottom. */
function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function reportParagraphs() {
  const report = (caseData && caseData.report) || {};
  const raw = patientReport ? label('patientReport') : (report.textNob || '');
  const parts = Array.isArray(raw) ? raw : String(raw).split(/\n+/);
  const volume = volumeText();
  return parts
    .map((s) => String(s).trim().split('{volume}').join(volume))
    .filter(Boolean);
}

function renderReport() {
  const isPatient = patientReport;
  const version = isPatient ? 'patient' : 'pro';
  /* Each version types itself out the first time this visit shows it. */
  const animate = !REDUCED_MOTION && !typedVersions[version];
  typedVersions[version] = true;
  const body = el('report-body');
  body.textContent = '';
  clearInterval(reportGenerationTimer);
  const paragraphs = reportParagraphs();
  el('patient-info').hidden = !isPatient;
  el('btn-patient-report').textContent =
    isPatient ? label('reportVersionPro') : label('reportVersionPatient');
  /* The narration belongs to the patient version, so leaving it stops the track. */
  if (!isPatient) {
    stopReportAudio();
    el('patient-info').open = false;
  }
  paragraphs.forEach((text, i) => {
    const p = document.createElement('p');
    p.textContent = animate ? '' : text;
    /* The opening line is the study heading; the rest are section labels. */
    if (i === 0 || text.endsWith(':')) p.className = 'report-sub';
    body.appendChild(p);
  });
  const reportAudioButton = el('patient-report-audio-toggle');
  /* Offering the narration mid-typing would invite a click on a half-written
     draft, so the button waits for the last character. */
  reportAudioButton.hidden = !isPatient || animate;
  reportAudioButton.textContent =
    el('patient-report-audio').paused ? label('listenReport') : label('pauseReport');

  body.setAttribute('aria-busy', String(animate));
  if (animate) {
    const started = performance.now();
    const total = paragraphs.reduce((sum, text) => sum + text.length, 0);
    reportGenerationTimer = setInterval(() => {
      const progress = Math.min(1, (performance.now() - started) / REPORT_MS);
      let remaining = Math.floor(total * progress);
      paragraphs.forEach((text, i) => {
        body.children[i].textContent = text.slice(0, Math.max(0, remaining));
        remaining -= text.length;
      });
      if (progress === 1) {
        clearInterval(reportGenerationTimer);
        body.setAttribute('aria-busy', 'false');
        reportAudioButton.hidden = !isPatient;
      }
    }, 30);
  }
}

function bindAudioToggle(audioId, buttonId, playKey, pauseKey) {
  const audio = el(audioId);
  const button = el(buttonId);
  const sync = () => { button.textContent = audio.paused ? label(playKey) : label(pauseKey); };
  button.addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  audio.addEventListener('play', () => {
    document.querySelectorAll('audio').forEach((other) => {
      if (other !== audio) {
        other.pause();
        other.currentTime = 0;
      }
    });
    sync();
  });
  audio.addEventListener('pause', sync);
  audio.addEventListener('ended', sync);
  sync();
  return sync;
}

function syncOverlays() {
  for (const imgId of ['reveal-overlay', 'ex-overlay']) {
    const img = el(imgId);
    if (imgId === 'ex-overlay' && !hasOverlay(curK)) img.hidden = true;
    else img.hidden = !overlayShown;
  }

  const revealBtn = el('btn-reveal-toggle');
  revealBtn.disabled = false;
  revealBtn.textContent = overlayShown ? label('hideOverlay') : label('showOverlay');
  revealBtn.setAttribute('aria-pressed', String(overlayShown));

  /* Most slices carry no segmentation, so there is nothing to toggle there. */
  const exploreBtn = el('btn-explore-toggle');
  const available = hasOverlay(curK);
  exploreBtn.disabled = !available;
  exploreBtn.textContent = available && overlayShown ? label('hideOverlay') : label('showOverlay');
  exploreBtn.setAttribute('aria-pressed', String(available && overlayShown));
}

function toggleOverlay() {
  overlayShown = !overlayShown;
  syncOverlays();
}

function showSlice(k) {
  const s = stackInfo();
  curK = Math.min(Math.max(k, 0), s.count - 1);
  el('ex-slice').src = stackUrl('sliceUrl', curK);
  if (hasOverlay(curK)) el('ex-overlay').src = stackUrl('overlayUrl', curK);
  const slider = el('slice-slider');
  slider.value = String(curK);
  const text = label('sliceLabel').replace('{k}', curK + 1).replace('{n}', s.count);
  el('explore-h').textContent = text;
  slider.setAttribute('aria-valuetext', text);
  el('btn-slice-prev').disabled = curK <= 0;
  el('btn-slice-next').disabled = curK >= s.count - 1;
  syncOverlays();
  for (let d = 1; d <= 3; d++) { preloadSlice(curK - d); preloadSlice(curK + d); }
}

function buildNeuralNet() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 640 360');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');

  const layers = [4, 6, 6, 2];
  const pos = layers.map((count, li) => {
    const x = 70 + li * (500 / (layers.length - 1));
    const gap = 280 / Math.max(count - 1, 1);
    const ys = [];
    for (let ni = 0; ni < count; ni++) ys.push(180 - (gap * (count - 1)) / 2 + ni * gap);
    return ys.map((y) => ({ x, y }));
  });

  for (let li = 0; li < pos.length - 1; li++) {
    for (const a of pos[li]) {
      for (const b of pos[li + 1]) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
        line.setAttribute('class', 'nn-edge');
        line.style.animationDelay = (li * 0.22).toFixed(2) + 's';
        svg.appendChild(line);
      }
    }
  }
  for (let li = 0; li < pos.length; li++) {
    for (const p of pos[li]) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 11);
      c.setAttribute('class', 'nn-node' + (li === pos.length - 1 ? ' nn-out' : ''));
      c.style.animationDelay = (li * 0.22).toFixed(2) + 's';
      svg.appendChild(c);
    }
  }
  el('nn-stage').appendChild(svg);
}

function runNeural(duration, done) {
  setState('analyzing');
  analyzeStart = performance.now();
  cancelAnimationFrame(analyzeRaf);
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => {
    el('progress-fill').style.width = '100%';
    done();
  }, duration);

  const steps = label('analyzeSteps');
  const stepCount = Array.isArray(steps) ? steps.length : 1;
  if (REDUCED_MOTION) {
    el('progress-fill').style.width = '100%';
    el('analyzing-status').textContent = steps[stepCount - 1];
    return;
  }
  const tick = () => {
    const frac = Math.min((performance.now() - analyzeStart) / duration, 1);
    el('progress-fill').style.width = frac >= 1 ? '100%' : (frac * 100).toFixed(1) + '%';
    const idx = Math.min(Math.floor(frac * stepCount), stepCount - 1);
    el('analyzing-status').textContent = steps[idx];
    if (frac < 1) analyzeRaf = requestAnimationFrame(tick);
  };
  tick();
}

function startAnalysis() {
  runNeural(REDUCED_MOTION ? ANALYZE_REDUCED_MS : ANALYZE_MS, () => setState('reveal'));
}

function stopAnalysis() {
  clearTimeout(analyzeTimer);
  cancelAnimationFrame(analyzeRaf);
  analyzeTimer = null;
  analyzeRaf = null;
}

function mountViewer() {
  if (viewer) return;

  const mount = el('mv-mount');
  const fallback = el('viewer-fallback');
  const loading = el('viewer-loading');
  mount.textContent = '';
  fallback.hidden = true;
  loading.hidden = true;

  if (!viewerSupported()) {
    fallback.textContent = label('viewerFallback');
    fallback.hidden = false;
    return;
  }
  loading.hidden = false;

  viewer = document.createElement('model-viewer');
  viewer.setAttribute('src', showBrain ? asset('brainTumor') : asset('mesh'));
  viewer.setAttribute('alt', label('meshAlt'));
  viewer.setAttribute('camera-controls', '');
  viewer.setAttribute('loading', 'eager');
  viewer.setAttribute('reveal', 'auto');
  viewer.setAttribute('environment-image', 'neutral');
  viewer.setAttribute('exposure', '1.15');
  viewer.setAttribute('shadow-intensity', '0.7');
  /* Start slightly above and to the side, so the slice plane and the tumor inside
     the translucent head are visible before the visitor touches anything. */
  viewer.setAttribute('camera-orbit', '-30deg 62deg auto');
  viewer.setAttribute('auto-rotate', '');
  viewer.setAttribute('auto-rotate-delay', '800');
  viewer.setAttribute('rotation-per-second', '12deg');
  viewer.addEventListener('load', () => { loading.hidden = true; });
  viewer.addEventListener('error', () => {
    loading.hidden = true;
    fallback.textContent = label('viewerFallback');
    fallback.hidden = false;
  });

  mount.appendChild(viewer);
}

/* Built in JS: a <model-viewer> in the markup spins up a WebGL renderer the
   moment the element upgrades, which throws on machines without WebGL. */
function viewerSupported() {
  return WEBGL_OK && typeof customElements !== 'undefined' &&
    !!(customElements.get('model-viewer') || window.ModelViewerElement);
}

/* Mounted on entering the report and removed on restart, like the dialog viewer. */
function mountReportThumb() {
  const box = el('report-volume');
  if (!viewerSupported()) {
    box.hidden = true;
    return;
  }
  if (box.querySelector('model-viewer')) return;
  const thumb = document.createElement('model-viewer');
  thumb.id = 'report-model';
  thumb.setAttribute('alt', label('meshAlt'));
  thumb.setAttribute('camera-controls', '');
  thumb.setAttribute('auto-rotate', '');
  thumb.setAttribute('interaction-prompt', 'none');
  thumb.setAttribute('loading', 'lazy');
  thumb.setAttribute('src', asset('mesh'));
  box.appendChild(thumb);
}

function unmountReportThumb() {
  const box = el('report-volume');
  const thumb = box.querySelector('model-viewer');
  if (thumb) box.removeChild(thumb);
}

function unmountViewer() {
  if (!viewer) return;
  const mount = el('mv-mount');
  if (viewer.parentNode === mount) mount.removeChild(viewer);
  viewer = null;
  el('viewer-loading').hidden = true;
  el('viewer-fallback').hidden = true;
}

function anyAudioPlaying() {
  return Array.prototype.some.call(document.querySelectorAll('audio'), (audio) => !audio.paused);
}

function attractReset() {
  if (state === 'inspect' || anyAudioPlaying()) {
    resetIdle();
    return;
  }
  restart();
}

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(attractReset, IDLE_MS);
}

function setState(next, focus) {
  state = next;
  document.body.dataset.state = next;

  if (next !== 'analyzing') stopAnalysis();
  closeViewerDialog();

  el('btn-to-report').disabled = next === 'report';
  if (next === 'report') {
    /* Audio is only fetched once the visitor has reached the report. */
    el('patient-audio').preload = 'auto';
    el('patient-report-audio').preload = 'auto';
    mountReportThumb();
    scrollToTop();
  }
  resetIdle();

  const target = el(`${next}-h`);
  if (focus !== false && target) target.focus({ preventScroll: true });
}

function openViewerDialog() {
  const dialog = el('viewer-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  mountViewer();
}

function closeViewerDialog() {
  const dialog = el('viewer-dialog');
  /* dialog.open is undefined where <dialog> is unsupported, so test the attribute. */
  if (dialog.open || dialog.hasAttribute('open')) {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }
  unmountViewer();
}

function stopReportAudio() {
  document.querySelectorAll('audio').forEach((audio) => { audio.pause(); audio.currentTime = 0; });
}

function restart() {
  stopReportAudio();
  el('patient-info').open = false;
  el('patient-report-audio-toggle').hidden = true;
  stopAnalysis();
  clearInterval(reportGenerationTimer);
  reportGenerationTimer = null;
  overlayShown = true;
  showBrain = true;
  el('btn-brain-toggle').textContent = label('hideSkull');
  el('btn-to-report').disabled = false;
  el('progress-fill').style.width = '0%';
  el('analyzing-status').textContent = label('analyzeSteps')[0];
  showSlice(stackInfo().best);
  el('report-body').textContent = '';
  el('patient-info').hidden = true;
  patientReport = false;
  typedVersions = { pro: false, patient: false };
  reportGenerated = false;
  syncReportEntry();
  el('btn-patient-report').textContent = label('reportVersionPatient');
  syncReportAudioLabel();
  syncPatientAudioLabel();
  closeViewerDialog();
  unmountReportThumb();
  setState('inspect');
}

function bind() {
  el('btn-to-reveal').addEventListener('click', startAnalysis);
  el('btn-skip-analysis').addEventListener('click', () => setState('reveal'));
  el('btn-to-explore').addEventListener('click', () => setState('explore'));
  el('btn-open-3d').addEventListener('click', openViewerDialog);
  el('btn-close-3d').addEventListener('click', closeViewerDialog);
  el('btn-brain-toggle').addEventListener('click', () => {
    showBrain = !showBrain;
    el('btn-brain-toggle').textContent = showBrain ? label('hideSkull') : label('showSkull');
    if (viewer) {
      el('viewer-loading').hidden = false;
      viewer.setAttribute('src', showBrain ? asset('brainTumor') : asset('mesh'));
    }
  });
  el('viewer-dialog').addEventListener('close', unmountViewer);
  el('btn-to-report').addEventListener('click', () => {
    /* Second and later visits reopen the draft that is already on the page. */
    const first = !reportGenerated;
    reportGenerated = true;
    syncReportEntry();
    setState('report');
    if (first) renderReport();
  });
  el('btn-back-explore').addEventListener('click', () => {
    /* Back to the slice the demo opens on, not wherever the visitor left off:
       that is the one carrying the marking they just read about. */
    showSlice(stackInfo().best);
    setState('explore');
  });
  el('btn-report-3d').addEventListener('click', openViewerDialog);
  el('btn-patient-report').addEventListener('click', () => {
    patientReport = !patientReport;
    renderReport();
    scrollToTop();
  });
  /* No autoplay anywhere: opening the explainer only offers its button, and
     closing it stops whatever it was playing. */
  el('patient-info').addEventListener('toggle', () => {
    if (!el('patient-info').open) el('patient-audio').pause();
  });
  syncPatientAudioLabel = bindAudioToggle('patient-audio', 'patient-audio-toggle', 'playAudio', 'pauseAudio');
  syncReportAudioLabel = bindAudioToggle('patient-report-audio', 'patient-report-audio-toggle', 'listenReport', 'pauseReport');
  el('btn-restart').addEventListener('click', restart);
  el('btn-reveal-toggle').addEventListener('click', toggleOverlay);
  el('btn-explore-toggle').addEventListener('click', toggleOverlay);

  el('slice-slider').addEventListener('input', (e) => showSlice(Number(e.target.value)));
  el('btn-slice-prev').addEventListener('click', () => showSlice(curK - 1));
  el('btn-slice-next').addEventListener('click', () => showSlice(curK + 1));
  el('ex-stage').addEventListener('wheel', (e) => {
    /* Leave horizontal and diagonal gestures to the page. */
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    wheelAccum += e.deltaY * (WHEEL_UNIT_PX[e.deltaMode] || 1);
    const steps = Math.trunc(wheelAccum / WHEEL_STEP);
    if (!steps) return;
    wheelAccum -= steps * WHEEL_STEP;
    showSlice(curK + steps);
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (state !== 'explore' || el('viewer-dialog').open) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLButtonElement) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); showSlice(curK - 1); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); showSlice(curK + 1); }
    else if (e.key === 'Home') { e.preventDefault(); showSlice(0); }
    else if (e.key === 'End') { e.preventDefault(); showSlice(stackInfo().count - 1); }
  });

  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, resetIdle, { passive: true });
  }
  resetIdle();
}

async function loadCase() {
  const res = await fetch('case.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`case.json: ${res.status}`);
  return res.json();
}

async function boot() {
  try {
    caseData = await loadCase();
  } catch (err) {
    failLoad();
    return;
  }

  applyLabels();
  preloadAssets();
  buildNeuralNet();

  el('inspect-img').src = asset('slice');
  el('reveal-slice').src = asset('slice');
  el('reveal-overlay').src = asset('overlay');
  el('report-slice').src = asset('slice');

  const s = stackInfo();
  const slider = el('slice-slider');
  slider.min = '0';
  slider.max = String(s.count - 1);
  showSlice(s.best);

  bind();
  setState('inspect', false);
}

boot();
