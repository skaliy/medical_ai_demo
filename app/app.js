'use strict';
/* Behaviour for the kiosk demo. Visible text lives in index.html and the
   measured case data in case.json; this file only wires the two together.

   Order: settings, state, helpers, image viewport, analysis, 3D viewers,
   report, audio, navigation, events, boot. */

/* ---------- settings ---------- */

const ANALYZE_MS = 5000;
const ANALYZE_REDUCED_MS = 1200;
const REPORT_TYPE_MS = 3000;
/* Kiosk attract reset: five idle minutes return the demo to its first screen. */
const IDLE_RESET_MS = 5 * 60 * 1000;
/* Wheel pixels consumed per slice step: one mouse notch (100 px in Chromium) is one
   slice, while a trackpad flick steps instead of flying through the stack. */
const WHEEL_STEP = 100;
/* Approximate pixels per unit for DOM_DELTA_LINE (1) and DOM_DELTA_PAGE (2). */
const WHEEL_UNIT_PX = { 1: 16, 2: WHEEL_STEP };
/* Which header step each state belongs to. */
const STEP_OF_STATE = { inspect: 'inspect', analyzing: 'reveal', reveal: 'reveal', explore: 'explore', report: 'report' };

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/* Probed once at boot: each probe costs a real WebGL context. */
const WEBGL_OK = detectWebgl();

/* ---------- state ---------- */

let caseData = null;
let state = 'inspect';
let sliceK = 0;
let wheelAccum = 0;
let viewer = null;
let analysisTimer = null;
let analysisFrame = null;
let typingTimer = null;
let idleTimer = null;

/* Everything a visitor can change. A restart replaces it wholesale, so a new
   field cannot be forgotten there. */
function freshSession() {
  return {
    overlayShown: true,
    showHead: true,
    reportVersion: 'pro',
    reportGenerated: false,
    /* Each version types itself out once per visit; after that it is instant. */
    typed: { pro: false, patient: false }
  };
}
let session = freshSession();

/* ---------- helpers ---------- */

const el = (id) => document.getElementById(id);

function detectWebgl() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (err) {
    return false;
  }
}

/* Buttons with two labels carry them as data-label and data-label-active. */
function setLabel(button, active) {
  button.textContent = active ? button.dataset.labelActive : button.dataset.label;
}

function templateItems(id) {
  return Array.from(el(id).content.children);
}

/* Replaces {volume} in every text node under root. The non-breaking space keeps
   the number and its unit on one line. */
function fillVolume(root) {
  const { display, unit } = caseData.volume;
  const volume = `${display}\u00a0${unit}`;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.includes('{volume}')) node.nodeValue = node.nodeValue.split('{volume}').join(volume);
  }
}

function stackUrl(kind, k) {
  return caseData.stack[kind].replace('%03d', String(k).padStart(3, '0'));
}

function hasOverlay(k) {
  const [lo, hi] = caseData.stack.overlayRange;
  return k >= lo && k <= hi;
}

function preloadSlice(k) {
  if (k < 0 || k >= caseData.stack.count) return;
  new Image().src = stackUrl('sliceUrl', k);
  if (hasOverlay(k)) new Image().src = stackUrl('overlayUrl', k);
}

/* ---------- image viewport ---------- */

function showSlice(k) {
  const { count } = caseData.stack;
  sliceK = Math.min(Math.max(k, 0), count - 1);
  el('slice-img').src = stackUrl('sliceUrl', sliceK);
  if (hasOverlay(sliceK)) el('overlay-img').src = stackUrl('overlayUrl', sliceK);

  el('slice-k').textContent = String(sliceK + 1);
  const slider = el('slice-slider');
  slider.value = String(sliceK);
  slider.setAttribute('aria-valuetext', el('slice-readout').textContent);
  el('btn-slice-prev').disabled = sliceK <= 0;
  el('btn-slice-next').disabled = sliceK >= count - 1;
  syncOverlay();
  for (let d = 1; d <= 3; d++) { preloadSlice(sliceK - d); preloadSlice(sliceK + d); }
}

/* The marking shows from the reveal on, on the slices that have one, unless the
   visitor has hidden it. Most slices carry none, so there the toggles switch off. */
function syncOverlay() {
  const available = hasOverlay(sliceK);
  const marking = state === 'reveal' || state === 'explore';
  el('overlay-img').hidden = !(marking && available && session.overlayShown);
  /* The label names the action, so the buttons carry no aria-pressed as well. */
  for (const button of document.querySelectorAll('.overlay-toggle')) {
    button.disabled = !available;
    setLabel(button, available && session.overlayShown);
  }
}

/* The slider track shows where in the stack the AI found the tumour. Half a step
   either side, so the band covers the thumb on its first and last slice. */
function markTumourOnSlider() {
  const { count, overlayRange: [lo, hi] } = caseData.stack;
  const at = (k) => Math.min(Math.max(k / (count - 1), 0), 1).toFixed(4);
  const slider = el('slice-slider');
  slider.style.setProperty('--band-start', at(lo - 0.5));
  slider.style.setProperty('--band-end', at(hi + 0.5));
}

/* ---------- analysis ---------- */

/* Lights the U-Net up to the given stage; -1 clears it. */
function lightUnet(stage) {
  for (const group of el('unet').querySelectorAll('[data-stage]')) {
    group.classList.toggle('is-lit', Number(group.dataset.stage) <= stage);
  }
}

function startAnalysis() {
  setState('analyzing');
  const duration = REDUCED_MOTION ? ANALYZE_REDUCED_MS : ANALYZE_MS;
  const steps = templateItems('analyze-steps').map((li) => li.textContent.trim());
  /* The diagram's stages advance with time, whatever the number of status lines. */
  const stages = el('unet').querySelectorAll('[data-stage]').length;
  const status = el('analyzing-status');
  const fill = el('progress-fill');
  const started = performance.now();

  analysisTimer = setTimeout(() => {
    fill.style.width = '100%';
    setState('reveal');
  }, duration);

  if (REDUCED_MOTION) {
    fill.style.width = '100%';
    status.textContent = steps[steps.length - 1];
    lightUnet(stages - 1);
    return;
  }
  const tick = () => {
    const frac = Math.min((performance.now() - started) / duration, 1);
    fill.style.width = frac >= 1 ? '100%' : `${(frac * 100).toFixed(1)}%`;
    status.textContent = steps[Math.min(Math.floor(frac * steps.length), steps.length - 1)];
    lightUnet(Math.min(Math.floor(frac * stages), stages - 1));
    if (frac < 1) analysisFrame = requestAnimationFrame(tick);
  };
  tick();
}

function stopAnalysis() {
  clearTimeout(analysisTimer);
  cancelAnimationFrame(analysisFrame);
  analysisTimer = null;
  analysisFrame = null;
}

/* ---------- 3D viewers ---------- */

function viewerSupported() {
  return WEBGL_OK && !!customElements.get('model-viewer');
}

function cloneViewer(templateId) {
  return document.importNode(el(templateId).content.firstElementChild, true);
}

function headModelUrl() {
  return session.showHead ? caseData.models.withHead : caseData.models.tumorOnly;
}

function mountViewer() {
  if (viewer) return;
  const loading = el('viewer-loading');
  const fallback = el('viewer-fallback');
  if (!viewerSupported()) {
    fallback.hidden = false;
    return;
  }
  loading.hidden = false;
  viewer = cloneViewer('tpl-viewer');
  viewer.setAttribute('src', headModelUrl());
  viewer.addEventListener('load', () => { loading.hidden = true; });
  viewer.addEventListener('error', () => {
    loading.hidden = true;
    fallback.hidden = false;
  });
  el('mv-mount').appendChild(viewer);
}

function unmountViewer() {
  if (!viewer) return;
  viewer.remove();
  viewer = null;
  el('viewer-loading').hidden = true;
  el('viewer-fallback').hidden = true;
}

function openViewerDialog() {
  el('viewer-dialog').showModal();
  mountViewer();
}

function closeViewerDialog() {
  const dialog = el('viewer-dialog');
  if (dialog.open) dialog.close();
  unmountViewer();
}

function toggleHead() {
  session.showHead = !session.showHead;
  setLabel(el('btn-brain-toggle'), session.showHead);
  if (viewer) {
    el('viewer-loading').hidden = false;
    viewer.setAttribute('src', headModelUrl());
  }
}

/* Mounted on entering the report and removed on restart. */
function mountReportThumb() {
  const box = el('report-volume');
  if (!viewerSupported()) {
    box.hidden = true;
    return;
  }
  if (box.firstElementChild) return;
  const thumb = cloneViewer('tpl-thumb');
  thumb.setAttribute('src', caseData.models.tumorOnly);
  box.appendChild(thumb);
}

/* ---------- report ---------- */

function stopTyping() {
  clearInterval(typingTimer);
  typingTimer = null;
}

function renderReport() {
  const version = session.reportVersion;
  const isPatient = version === 'patient';
  const animate = !REDUCED_MOTION && !session.typed[version];
  session.typed[version] = true;
  stopTyping();

  for (const [id, v] of [['btn-pro-report', 'pro'], ['btn-patient-report', 'patient']]) {
    el(id).setAttribute('aria-pressed', String(v === version));
  }
  /* The explainer and the narration belong to the patient version. */
  el('patient-info').hidden = !isPatient;
  if (!isPatient) {
    stopAllAudio();
    el('patient-info').open = false;
  }
  /* Offering the narration mid-typing would invite a click on a half-written
     draft, so the button waits for the last character. */
  const listen = el('patient-report-audio-toggle');
  listen.hidden = !isPatient || animate;

  const body = el('report-body');
  const blocks = () => templateItems(`report-${version}`).map((node) => node.cloneNode(true));
  body.replaceChildren(...blocks());
  body.setAttribute('aria-busy', String(animate));
  if (!animate) return;

  const shown = Array.from(body.children);
  /* Collapse source indentation, but not the no-break space inside the volume. */
  const texts = shown.map((node) => node.textContent.replace(/[ \t\r\n]+/g, ' ').trim());
  const total = texts.reduce((sum, t) => sum + t.length, 0);
  const started = performance.now();
  const type = () => {
    const progress = Math.min(1, (performance.now() - started) / REPORT_TYPE_MS);
    let remaining = Math.floor(total * progress);
    shown.forEach((node, i) => {
      node.textContent = texts[i].slice(0, Math.max(0, remaining));
      remaining -= texts[i].length;
    });
    if (progress < 1) return;
    stopTyping();
    body.replaceChildren(...blocks());  // restores any markup inside the blocks
    body.setAttribute('aria-busy', 'false');
    listen.hidden = !isPatient;
  };
  type();
  typingTimer = setInterval(type, 30);
}

function setReportVersion(version) {
  if (version === session.reportVersion) return;
  session.reportVersion = version;
  renderReport();
  /* Instant, not smooth: the patient version is taller, and the scroll offset
     Chromium clamps after switching away from it cancels a smooth scroll. */
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function openReport() {
  /* Generated once; later visits reopen the draft already on the page. */
  const first = !session.reportGenerated;
  session.reportGenerated = true;
  setLabel(el('btn-to-report'), true);
  setState('report');
  if (first) renderReport();
}

/* ---------- audio ---------- */

const AUDIO_BUTTONS = [
  ['patient-report-audio', 'patient-report-audio-toggle'],
  ['patient-audio', 'patient-audio-toggle']
];

function syncAudioButtons() {
  for (const [audioId, buttonId] of AUDIO_BUTTONS) setLabel(el(buttonId), !el(audioId).paused);
}

function stopAllAudio() {
  for (const audio of document.querySelectorAll('audio')) {
    audio.pause();
    audio.currentTime = 0;
  }
  syncAudioButtons();
}

/* No autoplay anywhere, and only one track at a time. */
function bindAudio() {
  for (const [audioId, buttonId] of AUDIO_BUTTONS) {
    const audio = el(audioId);
    el(buttonId).addEventListener('click', () => {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    });
    audio.addEventListener('play', () => {
      for (const other of document.querySelectorAll('audio')) {
        if (other !== audio) {
          other.pause();
          other.currentTime = 0;
        }
      }
      syncAudioButtons();
    });
    audio.addEventListener('pause', syncAudioButtons);
    audio.addEventListener('ended', syncAudioButtons);
  }
  /* Closing the explainer stops whatever it was playing. */
  el('patient-info').addEventListener('toggle', () => {
    if (!el('patient-info').open) el('patient-audio').pause();
  });
}

/* ---------- navigation ---------- */

function syncSteps() {
  const order = ['inspect', 'reveal', 'explore', 'report'];
  const current = order.indexOf(STEP_OF_STATE[state]);
  order.forEach((name, i) => {
    const step = el(`step-${name}`);
    step.classList.toggle('is-done', i < current);
    if (i === current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
}

function setState(next, { focus = true } = {}) {
  state = next;
  document.body.dataset.state = next;
  if (next !== 'analyzing') stopAnalysis();
  /* The narration belongs to the report and has no control anywhere else. */
  if (next !== 'report') stopAllAudio();
  closeViewerDialog();
  syncSteps();
  syncOverlay();
  if (next === 'report') {
    /* Narration is only fetched once the visitor has reached the report. */
    for (const audio of document.querySelectorAll('audio')) audio.preload = 'auto';
    mountReportThumb();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  resetIdle();
  if (focus) el(`${next}-h`).focus({ preventScroll: true });
}

/* setState('inspect') at the end also stops the analysis and the audio and
   closes the 3D dialog. */
function restart() {
  stopTyping();
  el('report-volume').replaceChildren();
  session = freshSession();
  wheelAccum = 0;

  el('report-body').replaceChildren();
  el('report-body').setAttribute('aria-busy', 'false');
  el('patient-info').open = false;
  el('patient-info').hidden = true;
  el('patient-report-audio-toggle').hidden = true;
  el('progress-fill').style.width = '0%';
  el('analyzing-status').textContent = '';
  lightUnet(-1);
  setLabel(el('btn-to-report'), false);
  setLabel(el('btn-brain-toggle'), true);
  showSlice(caseData.stack.best);
  setState('inspect');
}

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const playing = Array.from(document.querySelectorAll('audio')).some((a) => !a.paused);
    if (state === 'inspect' || playing) resetIdle();
    else restart();
  }, IDLE_RESET_MS);
}

/* ---------- events ---------- */

function bind() {
  el('btn-to-reveal').addEventListener('click', startAnalysis);
  el('btn-skip-analysis').addEventListener('click', () => setState('reveal'));
  el('btn-to-explore').addEventListener('click', () => setState('explore'));
  el('btn-to-report').addEventListener('click', openReport);
  el('btn-back-explore').addEventListener('click', () => {
    /* Back to the slice the demo opens on, the one the report describes. */
    showSlice(caseData.stack.best);
    setState('explore');
  });
  el('btn-restart').addEventListener('click', restart);

  for (const button of document.querySelectorAll('.overlay-toggle')) {
    button.addEventListener('click', () => {
      session.overlayShown = !session.overlayShown;
      syncOverlay();
    });
  }

  el('btn-open-3d').addEventListener('click', openViewerDialog);
  el('btn-report-3d').addEventListener('click', openViewerDialog);
  el('btn-close-3d').addEventListener('click', closeViewerDialog);
  el('btn-brain-toggle').addEventListener('click', toggleHead);
  el('viewer-dialog').addEventListener('close', unmountViewer);

  el('btn-pro-report').addEventListener('click', () => setReportVersion('pro'));
  el('btn-patient-report').addEventListener('click', () => setReportVersion('patient'));
  bindAudio();

  el('slice-slider').addEventListener('input', (e) => showSlice(Number(e.target.value)));
  el('btn-slice-prev').addEventListener('click', () => showSlice(sliceK - 1));
  el('btn-slice-next').addEventListener('click', () => showSlice(sliceK + 1));
  el('viewport').addEventListener('wheel', (e) => {
    /* Only the slice browser scrolls the stack; horizontal gestures stay with the page. */
    if (state !== 'explore' || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    wheelAccum += e.deltaY * (WHEEL_UNIT_PX[e.deltaMode] || 1);
    const steps = Math.trunc(wheelAccum / WHEEL_STEP);
    if (!steps) return;
    wheelAccum -= steps * WHEEL_STEP;
    showSlice(sliceK + steps);
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (state !== 'explore' || el('viewer-dialog').open) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
    const keys = {
      ArrowLeft: sliceK - 1, ArrowDown: sliceK - 1,
      ArrowRight: sliceK + 1, ArrowUp: sliceK + 1,
      Home: 0, End: caseData.stack.count - 1
    };
    if (!(e.key in keys)) return;
    e.preventDefault();
    showSlice(keys[e.key]);
  });

  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, resetIdle, { passive: true });
  }
}

/* ---------- boot ---------- */

async function loadCase() {
  const res = await fetch('case.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`case.json: ${res.status}`);
  caseData = await res.json();
}

/* Everything that reads case.json, so a missing or misspelt key lands in the
   load error below rather than in a page whose buttons do nothing. */
function setUp() {
  fillVolume(document.body);
  for (const template of document.querySelectorAll('template')) fillVolume(template.content);

  const { best, count } = caseData.stack;
  el('slice-n').textContent = String(count);
  el('slice-slider').max = String(count - 1);
  el('report-slice').src = stackUrl('sliceUrl', best);
  el('report-overlay').src = stackUrl('overlayUrl', best);
  for (const button of document.querySelectorAll('[data-label]')) setLabel(button, false);
  setLabel(el('btn-brain-toggle'), true);
  markTumourOnSlider();
  el('unet-in').setAttribute('href', stackUrl('sliceUrl', best));
  el('unet-out-slice').setAttribute('href', stackUrl('sliceUrl', best));
  el('unet-out-overlay').setAttribute('href', stackUrl('overlayUrl', best));
  showSlice(best);
  /* Warm both 3D models (about 1.6 MB together) before anyone opens the dialog. */
  for (const url of Object.values(caseData.models)) fetch(url).catch(() => {});

  /* Without WebGL the dialog shows a fallback message, and the toggle has nothing to swap. */
  el('btn-brain-toggle').hidden = !viewerSupported();
}

async function boot() {
  try {
    await loadCase();
    setUp();
  } catch (err) {
    console.error(err);
    document.body.classList.add('load-failed');
    el('load-error').hidden = false;
    return;
  }
  bind();
  setState('inspect', { focus: false });
}

boot();
