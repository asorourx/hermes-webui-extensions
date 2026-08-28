/* Regression test for sysinfo's per-container info (ⓘ) panel lifecycle.
   Self-contained: evaluates assets/sysinfo.js against a minimal DOM/fetch stub —
   no jsdom / no browser.  Run: `node --test scripts/test-sysinfo-info-race.mjs`

   Covers the review's frontend findings:
     - close→reopen must NOT let a late inspect response clobber the newer open
       (each fetch is bound to its exact detail entry);
     - a container that leaves the poll payload has its detail entry pruned;
     - the ⓘ button drops aria-haspopup=dialog and gains aria-controls; the open
       panel is a labelled region with a status region for loading/error. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  fileURLToPath(new URL('../extensions/sysinfo/assets/sysinfo.js', import.meta.url)), 'utf8');

function makeEl() {
  return {
    innerHTML: '', textContent: '', hidden: false, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, insertBefore() {}, removeChild() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    contains() { return false; }, closest() { return null; }, focus() {},
    children: [], parentNode: null, dataset: {},
  };
}

function loadSysinfo() {
  const els = {};
  const getEl = (id) => (els[id] || (els[id] = makeEl()));
  const inspectResolvers = [];
  const store = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.window = {
    __sysinfo: undefined, showToast() {},
    MutationObserver: class { observe() {} disconnect() {} },
    addEventListener() {}, removeEventListener() {}, localStorage: store, CSS: undefined,
  };
  globalThis.document = {
    readyState: 'complete', body: makeEl(), activeElement: null,
    addEventListener() {}, removeEventListener() {},
    getElementById: getEl, querySelector() { return null; }, querySelectorAll() { return []; },
    createElement: makeEl,
  };
  globalThis.localStorage = store;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0; globalThis.clearTimeout = () => {};
  globalThis.AbortController = class { constructor() { this.signal = {}; } abort() {} };
  globalThis.fetch = (url) => {
    if (String(url).includes('/api/system/docker/inspect')) {
      return new Promise((resolve) => {
        inspectResolvers.push((detailResp) =>
          resolve({ ok: true, status: 200, json: async () => detailResp }));
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  (0, eval)(SRC);
  return { listHtml: () => getEl('systemHealthDockerList').innerHTML, inspectResolvers };
}

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => process.nextTick(r)); };
const CID = 'abc123abc123';
const payload = { docker: { available: true, containers: [
  { id: CID, name: 'app', state: 'running', compose_project: '', compose_service: '' },
] } };

test('close→reopen: a LATE (out-of-order) response cannot clobber the newer open', async () => {
  const { listHtml, inspectResolvers } = loadSysinfo();
  window._mcRenderDockerCard(payload);
  window.mcDockerInfo(CID);                         // open A -> inspect req #0
  window.mcDockerInfo(CID);                         // close  -> entry deleted
  window.mcDockerInfo(CID);                         // open B -> inspect req #1
  assert.equal(inspectResolvers.length, 2);
  // settle B FIRST, then the stale A LATE — this is the order that exposes the bug
  inspectResolvers[1]({ ok: true, detail: { image: 'IMAGE_FROM_B', state: 'running' } });
  await flush();
  inspectResolvers[0]({ ok: true, detail: { image: 'IMAGE_FROM_A', state: 'running' } });
  await flush();
  window._mcRenderDockerCard(payload);
  assert.ok(listHtml().includes('IMAGE_FROM_B'), 'panel keeps the reopened (B) detail');
  assert.ok(!listHtml().includes('IMAGE_FROM_A'), 'the stale late A response was NOT applied');
});

test('a container that leaves the payload has its detail pruned', async () => {
  const { listHtml, inspectResolvers } = loadSysinfo();
  window._mcRenderDockerCard(payload);
  window.mcDockerInfo(CID);
  inspectResolvers[0]({ ok: true, detail: { image: 'IMAGE_X', state: 'running' } });
  await flush();
  window._mcRenderDockerCard(payload);
  assert.ok(listHtml().includes('IMAGE_X'), 'panel present while its container is present');
  window._mcRenderDockerCard({ docker: { available: true, containers: [
    { id: 'ffffffffffff', name: 'other', state: 'running', compose_project: '', compose_service: '' },
  ] } });
  assert.ok(!listHtml().includes('IMAGE_X'), 'detail pruned once its row disappears');
});

test('ARIA: no dialog role; button has aria-controls; open panel is a labelled region', async () => {
  const { listHtml } = loadSysinfo();
  window._mcRenderDockerCard(payload);
  window.mcDockerInfo(CID);                          // open -> loading panel (inspect pending)
  window._mcRenderDockerCard(payload);
  const html = listHtml();
  assert.ok(!/aria-haspopup="dialog"/.test(html), 'button must not claim a dialog');
  assert.ok(/aria-controls="mc-docker-detail-/.test(html), 'button has aria-controls');
  assert.ok(/class="mc-docker-detail"[^>]*role="region"/.test(html), 'panel is a region');
  assert.ok(/role="status"/.test(html), 'loading/error uses a status region');
});
