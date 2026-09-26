// 서버 모드 끝까지 시험(계획 work/impl-server/plan.md §10 E2E · I2). 빌드한 앱(apps/pos/dist)을 로컬 앞단(scripts/lib/local-proxy.mjs,
// index.html에 서버 표시)으로 띄우고, 진짜 서버(packages/server)를 임시 자료 폴더로 띄워 브라우저(Playwright chromium) 여럿으로 쓴다.
//
//   준비: 빈 포트 둘(서버 · 앞단) → 임시 자료 폴더 · 무작위 비밀값 · 짧은 관리 소켓 → 서버를 한 번 띄워 마이그레이션 → 멈춤 →
//         명령줄 provision(시험 매장 · 견본 명세 · 직원 셋, 비밀번호는 표준 출력에서 읽음) · device-code(포스 셋 · 기사 태블릿 · 기사 휴대폰)
//         · load-sample(오늘 견본 하루)
//         → 서버 · 앞단을 다시 띄움
//   A(카운터 1, 1024×600): 기기 등록(숫자판으로 12자리) → 로그인(타일 → 비밀번호 숫자판) → 장부 → 새 접수: 대표자 이름을 화면 키보드로
//         (ㄱ ㅣ ㅁ ㅁ ㅣ ㄴ ㅅ ㅜ = 김민수) → 연락처 숫자판 → 품목 → 일정 → 접수 확정(현금) → 접수증 → 지급 도장 → 새로 고침에도 그대로
//   B(카운터 2, 관리자): 등록 · 로그인 → A가 만든 팀이 장부에 있음 → 둘 다 운영 규칙 화면 → B가 규칙을 저장하면 A의 화면이 새로 고침
//         없이 바뀐다(알림 연결) → A를 새로 고쳐도 서버 값 그대로(서버 장부)
//   A 연결: 끊기면 머리줄에 연결 띠와 같은 노랑 이름표 `연결 끊김 · 마지막 연결 …`(875×600에서도 잘리지 않음), 다시 이으면 사라짐
//   C(기사 태블릿 · 1호 차량): 등록 · 로그인 → 수거 목록(바닥줄에 `전송 대기` 없음: 서버에 붙은 기기는 보냄 대기가 없다), 끊기면 연결 띠,
//         장부 조회는 403
//   E(기사 휴대폰 · 1호 차량, 360×640 — 첫 매장 기사의 주 기기): 등록 · 로그인(휴대폰 등급) → 배달 목록(촘촘한 줄) → 업무 판(품목 줄 한 쪽)
//         → 현장 수납 수단은 현금 · 계좌이체뿐 → 장부 조회 403 → 끝에 명령줄로 그 휴대폰을 끊으면 기기 등록 화면
//   D(카운터 3): 관리자 비밀번호를 다섯 번 틀림 → `로그인 잠김 · … 이후 가능`, B는 그대로 로그인
//   화면 키보드 875×600(A의 새 접수) 찍기 → 우리 주소의 ?demo는 서버 모드 그대로(기기 등록 화면) → 표시를 찍지 않는 둘째 앞단(체험판)의
//   360×640 미리 보기 키보드 → A 로그아웃(로그인 화면, 머리 401) → 다시 로그인하면 장부(나가기 화면이 아님) → 명령줄로 C 기기 끊기(관리
//   소켓) → C가 기기 등록 화면으로 → 서버 · 앞단을 멈추고 기록에 처리 오류 · 비밀번호 · 등록 번호가 없는지
//
// 접수 걸음(새 접수 확정 · 지급 · 새로 고침 · 다른 기기의 장부)은 서버 저장소가 접수를 표에 적는다(계획 C3a ~ C3e). 서버가 그래도
// `미지원 기능 · 처리 불가`로 거절하면 그 걸음들은 실패가 아니라 '막힘'으로 적고 끝 코드 3으로 끝난다(모든 걸음 통과 0, 실패 1).
//
// 실행: npm run build && npm run test:e2e   (찍은 화면 · 기록은 work/e2e/<시각>/, 저장소에 올리지 않음)
//   환경 변수: SKINOTE_E2E_HEADED=1(창을 보이며), SKINOTE_E2E_KEEP=1(임시 자료 폴더를 지우지 않음)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { newSecretsEnv } from '../packages/server/src/secrets.js';
import { startLocalProxy } from './lib/local-proxy.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'apps/pos/dist');
const SERVER_MAIN = join(ROOT, 'packages/server/src/main.js');
const SHOP_CLI = join(ROOT, 'packages/server/bin/shop.js');
const SHOP = 'e2e0shop';
const STAFF = { manager: '정하늘', counter: '김카운터', driver: '박기사' };
const TEAM = { name: '김민수', keys: ['ㄱ', 'ㅣ', 'ㅁ', 'ㅁ', 'ㅣ', 'ㄴ', 'ㅅ', 'ㅜ'], phone: '01000001234' };
const UNSUPPORTED_LINE = '미지원 기능 · 처리 불가';
const STEP_MS = 15_000;
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(ROOT, 'work/e2e', RUN);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, state: ok ? 'ok' : 'fail', detail });
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  ' + detail : ''));
  return Boolean(ok);
};
const blocked = (name, detail) => {
  results.push({ name, state: 'blocked', detail });
  console.log('… ' + name + ' — 막힘: ' + detail);
};

/** 비어 있는 포트(잠깐 잡았다 놓는다). */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 자식 프로세스(뒤에서, 기록 파일). */
function startChild(args, env, logFile) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  const keep = (b) => { chunks.push(b); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.log = () => Buffer.concat(chunks).toString('utf8');
  child.on('exit', () => { try { writeFileSync(logFile, child.log()); } catch { /* 폴더가 없음 */ } });
  return child;
}

/** 자식 프로세스를 멈춘다(SIGTERM, 10초 뒤 SIGKILL). */
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await Promise.race([exited, sleep(12_000)]);
  clearTimeout(timer);
}

async function waitHealthy(port, child, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error('서버가 끝났다(끝 코드 ' + child.exitCode + '):\n' + child.log().slice(-2000));
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health/live`)).ok) return;
    } catch { /* 아직 */ }
    await sleep(150);
  }
  throw new Error('서버가 ' + ms + 'ms 안에 뜨지 않았다');
}

/** 명령줄 한 번(30초). 표준 출력 · 오류 · 끝 코드. */
function runCli(args, env, logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SHOP_CLI, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('명령줄이 30초 안에 끝나지 않음: ' + args[0])); }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // 기록에는 표준 오류만 남긴다(표준 출력에는 비밀번호 · 등록 번호가 있다).
      try { writeFileSync(logFile, err, { flag: 'a' }); } catch { /* 폴더가 없음 */ }
      resolve({ code, out, err });
    });
  });
}

// ── 브라우저 걸음 ─────────────────────────────────────────────────────────

async function shot(page, name) {
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.screenshot({ path: join(OUT, name + '.png') }).catch(() => {});
}

/** 기기 등록: 화면 숫자판의 키로 12자리 → 입력 → 로그인 화면. */
async function enroll(page, code) {
  await page.waitForSelector('.pos-enroll', { timeout: STEP_MS });
  const pad = page.locator('.pos-enroll .sn-numpad');
  for (const d of code) await pad.getByRole('button', { name: d, exact: true }).click();
  const shown = (await pad.locator('.sn-numpad-display').textContent())?.trim();
  await pad.getByRole('button', { name: '입력', exact: true }).click();
  await page.waitForSelector('.pos-login-tile', { timeout: STEP_MS });
  return shown;
}

/** 로그인: 직원 타일 → 비밀번호 숫자판(가린 표시) → 입력. 잠김 · 틀림이면 판의 한 줄을 돌려준다(되면 null). */
async function login(page, name, pin, { expectApp = true } = {}) {
  if (!(await page.locator('.sn-sheet-overlay .sn-numpad').count())) {
    await page.locator('.pos-login-tile', { hasText: name }).first().click();
  }
  const pad = page.locator('.sn-sheet-overlay .sn-numpad');
  await pad.waitFor({ timeout: STEP_MS });
  for (const d of pin) await pad.getByRole('button', { name: d, exact: true }).click();
  const masked = (await pad.locator('.sn-numpad-display').textContent())?.trim() ?? '';
  await pad.getByRole('button', { name: '입력', exact: true }).click();
  if (expectApp) {
    await page.waitForFunction(() => !document.querySelector('.pos-login'), null, { timeout: STEP_MS });
    return { note: null, masked };
  }
  // 보내는 동안 판의 한 줄은 `처리 중`이다: 답의 한 줄(틀림 · 잠김)이 올 때까지 기다린다.
  const note = pad.locator('.sn-keypad-note');
  await page.waitForFunction(() => {
    const text = document.querySelector('.sn-sheet-overlay .sn-numpad .sn-keypad-note')?.textContent?.trim() ?? '';
    return text !== '' && text !== '처리 중';
  }, null, { timeout: STEP_MS });
  return { note: (await note.textContent())?.trim() ?? '', masked };
}

/** 앞단 주소 기준 조회(페이지 안에서, 쿠키 + 세션의 CSRF). */
async function pageQuery(page, body) {
  return page.evaluate(async (payload) => {
    const session = await fetch('api/v2/session', { cache: 'no-store' });
    if (session.status !== 200) return { status: session.status };
    const { csrf } = await session.json();
    const res = await fetch('api/v2/query', { method: 'POST', headers: { 'content-type': 'application/json', 'x-skinote-csrf': csrf }, body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);
}

/** 운영 규칙 카드의 버튼(카드가 다음 쪽이면 넘긴다). */
async function ruleButton(page, cardTitle, button) {
  const target = () => page.locator('.sn-rule-card[aria-label="' + cardTitle + '"]').getByRole('button', { name: button, exact: true });
  for (let guard = 0; guard < 6; guard += 1) {
    if (await target().count()) return target();
    const next = page.locator('.sn-footer').getByRole('button', { name: '다음 쪽' });
    if (!(await next.count()) || !(await next.isEnabled())) break;
    await next.click();
  }
  return null;
}

/** 새 접수(걸어 온 손님): 대표자 화면 키보드 → 연락처 숫자판 → 첫 품목 → 일정 → 접수 확정 창. 창의 주 버튼 앞까지. */
async function newWalkIn(page) {
  await page.goto(page.url().replace(/#.*$/, '') + '#/orders/new');
  await page.waitForSelector('.pos-new', { timeout: STEP_MS });
  await page.locator('.pos-new-field.is-name').click();
  const kb = page.locator('.sn-kb');
  await kb.waitFor({ timeout: STEP_MS });
  const noEditable = await page.evaluate(() => !document.querySelector('.sn-kb input, .sn-kb textarea, .sn-kb [contenteditable="true"]'));
  for (const key of TEAM.keys) await kb.getByRole('button', { name: key, exact: true }).click();
  const typed = await page.locator('.sn-kb-display').getAttribute('data-value');
  await shot(page, 'a-keyboard-name-1024x600');
  await kb.locator('[data-primary="true"]').click();
  await kb.waitFor({ state: 'detached', timeout: STEP_MS });
  const nameField = await page.locator('.pos-new-field.is-name').getAttribute('aria-label');
  await page.locator('.pos-new-field.is-phone').click();
  const pad = page.locator('.sn-sheet-overlay .sn-numpad');
  await pad.waitFor({ timeout: STEP_MS });
  for (const d of TEAM.phone) await pad.getByRole('button', { name: d, exact: true }).click();
  await pad.getByRole('button', { name: '입력', exact: true }).click();
  // 첫 종류 타일 → (규격이 있으면 첫 규격) → 수량 +1. 판은 서버의 초안(orderDraft)을 받아 다시 그리므로 버튼이 뜰 때까지 기다린다.
  await page.locator('.pos-new-kinds .sn-kind').first().click();
  const open = page.locator('.pos-new-open');
  const plus = open.getByRole('button', { name: '수량 증가' });
  const size = open.locator('.sn-choice[aria-pressed="false"]:enabled').filter({ hasNotText: '더 보기' });
  await Promise.race([plus.waitFor({ timeout: STEP_MS }), size.first().waitFor({ timeout: STEP_MS })]);
  if (!(await plus.count()) && await size.count()) await size.first().click();
  await plus.waitFor({ timeout: STEP_MS });
  await plus.click();
  await page.waitForSelector('.pos-new-side [data-primary="true"]:enabled', { timeout: STEP_MS });
  await page.locator('.pos-new-side [data-primary="true"]').click();
  await page.waitForSelector('.pos-new-schedule', { timeout: STEP_MS });
  await page.waitForSelector('.pos-new-side [data-primary="true"]:enabled', { timeout: STEP_MS });
  await page.locator('.pos-new-side [data-primary="true"]').click();
  const dialog = page.locator('.pos-checkout');
  await dialog.waitFor({ timeout: STEP_MS });
  const cash = dialog.getByRole('group', { name: '장비 결제 수단', exact: true }).getByRole('button', { name: '현금', exact: true });
  await cash.waitFor({ timeout: STEP_MS });
  await cash.click();
  await dialog.locator('[data-primary="true"]:enabled').waitFor({ timeout: STEP_MS }).catch(() => {});
  return { typed, nameField, noEditable, dialog };
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('빌드한 앱이 없습니다(' + DIST + '). 먼저 npm run build');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'sn-e2e-'));
  const [serverPort, proxyPort] = [await freePort(), await freePort()];
  const secrets = newSecretsEnv();
  const env = {
    ...process.env,
    SKINOTE_DATA_DIR: join(tmp, 'data'),
    SKINOTE_SHOP_IDS: SHOP,
    SKINOTE_PORT: String(serverPort),
    SKINOTE_HOST: '127.0.0.1',
    SKINOTE_RELEASE: 'e2e',
    SKINOTE_BACKUP_RESERVE_MB: '0',
    SKINOTE_ADMIN_SOCKET: join(tmp, 'a.sock'),
    SKINOTE_API: 'on',
    ...secrets,
  };
  delete env.SKINOTE_PUBLIC_ORIGIN;
  const serverLog = join(OUT, 'server.log');
  const cliLog = join(OUT, 'cli.log');
  const proxyLines = [];
  /** 기록에 나오면 안 되는 비밀(비밀번호 · 등록 번호). */
  const secretsSeen = [];
  let server = null;
  let proxy = null;
  let demoProxy = null;
  let browser = null;
  let serverRuns = 0;
  const startServer = async () => {
    serverRuns += 1;
    const child = startChild([SERVER_MAIN], env, serverLog.replace(/\.log$/, '-' + serverRuns + '.log'));
    await waitHealthy(serverPort, child);
    return child;
  };
  try {
    // ── 준비: 마이그레이션 → 매장 · 직원 · 등록 번호 ──────────────────────
    server = await startServer();
    await stopChild(server);
    server = null;
    const made = await runCli(['provision', '--shop', SHOP, '--code', 'e2e-shop', '--name', '시험 매장', '--sample', '--test',
      '--staff', STAFF.manager + ':manager', '--staff', STAFF.counter + ':counter', '--staff', STAFF.driver + ':driver:v1'], env, cliLog);
    const pins = Object.fromEntries(made.out.trim().split('\n').slice(1).map((line) => line.split('\t')).map(([name, , pin]) => [name, pin]));
    if (!check('명령줄 provision: 직원 셋의 비밀번호를 한 번 찍음', made.code === 0 && Object.keys(pins).length === 3 && Object.values(pins).every((p) => /^\d{4}$/.test(p)),
      '끝 코드 ' + made.code + ' · ' + made.err.trim().split('\n').pop())) throw new Error('매장을 만들지 못함');
    secretsSeen.push(...Object.values(pins));
    const codeOf = async (kind, label, vehicle) => {
      const r = await runCli(['device-code', '--shop', SHOP, '--kind', kind, '--label', label, ...(vehicle ? ['--vehicle', vehicle] : [])], env, cliLog);
      const m = /등록 번호\t(\d{4}-\d{4}-\d{4})/.exec(r.out);
      if (r.code !== 0 || !m) throw new Error('등록 번호를 받지 못함: ' + r.err);
      const digits = m[1].replace(/-/g, '');
      secretsSeen.push(digits, m[1]);
      return digits;
    };
    const codes = {
      a: await codeOf('pos', '카운터 1'), b: await codeOf('pos', '카운터 2'), c: await codeOf('driver_tablet', '1호 차량 태블릿', 'v1'), d: await codeOf('pos', '카운터 3'),
      e: await codeOf('driver_phone', '1호 차량 기사 휴대폰', 'v1'),
    };
    check('명령줄 device-code: 등록 번호 다섯(포스 셋 · 기사 태블릿 · 기사 휴대폰)', Object.values(codes).every((c) => /^\d{12}$/.test(c)));
    // 견본 하루(시험 매장): 기사 휴대폰(첫 매장 기사의 주 기기, 2026-09-26 답 12)이 오늘 배달 · 수거 업무를 본다.
    const sample = await runCli(['load-sample', '--shop', SHOP, '--date', 'today'], env, cliLog);
    check('명령줄 load-sample: 오늘 견본 하루(첫 매장 모양)', sample.code === 0 && /접수\t18팀/.test(sample.out), '끝 코드 ' + sample.code + ' · ' + sample.err.trim().split('\n').pop());

    server = await startServer();
    proxy = await startLocalProxy({ port: proxyPort, serverPort, log: (line) => proxyLines.push(line) });
    const APP = proxy.url;
    browser = await chromium.launch({ headless: process.env.SKINOTE_E2E_HEADED !== '1' });
    const newContext = (size = { width: 1024, height: 600 }) => browser.newContext({ viewport: size, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const pageErrors = [];
    const watch = (page, who) => {
      page.on('pageerror', (e) => pageErrors.push(who + ': ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(who + ' console: ' + m.text().slice(0, 200)); });
    };

    // ── A: 카운터 1 ─────────────────────────────────────────────────────
    const ctxA = await newContext();
    const a = await ctxA.newPage();
    watch(a, 'A');
    await a.goto(APP);
    await a.waitForSelector('.pos-enroll', { timeout: STEP_MS });
    check('A: 서버 표시가 있는 앱 뼈대 → 체험판이 아니라 기기 등록 화면', (await a.locator('.pos-enroll h1').textContent())?.trim() === '기기 등록');
    await shot(a, 'a-enroll-1024x600');
    const shownCode = await enroll(a, codes.a);
    check('A: 등록 번호는 넷씩 끊어 보이고 등록되면 로그인 화면', shownCode === codes.a.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3'), shownCode ?? '');
    const tiles = await a.locator('.pos-login-tile').allTextContents();
    check('A: 로그인 화면에 직원 타일 셋', [STAFF.manager, STAFF.counter, STAFF.driver].every((n) => tiles.some((t) => t.includes(n))), tiles.join(', '));
    await shot(a, 'a-login-1024x600');
    const loggedA = await login(a, STAFF.counter, pins[STAFF.counter]);
    check('A: 비밀번호는 숫자 없이 가려 보인다', /^●( ●){3}$/.test(loggedA.masked), loggedA.masked);
    await a.waitForSelector('.sn-header', { timeout: STEP_MS });
    check('A: 로그인하면 카운터의 첫 화면(오늘 장부)', /#\/ledger/.test(a.url()), a.url().replace(APP, '/'));
    await shot(a, 'a-ledger-1024x600');
    const idbKept = await a.evaluate(() => new Promise((resolve) => {
      const request = indexedDB.open('skinote-device');
      request.onsuccess = () => {
        const tx = request.result.transaction('device', 'readonly');
        const get = tx.objectStore('device').get('current');
        get.onsuccess = () => resolve({ id: typeof get.result?.deviceId === 'string', extractable: get.result?.keyPair?.privateKey?.extractable });
        get.onerror = () => resolve(null);
      };
      request.onerror = () => resolve(null);
    }));
    check('A: 기기 열쇠는 IndexedDB에 있고 비밀 열쇠는 꺼낼 수 없다', idbKept?.id === true && idbKept?.extractable === false, JSON.stringify(idbKept));

    // ── A: 새 접수(화면 키보드) ─────────────────────────────────────────
    const walk = await newWalkIn(a);
    check('A: 대표자 칸은 편집 칸 없는 화면 키보드', walk.noEditable);
    check('A: 화면 키보드 키 ㄱ ㅣ ㅁ ㅁ ㅣ ㄴ ㅅ ㅜ → ' + TEAM.name, walk.typed === TEAM.name, String(walk.typed));
    check('A: 입력하면 대표자 칸에 이름', walk.nameField === '대표자 ' + TEAM.name + ' · 이름 입력', String(walk.nameField));
    await shot(a, 'a-checkout-1024x600');
    const confirm = walk.dialog.locator('[data-primary="true"]');
    const confirmEnabled = await confirm.isEnabled();
    check('A: 접수 확정 창의 주 버튼(현금)을 누를 수 있다', confirmEnabled, (await confirm.textContent())?.trim() ?? '');
    let orderSaved = false;
    if (confirmEnabled) {
      await confirm.click();
      // 된 것: 새 접수증 주소(#/orders/<id>)로 간다. 서버가 거절하면 창에 한 줄이 남는다. (새 접수 화면의 오른쪽 판도 접수증 모양이라
      // .sn-slip으로는 가르지 않는다.)
      const outcome = await Promise.race([
        a.waitForFunction(() => /^#\/orders\/(?!new\b)[^/?]+$/.test(location.hash), null, { timeout: STEP_MS }).then(() => 'slip'),
        walk.dialog.getByText(UNSUPPORTED_LINE).waitFor({ timeout: STEP_MS }).then(() => 'unsupported'),
      ]).catch(() => 'none');
      if (outcome === 'slip') await a.waitForSelector('.sn-slip', { timeout: STEP_MS }).catch(() => {});
      await shot(a, 'a-after-confirm-1024x600');
      if (outcome === 'slip') {
        orderSaved = check('A: 접수 확정 → 서버가 적은 새 접수증', (await a.locator('.sn-slip').textContent())?.includes(TEAM.name));
      } else if (outcome === 'unsupported') {
        check('A: 접수 확정 명령이 서버까지 가서 업무 결과로 돌아옴(거절 한 줄)', true, UNSUPPORTED_LINE);
        blocked('A: 접수 확정 → 새 접수증', '서버 저장소가 아직 접수를 표에 적지 못해 `' + UNSUPPORTED_LINE + '`로 거절함(계획 C3a ~ C3e)');
      } else {
        check('A: 접수 확정 뒤 접수증 또는 거절 한 줄', false, '둘 다 없음');
      }
    }
    if (orderSaved) {
      // 지급 도장: 접수증 오른쪽 판의 주 버튼(다음 처리) → 확인 창의 주 버튼.
      const next = a.locator('.pos-side [data-primary="true"]');
      await next.click();
      await a.locator('[role="dialog"] [data-primary="true"]').last().click();
      await a.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: STEP_MS }).catch(() => {});
      await sleep(500);
      const slipText = (await a.locator('.sn-slip').textContent()) ?? '';
      check('A: 지급 처리 → 접수증에 지급 완료', /지급 완료/.test(slipText) || (await a.locator('[aria-label*="지급 완료"]').count()) > 0);
      await a.reload();
      await a.waitForSelector('.sn-slip', { timeout: STEP_MS });
      const again = (await a.locator('.sn-slip').textContent()) ?? '';
      check('A: 새로 고쳐도 서버 장부의 팀 · 지급 도장이 그대로', again.includes(TEAM.name) && ((await a.locator('[aria-label*="지급 완료"]').count()) > 0 || /지급 완료/.test(again)));
    } else {
      blocked('A: 지급 도장 → 새로 고침에도 그대로', '접수를 서버에 적지 못해 이어 할 수 없음');
      await a.keyboard.press('Escape').catch(() => {});
      await a.goto(APP + '#/ledger');
    }

    // ── B: 카운터 2(관리자) ──────────────────────────────────────────────
    const ctxB = await newContext();
    const b = await ctxB.newPage();
    watch(b, 'B');
    await b.goto(APP);
    await enroll(b, codes.b);
    await login(b, STAFF.manager, pins[STAFF.manager]);
    await b.waitForSelector('.sn-header', { timeout: STEP_MS });
    check('B: 다른 기기 · 관리자 로그인 → 장부', /#\/ledger/.test(b.url()));
    if (orderSaved) {
      // 장부에는 견본 하루 18팀도 있어 A의 팀이 다른 쪽일 수 있다: B 세션으로 장부를 물어 A의 팀(끝 4자리)이 있는지 본다.
      await b.waitForSelector('.sn-ledger tr.sn-row', { timeout: STEP_MS });
      const ledgerB = await pageQuery(b, { name: 'ledgerView', params: { viewKey: 'day_ledger' } });
      const last4 = TEAM.phone.slice(-4);
      const listed = (ledgerB.body?.rows ?? []).some((row) => Object.values(row.cells ?? {}).some((cell) => cell?.renderer === 'team' && cell.last4 === last4 && cell.name === TEAM.name));
      check('B: A가 적은 팀이 B의 장부에 있음(한 장부)', ledgerB.status === 200 && listed, String(ledgerB.status));
    } else {
      blocked('B: A가 적은 팀이 B의 장부에 있음', '접수를 서버에 적지 못함');
    }

    // 알림 연결: A와 B가 같은 운영 규칙 화면을 보고, B가 저장하면 A가 새로 고침 없이 바뀐다.
    const settingsUrl = APP + '#/manage/settings/rules';
    await a.goto(settingsUrl);
    await b.goto(settingsUrl);
    await a.waitForSelector('.sn-rule-card', { timeout: STEP_MS });
    await b.waitForSelector('.sn-rule-card', { timeout: STEP_MS });
    const card = '당일 취소 환불';
    const choiceA = await ruleButton(a, card, '환불 없음');
    const pressedBefore = choiceA ? await choiceA.getAttribute('aria-pressed') : null;
    const loadsA = { n: 0 };
    a.on('framenavigated', (frame) => { if (frame === a.mainFrame()) loadsA.n += 1; });
    const choiceB = await ruleButton(b, card, '환불 없음');
    if (choiceB && pressedBefore === 'false') {
      await choiceB.click();
      await b.locator('.sn-footer [data-primary="true"]').click();
      await b.locator('[role="dialog"] [data-primary="true"]').last().click();
      await b.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: STEP_MS });
      await shot(b, 'b-rules-saved-1024x600');
      const started = Date.now();
      const changed = await a.waitForFunction((title) => {
        const btn = [...document.querySelectorAll('.sn-rule-card[aria-label="' + title + '"] button')].find((el) => el.textContent?.trim() === '환불 없음');
        return btn?.getAttribute('aria-pressed') === 'true';
      }, card, { timeout: 5_000 }).then(() => true, () => false);
      check('A: B가 저장한 운영 규칙이 새로 고침 없이 5초 안에 보임(알림 연결)', changed && loadsA.n === 0, (Date.now() - started) + 'ms · 새로 고침 ' + loadsA.n + '번');
      await shot(a, 'a-rules-live-1024x600');
      await a.reload();
      await a.waitForSelector('.sn-rule-card', { timeout: STEP_MS });
      const kept = await (await ruleButton(a, card, '환불 없음'))?.getAttribute('aria-pressed');
      check('A: 새로 고쳐도 서버 장부의 운영 규칙 · 로그인이 그대로', kept === 'true' && !(await a.locator('.pos-login').count()));
      const refusedA = await pageQuery(a, { name: 'shopRules', params: {} });
      check('A: 카운터 세션도 운영 규칙을 읽는다(쓰기만 관리자)', refusedA.status === 200, String(refusedA.status));
    } else {
      check('운영 규칙 화면에 `' + card + '` · `환불 없음`(처음 값 환불)', false, String(pressedBefore));
    }

    // 연결 상태: A의 네트워크를 끊으면 머리줄에 노랑 이름표(연결 띠와 같은 색) `연결 끊김 · 마지막 연결 …`, 다시 이으면 사라진다.
    await ctxA.setOffline(true);
    const offTag = await a.waitForSelector('.sn-header-offline', { timeout: 20_000 }).then(() => true, () => false);
    const offText = offTag ? ((await a.locator('.sn-header-offline').getAttribute('aria-label')) ?? '') : '';
    await shot(a, 'a-offline-header-1024x600');
    check('A: 끊기면 머리줄에 `연결 끊김 · 마지막 연결` 이름표(빨강 없음)', offTag && /^연결 끊김 · 마지막 연결 \d{2}:\d{2}$/.test(offText), offText);
    const tagColor = await a.evaluate(() => {
      const tag = document.querySelector('.sn-header-offline .sn-fit');
      const probe = document.createElement('span');
      probe.style.background = 'var(--sn-strip)';
      (document.querySelector('.sn-root') ?? document.body).append(probe);
      const strip = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { tag: tag ? getComputedStyle(tag).backgroundColor : '', strip };
    });
    check('A: 이름표 바탕은 기사 연결 띠와 같은 노랑(회색 아님)', !!tagColor.tag && tagColor.tag === tagColor.strip, JSON.stringify(tagColor));
    // 좁은 포스(875×600)에서도 `연결 끊김`은 잘리지 않고 16px 이상.
    await a.setViewportSize({ width: 875, height: 600 });
    await sleep(300);
    const narrowTag = await a.evaluate(() => {
      const fit = document.querySelector('.sn-header-offline .sn-fit');
      if (!fit) return null;
      const size = parseFloat(getComputedStyle(fit).fontSize);
      return { text: fit.textContent?.trim() ?? '', fits: fit.getAttribute('data-fits') !== 'false', size, overflow: fit.scrollWidth > fit.clientWidth + 1 };
    });
    await shot(a, 'a-offline-header-875x600');
    check('A: 875×600에서도 이름표 `연결 끊김`이 잘리지 않음(16px 이상)', !!narrowTag && /^연결 끊김/.test(narrowTag.text) && narrowTag.fits && !narrowTag.overflow && narrowTag.size >= 16, JSON.stringify(narrowTag));
    await a.setViewportSize({ width: 1024, height: 600 });
    await ctxA.setOffline(false);
    const backOn = await a.waitForSelector('.sn-header-offline', { state: 'detached', timeout: 20_000 }).then(() => true, () => false);
    check('A: 다시 이으면 이름표가 사라진다(머리 묻기)', backOn);

    // ── C: 기사 태블릿 ──────────────────────────────────────────────────
    const ctxC = await newContext();
    const c = await ctxC.newPage();
    watch(c, 'C');
    await c.goto(APP);
    await enroll(c, codes.c);
    const driverTiles = await c.locator('.pos-login-tile').allTextContents();
    check('C: 기사 기기의 타일은 기사가 먼저', driverTiles[0]?.includes(STAFF.driver), driverTiles.join(', '));
    await login(c, STAFF.driver, pins[STAFF.driver]);
    await c.waitForFunction(() => /#\/driver\/\d{4}-\d{2}-\d{2}/.test(location.hash), null, { timeout: STEP_MS });
    await c.waitForSelector('.sn-header', { timeout: STEP_MS });
    check('C: 기사 로그인 → 그 영업일의 수거 목록', true, c.url().replace(APP, '/'));
    await c.waitForSelector('.sn-footer', { timeout: STEP_MS });
    await shot(c, 'c-driver-1024x600');
    const footerC = ((await c.locator('.sn-footer').textContent()) ?? '').trim();
    check('C: 서버에 붙은 기사 기기의 바닥줄에 `전송 대기`가 없음(보냄 대기가 없다)', footerC !== '' && !footerC.includes('전송 대기'), footerC.slice(0, 80));
    await ctxC.setOffline(true);
    const strip = await c.waitForSelector('.sn-strip.is-offline', { timeout: 30_000 }).then(() => true, () => false);
    const stripText = strip ? ((await c.locator('.sn-strip').textContent()) ?? '').trim() : '';
    await shot(c, 'c-offline-strip-1024x600');
    check('C: 끊기면 기사 화면에 연결 띠 `연결 끊김 · 마지막 연결`', strip && /^연결 끊김/.test(stripText), stripText);
    await ctxC.setOffline(false);
    check('C: 다시 이으면 연결 띠가 사라진다', await c.waitForSelector('.sn-strip', { state: 'detached', timeout: 30_000 }).then(() => true, () => false));
    const ledgerC = await pageQuery(c, { name: 'ledgerView', params: { viewKey: 'day_ledger' } });
    check('C: 기사 세션의 장부 조회는 403', ledgerC.status === 403, String(ledgerC.status));
    await c.goto(APP + '#/ledger');
    await sleep(300);
    check('C: 기사 기기에서 장부 주소를 열면 수거 목록으로', /#\/driver\//.test(c.url()), c.url().replace(APP, '/'));

    // ── E: 기사 휴대폰(1호 차량, 360×640 — 첫 매장 기사의 주 기기는 개인 휴대폰, 2026-09-26 답 12) ─────────────
    const ctxE = await newContext({ width: 360, height: 640 });
    const e = await ctxE.newPage();
    watch(e, 'E');
    await e.goto(APP);
    await enroll(e, codes.e);
    const phoneTiles = await e.locator('.pos-login-tile').allTextContents();
    check('E: 기사 휴대폰 등록 → 로그인 타일은 기사가 먼저', phoneTiles[0]?.includes(STAFF.driver), phoneTiles.join(', '));
    await shot(e, 'e-login-360x640');
    await login(e, STAFF.driver, pins[STAFF.driver]);
    await e.waitForFunction(() => /#\/driver\/\d{4}-\d{2}-\d{2}/.test(location.hash), null, { timeout: STEP_MS });
    await e.waitForSelector('.sn-ledger tr.sn-row', { timeout: STEP_MS });
    const phoneClass = await e.evaluate(() => document.querySelector('.sn-root')?.getAttribute('data-device'));
    check('E: 비밀번호 로그인 → 360×640 기사 휴대폰 등급의 수거 목록', phoneClass === 'driver_phone', String(phoneClass));
    await shot(e, 'e-collections-360x640');
    const phoneDate = /#\/driver\/(\d{4}-\d{2}-\d{2})/.exec(e.url())?.[1] ?? '';
    await e.goto(APP + '#/driver/' + phoneDate + '/deliveries');
    await e.waitForSelector('.sn-ledger tr.sn-row', { timeout: STEP_MS });
    const deliveryRows = await e.locator('.sn-ledger tr.sn-row').count();
    check('E: 배달 목록은 촘촘한 줄(카드 아님) · 쪽 넘김', deliveryRows > 0 && !(await e.locator('.sn-card').count()), '줄 ' + deliveryRows);
    await shot(e, 'e-deliveries-360x640');
    await e.locator('.sn-ledger tr.sn-row .sn-cell-open').first().click();
    await e.waitForSelector('.pos-task-sheet', { timeout: STEP_MS });
    const taskId = decodeURIComponent(/#\/driver\/tasks\/([^?]+)/.exec(e.url())?.[1] ?? '');
    const itemRows = await e.locator('.pos-task-items tr.sn-row').count();
    check('E: 업무 판(360×640)에 품목 줄이 모두 한 쪽(쪽 넘김 없음)', itemRows >= 2 && !(await e.locator('.pos-task-pager').count()), taskId + ' · 줄 ' + itemRows);
    await shot(e, 'e-task-360x640');
    const fieldPay = await pageQuery(e, { name: 'fieldPaySheet', params: { taskId } });
    const methods = (fieldPay.body?.result?.methods ?? fieldPay.body?.methods ?? []).map((m) => m.label);
    check('E: 현장 수납 수단은 현금 · 계좌이체뿐(카드 단말기는 카운터 1대)', fieldPay.status === 200 && methods.join(',') === '현금,계좌이체', fieldPay.status + ' · ' + methods.join(','));
    const ledgerE = await pageQuery(e, { name: 'ledgerView', params: { viewKey: 'day_ledger' } });
    check('E: 기사 휴대폰 세션의 장부 조회는 403', ledgerE.status === 403, String(ledgerE.status));

    // ── D: 비밀번호 잠김 ─────────────────────────────────────────────────
    const ctxD = await newContext();
    const d = await ctxD.newPage();
    watch(d, 'D');
    await d.goto(APP);
    await enroll(d, codes.d);
    const real = pins[STAFF.manager];
    const wrong = [...real].map((x) => String((Number(x) + 1) % 10)).join('');
    let last = null;
    for (let i = 0; i < 5; i += 1) last = await login(d, STAFF.manager, wrong, { expectApp: false });
    await shot(d, 'd-locked-1024x600');
    check('D: 다섯 번 틀리면 `로그인 잠김 · 시각 이후 가능`', /^로그인 잠김 · \d{2}:\d{2} 이후 가능$/.test(last?.note ?? ''), last?.note ?? '');
    // 잠긴 동안: 맞는 비밀번호를 쳐도 잠김 한 줄(풀리는 시각)이 남고 `입력`이 눌리지 않는다(서버의 잠김은 서버 시험이 본다).
    const lockPad = d.locator('.sn-sheet-overlay .sn-numpad');
    for (const x of real) await lockPad.getByRole('button', { name: x, exact: true }).click();
    const lockNote = (await lockPad.locator('.sn-keypad-note').textContent())?.trim() ?? '';
    const enterOff = await lockPad.getByRole('button', { name: '입력', exact: true }).isDisabled();
    check('D: 잠긴 동안에는 숫자를 쳐도 잠김 한 줄이 남고 입력이 눌리지 않음', /^로그인 잠김 · \d{2}:\d{2} 이후 가능$/.test(lockNote) && enterOff, lockNote);
    await b.reload();
    await b.waitForSelector('.sn-rule-card', { timeout: STEP_MS });
    check('B: 다른 기기의 잠김과 관계없이 그대로 로그인', !(await b.locator('.pos-login').count()));

    // ── 화면 키보드: 875×600(A의 새 접수) · 360×640(체험판 앞단의 미리 보기) ─────────
    await a.setViewportSize({ width: 875, height: 600 });
    await a.goto(APP + '#/orders/new');
    await a.waitForSelector('.pos-new', { timeout: STEP_MS });
    await a.locator('.pos-new-field.is-name').click();
    await a.waitForSelector('.sn-kb', { timeout: STEP_MS });
    await shot(a, 'a-keyboard-875x600');
    const kbBox = await a.locator('.sn-kb').boundingBox();
    check('A: 875×600에서 화면 키보드가 화면 안', !!kbBox && kbBox.y >= 0 && kbBox.y + kbBox.height <= 600.5 && kbBox.x + kbBox.width <= 875.5, JSON.stringify(kbBox));
    await a.keyboard.press('Escape');
    await a.setViewportSize({ width: 1024, height: 600 });
    const ctxP = await newContext({ width: 360, height: 640 });
    const p = await ctxP.newPage();
    watch(p, 'P');
    // 우리 주소(표시가 있는 앱 뼈대)의 ?demo는 무시한다: 체험 자료에 접수를 적는 일이 없게 서버 모드(새 기기면 기기 등록) 그대로.
    await p.goto(APP + '?demo#/preview/keyboard?device=phone');
    const stayed = await p.waitForSelector('.pos-enroll', { timeout: STEP_MS }).then(() => true, () => false);
    check('?demo: 우리 서버 주소에서는 체험판으로 가지 않고 서버 모드(기기 등록)', stayed && !(await p.locator('.sn-kb').count()));
    // 휴대폰 키보드 모양은 표시를 찍지 않는 둘째 앞단(GitHub Pages처럼 체험판)으로 같은 빌드를 본다.
    demoProxy = await startLocalProxy({ port: await freePort(), serverPort, stamp: false });
    await p.goto(demoProxy.url + '#/preview/keyboard?device=phone');
    await p.waitForSelector('.sn-kb', { timeout: STEP_MS });
    await shot(p, 'p-keyboard-360x640');
    const phoneKb = await p.evaluate(() => ({
      layout: document.querySelector('.sn-kb')?.getAttribute('data-layout'),
      closeInKeys: [...document.querySelectorAll('.sn-kb-keys button')].some((b) => b.textContent === '닫기'),
      shift: [...document.querySelectorAll('.sn-kb-keys button')].some((b) => b.textContent === '쌍자음'),
    }));
    check('표시 없는 앞단(체험판): 360×640 화면 키보드는 자모 격자, 닫기는 키 줄 밖, 쌍자음 키는 글자', phoneKb.layout === 'grid' && !phoneKb.closeInKeys && phoneKb.shift, JSON.stringify(phoneKb));
    await ctxP.close();

    // ── A 로그아웃 ───────────────────────────────────────────────────────
    await a.goto(APP + '#/exit');
    await a.waitForSelector('.pos-card', { timeout: STEP_MS });
    await shot(a, 'a-exit-1024x600');
    await a.getByRole('button', { name: '로그아웃', exact: true }).click();
    await a.locator('[role="dialog"] [data-primary="true"]').click();
    await a.waitForSelector('.pos-login', { timeout: STEP_MS });
    const headA = await a.evaluate(() => fetch('api/v2/head', { cache: 'no-store' }).then((r) => r.status));
    check('A: 로그아웃 → 로그인 화면, 머리 조회는 401', headA === 401, String(headA));
    // 다시 로그인하면 카운터의 첫 화면(로그아웃을 누른 나가기 화면으로 돌아가지 않는다).
    await login(a, STAFF.counter, pins[STAFF.counter]);
    await a.waitForSelector('.sn-header', { timeout: STEP_MS });
    await sleep(300);
    check('A: 로그아웃 뒤 다시 로그인하면 장부(나가기 화면이 아님)', /#\/ledger/.test(a.url()), a.url().replace(APP, '/'));

    // ── C 기기 끊기(서버가 도는 동안 명령줄 → 관리 소켓) ─────────────────────
    const revoke = await runCli(['revoke-device', '--shop', SHOP, '--device', '1호 차량 태블릿'], env, cliLog);
    check('명령줄 revoke-device(관리 소켓)', revoke.code === 0, revoke.out.trim());
    const toEnroll = await c.waitForSelector('.pos-enroll', { timeout: 20_000 }).then(() => true, () => false);
    await shot(c, 'c-revoked-1024x600');
    check('C: 끊은 기기는 곧 기기 등록 화면으로(열쇠를 지움)', toEnroll);
    // 기사가 그만두면(개인 휴대폰): 그 휴대폰 끊기 → 세션이 끝나 기기 등록 화면으로(deployment 10-5).
    const revokePhone = await runCli(['revoke-device', '--shop', SHOP, '--device', '1호 차량 기사 휴대폰'], env, cliLog);
    check('명령줄 revoke-device: 기사 휴대폰', revokePhone.code === 0, revokePhone.out.trim());
    const phoneOut = await e.waitForSelector('.pos-enroll', { timeout: 20_000 }).then(() => true, () => false);
    await shot(e, 'e-revoked-360x640');
    check('E: 끊은 기사 휴대폰은 곧 기기 등록 화면으로(세션 끝)', phoneOut);

    check('페이지 오류 없음', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
    for (const ctx of [ctxA, ctxB, ctxC, ctxD, ctxE]) await ctx.close();
  } catch (error) {
    check('끝까지 돌기', false, String(error?.stack ?? error).split('\n').slice(0, 4).join(' | '));
    // 실패한 때의 화면(열린 창마다).
    let n = 0;
    for (const ctx of browser?.contexts() ?? []) for (const page of ctx.pages()) await shot(page, 'fail-' + (n += 1));
  } finally {
    await browser?.close().catch(() => {});
    await proxy?.close().catch(() => {});
    await demoProxy?.close().catch(() => {});
    await stopChild(server);
    writeFileSync(join(OUT, 'proxy.log'), proxyLines.join('\n') + '\n');
    // 기록 확인: 처리 오류 · 처리하지 않은 예외 · 비밀번호 · 등록 번호.
    const logs = [1, 2, 3].map((n) => join(OUT, 'server-' + n + '.log')).filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n')
      + '\n' + (existsSync(cliLog) ? readFileSync(cliLog, 'utf8') : '') + '\n' + proxyLines.join('\n');
    const leaks = secretsSeen.filter((s) => s && logs.includes(s));
    check('서버 · 명령줄 · 앞단 기록에 처리 오류 · 예외가 없음', !/처리 오류|Unhandled|uncaught/i.test(logs), (/.*(처리 오류|Unhandled|uncaught).*/i.exec(logs) ?? [''])[0].slice(0, 200));
    check('기록에 비밀번호 · 등록 번호가 없음', leaks.length === 0, leaks.length + '개');
    if (process.env.SKINOTE_E2E_KEEP === '1') console.log('임시 자료 폴더: ' + tmp);
    else rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => r.state === 'fail');
  const held = results.filter((r) => r.state === 'blocked');
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ run: RUN, results }, null, 2));
  console.log('\n서버 끝까지 시험: 확인 ' + results.length + '개 · 실패 ' + failed.length + ' · 막힘 ' + held.length + ' · 기록 ' + OUT.replace(ROOT, ''));
  process.exitCode = failed.length ? 1 : held.length ? 3 : 0;
}

await main();
