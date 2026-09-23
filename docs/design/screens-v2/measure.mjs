// 둘째 판 화면 시안 재기(docs/design/screens-v2, 명세는 spec.md 5절).
//
//   node docs/design/screens-v2/measure.mjs            spec.json의 화면 모두
//   node docs/design/screens-v2/measure.mjs V1 v4      고른 화면만(대소문자 상관없음)
//
// 화면마다 spec.json의 틀 크기(frame)로 연다. 작은 정적 서버가 저장소 뿌리를 내어 주므로 base.css가 앱의 토큰 · 부품 ·
// 묶은 글꼴을 상대 주소로 읽는다(파일 주소로 열면 브라우저가 글꼴을 막는다). 그림(PNG)은 화면 파일 옆에 spec.json의
// png 이름으로 남기고, 상태 변형(variants)은 '이름--변형.png'로 남긴다. spec의 checkFrames(더 작은 틀, 예: 설치한 앱의
// 1024×529)는 그린 상태의 창만 다시 재고 '이름--1024x529.png'로 남긴다.
//
// 재는 것은 앱의 규칙 검사기와 같은 함수(apps/pos/scripts/ui-rules-measure.mjs의 measureRules)다: 16px보다 작은 글자,
// 등급 최소보다 작은 누르는 곳, 틀 밖으로 나간 것 · 가로 넘침 · 페이지 스크롤, 잘리거나 넘친 글자, 말줄임표, 반쯤 잘린 줄,
// 주 버튼 둘 이상 · 등급 강조색이 아닌 주 버튼, 늦음이 아닌 빨강, 영어 글자, 기기 등급. 창(role=dialog)이 열려 있으면
// 창 안을 재고, 창을 숨긴 뒤 뒤 화면도 따로 잰다. 시안에만 더 재는 것:
//   읽기 실패  base.css · 글꼴 · 그림을 읽지 못함, 스크립트 오류
//   글꼴       묶은 Pretendard를 읽지 못함(다른 글꼴이면 글자 폭이 달라 잰 값이 틀린다)
//   크기 변수  .sn-root의 --sn-* 값이 DeviceProfile(profileCssVars)과 다름 → base.css를 고친다
//   틀         .sn-root가 틀을 꽉 채우지 않음
//   창 크기    확인 창 폭 · 높이가 confirmWindow()(ui 4-5)와 다름 · spec의 dialog와 창 유무가 다름
//   문구       spec의 mustShow가 화면에 없음, 주 버튼 문구가 spec의 primary와 다름
//   왼쪽 메뉴 줄  화면 왼쪽 끝에 세로로 긴 메뉴 줄(레일)이 있음(사장님 답 2026-09-24: 없앰)
//
// 크기 숫자는 여기에 적지 않는다. 최소 글자 · 누르는 곳 · 강조색 · 크기 변수 · 확인 창 크기는 모두
// packages/ui/src/device-profile.ts(DeviceProfile)와 packages/layout(confirmWindow)에서 읽는다.
// 하나라도 어긋나면 끝 코드 1. 규칙이 틀렸다고 생각되면 검사를 느슨하게 하지 말고 사람에게 묻는다(AGENTS.md).
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { confirmWindow } from '@skinote/layout';
import { DEVICE_PROFILES, profileCssVars } from '@skinote/ui/device-profile';
import { RULE_LABELS, measureRules } from '../../../apps/pos/scripts/ui-rules-measure.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../../..');
const SPEC = JSON.parse(readFileSync(join(HERE, 'spec.json'), 'utf8'));

// 앱 검사기(apps/pos/scripts/check-ui-rules.mjs)와 같은 값: 빨강을 허락하는 곳과 늦음 토큰.
const LATE_SELECTOR = '.tone-late,.is-late';
const LATE_TOKENS = ['--sn-late', '--sn-late-wash'];
const PROFILES = Object.fromEntries(
  Object.entries(DEVICE_PROFILES).map(([key, p]) => [key, { minFont: p.minFontPx, minTarget: p.minTargetPx, accent: p.accent }]),
);

const LABELS = {
  load: '읽기 실패',
  fonts: '글꼴',
  profile: '크기 변수',
  frame: '틀',
  window: '창 크기',
  text: '문구',
  rail: '왼쪽 메뉴 줄',
  ...RULE_LABELS,
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

/** 저장소 뿌리를 내어 주는 정적 서버(127.0.0.1, 빈 포트). 뿌리 밖의 경로는 거절한다. */
function startServer() {
  const server = createServer((req, res) => {
    let path;
    try {
      path = resolve(REPO, '.' + decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path !== REPO && !path.startsWith(REPO + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(path));
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const urlPath = (file) => relative(REPO, file).split(sep).map(encodeURIComponent).join('/');

/** 고른 화면(인자가 없으면 모두). 없는 코드는 알리고 끝 코드 2. */
function pickScreens(args) {
  const codes = args.filter((a) => !a.startsWith('-')).map((a) => a.toUpperCase());
  if (codes.length === 0) return SPEC.screens;
  const known = new Map(SPEC.screens.map((s) => [s.code.toUpperCase(), s]));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) {
    console.error('spec.json에 없는 화면: ' + unknown.join(', ') + ' (있는 것: ' + [...known.keys()].join(' ') + ')');
    process.exit(2);
  }
  return codes.map((c) => known.get(c));
}

/**
 * 화면의 상태 목록: 그린 상태(기본) + spec의 variants(주소 #hash로 여는 다른 상태)
 * + checkFrames(같은 그린 상태를 더 작은 틀로: 설치한 앱의 1024×569 · 1024×529, ui 3-7). 더 작은 틀에서는 창(크기 · 안)만 잰다.
 * 뒤 화면은 spec의 틀로 그린 그림이고, 앱의 화면은 앱의 검사기가 모든 검사 크기에서 잰다.
 */
function statesOf(screen) {
  const base = { key: '', hash: '', note: '그린 상태', primary: screen.primary, mustShow: screen.mustShow ?? [], dialog: Boolean(screen.dialog), frame: screen.frame };
  const variants = (screen.variants ?? []).map((v) => ({
    key: v.key,
    hash: v.hash ?? '#' + v.key,
    note: v.note ?? v.key,
    primary: v.primary ?? screen.primary,
    mustShow: v.mustShow ?? [],
    dialog: v.dialog ?? Boolean(screen.dialog),
    frame: screen.frame,
  }));
  // 창이 없는 화면(V6 · V7 · V8)은 더 작은 틀에서 화면 전체를 잰다. 상태 변형을 그 틀로 재려면 "hash"(예: V7 1024×520 #offline),
  // 그 틀에서만 다른 주 버튼 · 문구는 "primary" · "mustShow"(예: V8 쪽 넘김 '1 / 2쪽').
  const frames = (screen.checkFrames ?? []).map((f) => ({
    key: f.w + 'x' + f.h + (f.hash ? '-' + f.hash.replace(/^#/, '') : ''),
    hash: f.hash ?? '',
    note: '틀 ' + f.w + '×' + f.h + (f.note ? ' · ' + f.note : '') + (screen.dialog ? ' · 창만' : ''),
    primary: f.primary ?? screen.primary,
    mustShow: f.mustShow ?? [],
    dialog: Boolean(screen.dialog),
    frame: { w: f.w, h: f.h },
    dialogOnly: true,
  }));
  return [base, ...variants, ...frames];
}

async function measureState(browser, origin, screen, state) {
  const { w, h } = state.frame ?? screen.frame;
  const profile = DEVICE_PROFILES[screen.deviceClass];
  const problems = {};
  const add = (rule, row) => (problems[rule] ??= []).push({ count: 1, ...row });
  const file = join(HERE, screen.file);
  const png = join(HERE, state.key ? screen.png.replace(/\.png$/, '--' + state.key + '.png') : screen.png);

  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, locale: 'ko-KR' });
  const page = await context.newPage();
  page.on('pageerror', (e) => add('load', { why: '스크립트 오류', text: norm(e.message).slice(0, 80) }));
  const failed = new Set();
  page.on('response', (r) => {
    if (r.status() < 400 || failed.has(r.url())) return;
    failed.add(r.url());
    add('load', { why: '읽지 못함 ' + r.status(), text: r.url().replace(origin, '') });
  });
  page.on('requestfailed', (r) => {
    if (failed.has(r.url())) return;
    failed.add(r.url());
    add('load', { why: '읽지 못함', text: r.url().replace(origin, '') });
  });

  try {
    await page.goto(origin + urlPath(file) + state.hash, { waitUntil: 'load', timeout: 20000 });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    // 화면 스크립트가 #hash로 상태를 바꾸고 글자 맞추기를 한 번 더 돌 시간.
    await page.waitForTimeout(80);

    // 글꼴: 묶은 Pretendard가 실제로 읽혔는지(document.fonts.check는 선언이 없어도 참이라 쓰지 않는다).
    const fontLoaded = await page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Skinote Pretendard' && f.status === 'loaded'));
    if (!fontLoaded) add('fonts', { why: '묶은 글꼴(Skinote Pretendard)을 읽지 못함 — base.css 링크와 서버로 열었는지 확인' });

    // 크기 변수와 틀.
    const expected = profileCssVars(profile);
    const root = await page.evaluate((keys) => {
      const el = [...document.querySelectorAll('.sn-root')].at(-1);
      if (!el) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { vars: Object.fromEntries(keys.map((k) => [k, s.getPropertyValue(k).trim()])), box: [r.left, r.top, r.width, r.height], device: el.getAttribute('data-device') ?? '' };
    }, Object.keys(expected));
    if (!root) {
      add('frame', { why: '.sn-root가 없음(시안은 <div class="sn-root" data-device="…"> 안에 그린다)' });
    } else {
      for (const [key, value] of Object.entries(expected)) {
        if (root.vars[key] !== value) add('profile', { why: key, has: root.vars[key] || '없음', need: value });
      }
      const [left, top, width, height] = root.box;
      if (Math.abs(left) > 1 || Math.abs(top) > 1 || Math.abs(width - w) > 1 || Math.abs(height - h) > 1) {
        add('frame', { why: '.sn-root가 틀을 채우지 않음', has: [left, top, width, height].map(Math.round).join(','), need: '0,0,' + w + ',' + h });
      }
    }

    // 확인 창: 있어야 할 때 있는지, 폭 · 높이가 confirmWindow()와 같은지.
    const dialog = await page.evaluate(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].filter((el) => el.getClientRects().length > 0).at(-1);
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    if (state.dialog && !dialog) add('window', { why: '확인 창(role="dialog")이 없음' });
    if (!state.dialog && dialog) add('window', { why: 'spec에 없는 창이 열려 있음' });
    if (dialog) {
      const size = confirmWindow({ width: w, height: h }, profile.confirm, 1, profile.capacity.quickMethods, profile.capacity.paymentSectionsPerPage);
      if (Math.abs(dialog.width - size.widthPx) > 1) add('window', { why: '창 폭', has: Math.round(dialog.width), need: size.widthPx });
      if (dialog.height > size.heightPx + 1) add('window', { why: '창 높이', has: Math.round(dialog.height), need: '≤ ' + size.heightPx });
    }

    // 문구: 꼭 보여야 할 글, 주 버튼 문구(창이 열려 있으면 창 안의 주 버튼).
    const seen = await page.evaluate(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].filter((el) => el.getClientRects().length > 0).at(-1);
      const scope = d ?? document;
      const primaries = [...scope.querySelectorAll('[data-primary="true"]')].filter((el) => el.getClientRects().length > 0);
      return { text: document.body.innerText, primaries: primaries.map((el) => el.innerText) };
    });
    const pageText = norm(seen.text);
    for (const s of state.mustShow) if (!pageText.includes(norm(s))) add('text', { why: '빠진 문구', text: s });
    const primaryTexts = seen.primaries.map(norm);
    if (state.primary) {
      if (primaryTexts.length === 0) add('text', { why: '주 버튼(data-primary="true")이 없음', need: state.primary });
      else if (!primaryTexts.includes(norm(state.primary))) add('text', { why: '주 버튼 문구', has: primaryTexts.join(' / '), need: state.primary });
    }

    // 왼쪽 메뉴 줄(레일): 왼쪽 끝에 붙은 좁고 긴 상자에 누르는 곳이 셋 이상.
    const rails = await page.evaluate((vh) => {
      const hits = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.left > 16 || r.width < 48 || r.width > 160 || r.height < vh * 0.6) continue;
        const targets = [...el.querySelectorAll('button,a[href],[role="button"],[role="tab"],[role="link"],[role="menuitem"]')]
          .filter((b) => b.getClientRects().length > 0);
        if (targets.length >= 3) hits.push({ el: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''), box: [r.left, r.top, r.width, r.height].map(Math.round).join(',') });
      }
      return hits.slice(0, 2);
    }, h);
    for (const r of rails) add('rail', { why: '왼쪽 끝의 세로 메뉴', el: r.el, box: r.box });

    // 앱과 같은 규칙: 창이 열려 있으면 창 안만.
    const options = { profiles: PROFILES, sizeClass: screen.deviceClass, allowedDevices: [screen.deviceClass], lateTokens: LATE_TOKENS, lateSelector: LATE_SELECTOR };
    const main = await page.evaluate(measureRules, options);
    for (const [rule, rows] of Object.entries(main.problems)) for (const row of rows) (problems[rule] ??= []).push(row);

    await page.screenshot({ path: png });

    // 창 뒤 화면: 창을 숨기고 다시 잰다(뒤 화면도 규칙을 지켜야 한다). 그림은 창이 열린 채로 이미 찍었다.
    let behind = null;
    if (dialog && !state.dialogOnly) {
      await page.evaluate(() => {
        for (const d of document.querySelectorAll('[role="dialog"]')) (d.closest('.sn-overlay, .sn-sheet-overlay') ?? d).style.display = 'none';
      });
      behind = await page.evaluate(measureRules, options);
      for (const [rule, rows] of Object.entries(behind.problems)) for (const row of rows) (problems[rule] ??= []).push({ ...row, behind: true });
    }
    return { state, png, problems, primaries: main.primaries, device: root?.device ?? '', minFont: main.minFont, minTarget: main.minTarget, behindChecked: Boolean(behind) };
  } catch (error) {
    add('load', { why: '열지 못함', text: norm(error.message).slice(0, 120) });
    return { state, png: null, problems, primaries: 0, device: '', behindChecked: false };
  } finally {
    await context.close();
  }
}

function describe(row) {
  const parts = [];
  if (row.behind) parts.push('뒤 화면');
  if (row.el) parts.push(row.el);
  if (row.text) parts.push('"' + row.text + '"');
  if (row.why) parts.push(row.why);
  if (row.px !== undefined) parts.push(row.px + 'px < ' + row.min + 'px');
  if (row.w !== undefined) parts.push(row.w + '×' + row.h + ' < ' + row.min + 'px');
  if (row.has !== undefined || row.need !== undefined) parts.push('지금 ' + (row.has ?? '—') + ' · 기대 ' + (row.need ?? '—'));
  if (row.by) parts.push('(' + row.by + ')');
  if (row.color) parts.push(row.color);
  if (row.box) parts.push('[' + row.box + ']');
  return parts.join(' · ') + (row.count > 1 ? ' ×' + row.count : '');
}

function printState(screen, run) {
  const rules = Object.entries(run.problems).filter(([, rows]) => rows.length);
  const head = run.state.key ? '  ' + run.state.hash + ' ' + run.state.note : '  ' + run.state.note;
  const shot = run.png ? ' · 그림 ' + relative(HERE, run.png) : '';
  if (rules.length === 0) {
    const scope = run.state.dialog ? (run.behindChecked ? '창 안과 뒤 화면' : '창 안') : '화면';
    console.log(head + ': 통과 · ' + scope + ' · 글자 ' + run.minFont + 'px 이상 · 누르는 곳 ' + run.minTarget + 'px 이상 · 주 버튼 ' + run.primaries + shot);
    return true;
  }
  const count = rules.reduce((n, [, rows]) => n + rows.length, 0);
  console.log(head + ': 어긋남 ' + count + shot);
  for (const [rule, rows] of rules) {
    console.log('    ' + (LABELS[rule] ?? rule) + ' ' + rows.length);
    for (const row of rows.slice(0, 6)) console.log('      - ' + describe(row));
    if (rows.length > 6) console.log('      … 외 ' + (rows.length - 6) + '곳');
  }
  return false;
}

async function main() {
  const screens = pickScreens(process.argv.slice(2));
  const server = await startServer();
  const origin = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();
  const tally = { pass: 0, fail: 0, missing: 0 };
  try {
    for (const screen of screens) {
      const profile = DEVICE_PROFILES[screen.deviceClass];
      console.log(screen.code + ' ' + screen.title + ' — ' + screen.deviceClass + ' ' + screen.frame.w + '×' + screen.frame.h + ' — ' + screen.file);
      if (!profile) {
        console.log('  어긋남: spec.json의 deviceClass가 DeviceProfile에 없음(' + screen.deviceClass + ')');
        tally.fail += 1;
        continue;
      }
      if (!existsSync(join(HERE, screen.file))) {
        console.log('  파일 없음: 아직 그리지 않았다(spec.md 3절의 이 화면을 보고 그린다)');
        tally.missing += 1;
        continue;
      }
      let ok = true;
      for (const state of statesOf(screen)) {
        const run = await measureState(browser, origin, screen, state);
        if (!printState(screen, run)) ok = false;
      }
      if (ok) tally.pass += 1;
      else tally.fail += 1;
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log('');
  console.log(screens.length + '개 화면 · 통과 ' + tally.pass + ' · 어긋남 ' + tally.fail + ' · 파일 없음 ' + tally.missing);
  if (tally.fail || tally.missing) process.exitCode = 1;
}

await main();
