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
//   매장 설정(settingsE2E, features-1 §4-6): B가 설천에 장소 추가 → A의 새 접수에 보임 → B가 차량 추가 + 박기사 배정(한 저장) → A의
//         수거 차량에 보임 → B가 박기사 비밀번호 재발급(본인 비밀번호 먼저) → E · C 로그아웃, 옛 비밀번호 틀림, 새 비밀번호로 다시 로그인 →
//         A(카운터)는 읽기만(항목 판 · 바닥줄 `권한 없음 · 관리자 확인 필요`) · registry.update FORBIDDEN → B가 그 차량 사용 종료 → 다시 사용
//   할인 적용(discountE2E, features-1 §6-6): A가 자기 팀(현금 결제 뒤)에 `직접 입력` 5,000원 · 사유 `단골` → `할인 적용 · 환불 현금 5,000원` →
//         접수증 출처 줄(할인 · 환불) → A가 미수 팀(윤서준)에 10% → 미수가 줄어듦 → B(관리자)가 카드로 낸 팀(김민재)에 직접 입력 5,000원 · 환불
//         현금 → 마감 결제 수단 표의 환불 줄
//   품목 추가 · 취소(orderEditE2E, features-1 §5-6): A가 자기 팀에 `품목 추가`(헬멧 · 현금) → 접수증 `품목 추가` 줄 → 그 헬멧을 `품목 취소` · 환불
//         현금 → 마감 `환불` 줄 → A가 최하은 팀(전화 예약)을 `연락 없음`으로 접수 취소(처음 결정 환불 없음 → 환불을 고름) → 장부 줄 `취소` · E의 배달 목록에서 빠짐
//   즉시 교환(exchangeE2E, features-1 §7-6): A가 김민재 팀(0021) 의류를 `즉시 교환` 창에서 다른 사이즈로 → 접수증 줄 이름 · 출처 줄 · 돈 그대로, E는 창 403
//   리프트권(ticketsE2E, features-1 §8-5): A가 리프트권 화면에서 `예비권 적재 · 1호 차량` 2매 → E의 차량 재고 +2매, A가 박준호 팀(0022)을 지급
//         (`지급 처리 · 6개 · 3매`) → 미반납 탭 `분실 처리`(0매로 열림) 1매 → 현황 미반납 2 · 분실 1, 그 팀의 수거 목록 줄은 야간권 2매 → 분실 탭 `분실 회수` → 분실 0
//   인쇄 · 전화(printCallE2E, features-1 §8-5): A의 수거 목록 `인쇄`(인쇄 창을 막아 둠) → 한 번 · 인쇄 문서에 가린 번호만, E(기사 휴대폰)의 `전화` →
//         주 버튼이 `tel:` 링크, A의 접수증 `전화` → 번호만(`tel:` 없음)
//   확인 필요(reviewE2E, features-1 §9-5): 견본 확인 필요 한 건이 A의 `확인 필요` 화면 · 머리줄 수에 있음 → `확인` → 수가 줄고 처리 완료 탭에
//         `확인 완료 · 시각 · 김카운터` → 서버를 다시 띄워도 그대로, E는 목록 403
//   D(카운터 3): 관리자 비밀번호를 다섯 번 틀림 → `로그인 잠김 · … 이후 가능`, B는 그대로 로그인
//   화면 키보드 875×600(A의 새 접수) 찍기 → 우리 주소의 ?demo는 서버 모드 그대로(기기 등록 화면) → 표시를 찍지 않는 둘째 앞단(체험판)의
//   360×640 미리 보기 키보드 → A 로그아웃(로그인 화면, 머리 401) → 다시 로그인하면 장부(나가기 화면이 아님) → 명령줄로 C 기기 끊기(관리
//   소켓) → C가 기기 등록 화면으로
//   열린 기기 등록(시험 매장, SKINOTE_TEST_OPEN_ENROLL=on인 둘째 서버 · 앞단, 등록 번호 없음): 첫 서버의 등록 방법은 번호(code) →
//   O(1024×600): 기기 선택(카운터(포스)가 먼저 · 주 버튼) → `카운터(포스)` → 로그인 타일 → 비밀번호 → 장부(`시험 기기 1`) →
//   Q(360×640): 기기 선택(휴대폰 등급: 기사 휴대폰이 먼저 · 주 버튼, 카운터(포스)는 맨 뒤) → 잘못 고른 `카운터(포스)` → 로그인 줄의
//   기기 모양 → `기기 선택`(등록을 끊고 돌아감) → `기사 휴대폰` → 차량 선택 `1호 차량` · `2호 차량` → `1호 차량` → 로그인 줄 `기사 휴대폰 ·
//   1호 차량` → 기사 타일 → 비밀번호 → 수거 목록(휴대폰 등급, 1호 차량, `시험 기기 3`) → 서버 안의 상태에 TEST_OPEN_ENROLL 경고 · 열린
//   기기 2대 → 명령줄로 Q 기기 끊기 → Q는 다시 기기 선택으로 → 설정을 끄고 다시 켠 서버: O는 끊겨 기기 등록(등록 번호)으로, 기기 선택에
//   있던 Q는 숫자판과 한 줄 `기기 선택 종료 · 등록 번호 필요`로
//   → 서버 · 앞단을 멈추고 기록에 처리 오류 · 비밀번호 · 등록 번호가 없는지, 열린 등록마다 경보 줄이 있는지
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
import { businessDate } from '../packages/server/src/clock.js';
import { addDays } from '../packages/server/src/config.js';
import { newSecretsEnv } from '../packages/server/src/secrets.js';
import { startLocalProxy } from './lib/local-proxy.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'apps/pos/dist');
const SERVER_MAIN = join(ROOT, 'packages/server/src/main.js');
const SHOP_CLI = join(ROOT, 'packages/server/bin/shop.js');
const SHOP = 'e2e0shop';
/** 열린 기기 등록을 켠 둘째 서버의 시험 매장. */
const OPEN_SHOP = 'e2e1open';
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

/** 매장 설정 목록 칸(쪽을 넘겨 찾는다). label은 칸의 이름, 또는 칸을 고르는 함수. */
async function settingsCellE2E(page, label) {
  const target = typeof label === 'function' ? () => label(page)
    : () => page.locator('.sn-rule-item').filter({ has: page.locator('.sn-rule-item-label', { hasText: new RegExp('^' + label + '$') }) });
  for (let guard = 0; guard < 6; guard += 1) {
    if (await target().count()) return target().first();
    const next = page.locator('.sn-footer').getByRole('button', { name: '다음 쪽' });
    if (!(await next.count()) || !(await next.isEnabled())) break;
    await next.click();
  }
  throw new Error('매장 설정 목록에 칸이 없음: ' + (typeof label === 'function' ? '(고르는 함수)' : label));
}

/** 항목 판의 버튼(첫 줄 글이 label). */
const sheetChoiceE2E = (page, label) => page.locator('[role="dialog"] .pos-choice-button').filter({ has: page.locator('.pos-choice-text > .sn-fit:first-child', { hasText: new RegExp('^' + label + '$') }) }).last();

/** 매장 설정 저장: 바닥줄 주 버튼 → 저장 확인 창(쪽이 여럿이면 끝까지) → 주 버튼 → 창이 닫히고 바닥줄 `변경 없음`. */
async function saveSettingsE2E(page) {
  await page.locator('.sn-footer [data-primary="true"]:enabled').click();
  const dialog = page.locator('[role="dialog"]').last();
  await dialog.waitFor({ timeout: STEP_MS });
  const next = dialog.getByRole('button', { name: '다음 쪽' });
  for (let guard = 0; guard < 6 && await next.count() && await next.isEnabled(); guard += 1) await next.click();
  await dialog.locator('[data-primary="true"]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: STEP_MS });
  await page.waitForFunction(() => document.querySelector('.pos-footer-back')?.textContent?.includes('변경 없음'), null, { timeout: STEP_MS });
}

/**
 * 매장 설정(features-1 §4-6): B가 설천에 장소 `매표소`를 더하면 A의 새 접수 반납 장소에 나온다(새로 고침 없이) → B가 `3호 차량`을 더하며 박기사를
 * 그 차량에 배정(한 저장, 두 명령) → A의 일정 변경 창 수거 차량에 `3호 차량` → B가 박기사의 비밀번호 재발급(본인 비밀번호 먼저) → E(기사 휴대폰)는
 * 로그인이 끝나고 옛 비밀번호는 틀리고 새 비밀번호로 다시 로그인 → A(카운터)의 `요금 · 할인`은 `권한 없음 · 관리자 확인 필요` · 저장 막힘, A가 보낸
 * registry.update는 FORBIDDEN → B가 `3호 차량` 사용 종료 → 다시 사용. 끝에 B는 운영 규칙 탭(뒤 걸음이 그 화면을 새로 고친다).
 */
async function settingsE2E({ APP, a, b, c, e, pins, secretsSeen }) {
  // 장소 추가(B, 화면): 설천 카드의 `장소 추가` → 화면 키보드 `매표소` → 저장.
  await b.goto(APP + '#/manage/settings/places');
  await b.waitForSelector('.sn-rule-card', { timeout: STEP_MS });
  await (await settingsCellE2E(b, (pg) => pg.locator('.sn-rule-card[aria-label="설천"] .sn-rule-item.is-add'))).click();
  const kb = b.locator('.sn-kb');
  await kb.waitFor({ timeout: STEP_MS });
  for (const key of ['ㅁ', 'ㅐ', 'ㅍ', 'ㅛ', 'ㅅ', 'ㅗ']) await kb.getByRole('button', { name: key, exact: true }).click();
  await kb.locator('[data-primary="true"]').click();
  await b.waitForFunction(() => document.querySelector('.pos-footer-back')?.textContent?.includes('변경 1건'), null, { timeout: STEP_MS });
  await shot(b, 'b-settings-place-1024x600');
  await saveSettingsE2E(b);
  const draft = { channel: 'walk_in', leader: { name: '', phone: '', party: 0 }, items: [], pickup: { mode: 'store', immediate: true }, giveBack: { mode: 'store' } };
  const orderA = await pageQuery(a, { name: 'orderDraft', params: { draft } });
  const seolcheon = (orderA.body?.schedule?.areas ?? []).find((area) => area.label === '설천');
  check('설정: B가 더한 장소 `매표소`가 A의 새 접수 반납 장소(설천)에 있음', orderA.status === 200 && (seolcheon?.places ?? []).some((pl) => pl.label === '매표소'), String(orderA.status));

  // 차량 추가 + 박기사 배정(B, 화면): 한 저장이 목록 바꿈 · 직원 바꿈 두 명령.
  await b.goto(APP + '#/manage/settings/fleet');
  await b.waitForSelector('.sn-rule-card', { timeout: STEP_MS });
  await (await settingsCellE2E(b, '차량 추가')).click();
  await b.locator('.sn-kb').waitFor({ timeout: STEP_MS });
  const vehicleName = await b.locator('.sn-kb-display').getAttribute('data-value');
  await b.locator('.sn-kb [data-primary="true"]').click();
  await (await settingsCellE2E(b, STAFF.driver)).click();
  await sheetChoiceE2E(b, '차량').click();
  await sheetChoiceE2E(b, '3호 차량').click();
  await b.waitForFunction(() => document.querySelector('.pos-footer-back')?.textContent?.includes('변경 2건'), null, { timeout: STEP_MS });
  await shot(b, 'b-settings-fleet-1024x600');
  await saveSettingsE2E(b);
  const fleet = await pageQuery(b, { name: 'shopSettings', params: { tab: 'fleet' } });
  const items = fleet.body?.cards?.[0]?.list?.items ?? [];
  const driverItem = (fleet.body?.cards?.[1]?.list?.items ?? []).find((i) => i.label === STAFF.driver);
  check('설정: `차량 추가` 3호 차량(처음 이름) · 박기사 배정이 한 저장으로', vehicleName === '3호 차량' && items.some((i) => i.label === '3호 차량' && i.tag === '담당 ' + STAFF.driver) && driverItem?.tag === '기사 · 3호 차량',
    vehicleName + ' · ' + JSON.stringify(items.map((i) => i.label + '/' + (i.tag ?? ''))));
  const ledgerA = await pageQuery(a, { name: 'ledgerView', params: { viewKey: 'day_ledger' } });
  const orderId = (ledgerA.body?.rows ?? []).map((row) => row.orderId).find(Boolean);
  const sheet = orderId ? await pageQuery(a, { name: 'promiseSheet', params: { orderId, place: { mode: 'vehicle', placeKey: 'seolcheon_parking' } } }) : { status: 0 };
  check('설정: A의 일정 변경 창 수거 차량에 `3호 차량`', sheet.status === 200 && (sheet.body?.vehicles ?? []).some((v) => v.label === '3호 차량'), String(sheet.status) + ' ' + orderId);

  // 비밀번호 재발급(B, 화면): 본인 비밀번호 → 새 비밀번호 한 번 → E는 로그인이 끝나고 새 비밀번호로만 들어온다.
  await (await settingsCellE2E(b, STAFF.driver)).click();
  await sheetChoiceE2E(b, '비밀번호 재발급').click();
  const own = b.locator('.sn-sheet-overlay .sn-numpad');
  await own.waitFor({ timeout: STEP_MS });
  for (const d of pins[STAFF.manager]) await own.getByRole('button', { name: d, exact: true }).click();
  await own.getByRole('button', { name: '입력', exact: true }).click();
  // 새 비밀번호 창은 찍지 않는다(비밀번호가 그림에 남는다; 모양은 규칙 검사기가 #/preview/pin으로 본다).
  await b.waitForSelector('.pos-pin-digits', { timeout: STEP_MS });
  const newPin = ((await b.locator('.pos-pin-digits').textContent()) ?? '').replace(/\s/g, '');
  secretsSeen.push(newPin);
  await b.locator('[role="dialog"] [data-primary="true"]').click();
  check('설정: 비밀번호 재발급 → 새 비밀번호 4자리를 한 번 보임', /^\d{4}$/.test(newPin) && !(await b.locator('.pos-pin-digits').count()));
  await e.reload();
  const loggedOut = await e.waitForSelector('.pos-login', { timeout: STEP_MS }).then(() => true, () => false);
  const oldTry = loggedOut ? await login(e, STAFF.driver, pins[STAFF.driver], { expectApp: false }) : null;
  check('설정: 재발급 뒤 E의 로그인이 끝나고 옛 비밀번호는 틀림', loggedOut && oldTry?.note === '비밀번호 불일치 · 재입력 필요', String(oldTry?.note));
  await login(e, STAFF.driver, newPin);
  // 같은 기사로 로그인해 있던 C(1호 차량 태블릿)도 로그인이 끝났다: 새 비밀번호로 다시(뒤의 기기 끊기 걸음이 C를 쓴다).
  await c.reload();
  const cOut = await c.waitForSelector('.pos-login', { timeout: STEP_MS }).then(() => true, () => false);
  if (cOut) await login(c, STAFF.driver, newPin);
  check('설정: E · C가 새 비밀번호로 다시 로그인', !(await e.locator('.pos-login').count()) && cOut && !(await c.locator('.pos-login').count()));
  pins[STAFF.driver] = newPin;

  // 카운터 A: 권한 없음(화면: 처음부터 읽기만) · FORBIDDEN(명령). 2026-09-27 점검 뒤 권한 없는 사람의 항목 판은 `권한 없음 · 관리자 확인 필요` 한 줄과
  // 누를 수 없는 버튼뿐이라 숫자판이 열리지 않는다(초안이 생기지 않음).
  await a.goto(APP + '#/manage/settings/pricing');
  await a.waitForSelector('.sn-rule-card', { timeout: STEP_MS });
  await (await settingsCellE2E(a, '스키')).click();
  const sheetA = a.locator('[role="dialog"]').last();
  await sheetA.waitFor({ timeout: STEP_MS });
  const sheetLine = await sheetA.getByText('권한 없음 · 관리자 확인 필요', { exact: true }).count();
  const padOpened = await a.locator('.sn-numpad').count();
  const sheetEnabled = await sheetA.locator('.pos-choice-button:enabled').count();
  await shot(a, 'a-settings-forbidden-1024x600');
  await sheetA.getByRole('button', { name: '닫기', exact: true }).click();
  await sheetA.waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  const footerA = ((await a.locator('.pos-footer-back').textContent()) ?? '').trim();
  const saveOff = await a.locator('.sn-footer [data-primary="true"]').isDisabled();
  check('설정: 카운터의 `요금 · 할인`은 읽기만(항목 판에 `권한 없음 · 관리자 확인 필요`, 숫자판 없음) · 바닥줄 같은 한 줄 · 저장 막힘',
    sheetLine > 0 && padOpened === 0 && sheetEnabled === 0 && footerA.includes('권한 없음 · 관리자 확인 필요') && saveOff,
    JSON.stringify({ sheetLine, padOpened, sheetEnabled, footerA, saveOff }));
  const forbidden = await a.evaluate(async () => {
    const session = await (await fetch('api/v2/session', { cache: 'no-store' })).json();
    const head = await (await fetch('api/v2/head', { cache: 'no-store' })).json();
    const t = Date.now().toString(32).toUpperCase().padStart(10, '0').slice(-10);
    const requestId = (t + 'ABCDEFGHJKMNPQRS').replace(/[ILOU]/g, 'X').slice(0, 26);
    const res = await fetch('api/v2/command', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-skinote-csrf': session.csrf },
      body: JSON.stringify({ type: 'registry.update', commandVersion: 1, requestId, basis: { epoch: head.epoch, rev: head.rev }, payload: { changes: [{ op: 'price.set', productKey: 'ski', amount: 45000 }] } }),
    });
    return res.json();
  });
  check('설정: 카운터가 보낸 registry.update는 FORBIDDEN', forbidden?.error?.code === 'FORBIDDEN', JSON.stringify(forbidden?.error ?? forbidden));

  // 사용 종료 → 다시 사용(B).
  await b.goto(APP + '#/manage/settings/fleet');
  await b.waitForSelector('.sn-rule-card', { timeout: STEP_MS });
  let cycle = true;
  for (const label of ['사용 종료', '다시 사용']) {
    await (await settingsCellE2E(b, '3호 차량')).click();
    await sheetChoiceE2E(b, label).click();
    await saveSettingsE2E(b);
    const now = await pageQuery(b, { name: 'shopSettings', params: { tab: 'fleet' } });
    const van = (now.body?.cards?.[0]?.list?.items ?? []).find((i) => i.label === '3호 차량');
    cycle &&= label === '사용 종료' ? van?.tag === '사용 종료' : van?.tag !== '사용 종료';
  }
  check('설정: `3호 차량` 사용 종료 → 다시 사용(같은 차량)', cycle);
  await b.goto(APP + '#/manage/settings/rules');
  await b.waitForSelector('.sn-rule-card', { timeout: STEP_MS });
}

/** 앞단 주소 기준 명령 하나(페이지 안에서, 쿠키 + 세션의 CSRF, 새 요청번호). 결과 { requestId, outcome }. */
async function pageSend(page, type, payload, extra = {}) {
  return page.evaluate(async ({ type, payload, extra }) => {
    const session = await (await fetch('api/v2/session', { cache: 'no-store' })).json();
    const head = await (await fetch('api/v2/head', { cache: 'no-store' })).json();
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let t = Date.now();
    let time = '';
    for (let i = 0; i < 10; i += 1) { time = alphabet[t % 32] + time; t = Math.floor(t / 32); }
    const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => alphabet[b % 32]).join('');
    const requestId = time + random;
    const res = await fetch('api/v2/command', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-skinote-csrf': session.csrf },
      body: JSON.stringify({ type, commandVersion: 1, requestId, basis: { epoch: head.epoch, rev: head.rev }, payload, ...extra }),
    });
    return { requestId, outcome: await res.json() };
  }, { type, payload, extra });
}

/** 할인 적용 창의 길(조회 → 할인 적용 → 이어진 환불, dependsOn)을 페이지 안에서. 명령마다의 결과. */
async function discountBySheet(page, params) {
  const sheet = await pageQuery(page, { name: 'discountSheet', params });
  if (sheet.status !== 200 || !sheet.body?.command) return { sheet: sheet.body, outcomes: [] };
  const outcomes = [];
  const first = await pageSend(page, sheet.body.command.type, sheet.body.command.payload, { expect: sheet.body.expect });
  outcomes.push(first.outcome);
  let previous = first.requestId;
  for (const step of sheet.body.then ?? []) {
    if (outcomes.at(-1)?.outcome !== 'applied') break;
    const next = await pageSend(page, step.command.type, step.command.payload, { expect: step.expect, dependsOn: [previous] });
    outcomes.push(next.outcome);
    previous = next.requestId;
  }
  return { sheet: sheet.body, outcomes };
}

/** 끝 4자리로 접수 id(오늘 장부의 첫 팀). */
async function orderOf(page, last4) {
  const found = await pageQuery(page, { name: 'findLast4', params: { last4 } });
  return found.body?.matches?.[0]?.orderId ?? null;
}

/**
 * 할인 적용(features-1 §6-6): A(카운터, 화면)가 자기 팀(현금 결제 뒤)의 `할인 적용` → `직접 입력` → 금액 5,000원 → 사유 키보드 `단골` → 주 버튼
 * `할인 적용 · 환불 현금 5,000원` → 접수증 출처 줄(할인 · 환불), A가 미수 팀(윤서준 0028)에 10% → 미수가 줄어듦, B(관리자)가 카드로 낸 팀(김민재
 * 0021)에 직접 입력 5,000원 · 환불 현금 → 마감 결제 수단 표에 환불 줄.
 */
async function discountE2E({ APP, a, b }) {
  const orderId = await orderOf(a, TEAM.phone.slice(-4));
  if (!orderId) { check('할인: A의 팀을 끝 4자리로 찾음', false); return; }
  await a.goto(APP + '#/orders/' + orderId);
  await a.waitForSelector('.sn-slip', { timeout: STEP_MS });
  const direct = a.locator('.pos-side-actions button', { hasText: '할인 적용' });
  if (await direct.count()) await direct.first().click();
  else {
    await a.locator('.pos-side-actions button', { hasText: '더 보기' }).click();
    const choice = () => a.locator('[role="dialog"] .pos-choice-button', { hasText: '할인 적용' });
    const next = a.locator('[role="dialog"]').getByRole('button', { name: '다음 쪽' });
    for (let guard = 0; guard < 4 && !(await choice().count()) && await next.count() && await next.isEnabled(); guard += 1) await next.click();
    await choice().first().click();
  }
  const dialog = a.locator('.pos-discount');
  await dialog.waitFor({ timeout: STEP_MS });
  await dialog.getByRole('group', { name: '할인', exact: true }).getByRole('button', { name: /^직접 입력/ }).click();
  await a.locator('[role="dialog"] .pos-choice-button', { hasText: '금액' }).click();
  const pad = a.locator('.sn-sheet-overlay .sn-numpad');
  await pad.waitFor({ timeout: STEP_MS });
  for (const d of ['5', '000']) await pad.getByRole('button', { name: d, exact: true }).click();
  await pad.getByRole('button', { name: '입력', exact: true }).click();
  const kb = a.locator('.sn-kb');
  await kb.waitFor({ timeout: STEP_MS });
  for (const key of ['ㄷ', 'ㅏ', 'ㄴ', 'ㄱ', 'ㅗ', 'ㄹ']) await kb.getByRole('button', { name: key, exact: true }).click();
  await kb.locator('[data-primary="true"]').click();
  await kb.waitFor({ state: 'detached', timeout: STEP_MS });
  const primary = dialog.locator('[data-primary="true"]');
  await a.waitForFunction(() => /환불/.test(document.querySelector('.pos-discount [data-primary="true"]')?.textContent ?? ''), null, { timeout: STEP_MS }).catch(() => {});
  const label = ((await primary.textContent()) ?? '').trim();
  await shot(a, 'a-discount-1024x600');
  check('할인: A의 직접 입력 5,000원 · 사유 `단골` → 주 버튼 `할인 적용 · 환불 현금 5,000원`', label === '할인 적용 · 환불 현금 5,000원', label);
  await primary.click();
  await dialog.waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  const slip = await pageQuery(a, { name: 'orderSlip', params: { orderId } });
  const rows = (slip.body?.adjustments ?? []).map((x) => x.parts.map((p) => p.text).join(' · ') + (x.amount !== undefined ? ' ' + x.amount : ''));
  check('할인: 접수증 출처 줄 `장비 할인 직접 입력 · 단골 · −5,000원` · `환불 · 현금 5,000원`, 미수 없음',
    rows.includes('장비 할인 직접 입력 · 단골 -5000') && rows.includes('환불 · 현금 5,000원') && slip.body?.money?.due === 0, rows.join(' / '));
  await a.waitForSelector('.sn-slip-adjust', { timeout: STEP_MS }).catch(() => {});
  await shot(a, 'a-discount-slip-1024x600');

  const yoon = await orderOf(a, '0028');
  const before = yoon ? (await pageQuery(a, { name: 'orderSlip', params: { orderId: yoon } })).body?.money?.due : null;
  const ten = yoon ? await discountBySheet(a, { orderId: yoon, sectionKey: 'gear', choice: { ruleKey: 'ten_percent' } }) : { outcomes: [] };
  const after = yoon ? (await pageQuery(a, { name: 'orderSlip', params: { orderId: yoon } })).body?.money?.due : null;
  check('할인: A가 미수 팀(윤서준)에 10% → 미수가 10% 줄어듦(환불 없음)', ten.outcomes.map((o) => o.outcome).join(',') === 'applied' && typeof before === 'number' && after === before - before / 10,
    before + ' → ' + after);

  // B: 카드로 낸 팀(김민재) → 직접 입력 5,000원, 환불 줄의 수단을 현금으로 고른 창의 명령(할인 적용 → 환불).
  const kim = await orderOf(b, '0021');
  const choice = { manual: { kind: 'amount', value: 5000, reason: '행사' } };
  const opened = kim ? await pageQuery(b, { name: 'discountSheet', params: { orderId: kim, sectionKey: 'gear', choice } }) : null;
  const paymentId = opened?.body?.refunds?.[0]?.paymentId;
  const done = kim && paymentId ? await discountBySheet(b, { orderId: kim, sectionKey: 'gear', choice, methods: { [paymentId]: 'cash' } }) : { sheet: null, outcomes: [] };
  const closing = await pageQuery(b, { name: 'closingSheet', params: {} });
  const refundRow = (closing.body?.methods ?? []).find((m) => m.key === 'refund');
  check('할인: B(관리자)가 카드로 낸 팀에 직접 입력 5,000원 · 환불 현금 → 할인 적용 · 환불이 이어서 적용, 마감 결제 수단 표에 환불 줄',
    done.sheet?.primary?.label === '할인 적용 · 환불 현금 5,000원' && done.outcomes.map((o) => o.outcome).join(',') === 'applied,applied'
      && refundRow !== undefined && refundRow.amount <= -10000,
    String(done.sheet?.primary?.label) + ' · ' + done.outcomes.map((o) => o.outcome + (o.error ? ':' + o.error.code : '')).join(',') + ' · ' + JSON.stringify(refundRow ?? null));
}

/** 취소 창의 길(조회 → 취소 → 이어진 환불, dependsOn)을 페이지 안에서. 명령마다의 결과. */
async function cancelBySheet(page, params) {
  const sheet = await pageQuery(page, { name: 'cancelSheet', params });
  if (sheet.status !== 200 || !sheet.body?.command) return { sheet: sheet.body, outcomes: [] };
  const outcomes = [];
  const first = await pageSend(page, sheet.body.command.type, sheet.body.command.payload, { expect: sheet.body.expect });
  outcomes.push(first.outcome);
  let previous = first.requestId;
  for (const step of sheet.body.then ?? []) {
    if (outcomes.at(-1)?.outcome !== 'applied') break;
    const next = await pageSend(page, step.command.type, step.command.payload, { expect: step.expect, dependsOn: [previous] });
    outcomes.push(next.outcome);
    previous = next.requestId;
  }
  return { sheet: sheet.body, outcomes };
}

/**
 * 품목 추가 · 품목 취소 · 접수 취소(features-1 §5-6): A(카운터, 화면)가 자기 팀에 `품목 추가`(헬멧 · 현금) → 접수증 `품목 추가` 줄, 그 헬멧을 `품목 취소`
 * · 환불 현금 → 마감 결제 수단 표의 `환불 · n건`, A가 전화 예약 최하은 팀(배달 적재 전, 계좌이체로 모두 받음)을 `연락 없음`으로 접수 취소(매장 설정이 환불 없음이라 처음 결정은
 * 환불 없음, 직원이 환불을 고름) → 장부 줄
 * `취소`(흐림) · 1호 차량 기사 휴대폰(E)의 배달 목록에서 빠짐.
 */
async function orderEditE2E({ APP, a, e }) {
  const orderId = await orderOf(a, TEAM.phone.slice(-4));
  if (!orderId) { check('품목 추가: A의 팀을 끝 4자리로 찾음', false); return; }
  // 품목 추가: 접수증 옆 동작(더 보기 안일 수 있음) → ① 품목 → 헬멧 → 다음 · 결제 → 현금 → 추가 확정.
  await a.setViewportSize({ width: 1024, height: 600 });
  await a.goto(APP + '#/orders/' + orderId);
  await a.waitForSelector('.sn-slip', { timeout: STEP_MS });
  const direct = a.locator('.pos-side-actions button', { hasText: '품목 추가' });
  if (await direct.count()) await direct.first().click();
  else {
    await a.locator('.pos-side-actions button', { hasText: '더 보기' }).click();
    const choice = () => a.locator('[role="dialog"] .pos-choice-button', { hasText: '품목 추가' });
    const next = a.locator('[role="dialog"]').getByRole('button', { name: '다음 쪽' });
    for (let guard = 0; guard < 4 && !(await choice().count()) && await next.count() && await next.isEnabled(); guard += 1) await next.click();
    await choice().first().click();
  }
  await a.waitForSelector('.pos-new-kinds', { timeout: STEP_MS });
  const title = ((await a.locator('.sn-slip-title').textContent()) ?? '').trim();
  await a.locator('.pos-new-kinds .sn-kind', { hasText: '헬멧' }).click();
  const size = a.locator('.pos-new-open .sn-choice[aria-pressed="false"]:enabled').filter({ hasNotText: '더 보기' });
  await size.first().waitFor({ timeout: STEP_MS }).catch(() => {});
  if (await size.count()) await size.first().click();
  const plus = a.locator('.pos-new-open').getByRole('button', { name: '수량 증가' });
  await plus.waitFor({ timeout: STEP_MS });
  await plus.click();
  await a.waitForSelector('.pos-new-side [data-primary="true"]:enabled', { timeout: STEP_MS });
  await shot(a, 'a-add-items-1024x600');
  await a.locator('.pos-new-side [data-primary="true"]').click();
  const dialog = a.locator('.pos-checkout');
  await dialog.waitFor({ timeout: STEP_MS });
  await dialog.getByRole('group', { name: '장비 결제 수단', exact: true }).getByRole('button', { name: '현금', exact: true }).click();
  await a.waitForFunction(() => /추가 확정 · 현금/.test(document.querySelector('.pos-checkout [data-primary="true"]')?.textContent ?? ''), null, { timeout: STEP_MS }).catch(() => {});
  const addLabel = ((await dialog.locator('[data-primary="true"]').textContent()) ?? '').trim();
  await shot(a, 'a-add-checkout-1024x600');
  await dialog.locator('[data-primary="true"]').click();
  await a.waitForSelector('.sn-slip', { timeout: STEP_MS }).catch(() => {});
  const slip = await pageQuery(a, { name: 'orderSlip', params: { orderId } });
  const rows = (slip.body?.adjustments ?? []).map((x) => x.parts.map((p) => p.text).join(' · '));
  const added = (slip.body?.lines ?? []).at(-1);
  check('품목 추가: A가 자기 팀에 헬멧(현금) → 제목 `품목 추가 · 김민수 팀` · `추가 확정 · 현금 …` → 접수증 `품목 추가` 줄 · 새 줄',
    title === '품목 추가 · ' + TEAM.name + ' 팀' && /^추가 확정 · 현금 /.test(addLabel) && rows.some((r) => r.startsWith('품목 추가 · ')) && /헬멧/.test(added?.label ?? ''),
    title + ' · ' + addLabel + ' · ' + rows.join(' / '));
  // 그 헬멧(지급 전)을 품목 취소 · 환불 현금.
  const removed = added ? await cancelBySheet(a, { orderId, scope: 'lines', picked: [{ lineId: added.id, quantity: 1 }] }) : { sheet: null, outcomes: [] };
  const closing = await pageQuery(a, { name: 'closingSheet', params: {} });
  const refundRow = (closing.body?.methods ?? []).find((m) => m.key === 'refund');
  check('품목 취소: 더한 헬멧 1을 환불 현금 → `품목 취소 · 헬멧 … · 환불 현금` 적용, 마감 결제 수단 표에 `환불 · n건`',
    /^품목 취소 · 헬멧 .* · 환불 현금 /.test(removed.sheet?.primary?.label ?? '') && removed.outcomes.map((o) => o.outcome).join(',') === 'applied,applied' && refundRow !== undefined,
    String(removed.sheet?.primary?.label) + ' · ' + removed.outcomes.map((o) => o.outcome + (o.error ? ':' + o.error.code : '')).join(',') + ' · ' + JSON.stringify(refundRow ?? null));
  await a.goto(APP + '#/orders/' + orderId);
  await a.waitForSelector('.sn-slip', { timeout: STEP_MS });
  await shot(a, 'a-removed-slip-1024x600');

  // 최하은(전화 예약 · 배달 적재 전 · 계좌이체로 모두 받음): 접수 취소 · 연락 없음. 앞의 운영 규칙 시험에서 B가 `당일 취소 환불`을 `환불 없음`으로
  // 저장했으니 연락 없음의 처음 결정은 `환불 없음`(E8), 직원이 `환불`을 골라 확정한다.
  const haeun = await orderOf(a, '0026');
  const opened = haeun ? await pageQuery(a, { name: 'cancelSheet', params: { orderId: haeun, scope: 'order', reasonKey: 'no_show' } }) : null;
  const first = (opened?.body?.decisions ?? []).find((d) => d.selected)?.label;
  check('접수 취소: 매장 설정 `당일 취소 환불` · 환불 없음 → 연락 없음의 처음 결정은 `환불 없음`, 고를 수 있는 줄 환불 · 환불 없음',
    first === '환불 없음' && (opened?.body?.decisions ?? []).some((d) => d.label === '환불'), String(first) + ' · ' + (opened?.body?.decisions ?? []).map((d) => d.label).join(','));
  const cancelled = haeun ? await cancelBySheet(a, { orderId: haeun, scope: 'order', reasonKey: 'no_show', decision: 'refund' }) : { sheet: null, outcomes: [] };
  const ledger = await pageQuery(a, { name: 'ledgerView', params: { viewKey: 'day_ledger' } });
  const row = (ledger.body?.rows ?? []).find((r) => r.orderId === haeun);
  check('접수 취소: A가 최하은 팀을 연락 없음 · 환불 → 취소 · 환불 적용, 장부 줄 `취소`(흐림 · 빨강 없음)',
    cancelled.outcomes.map((o) => o.outcome).join(',') === 'applied,applied' && row?.statusWord === '취소' && row?.finished === true && row?.lateAt === undefined,
    String(cancelled.sheet?.primary?.label) + ' · ' + cancelled.outcomes.map((o) => o.outcome + (o.error ? ':' + o.error.code : '')).join(',') + ' · ' + JSON.stringify({ word: row?.statusWord, finished: row?.finished }));
  await a.goto(APP + '#/orders/' + haeun);
  await a.waitForSelector('.sn-slip', { timeout: STEP_MS });
  await shot(a, 'a-cancelled-slip-1024x600');
  // E(기사 휴대폰, 1호 차량)의 배달 목록에서 빠진다.
  const deliveries = await pageQuery(e, { name: 'ledgerView', params: { viewKey: 'delivery_list' } });
  const still = (deliveries.body?.rows ?? []).some((r) => r.orderId === haeun);
  check('접수 취소: 1호 차량 기사 휴대폰(E)의 배달 목록에서 최하은 팀이 빠짐', deliveries.status === 200 && !still, deliveries.status + ' · ' + still);
}

/**
 * 즉시 교환(features-1 §7-6): A(카운터, 화면)가 김민재 팀(0021, 손님에게 있는 의류)의 `즉시 교환` 창에서 다른 사이즈(105, 이미 105면 110)를 골라
 * 확정 → 주 버튼 `즉시 교환 · 의류 1벌` → 접수증 줄 이름이 새 사이즈 · 출처 줄 `즉시 교환 · 의류 사이즈 … → 사이즈 … · 1벌 · 시각`, 돈은 그대로.
 * 1호 차량 기사 휴대폰(E)은 교환 창을 읽지 못한다(403, E14).
 */
async function exchangeE2E({ APP, a, e }) {
  const orderId = await orderOf(a, '0021');
  if (!orderId) { check('즉시 교환: 김민재 팀을 끝 4자리로 찾음', false); return; }
  await a.setViewportSize({ width: 1024, height: 600 });
  await a.goto(APP + '#/orders/' + orderId);
  await a.waitForSelector('.sn-slip', { timeout: STEP_MS });
  const before = (await pageQuery(a, { name: 'orderSlip', params: { orderId } })).body;
  const direct = a.locator('.pos-side-actions button', { hasText: '즉시 교환' });
  if (await direct.count()) await direct.first().click();
  else {
    await a.locator('.pos-side-actions button', { hasText: '더 보기' }).click();
    const choice = () => a.locator('[role="dialog"] .pos-choice-button', { hasText: '즉시 교환' });
    const next = a.locator('[role="dialog"]').getByRole('button', { name: '다음 쪽' });
    for (let guard = 0; guard < 4 && !(await choice().count()) && await next.count() && await next.isEnabled(); guard += 1) await next.click();
    await choice().first().click();
  }
  const dialog = a.locator('.pos-exchange');
  await dialog.waitFor({ timeout: STEP_MS });
  const item = dialog.getByRole('group', { name: '교환 품목', exact: true }).locator('button.sn-choice', { hasText: '의류' });
  await item.first().waitFor({ timeout: STEP_MS }).catch(() => {});
  if (await item.count() && (await item.first().getAttribute('aria-pressed')) !== 'true') await item.first().click();
  const from = /사이즈 (\d+)/.exec(((await item.first().textContent().catch(() => '')) ?? ''))?.[1] ?? '';
  const to = from === '105' ? '110' : '105';
  await dialog.getByRole('group', { name: '지급 사이즈', exact: true }).getByRole('button', { name: to, exact: true }).click();
  await a.waitForFunction(() => !document.querySelector('.pos-exchange [data-primary="true"]')?.hasAttribute('disabled'), null, { timeout: STEP_MS }).catch(() => {});
  const label = ((await dialog.locator('[data-primary="true"]').textContent()) ?? '').trim();
  await shot(a, 'a-exchange-1024x600');
  await dialog.locator('[data-primary="true"]').click();
  await dialog.waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  const slip = (await pageQuery(a, { name: 'orderSlip', params: { orderId } })).body;
  const rows = (slip?.adjustments ?? []).map((x) => x.parts.map((p) => p.text).join(' · '));
  const line = (slip?.lines ?? []).find((l) => /^의류/.test(l.label));
  check('즉시 교환: A가 김민재 팀 의류 ' + from + ' → ' + to + ' · 주 버튼 `즉시 교환 · 의류 1벌` → 접수증 줄 `의류 사이즈 ' + to + '` · 출처 줄 · 돈 그대로',
    label === '즉시 교환 · 의류 1벌' && line?.label === '의류 사이즈 ' + to
      && rows.some((r) => new RegExp('^즉시 교환 · 의류 사이즈 ' + from + ' → 사이즈 ' + to + ' · 1벌 · \\d\\d:\\d\\d$').test(r))
      && JSON.stringify(slip?.money) === JSON.stringify(before?.money),
    label + ' · ' + String(line?.label) + ' · ' + rows.join(' / '));
  await a.goto(APP + '#/orders/' + orderId);
  await a.waitForSelector('.sn-slip-adjust', { timeout: STEP_MS }).catch(() => {});
  await shot(a, 'a-exchange-slip-1024x600');
  const driver = await pageQuery(e, { name: 'exchangeSheet', params: { orderId } });
  check('즉시 교환: 기사 휴대폰(E) 세션은 교환 창을 읽지 못함(403, 카운터만)', driver.status === 403, String(driver.status));
}

/** 분실 처리 · 예비권 창(PieceSheet)의 칸 label을 plus번 올리고 minus번 내린 뒤 주 버튼 글(바뀔 때까지 기다림). */
async function piecesE2E(page, label, { plus = 0, minus = 0, expect }) {
  const sheet = page.locator('.pos-pieces-sheet');
  await sheet.waitFor({ timeout: STEP_MS });
  const piece = () => sheet.locator('.sn-piece-line', { hasText: label }).first();
  const next = sheet.getByRole('button', { name: '다음 쪽' });
  for (let guard = 0; guard < 6 && !(await piece().count()) && await next.count() && await next.isEnabled(); guard += 1) await next.click();
  for (let i = 0; i < plus; i += 1) { await piece().getByRole('button', { name: '수량 증가' }).click(); await sleep(150); }
  for (let i = 0; i < minus; i += 1) { await piece().getByRole('button', { name: '수량 감소' }).click(); await sleep(150); }
  await page.waitForFunction((want) => {
    const button = document.querySelector('.pos-pieces-sheet [data-primary="true"]');
    return button && !button.hasAttribute('disabled') && (button.textContent ?? '').trim() === want;
  }, expect, { timeout: STEP_MS }).catch(() => {});
  return ((await sheet.locator('[data-primary="true"]').textContent()) ?? '').trim();
}

/**
 * 리프트권(features-1 §8-5): A(카운터, 화면)가 리프트권 화면의 1호 차량 `예비권 적재` 2매 → E(기사 휴대폰)의 차량 재고가 2매 늘어남, A가 박준호 팀(0022)
 * 을 지급(`지급 처리 · 6개 · 3매`) → 미반납 탭에서 `분실 처리` 1매(청구 없음) → 현황 미반납 2 · 분실 1, 그 팀의 수거 목록 줄은 야간권 2매 → 분실 탭
 * `분실 회수` → 분실 0.
 */
async function ticketsE2E({ APP, a, e }) {
  await a.setViewportSize({ width: 1024, height: 600 });
  const spareOf = async () => ((await pageQuery(e, { name: 'vehicleLoad', params: { vehicleId: 'v1' } })).body?.spareTickets ?? []).find((x) => x.label === '야간권')?.qty ?? 0;
  const base = await spareOf();
  await a.goto(APP + '#/tickets');
  await a.waitForSelector('.pos-tickets-table', { timeout: STEP_MS });
  await shot(a, 'a-tickets-status-1024x600');
  await a.locator('.pos-tickets-van', { hasText: '1호 차량' }).locator('button.pos-tickets-van-button').first().click();
  const loadLabel = await piecesE2E(a, '야간권', { plus: 2, expect: '예비권 적재 · 야간권 2매' });
  await shot(a, 'a-spare-load-1024x600');
  await a.locator('.pos-pieces-sheet [data-primary="true"]').click();
  await a.locator('.pos-pieces-sheet').waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  const after = await spareOf();
  check('리프트권: A가 `예비권 적재 · 1호 차량` 2매 → E(기사 휴대폰)의 차량 재고 야간권 ' + base + ' → ' + (base + 2) + '매', loadLabel === '예비권 적재 · 야간권 2매' && after === base + 2, loadLabel + ' · ' + after);
  // 박준호 팀 지급(접수증의 주 버튼 → 확인 창).
  const orderId = await orderOf(a, '0022');
  if (!orderId) { check('리프트권: 박준호 팀을 끝 4자리로 찾음', false); return; }
  await a.goto(APP + '#/orders/' + orderId);
  await a.waitForSelector('.sn-slip', { timeout: STEP_MS });
  const issueLabel = ((await a.locator('.pos-side [data-primary="true"]').textContent()) ?? '').trim();
  await a.locator('.pos-side [data-primary="true"]').click();
  const confirmButton = a.locator('[role="dialog"] [data-primary="true"]');
  await confirmButton.waitFor({ timeout: STEP_MS });
  await confirmButton.click();
  await a.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  // 미반납 탭 → 박준호 `분실 처리` → 창은 0매로 열린다(2026-09-27 점검: 모두 골라진 채 열리지 않음) → 3매 중 1매.
  await a.goto(APP + '#/tickets/unreturned');
  await a.waitForSelector('.pos-tickets-rows', { timeout: STEP_MS });
  const row = a.locator('.pos-tickets-line', { hasText: '박준호' });
  await row.locator('.pos-tickets-line-actions button', { hasText: '분실 처리' }).click();
  await a.locator('.pos-pieces-sheet').waitFor({ timeout: STEP_MS });
  const lossStartsEmpty = await a.locator('.pos-pieces-sheet [data-primary="true"]').isDisabled();
  const lossLabel = await piecesE2E(a, '야간권', { plus: 1, expect: '분실 처리 · 야간권 1매' });
  const noCharge = await a.locator('.pos-pieces-sheet', { hasText: '청구 없음' }).count();
  await shot(a, 'a-ticket-loss-1024x600');
  await a.locator('.pos-pieces-sheet [data-primary="true"]').click();
  await a.locator('.pos-pieces-sheet').waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  const board = (await pageQuery(a, { name: 'ticketBoard', params: { tab: 'status' } })).body;
  const night = (board?.status ?? []).find((r) => r.label === '야간권');
  const list = (await pageQuery(a, { name: 'ledgerView', params: { viewKey: 'collection_list', vehicleId: 'v1', deviceClass: 'pos' } })).body;
  const task = (list?.rows ?? []).find((r) => r.orderId === orderId);
  const ticketsLeft = (task?.cells?.items?.items ?? []).find((x) => x.label === '야간권')?.qty;
  check('리프트권: A가 박준호 팀 지급(`' + issueLabel + '`) → 0매로 열린 창에서 `분실 처리 · 야간권 1매`(청구 없음) → 현황 미반납 2 · 분실 1, 수거 목록 줄은 야간권 2매',
    issueLabel === '지급 처리 · 6개 · 3매' && lossStartsEmpty && lossLabel === '분실 처리 · 야간권 1매' && noCharge > 0 && night?.out === 2 && night?.lost === 1 && ticketsLeft === 2,
    [issueLabel, 'empty ' + lossStartsEmpty, lossLabel, JSON.stringify(night), ticketsLeft].join(' · '));
  // 분실 탭 → 분실 회수.
  await a.goto(APP + '#/tickets/lost');
  await a.waitForSelector('.pos-tickets-rows', { timeout: STEP_MS });
  await shot(a, 'a-tickets-lost-1024x600');
  await a.locator('.pos-tickets-line', { hasText: '박준호' }).locator('.pos-tickets-line-actions button', { hasText: '분실 회수' }).click();
  const foundLabel = await piecesE2E(a, '야간권', { expect: '분실 회수 · 야간권 1매' });
  await a.locator('.pos-pieces-sheet [data-primary="true"]').click();
  await a.locator('.pos-pieces-sheet').waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  const again = (await pageQuery(a, { name: 'ticketBoard', params: { tab: 'status' } })).body;
  const lost = (again?.status ?? []).find((r) => r.label === '야간권')?.lost;
  check('리프트권: 분실 탭 `분실 회수 · 야간권 1매` → 분실 0', foundLabel === '분실 회수 · 야간권 1매' && lost === 0, foundLabel + ' · ' + lost);
  const driverBoard = await pageQuery(e, { name: 'ticketBoard', params: {} });
  check('리프트권: 기사 휴대폰(E) 세션은 리프트권 화면을 읽지 못함(403)', driverBoard.status === 403, String(driverBoard.status));
}

/**
 * 인쇄 · 전화(features-1 §8-5): A의 수거 목록 `인쇄`(인쇄 창은 막아 두고 부른 수 · 인쇄 문서의 글을 남김) → 한 번 · 팀과 가린 번호(`010-****-xxxx`)만,
 * E(기사 휴대폰)의 수거 목록 줄 `전화` → 창의 주 버튼이 `tel:` 링크, A의 접수증 `전화` → 번호만(`tel:` 없음).
 */
async function printCallE2E({ APP, a, e }) {
  await a.goto(APP + '#/collections');
  await a.waitForSelector('.sn-ledger tr.sn-row', { timeout: STEP_MS });
  await a.evaluate(() => {
    window.__printed = 0;
    window.print = () => { window.__printed += 1; window.__printText = document.querySelector('.pos-print-host')?.textContent ?? ''; };
  });
  await a.locator('.sn-footer [data-primary="true"]').click();
  await a.waitForFunction(() => window.__printed > 0, null, { timeout: STEP_MS }).catch(() => {});
  const printed = await a.evaluate(() => ({ n: window.__printed, text: window.__printText ?? '' }));
  check('인쇄: A의 수거 목록 `인쇄` → 인쇄 창 한 번 · 인쇄 문서에 가린 번호(010-****-xxxx)만',
    printed.n === 1 && /010-\*{4}-\d{4}/.test(printed.text) && !/010-0000-(?!0000)\d{4}/.test(printed.text), printed.n + ' · ' + printed.text.slice(0, 80));
  await e.goto(APP);
  await e.waitForSelector('.sn-ledger tr.sn-row', { timeout: STEP_MS });
  const call = e.locator('.sn-ledger tr.sn-row button.sn-cell-action').first();
  let href = null;
  if (await call.count()) {
    await call.click();
    await e.locator('.pos-call').waitFor({ timeout: STEP_MS }).catch(() => {});
    href = await e.locator('.pos-call a.pos-call-link').getAttribute('href').catch(() => null);
    await shot(e, 'e-call-360x640');
    await e.locator('.pos-call').getByRole('button', { name: '닫기' }).click().catch(() => {});
  }
  check('전화: 기사 휴대폰(E)의 수거 목록 `전화` → 주 버튼이 `tel:` 링크', typeof href === 'string' && href.startsWith('tel:'), String(href));
  const orderId = await orderOf(a, '0025');
  await a.goto(APP + '#/orders/' + orderId);
  await a.waitForSelector('.sn-slip', { timeout: STEP_MS });
  const direct = a.locator('.pos-side-actions button', { hasText: '전화' });
  if (await direct.count()) await direct.first().click();
  else {
    await a.locator('.pos-side-actions button', { hasText: '더 보기' }).click();
    await a.locator('[role="dialog"] .pos-choice-button', { hasText: '전화' }).first().click();
  }
  await a.locator('.pos-call').waitFor({ timeout: STEP_MS }).catch(() => {});
  const number = ((await a.locator('.pos-call .pos-call-number').textContent().catch(() => '')) ?? '').trim();
  const tel = await a.locator('.pos-call a[href^="tel:"]').count();
  await shot(a, 'a-call-1024x600');
  await a.locator('.pos-call').getByRole('button', { name: '닫기' }).click().catch(() => {});
  check('전화: A(카운터)의 접수증 `전화` → 번호만(`tel:` 링크 없음)', number === '010-0000-0025' && tel === 0, number + ' · tel ' + tel);
}

/**
 * 확인 필요(features-1 §9-5): 견본 하루(load-sample)의 확인 필요 한 건(최은정 팀)이 A(카운터)의 `확인 필요` 화면에 있고 머리줄 메뉴에 수 → 그 줄의 `확인`
 * → 수가 하나 줄고 처리 완료 탭에 `확인 완료 · 시각 · 김카운터` → 서버를 다시 띄워도 처리 완료 그대로, E(기사 휴대폰)는 목록을 읽지 못함(403).
 */
async function reviewE2E({ APP, a, e, restart }) {
  await a.setViewportSize({ width: 1024, height: 600 });
  const listOf = async () => (await pageQuery(a, { name: 'reviewList', params: {} })).body;
  const before = await listOf();
  await a.goto(APP + '#/review');
  await a.waitForSelector('.pos-review-rows', { timeout: STEP_MS });
  const badge = async () => ((await a.locator('.sn-header-right button', { hasText: '확인 필요' }).locator('.sn-count').textContent().catch(() => '')) ?? '').trim();
  const row = a.locator('.pos-review-line', { hasText: '최은정 팀 스키 1대 매장 반납 완료' });
  const shownBefore = await badge();
  await shot(a, 'a-review-1024x600');
  check('확인 필요: 견본 한 건(`최은정 팀 스키 1대 매장 반납 완료 · 기사 수거 기록 제외`)이 미처리에 있고 머리줄 `확인 필요`에 수',
    (await row.count()) === 1 && shownBefore === String(before?.count) && before?.count >= 1, shownBefore + ' · ' + before?.count);
  await row.locator('.pos-review-actions button', { hasText: /^확인$/ }).click();
  await row.waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  await a.waitForFunction((n) => {
    const b = [...document.querySelectorAll('.sn-header-right button')].find((x) => (x.textContent ?? '').includes('확인 필요'));
    const c = b?.querySelector('.sn-count')?.textContent?.trim() ?? '';
    return n === 0 ? c === '' : c === String(n);
  }, (before?.count ?? 1) - 1, { timeout: STEP_MS }).catch(() => {});
  const after = await listOf();
  await a.goto(APP + '#/review/done');
  await a.waitForSelector('.pos-review-rows', { timeout: STEP_MS });
  const doneLine = ((await a.locator('.pos-review-line.is-done', { hasText: '최은정 팀' }).locator('.pos-review-note').textContent().catch(() => '')) ?? '').trim();
  await shot(a, 'a-review-done-1024x600');
  check('확인 필요: A의 `확인` → 미처리 수가 하나 줄고 처리 완료 탭에 `확인 완료 · 시각 · ' + STAFF.counter + '`',
    after?.count === (before?.count ?? 0) - 1 && new RegExp('^확인 완료 · \\d{2}:\\d{2} · ' + STAFF.counter + '$').test(doneLine), after?.count + ' · ' + doneLine);
  await restart();
  await a.goto(APP + '#/review/done');
  await a.waitForSelector('.pos-review-rows', { timeout: STEP_MS });
  const kept = ((await a.locator('.pos-review-line.is-done', { hasText: '최은정 팀' }).locator('.pos-review-note').textContent().catch(() => '')) ?? '').trim();
  const again = await listOf();
  check('확인 필요: 서버를 다시 띄워도 처리 완료 그대로(누가 · 시각), 미처리 수 그대로', kept === doneLine && again?.count === after?.count, kept + ' · ' + again?.count);
  const driverList = await pageQuery(e, { name: 'reviewList', params: {} });
  check('확인 필요: 기사 휴대폰(E) 세션은 확인 필요를 읽지 못함(403)', driverList.status === 403, String(driverList.status));
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
  let openServer = null;
  let openProxy = null;
  let browser = null;
  let serverRuns = 0;
  let openRuns = 0;
  const startServer = async () => {
    serverRuns += 1;
    const child = startChild([SERVER_MAIN], env, serverLog.replace(/\.log$/, '-' + serverRuns + '.log'));
    await waitHealthy(serverPort, child);
    return child;
  };
  // 둘째 서버: 시험 매장 하나 + 열린 기기 등록(SKINOTE_TEST_OPEN_ENROLL=on). 자료 폴더 · 포트 · 관리 소켓 · 비밀값이 따로다.
  const openServerPort = await freePort();
  const openEnv = {
    ...env,
    ...newSecretsEnv(),
    SKINOTE_DATA_DIR: join(tmp, 'open-data'),
    SKINOTE_SHOP_IDS: OPEN_SHOP,
    SKINOTE_PORT: String(openServerPort),
    SKINOTE_ADMIN_SOCKET: join(tmp, 'o.sock'),
    SKINOTE_TEST_OPEN_ENROLL: 'on',
    // 켜면 마지막 영업일이 꼭 있다(deploy.sh --set-env …=on처럼 오늘 + 7일, 서울 · 06:00).
    SKINOTE_TEST_OPEN_ENROLL_UNTIL: addDays(businessDate(new Date(), 'Asia/Seoul', 6 * 60), 7),
  };
  const startOpenServer = async () => {
    openRuns += 1;
    const child = startChild([SERVER_MAIN], openEnv, join(OUT, 'open-server-' + openRuns + '.log'));
    await waitHealthy(openServerPort, child);
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

    // ── 매장 설정의 다른 탭(features-1 plan §4-6): B(관리자)가 바꾸고 A(카운터) · E(기사 휴대폰)가 본다 ──────────────
    await settingsE2E({ APP, a, b, c, e, pins, secretsSeen });

    // ── 할인 적용(features-1 plan §6-6): A(카운터, 화면) · B(관리자) ─────────────────────────
    await discountE2E({ APP, a, b });

    // ── 품목 추가 · 품목 취소 · 접수 취소(features-1 plan §5-6): A(카운터, 화면) · E(기사 휴대폰) ──────────────
    await orderEditE2E({ APP, a, e });

    // ── 즉시 교환(features-1 plan §7-6): A(카운터, 화면) · E(기사 휴대폰은 읽지 못함) ──────────────
    await exchangeE2E({ APP, a, e });

    // ── 리프트권 · 인쇄 · 전화(features-1 plan §8-5): A(카운터, 화면) · E(기사 휴대폰) ──────────────
    await ticketsE2E({ APP, a, e });
    await printCallE2E({ APP, a, e });

    // ── 확인 필요(features-1 plan §9-5): A(카운터, 화면) · 서버 다시 띄우기 · E(기사 휴대폰은 읽지 못함) ──────────────
    // 다시 띄우는 동안 다른 기기는 빈 주소로 두었다가(알림 연결의 오류 줄 없이) 그 화면으로 되돌린다(세션은 이어진다).
    const restart = async () => {
      const kept = { b: b.url(), c: c.url(), e: e.url() };
      for (const page of [a, b, c, e]) await page.goto('about:blank');
      await stopChild(server);
      server = null;
      server = await startServer();
      for (const [page, url] of [[b, kept.b], [c, kept.c], [e, kept.e]]) {
        await page.goto(url);
        await page.waitForSelector('.sn-header, .sn-screen', { timeout: STEP_MS }).catch(() => {});
      }
    };
    await reviewE2E({ APP, a, e, restart });

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

    // ── 열린 기기 등록(시험 매장, SKINOTE_TEST_OPEN_ENROLL=on인 둘째 서버) ─────────────────────
    const codeMode = await fetch(`http://127.0.0.1:${serverPort}/api/v2/device/enroll`).then((r) => r.json()).catch(() => null);
    check('첫 서버(설정 없음)의 등록 방법은 등록 번호(code)', codeMode?.mode === 'code', JSON.stringify(codeMode));
    openServer = await startOpenServer();
    await stopChild(openServer);
    openServer = null;
    const openMade = await runCli(['provision', '--shop', OPEN_SHOP, '--code', 'e2e-open', '--name', '시험 매장 열린 등록', '--sample', '--test',
      '--staff', STAFF.manager + ':manager', '--staff', STAFF.counter + ':counter', '--staff', STAFF.driver + ':driver:v1'], openEnv, cliLog);
    const openPins = Object.fromEntries(openMade.out.trim().split('\n').slice(1).map((line) => line.split('\t')).map(([name, , pin]) => [name, pin]));
    if (!check('열린 등록 서버: 시험 매장 provision(등록 번호는 만들지 않음)', openMade.code === 0 && Object.keys(openPins).length === 3, '끝 코드 ' + openMade.code)) {
      throw new Error('열린 등록 서버의 매장을 만들지 못함');
    }
    secretsSeen.push(...Object.values(openPins));
    openServer = await startOpenServer();
    openProxy = await startLocalProxy({ port: await freePort(), serverPort: openServerPort, log: (line) => proxyLines.push(line) });

    // O: 카운터(1024×600) — 기기 선택 → 카운터(포스) → 로그인 → 장부.
    const ctxO = await newContext();
    const o = await ctxO.newPage();
    watch(o, 'O');
    await o.goto(openProxy.url);
    const chooser = await o.waitForSelector('.pos-choose', { timeout: STEP_MS }).then(() => true, () => false);
    await shot(o, 'o-choose-1024x600');
    check('O: 열린 등록 서버의 새 기기는 등록 번호 대신 `기기 선택`', chooser && (await o.locator('.pos-choose h1').textContent())?.trim() === '기기 선택' && !(await o.locator('.pos-enroll').count()));
    const oKinds = (await o.locator('.pos-choose .pos-big-choice').allTextContents()).map((t) => t.trim());
    const oPrimary = (await o.locator('.pos-choose .pos-big-choice[data-primary="true"]').allTextContents()).map((t) => t.trim());
    check('O: 종류는 카운터 · 기사 휴대폰 · 기사 태블릿(카운터 폭은 카운터(포스)가 주 버튼)', oKinds.length === 3 && /^카운터/.test(oKinds[0]) && /^기사 휴대폰/.test(oKinds[1])
      && /^기사 태블릿/.test(oKinds[2]) && oPrimary.length === 1 && /^카운터/.test(oPrimary[0]), oKinds.join(' | '));
    await o.locator('.pos-choose .pos-big-choice', { hasText: '카운터' }).click();
    await o.waitForSelector('.pos-login-tile', { timeout: STEP_MS });
    const oTiles = await o.locator('.pos-login-tile').allTextContents();
    check('O: 카운터 선택 → 로그인 화면(직원 타일 셋)', [STAFF.manager, STAFF.counter, STAFF.driver].every((n) => oTiles.some((t) => t.includes(n))), oTiles.join(', '));
    await login(o, STAFF.counter, openPins[STAFF.counter]);
    await o.waitForSelector('.sn-header', { timeout: STEP_MS });
    await shot(o, 'o-ledger-1024x600');
    check('O: 비밀번호 로그인 → 카운터의 첫 화면(오늘 장부)', /#\/ledger/.test(o.url()), o.url().replace(openProxy.url, '/'));
    const oSession = await o.evaluate(() => fetch('api/v2/session', { cache: 'no-store' }).then((r) => r.json()));
    check('O: 스스로 등록한 카운터 = 시험 기기 1(포스)', oSession?.device?.label === '시험 기기 1' && oSession?.device?.kind === 'pos', JSON.stringify(oSession?.device));

    // Q: 기사 휴대폰(360×640) — 기기 선택 → (잘못 고른 카운터 → 기기 선택) → 기사 휴대폰 → 차량 선택 1호 차량 → 기사 로그인 → 수거 목록.
    const ctxQ = await newContext({ width: 360, height: 640 });
    const q = await ctxQ.newPage();
    watch(q, 'Q');
    await q.goto(openProxy.url);
    await q.waitForSelector('.pos-choose', { timeout: STEP_MS });
    const chooseClass = await q.evaluate(() => document.querySelector('.sn-root')?.getAttribute('data-device'));
    const qKinds = (await q.locator('.pos-choose .pos-big-choice').allTextContents()).map((t) => t.trim());
    const qPrimary = (await q.locator('.pos-choose .pos-big-choice[data-primary="true"]').allTextContents()).map((t) => t.trim());
    await shot(q, 'q-choose-360x640');
    check('Q: 휴대폰 폭의 기기 선택은 기사 휴대폰 등급(56px 누르는 곳) · 기사 휴대폰이 먼저이고 주 버튼, 카운터(포스)는 맨 뒤', chooseClass === 'driver_phone'
      && /^기사 휴대폰/.test(qKinds[0] ?? '') && /^기사 태블릿/.test(qKinds[1] ?? '') && /^카운터/.test(qKinds[2] ?? '') && qPrimary.length === 1 && /^기사 휴대폰/.test(qPrimary[0] ?? ''),
    String(chooseClass) + ' · ' + qKinds.join(' | '));
    // 잘못 고름: 카운터(포스) → 로그인 줄에 기기 모양, 바닥줄의 `기기 선택`으로 이 기기의 등록을 끊고 기기 선택으로 돌아간다.
    await q.locator('.pos-choose .pos-big-choice', { hasText: '카운터' }).click();
    await q.waitForSelector('.pos-login-tile', { timeout: STEP_MS });
    const wrongLine = (await q.locator('.pos-login .pos-card-line').first().textContent())?.trim() ?? '';
    const releaseButton = q.locator('.pos-login-foot').getByRole('button', { name: '기기 선택', exact: true });
    await shot(q, 'q-wrong-kind-360x640');
    check('Q: 잘못 고른 카운터의 로그인 줄에 기기 모양(카운터(포스)) · 바닥줄에 기기 선택', / · 카운터\(포스\)$/.test(wrongLine) && (await releaseButton.count()) === 1, wrongLine);
    await releaseButton.click();
    const reChoose = await q.waitForSelector('.pos-choose', { timeout: STEP_MS }).then(() => true, () => false);
    check('Q: 기기 선택 → 이 기기의 등록을 끊고 다시 기기 선택으로', reChoose);
    await q.locator('.pos-choose .pos-big-choice', { hasText: '기사 휴대폰' }).click();
    await q.waitForSelector('.pos-choose-tile', { timeout: STEP_MS });
    const vans = (await q.locator('.pos-choose-tile').allTextContents()).map((t) => t.trim());
    const vanTitle = (await q.locator('.pos-choose-vehicles h1').textContent())?.trim();
    await shot(q, 'q-vehicle-360x640');
    check('Q: 기사 휴대폰 → `차량 선택` 1호 차량 · 2호 차량(매장 차량)', vanTitle === '차량 선택' && vans.join(',') === '1호 차량,2호 차량', vanTitle + ' · ' + vans.join(','));
    await q.locator('.pos-choose-tile', { hasText: '1호 차량' }).click();
    await q.waitForSelector('.pos-login-tile', { timeout: STEP_MS });
    const qTiles = (await q.locator('.pos-login-tile').allTextContents()).map((t) => t.trim());
    const qLine = (await q.locator('.pos-login .pos-card-line').first().textContent())?.trim() ?? '';
    check('Q: 기사 기기의 로그인 타일은 기사만 · 로그인 줄에 기사 휴대폰 · 1호 차량', qTiles.join(',') === STAFF.driver && / · 기사 휴대폰 · 1호 차량$/.test(qLine), qTiles.join(',') + ' · ' + qLine);
    await login(q, STAFF.driver, openPins[STAFF.driver]);
    await q.waitForFunction(() => /#\/driver\/\d{4}-\d{2}-\d{2}/.test(location.hash), null, { timeout: STEP_MS });
    await q.waitForSelector('.sn-header', { timeout: STEP_MS });
    await shot(q, 'q-driver-360x640');
    const qClass = await q.evaluate(() => document.querySelector('.sn-root')?.getAttribute('data-device'));
    const qSession = await q.evaluate(() => fetch('api/v2/session', { cache: 'no-store' }).then((r) => r.json()));
    check('Q: 비밀번호 로그인 → 기사 휴대폰 등급의 수거 목록, 1호 차량 · 시험 기기 3(놓은 2는 다시 쓰지 않음)', qClass === 'driver_phone'
      && qSession?.device?.kind === 'driver_phone' && qSession?.device?.vehicleId === 'v1' && qSession?.device?.label === '시험 기기 3', JSON.stringify(qSession?.device));
    const ledgerQ = await pageQuery(q, { name: 'ledgerView', params: { viewKey: 'day_ledger' } });
    check('Q: 스스로 등록한 기사 휴대폰도 장부 조회는 403', ledgerQ.status === 403, String(ledgerQ.status));

    const openHealth = await fetch(`http://127.0.0.1:${openServerPort}/api/health`).then((r) => r.json()).catch(() => null);
    check('열린 등록 서버 안의 상태: TEST_OPEN_ENROLL 경고 · 켜짐 · 열린 기기 2대', openHealth?.warnings?.includes('TEST_OPEN_ENROLL')
      && openHealth?.testOpenEnroll?.active === true && openHealth?.testOpenEnroll?.devices === 2 && openHealth?.ok === true, JSON.stringify(openHealth?.testOpenEnroll));
    const firstHealth = await fetch(`http://127.0.0.1:${serverPort}/api/health`).then((r) => r.json()).catch(() => null);
    check('첫 서버 안의 상태에는 TEST_OPEN_ENROLL 경고가 없음', Array.isArray(firstHealth?.warnings) && !firstHealth.warnings.includes('TEST_OPEN_ENROLL'), JSON.stringify(firstHealth?.warnings));

    // 기기 끊기는 그대로: 명령줄(관리 소켓)로 Q를 끊으면 세션이 끝나고 다시 기기 선택으로(열린 등록이 켜져 있으니 번호 화면이 아님).
    const revokeOpen = await runCli(['revoke-device', '--shop', OPEN_SHOP, '--device', '시험 기기 3'], openEnv, cliLog);
    check('명령줄 revoke-device: 스스로 등록한 기사 휴대폰(시험 기기 3)', revokeOpen.code === 0, revokeOpen.out.trim());
    const backToChoose = await q.waitForSelector('.pos-choose', { timeout: 20_000 }).then(() => true, () => false);
    await shot(q, 'q-revoked-360x640');
    check('Q: 끊은 기기는 곧 기기 선택으로(세션 끝 · 열쇠 지움)', backToChoose);

    // 설정을 끄고 다시 켜면 스스로 붙은 기기는 모두 끊긴다. O는 서버가 없는 동안 빈 주소로 두었다가(알림 연결의 오류 줄 없이) 다시 열면 기기
    // 등록(등록 번호) 화면, 기기 선택에 있던 Q는 등록 방법을 다시 물어(화면이 다시 보임) 숫자판과 한 줄로.
    await o.goto('about:blank');
    await stopChild(openServer);
    openServer = null;
    openRuns += 1;
    openServer = startChild([SERVER_MAIN], { ...openEnv, SKINOTE_TEST_OPEN_ENROLL: 'off' }, join(OUT, 'open-server-' + openRuns + '.log'));
    await waitHealthy(openServerPort, openServer);
    await o.goto(openProxy.url);
    const oCut = await o.waitForSelector('.pos-enroll', { timeout: STEP_MS }).then(() => true, () => false);
    await shot(o, 'o-cut-1024x600');
    const offHealth = await fetch(`http://127.0.0.1:${openServerPort}/api/health`).then((r) => r.json()).catch(() => null);
    check('설정을 끄고 다시 켠 서버: 스스로 붙은 O가 끊겨 기기 등록 화면으로, 상태 확인은 끊은 1대 · 경고 없음', oCut && offHealth?.testOpenEnroll?.flag === 'off'
      && offHealth?.testOpenEnroll?.devices === 0 && offHealth?.testOpenEnroll?.cutAtStart === 1 && !offHealth?.warnings?.includes('TEST_OPEN_ENROLL'), JSON.stringify(offHealth?.testOpenEnroll));
    await q.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const qClosed = await q.waitForSelector('.pos-enroll .sn-keypad-note', { timeout: STEP_MS }).then(() => true, () => false);
    const qClosedNote = qClosed ? (await q.locator('.pos-enroll .sn-keypad-note').textContent())?.trim() : '';
    await shot(q, 'q-closed-360x640');
    check('Q: 기기 선택에 있던 기기는 숫자판으로, 한 줄 `기기 선택 종료 · 등록 번호 필요`', qClosedNote === '기기 선택 종료 · 등록 번호 필요', String(qClosedNote));

    check('페이지 오류 없음', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
    for (const ctx of [ctxA, ctxB, ctxC, ctxD, ctxE, ctxO, ctxQ]) await ctx.close();
  } catch (error) {
    check('끝까지 돌기', false, String(error?.stack ?? error).split('\n').slice(0, 4).join(' | '));
    // 실패한 때의 화면(열린 창마다).
    let n = 0;
    for (const ctx of browser?.contexts() ?? []) for (const page of ctx.pages()) await shot(page, 'fail-' + (n += 1));
  } finally {
    await browser?.close().catch(() => {});
    await proxy?.close().catch(() => {});
    await demoProxy?.close().catch(() => {});
    await openProxy?.close().catch(() => {});
    await stopChild(server);
    await stopChild(openServer);
    writeFileSync(join(OUT, 'proxy.log'), proxyLines.join('\n') + '\n');
    // 기록 확인: 처리 오류 · 처리하지 않은 예외 · 비밀번호 · 등록 번호.
    const openLogs = [1, 2, 3].map((n) => join(OUT, 'open-server-' + n + '.log')).filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n');
    const logs = [1, 2, 3].map((n) => join(OUT, 'server-' + n + '.log')).filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n')
      + '\n' + openLogs + '\n' + (existsSync(cliLog) ? readFileSync(cliLog, 'utf8') : '') + '\n' + proxyLines.join('\n');
    // 비밀은 숫자 경계로 찾는다(앞뒤가 숫자가 아닌 자리): 짧은 비밀번호가 `1234ms` 같은 기록 숫자 안에 우연히 든 것은 새지 않은 것이다(2026-09-27
    // 점검: 경계 없는 찾기가 우연히 걸려 다시 돌리는 일이 있었다).
    const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leaks = secretsSeen.filter((s) => s && new RegExp('(?<!\\d)' + escape(s) + '(?!\\d)(?!ms)').test(logs));
    if (openRuns > 1) {
      check('열린 등록 서버 기록: 시작의 주의 줄 · 등록마다 ALERT open_enroll 세 줄 · 끈 뒤 시작의 끊음 줄', /주의: 열린 기기 등록 켬/.test(openLogs)
        && (openLogs.match(/ALERT open_enroll e2e1open/g) ?? []).length === 3 && (openRuns < 3 || /ALERT open_enroll_cut e2e1open · 열린 등록 꺼짐\(open_enroll_off\) · 시험 기기 1대 끊음/.test(openLogs)),
        (openLogs.match(/ALERT open_enroll.*/g) ?? []).join(' | ').slice(0, 200));
    }
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
