'use strict';
/*
 * End-to-end check of the whole demo flow against a served copy of app/.
 *
 *   cd app && python3 -m http.server 8077 &
 *   NODE_PATH="$(npm root -g)" node tools/demo_flow.cjs
 *
 * Environment:
 *   BASE     origin the app is served from      (default http://127.0.0.1:8077)
 *   CHANNEL  Playwright browser channel         (default "chrome"; CHANNEL= uses
 *            the bundled Chromium, which is what CI has)
 *   CSP      when set, every same-origin response is re-served with this
 *            Content-Security-Policy, so app/_headers can be validated by the
 *            same flow it protects. Violations surface as console errors.
 *
 * Plain CommonJS, node:assert/strict, no test runner and no build step, so the
 * repository keeps its "no node_modules, no package.json" rule. Screenshots are
 * written to tools/out/ and are deliberately left behind after a failure.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = (process.env.BASE || 'http://127.0.0.1:8077').replace(/\/+$/, '');
const CHANNEL = process.env.CHANNEL === undefined ? 'chrome' : process.env.CHANNEL;
const CSP = process.env.CSP || '';
const OUT = path.join(__dirname, 'out');
const NBSP = ' ';

const results = [];
const bus = {
  crossOrigin: [],
  badResponses: [],
  failedRequests: [],
  consoleErrors: [],
  pageErrors: [],
  cspViolations: [],
  requests: []
};

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const tail = detail ? `  ${detail}` : '';
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${tail}`);
}

function brief(err) {
  return String((err && err.message) || err)
    // node:assert colours its diffs; the codes only get in the way in a log.
    .replace(/\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    record(name, false, brief(err));
  }
}

let shotIndex = 0;
async function shot(target, name) {
  const file = path.join(OUT, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
  // A screenshot failure must never mask the assertion it was taken for.
  try {
    return await target.screenshot({ path: file });
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------- page setup

async function openPage(browser, options) {
  const context = await browser.newContext(
    Object.assign({ viewport: { width: 1920, height: 1080 } }, options || {})
  );

  // The demo must work with no network at all. Anything off BASE is recorded
  // and blocked rather than allowed through, so a stray CDN link fails loudly.
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url !== BASE && !url.startsWith(`${BASE}/`)) {
      bus.crossOrigin.push(url);
      return route.abort();
    }
    bus.requests.push(url);
    if (!CSP) return route.continue();
    let response;
    try {
      response = await route.fetch();
    } catch (err) {
      return route.abort();
    }
    const headers = Object.assign({}, response.headers(), { 'content-security-policy': CSP });
    return route.fulfill({ response, headers });
  });

  const page = await context.newPage();

  page.on('console', (msg) => {
    const text = msg.text();
    if (/Content Security Policy/i.test(text)) bus.cspViolations.push(text);
    if (msg.type() === 'error') bus.consoleErrors.push(text);
  });
  page.on('pageerror', (err) => bus.pageErrors.push(err.message));
  page.on('response', (res) => {
    if (res.status() >= 400) bus.badResponses.push(`${res.status()} ${res.url()}`);
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url !== BASE && !url.startsWith(`${BASE}/`)) return;
    const why = (req.failure() && req.failure().errorText) || 'unknown';
    // Scrubbing the stack swaps <img src> and cancels the previous load. That is
    // the browser doing its job, not a broken asset.
    if (why === 'net::ERR_ABORTED') return;
    bus.failedRequests.push(`${why} ${url}`);
  });

  // model-viewer's load/error events do not bubble, but the capture phase still
  // reaches document, so this sees both the dialog viewer and the report thumbnail.
  await page.addInitScript(() => {
    window.__mv = { loads: [], errors: [] };
    const note = (bucket) => (event) => {
      const target = event.target;
      if (!target || target.tagName !== 'MODEL-VIEWER') return;
      window.__mv[bucket].push({
        src: target.getAttribute('src'),
        inDialog: !!(target.parentElement && target.parentElement.id === 'mv-mount')
      });
    };
    document.addEventListener('load', note('loads'), true);
    document.addEventListener('error', note('errors'), true);
  });

  return page;
}

// ------------------------------------------------------------------- helpers

const state = (page) => page.evaluate(() => document.body.dataset.state);

const waitState = (page, want) =>
  page.waitForFunction((s) => document.body.dataset.state === s, want, { timeout: 20000 });

const text = (page, selector) =>
  page.$eval(selector, (node) => (node.textContent || '').trim());

const attr = (page, selector, name) =>
  page.$eval(selector, (node, n) => node.getAttribute(n), name);

const disabled = (page, selector) => page.$eval(selector, (node) => node.disabled);

const playingAudio = (page) =>
  page.evaluate(() => Array.from(document.querySelectorAll('audio'))
    .filter((a) => !a.paused).map((a) => a.id));

const paragraphs = (page) =>
  page.$$eval('#report-body p', (nodes) => nodes.map((n) => n.textContent));

const hidden = (page, selector) => page.$eval(selector, (node) => node.hidden);

const typingDone = (page) =>
  page.waitForFunction(
    () => document.getElementById('report-body').getAttribute('aria-busy') === 'false',
    undefined, { timeout: 15000 }
  );

// The footer carries the centre's logo and a contact address, in every state.
async function footerCheck(page, where) {
  await page.waitForFunction(() => {
    const img = document.querySelector('#site-footer .footer-logo');
    return !!img && img.complete && img.naturalWidth > 0;
  }, undefined, { timeout: 10000 });
  const seen = await page.evaluate(() => {
    const footer = document.getElementById('site-footer');
    const logo = footer.querySelector('.footer-logo');
    const contact = footer.querySelector('.footer-contact');
    const box = footer.getBoundingClientRect();
    return {
      natural: logo.naturalWidth,
      width: Math.round(box.width),
      height: Math.round(box.height),
      contact: (contact ? contact.textContent : '').replace(/\s+/g, ' ').trim(),
      links: footer.querySelectorAll('a').length
    };
  });
  assert.ok(seen.natural > 0, 'the MMIV logo did not load');
  assert.ok(seen.width > 0 && seen.height > 0, `the footer is not laid out: ${JSON.stringify(seen)}`);
  assert.equal(seen.contact, 'Kontakt: satheshkumar.kaliyugarasan@hvl.no', 'contact line');
  // A mail client must never open on a kiosk, so the address stays plain text.
  assert.equal(seen.links, 0, 'the footer must not link the address');
  return `${where}: logo ${seen.natural} px wide, ${seen.height} px tall footer`;
}

const overlap = (page, a, b) =>
  page.evaluate(([x, y]) => {
    const ra = document.getElementById(x).getBoundingClientRect();
    const rb = document.getElementById(y).getBoundingClientRect();
    return Math.max(
      Math.abs(ra.x - rb.x), Math.abs(ra.y - rb.y),
      Math.abs(ra.width - rb.width), Math.abs(ra.height - rb.height)
    );
  }, [a, b]);

async function setSlice(page, k) {
  await page.$eval('#slice-slider', (node, value) => {
    node.value = String(value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, k);
}

async function toExplore(page) {
  await page.click('#btn-to-reveal');
  await page.click('#btn-skip-analysis');
  await waitState(page, 'reveal');
  await page.click('#btn-to-explore');
  await waitState(page, 'explore');
}

async function openDialog(page, trigger = '#btn-open-3d') {
  await page.evaluate(() => { window.__mv.loads.length = 0; });
  await page.click(trigger);
  await page.waitForFunction(
    () => window.__mv.loads.some((l) => l.inDialog) || window.__mv.errors.length > 0,
    undefined, { timeout: 30000 }
  );
}

function padded(k) {
  return `assets/slices/slice_${String(k).padStart(3, '0')}.png`;
}

// ---------------------------------------------------------------------- main

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const caseRes = await fetch(`${BASE}/case.json`, { cache: 'no-store' });
  if (!caseRes.ok) throw new Error(`cannot read ${BASE}/case.json: ${caseRes.status}`);
  const caseData = await caseRes.json();

  const volume = `${caseData.volume.display}${NBSP}${caseData.volume.unit}`;
  const expectedReport = caseData.report.textNob
    .map((line) => String(line).trim().split('{volume}').join(volume))
    .filter(Boolean);
  const best = caseData.stack.best;
  const count = caseData.stack.count;
  const [lo, hi] = caseData.stack.overlayRange;
  const offRange = lo > 0 ? Math.max(0, lo - 20) : hi + 20;
  const brainTumorAsset = caseData.assets.brainTumor;
  const tumorAsset = caseData.assets.mesh;

  const browser = await chromium.launch(Object.assign(
    {
      headless: true,
      // Lets the 3D dialog render on CI runners with no GPU.
      args: ['--enable-unsafe-swiftshader']
    },
    CHANNEL ? { channel: CHANNEL } : {}
  ));

  let page;
  try {
    page = await openPage(browser);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await waitState(page, 'inspect');

    // ---- boot ----------------------------------------------------------
    await check('boot: reaches inspect with the load error hidden', async () => {
      assert.equal(await state(page), 'inspect');
      assert.equal(await page.$eval('#load-error', (n) => n.hidden), true);
      await page.locator('#inspect-img').evaluate((n) => n.decode());
      await shot(page, 'inspect');
    });

    await check('footer: the logo and the contact line are on screen in inspect',
      () => footerCheck(page, 'inspect'));

    await check('boot: no narration audio is downloaded before the report', () => {
      const early = bus.requests.filter((u) => u.endsWith('.mp3'));
      assert.deepEqual(early, []);
    });

    // ---- state machine -------------------------------------------------
    await check('state: "Vis KI-funnet." starts the analysis and the progress bar advances', async () => {
      await page.click('#btn-to-reveal');
      await waitState(page, 'analyzing');
      await page.waitForFunction(() => {
        const w = parseFloat(document.getElementById('progress-fill').style.width);
        return w > 0 && w < 100;
      }, undefined, { timeout: 8000 });
      return `state=${await state(page)}`;
    });

    await check('state: the analysis auto-advances to reveal and the progress bar ends at 100%', async () => {
      await waitState(page, 'reveal');
      assert.equal(
        await page.$eval('#progress-fill', (n) => n.style.width), '100%'
      );
    });

    // ---- overlay alignment ---------------------------------------------
    await check('overlay: slice and overlay align within 0.5 px in reveal at 1920', async () => {
      await page.locator('#reveal-overlay').evaluate((n) => n.decode());
      const delta = await overlap(page, 'reveal-slice', 'reveal-overlay');
      await shot(page, 'reveal-1920');
      assert.ok(delta < 0.5, `max box delta ${delta} px`);
      return `delta ${delta} px`;
    });

    await page.click('#btn-to-explore');
    await waitState(page, 'explore');

    await check('overlay: slice and overlay align within 0.5 px in explore at 1920', async () => {
      await page.locator('#ex-overlay').evaluate((n) => n.decode());
      const delta = await overlap(page, 'ex-slice', 'ex-overlay');
      assert.ok(delta < 0.5, `max box delta ${delta} px`);
      return `delta ${delta} px`;
    });

    await check('overlay: alignment holds at 390 in reveal and explore', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const inExplore = await overlap(page, 'ex-slice', 'ex-overlay');
      await shot(page, 'explore-390');
      await page.evaluate(() => { document.body.dataset.state = 'reveal'; });
      const inReveal = await overlap(page, 'reveal-slice', 'reveal-overlay');
      await page.evaluate(() => { document.body.dataset.state = 'explore'; });
      await page.setViewportSize({ width: 1920, height: 1080 });
      assert.ok(inReveal < 0.5 && inExplore < 0.5, `reveal ${inReveal}, explore ${inExplore}`);
      return `reveal ${inReveal} px, explore ${inExplore} px`;
    });

    // ---- slice browser --------------------------------------------------
    await check(`slice browser: opens on the best slice, labelled "Snitt ${best + 1} / ${count}"`, async () => {
      assert.equal(await text(page, '#explore-h'), `Snitt ${best + 1} / ${count}`);
      assert.equal(await page.$eval('#slice-slider', (n) => n.value), String(best));
      assert.equal(await attr(page, '#slice-slider', 'min'), '0');
      assert.equal(await attr(page, '#slice-slider', 'max'), String(count - 1));
      assert.equal(await attr(page, '#ex-slice', 'src'), padded(best));
      assert.equal(await attr(page, '#slice-slider', 'aria-valuetext'), `Snitt ${best + 1} / ${count}`);
    });

    await check('slice browser: slider, prev, next and wheel each land on the expected slice', async () => {
      await setSlice(page, best + 4);
      assert.equal(await attr(page, '#ex-slice', 'src'), padded(best + 4), 'slider');

      await page.click('#btn-slice-prev');
      assert.equal(await attr(page, '#ex-slice', 'src'), padded(best + 3), 'prev');

      await page.click('#btn-slice-next');
      await page.click('#btn-slice-next');
      assert.equal(await attr(page, '#ex-slice', 'src'), padded(best + 5), 'next');

      const box = await page.locator('#ex-stage').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const before = Number((await attr(page, '#ex-slice', 'src')).match(/(\d+)\.png$/)[1]);
      await page.mouse.wheel(0, 300);
      await page.waitForFunction(
        (src) => document.getElementById('ex-slice').getAttribute('src') !== src,
        padded(before), { timeout: 4000 }
      );
      const after = Number((await attr(page, '#ex-slice', 'src')).match(/(\d+)\.png$/)[1]);
      assert.ok(after > before, `wheel down moved ${before} -> ${after}`);
    });

    await check('slice browser: arrow keys, Home and End drive the stack from the heading', async () => {
      await page.$eval('#explore-h', (n) => n.focus());
      await setSlice(page, best);
      await page.keyboard.press('ArrowRight');
      assert.equal(await attr(page, '#ex-slice', 'src'), padded(best + 1), 'ArrowRight');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await attr(page, '#ex-slice', 'src'), padded(best), 'ArrowLeft');
      await page.keyboard.press('Home');
      assert.equal(await attr(page, '#ex-slice', 'src'), padded(0), 'Home');
      await page.keyboard.press('End');
      assert.equal(await attr(page, '#ex-slice', 'src'), padded(count - 1), 'End');
    });

    await check('slice browser: prev and next are disabled at the two ends of the stack', async () => {
      await setSlice(page, count - 1);
      assert.equal(await disabled(page, '#btn-slice-next'), true, 'next at last slice');
      assert.equal(await disabled(page, '#btn-slice-prev'), false, 'prev at last slice');
      await setSlice(page, 0);
      assert.equal(await disabled(page, '#btn-slice-prev'), true, 'prev at first slice');
      assert.equal(await disabled(page, '#btn-slice-next'), false, 'next at first slice');
    });

    // ---- overlay toggle --------------------------------------------------
    await check(`overlay toggle: on slice ${best} it hides and shows the marking`, async () => {
      await setSlice(page, best);
      assert.equal(await disabled(page, '#btn-explore-toggle'), false);
      assert.equal(await text(page, '#btn-explore-toggle'), 'Skjul markering');
      assert.equal(await attr(page, '#btn-explore-toggle', 'aria-pressed'), 'true');
      assert.equal(await page.$eval('#ex-overlay', (n) => n.hidden), false);

      await page.click('#btn-explore-toggle');
      assert.equal(await text(page, '#btn-explore-toggle'), 'Vis markering');
      assert.equal(await attr(page, '#btn-explore-toggle', 'aria-pressed'), 'false');
      assert.equal(await page.$eval('#ex-overlay', (n) => n.hidden), true);

      await page.click('#btn-explore-toggle');
      assert.equal(await text(page, '#btn-explore-toggle'), 'Skjul markering');
      assert.equal(await page.$eval('#ex-overlay', (n) => n.hidden), false);
    });

    await check(`overlay toggle: on slice ${offRange}, outside the tumour range, it is disabled and reads "Vis markering"`, async () => {
      await setSlice(page, offRange);
      assert.equal(await disabled(page, '#btn-explore-toggle'), true, 'disabled');
      assert.equal(await attr(page, '#btn-explore-toggle', 'aria-pressed'), 'false', 'aria-pressed');
      assert.equal(await text(page, '#btn-explore-toggle'), 'Vis markering', 'label');
      assert.equal(await page.$eval('#ex-overlay', (n) => n.hidden), true, 'overlay hidden');
      await setSlice(page, best);
    });

    // ---- 3D dialog --------------------------------------------------------
    await check(`3D: opening the dialog loads ${brainTumorAsset} and renders a canvas`, async () => {
      await openDialog(page);
      const loads = await page.evaluate(() => window.__mv.loads.filter((l) => l.inDialog));
      assert.deepEqual(await page.evaluate(() => window.__mv.errors), [], 'model-viewer error event');
      assert.equal(loads[0] && loads[0].src, brainTumorAsset);
      const canvas = await page.evaluate(() => {
        const mv = document.querySelector('#mv-mount model-viewer');
        const c = mv && mv.shadowRoot && mv.shadowRoot.querySelector('canvas');
        return c ? { w: c.width, h: c.height } : null;
      });
      assert.ok(canvas && canvas.w > 0 && canvas.h > 0, `canvas ${JSON.stringify(canvas)}`);
      return `canvas ${canvas.w}x${canvas.h}`;
    });

    await check('3D: the tumour is a visible share of the default render, not buried in the skull', async () => {
      // Freeze the turntable at its starting orientation, otherwise the share
      // depends on how far the model happened to rotate.
      await page.evaluate(() => {
        const mv = document.querySelector('#mv-mount model-viewer');
        mv.removeAttribute('auto-rotate');
        if (typeof mv.resetTurntableRotation === 'function') mv.resetTurntableRotation(0);
      });
      await page.waitForTimeout(600);
      const png = await shot(page.locator('.viewer-box'), '3d-default');
      assert.ok(png, 'could not screenshot .viewer-box');
      const share = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let pink = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (r > 80 && r - g >= 30 && r - b >= 5) pink++;
        }
        return pink / (data.length / 4);
      }, png.toString('base64'));
      // A 3.67 cm3 tumour inside a whole head is a small share of the frame:
      // measured 0.16% at this framing, stable to three decimals across runs.
      // The failure this guards against - an OPAQUE skull material, which makes
      // glTF ignore the alpha in baseColorFactor - drives it to exactly zero.
      assert.ok(share > 0.0005, `only ${(share * 100).toFixed(3)}% of the viewer is tumour-coloured`);
      return `${(share * 100).toFixed(3)}% tumour pixels`;
    });

    await check('3D: the volume line is the volume from case.json, with a non-breaking space', async () => {
      const line = await text(page, '#volume-line');
      assert.equal(line, `Volum beregnet fra KI-markeringen: ${volume}.`);
      assert.ok(line.includes(NBSP), 'number and unit are not joined by a non-breaking space');
      return JSON.stringify(line);
    });

    await check('3D: the skull toggle swaps the model and its own label', async () => {
      assert.equal(await text(page, '#btn-brain-toggle'), 'Skjul skallen');
      await page.evaluate(() => { window.__mv.loads.length = 0; });
      await page.click('#btn-brain-toggle');
      assert.equal(await text(page, '#btn-brain-toggle'), 'Vis skallen');
      await page.waitForFunction(
        (src) => window.__mv.loads.some((l) => l.inDialog && l.src === src),
        tumorAsset, { timeout: 30000 }
      );
      assert.equal(
        await page.$eval('#mv-mount model-viewer', (n) => n.getAttribute('src')), tumorAsset
      );
      await shot(page.locator('.viewer-box'), '3d-tumor-only');
      await page.click('#btn-brain-toggle');
      assert.equal(await text(page, '#btn-brain-toggle'), 'Skjul skallen');
    });

    await check('3D: the close button closes the dialog and unmounts the viewer', async () => {
      await page.click('#btn-close-3d');
      await page.waitForFunction(
        () => !document.getElementById('viewer-dialog').open &&
          document.getElementById('mv-mount').children.length === 0,
        undefined, { timeout: 5000 }
      );
    });

    // ---- report -----------------------------------------------------------
    await check('report: aria-busy is true while the draft types, then false', async () => {
      await page.click('#btn-to-report');
      await waitState(page, 'report');
      assert.equal(await attr(page, '#report-body', 'aria-busy'), 'true');
      await page.waitForFunction(
        () => document.getElementById('report-body').getAttribute('aria-busy') === 'false',
        undefined, { timeout: 15000 }
      );
    });

    await check('report: the paragraphs are exactly case.json report.textNob with {volume} filled in', async () => {
      await shot(page, 'report');
      assert.deepEqual(await paragraphs(page), expectedReport);
    });

    await check('report: the patient version types itself in the first time it is shown', async () => {
      await page.click('#btn-patient-report');
      assert.equal(await attr(page, '#report-body', 'aria-busy'), 'true', 'aria-busy at the switch');
      assert.equal(await hidden(page, '#patient-report-audio-toggle'), true, '"Lytt til rapporten" while typing');
      await typingDone(page);
      assert.equal(await hidden(page, '#patient-report-audio-toggle'), false, '"Lytt til rapporten" after typing');
      assert.match(await text(page, '#report-body'), /MR av hodet/);
      assert.deepEqual(await playingAudio(page), [], 'the switch started a track by itself');
    });

    await check('report: the listen button plays, and the explainer takes the single audio slot over', async () => {
      await page.click('#patient-report-audio-toggle');
      // The paused flag flips before the play event relabels the button, so the
      // label is part of what we wait for.
      await page.waitForFunction(
        () => !document.getElementById('patient-report-audio').paused &&
          document.getElementById('patient-report-audio-toggle').textContent.trim() === 'Pause rapporten',
        undefined, { timeout: 8000 }
      );

      await page.click('#patient-info summary');
      await page.waitForTimeout(400);
      assert.deepEqual(await playingAudio(page), ['patient-report-audio'], 'the explainer opened itself playing');
      assert.equal(await text(page, '#patient-audio-toggle'), 'Spill av lyd', 'explainer button label');

      await page.click('#patient-audio-toggle');
      await page.waitForFunction(
        () => !document.getElementById('patient-audio').paused &&
          document.getElementById('patient-report-audio').paused &&
          document.getElementById('patient-audio-toggle').textContent.trim() === 'Pause lyd' &&
          document.getElementById('patient-report-audio-toggle').textContent.trim() === 'Lytt til rapporten',
        undefined, { timeout: 8000 }
      );
      assert.deepEqual(await playingAudio(page), ['patient-audio'], 'exactly one track plays');

      await page.click('#patient-info summary');
      await page.waitForFunction(
        () => document.getElementById('patient-audio').paused,
        undefined, { timeout: 8000 }
      );
      assert.deepEqual(await playingAudio(page), [], 'closing the explainer left it playing');
    });

    await check('report: a version already typed comes back instantly and silently, both ways', async () => {
      await page.click('#btn-patient-report');
      assert.equal(await attr(page, '#report-body', 'aria-busy'), 'false', 'professional version re-typed');
      assert.deepEqual(await paragraphs(page), expectedReport);
      assert.equal(await text(page, '#btn-patient-report'), 'Pasientvennlig versjon', 'label on the professional version');
      assert.equal(await hidden(page, '#patient-report-audio-toggle'), true, 'listen button in the professional version');

      await page.click('#btn-patient-report');
      assert.equal(await attr(page, '#report-body', 'aria-busy'), 'false', 'patient version re-typed');
      assert.match(await text(page, '#report-body'), /MR av hodet/, 'patient text');
      assert.equal(await text(page, '#btn-patient-report'), 'Faglig versjon', 'label on the patient version');
      assert.equal(await hidden(page, '#patient-report-audio-toggle'), false, 'listen button in the patient version');
      assert.deepEqual(await playingAudio(page), [], 'a switch started a track by itself');

      await page.click('#btn-patient-report');
      assert.deepEqual(await paragraphs(page), expectedReport, 'back on the professional version');
    });

    await check('report: a version switch scrolls back to the top at 390', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const room = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight
      );
      assert.ok(room > 0, 'the report does not scroll at 390, so the reset cannot be observed');
      const scrolled = [];
      for (let i = 0; i < 2; i++) {
        // Clicked through the DOM: a Playwright click would scroll the button
        // into view first and hide the very jump this checks for.
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 4000 });
        scrolled.push(await page.evaluate(() => Math.round(window.scrollY)));
        await page.$eval('#btn-patient-report', (node) => node.click());
        // The smooth scroll needs a moment; the value itself is the failure message.
        await page.waitForFunction(() => window.scrollY === 0, undefined, { timeout: 6000 })
          .catch(() => {});
        const landed = await page.evaluate(() => Math.round(window.scrollY * 10) / 10);
        assert.equal(landed, 0, `switch ${i + 1} left the page ${landed} px down`);
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
      return `from ${scrolled.join(' and ')} px down`;
    });

    await check('report: "Tilbake til snittene" returns to the slices and the report reopens instantly', async () => {
      const before = await paragraphs(page);
      await page.click('#btn-back-explore');
      await waitState(page, 'explore');
      assert.equal(await text(page, '#btn-to-report'), 'Vis KI-rapporten', 'explore primary button');
      assert.equal(await disabled(page, '#btn-to-report'), false, 'explore primary button disabled');

      // Going back lands on the default slice, the one carrying the marking,
      // wherever in the stack the visitor had wandered off to.
      await setSlice(page, best + 7);
      await page.click('#btn-to-report');
      await waitState(page, 'report');
      assert.equal(await attr(page, '#report-body', 'aria-busy'), 'false', 're-entry typed the draft again');
      assert.deepEqual(await paragraphs(page), before, 'a different version came back');

      await page.click('#btn-back-explore');
      await waitState(page, 'explore');
      assert.equal(await page.$eval('#slice-slider', (n) => n.value), String(best), 'slice on returning');
      assert.equal(await text(page, '#explore-h'), `Snitt ${best + 1} / ${count}`, 'slice heading on returning');
      await page.click('#btn-to-report');
      await waitState(page, 'report');
    });

    await check('report: "Se svulsten i 3D" opens the dialog without leaving the report', async () => {
      const before = await paragraphs(page);
      await openDialog(page, '#btn-report-3d');
      assert.equal(await page.$eval('#viewer-dialog', (n) => n.open), true, 'dialog open');
      assert.equal(await state(page), 'report', 'state while the dialog is open');
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => !document.getElementById('viewer-dialog').open &&
          document.getElementById('mv-mount').children.length === 0,
        undefined, { timeout: 5000 }
      );
      assert.equal(await state(page), 'report', 'state after closing the dialog');
      assert.deepEqual(await paragraphs(page), before, 'the draft changed while the dialog was open');
    });

    await check('report: spamming the version toggle during typing settles with aria-busy false', async () => {
      await page.click('#btn-restart');
      await waitState(page, 'inspect');
      await toExplore(page);
      await page.click('#btn-to-report');
      await waitState(page, 'report');
      for (let i = 0; i < 6; i++) await page.click('#btn-patient-report');
      await page.waitForTimeout(400);
      assert.equal(await attr(page, '#report-body', 'aria-busy'), 'false');
      const shown = await paragraphs(page);
      assert.deepEqual(shown, expectedReport, 'six switches end on the professional text');
    });

    // ---- restart ----------------------------------------------------------
    await check('restart: returns to inspect with the slider, report and skull toggle reset', async () => {
      // Put every resettable control into a non-default state first, so the
      // restart has something to undo.
      await page.click('#btn-restart');
      await waitState(page, 'inspect');
      await toExplore(page);
      await setSlice(page, Math.min(count - 1, best + 10));
      await page.click('#btn-open-3d');
      await page.waitForSelector('#mv-mount model-viewer', { timeout: 30000 });
      await page.click('#btn-brain-toggle');
      assert.equal(await text(page, '#btn-brain-toggle'), 'Vis skallen', 'skull toggle flipped');
      await page.click('#btn-close-3d');
      await page.click('#btn-to-report');
      await waitState(page, 'report');
      await page.click('#btn-patient-report');
      await typingDone(page);
      await page.click('#patient-report-audio-toggle');
      await page.waitForFunction(
        () => !document.getElementById('patient-report-audio').paused,
        undefined, { timeout: 8000 }
      );

      await page.click('#btn-restart');
      await waitState(page, 'inspect');
      assert.equal(await page.$eval('#slice-slider', (n) => n.value), String(best), 'slider');
      assert.equal(await text(page, '#report-body'), '', 'report body');
      assert.equal(await text(page, '#btn-to-report'), 'Generer KI-rapport.', 'explore primary button');
      assert.equal(await page.$eval('#patient-info', (n) => n.hidden), true, 'explainer hidden');
      assert.equal(await text(page, '#btn-brain-toggle'), 'Skjul skallen', 'skull toggle label');
      assert.equal(await page.$eval('#progress-fill', (n) => n.style.width), '0%', 'progress');
      assert.equal(await page.$eval('#viewer-dialog', (n) => n.open), false, 'dialog');
      assert.equal(await page.$eval('#mv-mount', (n) => n.children.length), 0, 'viewer unmounted');
    });

    await check('restart: audio is paused and its button reads "Lytt til rapporten" again', async () => {
      assert.deepEqual(await playingAudio(page), []);
      assert.equal(
        await page.evaluate(() => Array.from(document.querySelectorAll('audio'))
          .every((a) => a.currentTime === 0)), true, 'audio rewound'
      );
      assert.equal(await text(page, '#patient-report-audio-toggle'), 'Lytt til rapporten');
      assert.equal(await hidden(page, '#patient-report-audio-toggle'), true, 'listen button hidden again');
    });

    await check('restart: a restart mid-typing leaves the DOM still 500 ms later', async () => {
      await toExplore(page);
      await page.click('#btn-to-report');
      await waitState(page, 'report');
      await page.waitForTimeout(700);
      assert.equal(await attr(page, '#report-body', 'aria-busy'), 'true', 'still typing');
      await page.click('#btn-restart');
      await waitState(page, 'inspect');
      const first = await page.$eval('#main', (n) => n.innerHTML);
      await page.waitForTimeout(500);
      const second = await page.$eval('#main', (n) => n.innerHTML);
      assert.equal(first, second, 'the abandoned typing timer kept writing after restart');

      // "Generer KI-rapport." is back and enabled the moment explore is re-entered.
      await toExplore(page);
      assert.equal(await disabled(page, '#btn-to-report'), false, 'report button disabled');
      assert.equal(await text(page, '#btn-to-report'), 'Generer KI-rapport.', 'report button label');
    });

    // ---- robustness --------------------------------------------------------
    await check('layout: no horizontal overflow at 390, 768 or 1920', async () => {
      const bad = [];
      const measure = async (where) => {
        for (const width of [390, 768, 1920]) {
          await page.setViewportSize({ width, height: 844 });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth
          );
          if (overflow > 0) bad.push(`${where}@${width}: +${overflow}px`);
        }
      };
      await measure('explore');
      await page.click('#btn-to-report');
      await waitState(page, 'report');
      await typingDone(page);
      await measure('report');
      await page.setViewportSize({ width: 1920, height: 1080 });
      assert.deepEqual(bad, []);
    });

    await check('a11y: the whole flow completes with reduced motion emulated', async () => {
      const reduced = await openPage(browser, { reducedMotion: 'reduce' });
      try {
        await reduced.goto(`${BASE}/`, { waitUntil: 'load' });
        await waitState(reduced, 'inspect');
        await reduced.click('#btn-to-reveal');
        await waitState(reduced, 'reveal');
        await reduced.click('#btn-to-explore');
        await waitState(reduced, 'explore');
        await reduced.click('#btn-to-report');
        await waitState(reduced, 'report');
        await reduced.waitForFunction(
          () => document.getElementById('report-body').getAttribute('aria-busy') === 'false',
          undefined, { timeout: 15000 }
        );
        assert.deepEqual(await paragraphs(reduced), expectedReport);
        await shot(reduced, 'reduced-motion-report');
        // Nothing types, so the narration button is offered straight away.
        await reduced.click('#btn-patient-report');
        assert.equal(await attr(reduced, '#report-body', 'aria-busy'), 'false', 'patient version typed');
        assert.equal(await hidden(reduced, '#patient-report-audio-toggle'), false, 'listen button');
        assert.deepEqual(await playingAudio(reduced), [], 'the switch started a track by itself');
      } finally {
        await reduced.context().close();
      }
    });

    // ---- aggregate observations across the whole run -----------------------
    await check('offline: no request left the origin under test', () => {
      assert.deepEqual([...new Set(bus.crossOrigin)], []);
    });

    await check('network: every response was below 400 and nothing failed', () => {
      assert.deepEqual([...new Set(bus.badResponses)], [], 'bad responses');
      assert.deepEqual([...new Set(bus.failedRequests)], [], 'failed requests');
    });

    await check('console: zero console errors', () => {
      assert.deepEqual([...new Set(bus.consoleErrors)], []);
    });

    await check('console: zero uncaught page errors', () => {
      assert.deepEqual([...new Set(bus.pageErrors)], []);
    });

    if (CSP) {
      await check('csp: the injected Content-Security-Policy blocked nothing', () => {
        assert.deepEqual([...new Set(bus.cspViolations)], []);
      });
    }
  } catch (err) {
    record('harness: the run reached the end', false, brief(err));
    if (page) await shot(page, 'harness-failure');
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.name}\n      ${f.detail}`);
  }
  console.log(`Screenshots: ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
