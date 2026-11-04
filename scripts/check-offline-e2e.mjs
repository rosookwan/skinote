// 기사 연결 끊김 끝까지 시험(work/impl-offline/plan.md §10 E2E S6 · §11 S4, sync-and-concurrency 8-4 S6): 산에서 개인 휴대폰의 연결이 끊겨도 기사는
// 기록하고, 다시 이으면 기록이 하나도 빠지지 않고 두 번 세지도 않는다. 빌드한 앱을 로컬 앞단(scripts/lib/local-proxy.mjs)으로, 진짜 서버를 임시 자료
// 폴더 · 무작위 비밀값 · 짧은 끊김 판정(SKINOTE_LINK_OFFLINE_MS=5000)으로 띄워 브라우저(Playwright chromium) 넷으로 쓴다.
//
//   준비: 시험 매장(첫 매장 견본 하루 · 직원 넷: 관리자 · 카운터 · 1호 차량 기사 · 2호 차량 기사) · 등록 번호 넷(카운터 둘 · 기사 휴대폰 둘)
//   A 카운터(1024×600, 카운터 역할) · B 관리자 카운터(1024×600) · E 1호 차량 기사 휴대폰(360×640) · F 2호 차량 기사 휴대폰(360×640)
//   1. A가 박준호 팀(0022)을 지급 → E 등록 · 로그인 → 서비스 워커가 화면을 맡음 · 저장 공간 유지(persist)를 청함
//   2. 두 창: E의 둘째 창이 같은 팀의 현장 수납(현금 20,000원)을 같은 순간에 → 하나만 보냄 대기, 다른 창은 `받을 금액 변경됨 · 재시도 필요`와
//      지금 미수로 다시 물은 판, 서버의 돈은 한 번(E가 Chromium에서 서명한 첫 묶음을 서버가 받음)
//   3. 저장 중 닫힌 창: 수거 확인 뒤 점선이 보이자 창을 닫음 → 다시 열면 한 번, 확인을 누르자마자 닫음 → 한 번이거나 없음(번호는 빈틈 없이)
//   4. 숨은 창: F가 숨으면(visibilitychange → hidden) 마지막 알림이 가고 끊김 판정 뒤에도 2호 차량 표시가 없음(조용함)
//   5. E 끊김(context.setOffline): 이도윤(T5) · 서지훈(T6) · 한동수(7) 수거, 임하늘 `수거 실패`(고객 부재), 박준호 현금 35,000원, 윤서준(8) 현금 수납 →
//      점선 도장 · 띠 `연결 끊김 · 전송 대기 6` · `매장 입고` → `입고 불가 · 연결 끊김` · `전화` → 사본의 온전한 번호
//   6. 끊긴 채 새로 고침 → 서버 없이 기억한 세션으로 같은 목록(점선 · 띠), 백승현 수거 하나 더(새 창의 시계)
//   7. 그사이 A: 수거 목록 제목 줄 `1호 차량 연결 끊김 · …부터` → 한동수 매장 반납 → 윤서준의 같은 돈을 카운터에서 → 이도윤 · 서지훈 일정 변경(경고
//      `… 수거 여부 미확인`) → 2호 차량 → F가 서지훈을 먼저 수거, 이도윤은 F의 목록에 남음
//   8. 마감: A(카운터 역할)는 막는 단계 `1호 차량 연결 끊김 · …부터 · 마감 전 전송 필요` + `권한 없음 · 관리자 확인 필요`, B(관리자)는 `관리자 승인` →
//      본인 비밀번호 → 사유 → 마감 명령의 첫 답을 잃음(context.route) → 같은 요청번호로 다시 보내 `applied` → 얼린 표의 1호 차량 현금 `점검 이월` ·
//      그때의 사실 `마지막 연결 … · 전송 대기 있음`
//   9. E 다시 이음: 첫 묶음의 답을 잃음(서버에는 감) → 결과 확인 중 → 다시 보내 첫 결과
//   10. E 띠 `전송 대기 0` · 실선 · 한동수 줄 메모 `매장 반납 완료` · 윤서준 업무 판 `중복 수납 의심`, 이도윤은 F의 목록에서 빠짐, A의 확인 필요에
//      task_moved_meanwhile · already_returned · collect_exceeds · late_money · possible_duplicate_money
//   11. 사본 형식: 끊긴 채 수거 하나 → 저장된 사본의 판(stateVersion)을 0으로 → 새로 고침 → 연결 끊김 화면 `전송 대기 1` → 이으면 보내고 새 사본 · 목록
//   11b. 끊긴 채 로그아웃 → 사본 · 세션 칸은 곧바로 지우고 서버에 닿지 못한 로그아웃 표시 → 다시 이어 새로 고침 → 서버 세션을 먼저 끝내고(401) 로그인
//      화면(서버의 살아 있는 세션만으로 목록을 열지 않음, plan §17-2 R3-7)
//   12. 서버를 멈추고 매장 파일(읽기 전용): E의 기기 번호 1…n 빈틈 없음 · 서명 · 새로 고침 전 wall_clock / 뒤 monotonic, 35,000원 한 번(1호 차량 ·
//      다음 날 기록), 보류 없음, 사본 열람 기록은 사본마다가 아님, 마감의 넘긴 사유 · 차량 연결 사실, 돈과 재고(두 번 세지 않음)
//   13. 서버 · 명령줄 · 앞단 기록에 비밀번호 · 등록 번호 · 서명 · 명령 본문이 없음
//
// 실행: npm run build && npm run test:e2e:offline   (찍은 화면 · 기록은 work/e2e/offline-<시각>/, 저장소에 올리지 않음)
//   환경 변수: SKINOTE_E2E_HEADED=1(창을 보이며), SKINOTE_E2E_KEEP=1(임시 자료 폴더를 지우지 않음)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadSecrets, newSecretsEnv } from '../packages/server/src/secrets.js';
import {
  DIST, ROOT, SERVER_MAIN, STEP_MS, codeOf, enroll, freePort, leaksIn, login, makeReporter, makeShot, orderOf, pageQuery, pageSend, pinsOf, runCli, sleep,
  startChild, stopChild, waitHealthy,
} from './lib/e2e-harness.mjs';
import { startLocalProxy } from './lib/local-proxy.mjs';

const SHOP = 'e2e2offline';
const STAFF = { manager: '한가람', counter: '오세린', driver: '문태오', driver2: '윤지호' };
/** 견본 하루의 팀(끝 4자리): 걸음마다 다른 팀을 쓴다. */
const TEAM = {
  pay: '0022', // 박준호: A가 지급 → 두 창 20,000원(연결됨) → 끊긴 채 35,000원(마감 뒤에 도착)
  first: '0025', // 김민수: 점선이 보이자 닫은 창
  early: '0041', // 정하늘: 확인을 누르자마자 닫은 창
  t5: '0029', // 이도윤: 끊긴 채 수거 → 그사이 2호 차량으로 옮김(F는 수거하지 않음)
  t6: '0031', // 서지훈: 끊긴 채 수거 → 그사이 2호 차량으로 옮기고 F가 먼저 수거
  t7: '0034', // 한동수: 끊긴 채 수거 → 그사이 매장 반납
  absent: '0037', // 임하늘: 끊긴 채 수거 실패(고객 부재, 내일)
  t8: '0028', // 윤서준: 끊긴 채 현금 수납 → 그사이 카운터가 같은 돈을 받음
  later: '0035', // 백승현: 끊긴 채 새로 고친 뒤 수거(새 창의 시계) · 끊긴 채 전화
  format: '0033', // 조은비: 사본 형식 걸음의 수거
};
const LINK_OFFLINE_MS = 5_000;
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(ROOT, 'work/e2e', 'offline-' + RUN);

const { results, check } = makeReporter();
const shot = makeShot(OUT);

// ── 기사 휴대폰 걸음 ───────────────────────────────────────────────────────

const bandText = async (page) => ((await page.locator('.sn-strip').first().textContent({ timeout: 1_000 }).catch(() => '')) ?? '').trim();

/** 띠가 조건을 채울 때까지(ms). 마지막 띠 글. */
async function waitBand(page, test, ms = 30_000) {
  const until = Date.now() + ms;
  let text = '';
  while (Date.now() < until) {
    text = await bandText(page);
    if (test(text)) return text;
    await sleep(250);
  }
  return text;
}

/** 업무 판을 연다(같은 문서 안의 주소 바꿈이라 끊겨도 된다). */
async function openTask(page, app, taskId) {
  await page.goto(app + '#/driver/tasks/' + encodeURIComponent(taskId));
  await page.waitForSelector('.pos-task-sheet', { timeout: STEP_MS });
  await page.waitForSelector('.pos-task-sheet .pos-task-items tr.sn-row', { timeout: STEP_MS });
}

/** 기사 목록(수거)으로. */
async function openList(page, app, date) {
  await page.goto(app + '#/driver/' + date);
  await page.waitForSelector('.sn-ledger tr.sn-row', { timeout: STEP_MS });
}

/** 같은 기기(같은 브라우저 저장소)의 새 창: 앱을 열어 목록이 뜬 뒤(기억한 세션) 그 업무 판으로. */
async function reopen(ctx, app, taskId, watchPage, who) {
  const page = await ctx.newPage();
  watchPage(page, who);
  await page.goto(app);
  await page.waitForSelector('.sn-ledger tr.sn-row', { timeout: STEP_MS });
  if (taskId) await openTask(page, app, taskId);
  return page;
}

/** 업무 판의 주 버튼(수거 처리 · n개) → 확인 창의 주 버튼. 누른 이름. wait false: 확인을 누른 뒤 창이 닫히기를 기다리지 않는다(닫히는 창 걸음). */
async function collectOnSheet(page, { wait = true } = {}) {
  const primary = page.locator('.sn-footer [data-primary="true"]');
  await page.waitForFunction(() => {
    const b = document.querySelector('.sn-footer [data-primary="true"]');
    return b && !b.hasAttribute('disabled') && /^수거 처리 · /.test((b.textContent ?? '').trim());
  }, null, { timeout: STEP_MS });
  const label = ((await primary.textContent()) ?? '').trim();
  await primary.click();
  const ok = page.locator('[role="dialog"] [data-primary="true"]');
  await ok.waitFor({ timeout: STEP_MS });
  await ok.click({ noWaitAfter: true });
  if (wait) await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  return label;
}

/** 업무 판의 도장: 점선(보냄 대기) · 미처리 · 끝남(실선) 수. */
async function sheetStamps(page) {
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll('.pos-task-items button.sn-stamp-cell')].map((b) => b.getAttribute('aria-label') ?? '');
    return { pending: cells.filter((x) => x.includes('전송 대기') || x.includes('결과 확인 중')).length, todo: cells.filter((x) => x.endsWith('미처리')).length, all: cells.length };
  });
}

/** 업무 판의 큰 버튼(현장 수납 · 수거 실패 · 전화). */
const sheetAction = (page, name) => page.locator('.pos-task-actions button', { hasText: name }).first();

/** 현장 수납 판: 금액을 지우고 digits를 친 뒤(없으면 받을 돈 그대로) 주 버튼 이름이 맞을 때까지. 판과 주 버튼 이름. */
async function openFieldPay(page, digits) {
  await sheetAction(page, '현장 수납').click();
  const panel = page.locator('.pos-field-pay');
  await panel.waitFor({ timeout: STEP_MS });
  await page.waitForFunction(() => /^현장 수납 · /.test((document.querySelector('.pos-field-pay [data-primary="true"]')?.textContent ?? '').trim()), null, { timeout: STEP_MS });
  if (digits !== undefined) {
    const keys = panel.locator('.sn-keypad-keys');
    for (let guard = 0; guard < 12 && ((await panel.locator('.pos-field-pay-amount output').textContent()) ?? '').trim() !== ''; guard += 1) {
      await keys.getByRole('button', { name: '정정', exact: true }).click();
    }
    for (const key of digits) await keys.getByRole('button', { name: key, exact: true }).click();
    const want = '현장 수납 · 현금 ' + Number(digits.join('')).toLocaleString('ko-KR') + '원';
    await page.waitForFunction((label) => {
      const b = document.querySelector('.pos-field-pay [data-primary="true"]');
      return b && !b.hasAttribute('disabled') && (b.textContent ?? '').trim() === label;
    }, want, { timeout: STEP_MS });
  }
  const primary = panel.locator('[data-primary="true"]');
  await page.waitForFunction(() => !document.querySelector('.pos-field-pay [data-primary="true"]')?.hasAttribute('disabled'), null, { timeout: STEP_MS });
  return { panel, primary, label: ((await primary.textContent()) ?? '').trim() };
}

/** 기사 목록에서 끝 4자리의 줄(쪽을 넘겨 찾는다). 없으면 null. */
async function findRow(page, last4) {
  const pager = (name) => page.locator('.sn-footer').getByRole('button', { name, exact: true });
  for (let guard = 0; guard < 8 && await pager('이전 쪽').count() && await pager('이전 쪽').isEnabled(); guard += 1) await pager('이전 쪽').click();
  for (let guard = 0; guard < 8; guard += 1) {
    const row = page.locator('.sn-ledger tr.sn-row', { hasText: last4 });
    if (await row.count()) return row.first();
    if (!(await pager('다음 쪽').count()) || !(await pager('다음 쪽').isEnabled())) return null;
    await pager('다음 쪽').click();
  }
  return null;
}

/** 줄의 도장 글(aria-label)들. */
const rowStamps = async (row) => (row ? row.locator('button.sn-stamp-cell').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? '')) : []);

/** 이 창(같은 기기 저장소)의 보냄 대기 · 보낸 기록의 평문 머리(요청번호 · 번호 · 종류 · 업무 · 결과). */
async function localRecords(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('skinote-local');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['queue', 'sent'], 'readonly');
      const out = { queue: [], sent: [] };
      const pick = (r) => ({ requestId: r.requestId, seq: r.seq, type: r.type, taskId: r.taskId, state: r.state, outcome: r.outcome, reviews: r.reviews ?? [] });
      tx.objectStore('queue').getAll().onsuccess = (e) => { out.queue = e.target.result.map(pick); };
      tx.objectStore('sent').getAll().onsuccess = (e) => { out.sent = e.target.result.map(pick); };
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = () => { db.close(); resolve(null); };
    };
  }));
}

/** 기기 메모의 서버에 닿지 못한 로그아웃 표시와 사본 · 세션 칸 수(plan §17-2 R3-7 · R3-9, 봉인하지 않은 칸만 읽는다). */
async function localSignOut(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('skinote-local');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['meta', 'snapshot', 'session'], 'readonly');
      const out = { marker: null, snapshot: -1, session: -1 };
      tx.objectStore('meta').getAll().onsuccess = (e) => { out.marker = e.target.result.find((r) => typeof r.signOutPending === 'string')?.signOutPending ?? null; };
      tx.objectStore('snapshot').count().onsuccess = (e) => { out.snapshot = e.target.result; };
      tx.objectStore('session').count().onsuccess = (e) => { out.session = e.target.result; };
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = () => { db.close(); resolve(null); };
    };
  }));
}

/** 이 기기의 보냄 대기가 빌 때까지(보내고 사본에 든 항목은 보낸 기록으로 옮겨진다). 빈 채로 끝났는지. */
async function queueDrained(page, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const local = await localRecords(page);
    if (local && local.queue.length === 0) return true;
    await sleep(300);
  }
  return false;
}

/** 저장된 사본의 평문 판(stateVersion)을 바꾼다(새 빌드가 모르는 사본을 흉내, R2 23). */
async function setCopyVersion(page, version) {
  return page.evaluate((v) => new Promise((resolve) => {
    const req = indexedDB.open('skinote-local');
    req.onerror = () => resolve(false);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('snapshot', 'readwrite');
      const store = tx.objectStore('snapshot');
      store.get('copy').onsuccess = (e) => { const r = e.target.result; if (r) store.put({ ...r, stateVersion: v }); };
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); resolve(false); };
    };
  }), version);
}

// ── 카운터 걸음 ────────────────────────────────────────────────────────────

/** 접수증의 옆 동작(더 보기 안일 수 있음). */
async function sideAction(page, name) {
  const direct = page.locator('.pos-counter-detail-actions button', { hasText: name });
  if (await direct.count()) { await direct.first().click(); return; }
  await page.locator('.pos-counter-detail-actions').getByRole('button', { name: '추가 처리', exact: true }).click();
  const choice = () => page.locator('[role="dialog"] .pos-choice-button', { hasText: name });
  const next = page.locator('[role="dialog"]').getByRole('button', { name: '다음 쪽' });
  for (let guard = 0; guard < 4 && !(await choice().count()) && await next.count() && await next.isEnabled(); guard += 1) await next.click();
  await choice().first().click();
}

/** 카운터의 매장 반납: 접수증 처리 현황의 `반납` → (차량 수거 알림이면 `매장 반납 처리`) → 반납 창의 주 버튼. 누른 이름. */
/**
 * 기사 휴대폰의 전송 대기 목록(§17 R3-19): 머리줄의 `전송 대기` 또는 더 보기 판의 `전송 대기 n` → 창의 제목과 쪽마다의 줄(`이름 · 둘째 줄`). 닫고 돌아온다.
 * @returns {Promise<{ title: string, rows: string[] }>}
 */
async function readPendingList(page) {
  const header = page.locator('.sn-header');
  const direct = header.getByRole('button', { name: /^전송 대기 \d+건$/ });
  if (await direct.count()) await direct.first().click();
  else {
    await header.getByRole('button', { name: /^더 보기/ }).first().click();
    await page.locator('.pos-choice-button', { hasText: /^전송 대기 \d+$/ }).first().click({ timeout: STEP_MS });
  }
  const dialog = page.locator('[role="dialog"]', { has: page.locator('.pos-pending-rows') });
  await dialog.waitFor({ timeout: STEP_MS });
  const title = ((await dialog.locator('.sn-dialog-title').textContent()) ?? '').trim();
  const rows = [];
  for (let guard = 0; guard < 10; guard += 1) {
    for (const row of await dialog.locator('.pos-pending-row').all()) rows.push(((await row.textContent()) ?? '').trim());
    const next = dialog.getByRole('button', { name: '다음 쪽' });
    if (!(await next.count()) || !(await next.isEnabled())) break;
    await next.click();
    await sleep(100);
  }
  await dialog.getByRole('button', { name: '닫기' }).click();
  await dialog.waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  return { title, rows };
}

async function counterReturn(page, app, orderId, notice = { text: '' }) {
  await page.goto(app + '#/orders/' + orderId);
  await page.waitForSelector('.pos-counter-detail', { timeout: STEP_MS });
  await sideAction(page, '반납 처리');
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ timeout: STEP_MS });
  // 차량 수거 팀이면 먼저 알림(`1호 차량 수거 예정 · …`, 끊긴 차량이면 그 사실 한 줄 — §17 R3-23): 부르는 쪽이 본다.
  notice.text = ((await dialog.textContent()) ?? '').trim();
  const other = page.locator('[role="dialog"] .pos-notice-actions button:not([data-primary="true"])', { hasText: '매장 반납' }).first();
  if (!(await page.locator('[role="dialog"] [data-primary="true"]').count()) && await other.count()) await other.click();
  const ok = page.locator('[role="dialog"] [data-primary="true"]').first();
  await page.waitForFunction(() => {
    const b = document.querySelector('[role="dialog"] [data-primary="true"]');
    return b && !b.hasAttribute('disabled') && /^반납 처리/.test((b.textContent ?? '').trim());
  }, null, { timeout: STEP_MS });
  const label = ((await ok.textContent()) ?? '').trim();
  await ok.click();
  await page.locator('[role="dialog"]').first().waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  return label;
}

/** 일정 변경 창: 모든 줄을 최대까지 → 경고 줄 → 수거 차량 → 주 버튼. { warning, label }. */
async function moveToVan(page, app, orderId, vehicle, shotName, shotFn) {
  await page.goto(app + '#/orders/' + orderId);
  await page.waitForSelector('.pos-counter-detail', { timeout: STEP_MS });
  await sideAction(page, '일정 변경');
  const dialog = page.locator('.pos-promise');
  await dialog.waitFor({ timeout: STEP_MS });
  for (let guard = 0; guard < 12; guard += 1) {
    const plus = dialog.locator('button[aria-label="수량 증가"]:enabled');
    if (!(await plus.count())) break;
    await plus.first().click();
    await sleep(150);
  }
  await dialog.getByRole('group', { name: '수거 차량', exact: true }).getByRole('button', { name: vehicle, exact: true }).click();
  await page.waitForFunction(() => {
    const b = document.querySelector('.pos-promise [data-primary="true"]');
    return b && !b.hasAttribute('disabled');
  }, null, { timeout: STEP_MS });
  // 옮기는 줄이 끊긴 차량의 열린 수거에 있으면 `유지` 줄 자리에 경고(바꿈이 생긴 뒤).
  await page.waitForSelector('.pos-promise .pos-summary-link', { timeout: 5_000 }).catch(() => {});
  const warning = ((await dialog.locator('.pos-summary-link .sn-fit').first().textContent({ timeout: 1_000 }).catch(() => '')) ?? '').trim();
  await shotFn(page, shotName);
  const label = ((await dialog.locator('[data-primary="true"]').textContent()) ?? '').trim();
  await dialog.locator('[data-primary="true"]').click();
  await dialog.waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
  return { warning, label };
}

/**
 * 마감 화면을 막는 단계까지: 막힌 차량의 현금 줄은 `점검 이월`, 돈통은 예상 금액 그대로 점검 → 주 버튼 `마감 · …` → 막는 단계 창.
 * { stepLabel, note, approve(버튼 수) }.
 */
async function closingToStep(page, app, date) {
  await page.goto(app + '#/closing/' + date);
  await page.waitForSelector('.pos-closing-table', { timeout: STEP_MS });
  const primary = () => page.locator('.sn-footer [data-primary="true"]');
  for (let guard = 0; guard < 4; guard += 1) {
    const text = ((await primary().textContent()) ?? '').trim();
    if (/^차량 현금 점검/.test(text)) {
      // 끊긴 차량의 현금은 세지 않고 넘긴다(점검 이월): 기사가 돌아오기 전이다.
      const defer = page.locator('.pos-closing-left tr.sn-row button.sn-cell-action', { hasText: '점검 이월' }).first();
      await defer.click();
      await page.waitForFunction(() => !/^차량 현금 점검/.test((document.querySelector('.sn-footer [data-primary="true"]')?.textContent ?? '').trim()), null, { timeout: STEP_MS });
      continue;
    }
    if (/^돈통 점검/.test(text)) {
      await primary().click();
      const panel = page.locator('.pos-cash-check');
      await panel.waitFor({ timeout: STEP_MS });
      await page.waitForFunction(() => /예상 [\d,]+원/.test(document.querySelector('.pos-cash-check .pos-cash-check-line')?.textContent ?? ''), null, { timeout: STEP_MS });
      const expected = /예상 ([\d,]+)원/.exec((await panel.locator('.pos-cash-check-line').first().textContent()) ?? '')?.[1]?.replace(/,/g, '') ?? '';
      for (const d of expected) await panel.locator('.sn-keypad-keys').getByRole('button', { name: d, exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.pos-cash-check [data-primary="true"]')?.hasAttribute('disabled'), null, { timeout: STEP_MS });
      await panel.locator('[data-primary="true"]').click();
      await panel.waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
      continue;
    }
    break;
  }
  await page.waitForFunction(() => /^마감/.test((document.querySelector('.sn-footer [data-primary="true"]')?.textContent ?? '').trim()), null, { timeout: STEP_MS });
  await primary().click();
  const step = page.locator('[role="dialog"] .sn-review-step');
  await step.waitFor({ timeout: STEP_MS });
  return {
    stepLabel: ((await step.getAttribute('aria-label')) ?? '').trim(),
    note: ((await page.locator('[role="dialog"] .pos-closing-step-note').textContent().catch(() => '')) ?? '').trim(),
    approve: await page.locator('[role="dialog"]').getByRole('button', { name: '관리자 승인', exact: true }).count(),
  };
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('빌드한 앱이 없습니다(' + DIST + '). 먼저 npm run build');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'sn-offline-'));
  const [serverPort, proxyPort] = [await freePort(), await freePort()];
  const secrets = newSecretsEnv();
  const env = {
    ...process.env,
    SKINOTE_DATA_DIR: join(tmp, 'data'),
    SKINOTE_SHOP_IDS: SHOP,
    SKINOTE_PORT: String(serverPort),
    SKINOTE_HOST: '127.0.0.1',
    SKINOTE_RELEASE: 'e2e-offline',
    SKINOTE_BACKUP_RESERVE_MB: '0',
    SKINOTE_ADMIN_SOCKET: join(tmp, 'a.sock'),
    SKINOTE_API: 'on',
    SKINOTE_LINK_OFFLINE_MS: String(LINK_OFFLINE_MS),
    ...secrets,
  };
  delete env.SKINOTE_PUBLIC_ORIGIN;
  delete env.SKINOTE_DRIVER_LOCAL_FIRST;
  const cliLog = join(OUT, 'cli.log');
  const proxyLines = [];
  /** 기록에 나오면 안 되는 비밀(비밀번호 · 등록 번호 · 서명). */
  const secretsSeen = [];
  let server = null;
  let serverRuns = 0;
  let proxy = null;
  let browser = null;
  /** 끝의 매장 파일 확인에 쓸 것(브라우저가 닫힌 뒤). */
  const facts = { date: '', ids: /** @type {Record<string, string>} */ ({}), deviceE: '', local: null, snapshotCalls: 0, t8Due: 0, early: 'none', stopped: null };
  const startServer = async () => {
    serverRuns += 1;
    const child = startChild([SERVER_MAIN], env, join(OUT, 'server-' + serverRuns + '.log'));
    await waitHealthy(serverPort, child);
    return child;
  };
  try {
    // ── 준비 ───────────────────────────────────────────────────────────
    server = await startServer();
    await stopChild(server);
    server = null;
    const made = await runCli(['provision', '--shop', SHOP, '--code', 'e2e-offline', '--name', '시험 매장', '--sample', '--test',
      '--staff', STAFF.manager + ':manager', '--staff', STAFF.counter + ':counter', '--staff', STAFF.driver + ':driver:v1', '--staff', STAFF.driver2 + ':driver:v2'], env, cliLog);
    const pins = pinsOf(made.out);
    if (!check('준비: 시험 매장 · 직원 넷(관리자 · 카운터 · 1호 차량 기사 · 2호 차량 기사)', made.code === 0 && Object.keys(pins).length === 4, '끝 코드 ' + made.code + ' · ' + made.err.trim().split('\n').pop())) {
      throw new Error('매장을 만들지 못함');
    }
    secretsSeen.push(...Object.values(pins));
    const deviceCode = async (kind, label, vehicle) => {
      const r = await runCli(['device-code', '--shop', SHOP, '--kind', kind, '--label', label, ...(vehicle ? ['--vehicle', vehicle] : [])], env, cliLog);
      const code = codeOf(r.out);
      if (r.code !== 0 || !code) throw new Error('등록 번호를 받지 못함: ' + r.err);
      secretsSeen.push(code.digits, code.shown);
      return code.digits;
    };
    const codes = {
      a: await deviceCode('pos', '카운터 1'), b: await deviceCode('pos', '카운터 2'),
      e: await deviceCode('driver_phone', '1호 차량 기사 휴대폰', 'v1'), f: await deviceCode('driver_phone', '2호 차량 기사 휴대폰', 'v2'),
    };
    const sample = await runCli(['load-sample', '--shop', SHOP, '--date', 'today'], env, cliLog);
    check('준비: 오늘 견본 하루(첫 매장 모양 18팀)', sample.code === 0 && /접수\t18팀/.test(sample.out), '끝 코드 ' + sample.code);

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

    // ── 1. A · B 카운터, A가 박준호 팀 지급 ─────────────────────────────────
    const ctxA = await newContext();
    const a = await ctxA.newPage();
    watch(a, 'A');
    await a.goto(APP);
    await enroll(a, codes.a);
    await login(a, STAFF.counter, pins[STAFF.counter]);
    await a.waitForSelector('.sn-header, .pos-counter-header', { timeout: STEP_MS });
    const head = await a.evaluate(() => fetch('api/v2/head', { cache: 'no-store' }).then((r) => r.json()));
    const date = head.currentBusinessDate;
    facts.date = date;
    for (const [key, last4] of Object.entries(TEAM)) facts.ids[key] = (await orderOf(a, last4)) ?? '';
    const ids = facts.ids;
    check('A: 견본 팀을 끝 4자리로 찾음(' + Object.values(TEAM).join(' · ') + ')', Object.values(ids).every(Boolean), JSON.stringify(ids));
    await a.goto(APP + '#/orders/' + ids.pay);
    await a.waitForSelector('.pos-counter-detail', { timeout: STEP_MS });
    const issueLabel = ((await a.locator('.pos-counter-detail-actions [data-primary="true"]').textContent()) ?? '').trim();
    await a.locator('.pos-counter-detail-actions [data-primary="true"]').click();
    await a.locator('[role="dialog"] [data-primary="true"]').click();
    await a.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
    const payDue = async () => (await pageQuery(a, { name: 'orderSlip', params: { orderId: ids.pay } })).body?.money?.due;
    const dueBefore = await payDue();
    check('A: 박준호 팀 지급(`' + issueLabel + '`) → 반납 때 받을 미수 ' + dueBefore, /^지급 처리/.test(issueLabel) && typeof dueBefore === 'number' && dueBefore >= 55_000, String(dueBefore));

    const ctxB = await newContext();
    const b = await ctxB.newPage();
    watch(b, 'B');
    await b.goto(APP);
    await enroll(b, codes.b);
    await login(b, STAFF.manager, pins[STAFF.manager]);
    await b.waitForSelector('.sn-header, .pos-counter-header', { timeout: STEP_MS });

    // ── 1. E: 1호 차량 기사 휴대폰 ─────────────────────────────────────────
    const ctxE = await newContext({ width: 360, height: 640 });
    await ctxE.addInitScript(() => {
      const storage = navigator.storage;
      if (storage && typeof storage.persist === 'function') {
        const original = storage.persist.bind(storage);
        storage.persist = () => { window.__persistCalls = (window.__persistCalls ?? 0) + 1; return original(); };
      }
    });
    ctxE.on('request', (req) => { if (/\/api\/v2\/snapshot$/.test(new URL(req.url()).pathname)) facts.snapshotCalls += 1; });
    let e = await ctxE.newPage();
    watch(e, 'E');
    await e.goto(APP);
    await enroll(e, codes.e);
    await login(e, STAFF.driver, pins[STAFF.driver]);
    await e.waitForFunction(() => /#\/driver\/\d{4}-\d{2}-\d{2}/.test(location.hash), null, { timeout: STEP_MS });
    await e.waitForSelector('.sn-ledger tr.sn-row', { timeout: STEP_MS });
    const controlled = await e.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20_000 }).then(() => true, () => false);
    const persistCalls = await e.evaluate(() => window.__persistCalls ?? 0);
    const sessionE = await e.evaluate(() => fetch('api/v2/session', { cache: 'no-store' }).then((r) => r.json()));
    facts.deviceE = sessionE?.device?.id ?? '';
    await shot(e, 'e1-list-360x640');
    check('E: 등록 · 로그인 → 1호 차량 수거 목록 · 서비스 워커가 화면을 맡음 · 저장 공간 유지(persist)를 청함',
      controlled && persistCalls >= 1 && sessionE?.device?.kind === 'driver_phone' && sessionE?.vehicleId === 'v1', JSON.stringify({ controlled, persistCalls, kind: sessionE?.device?.kind, van: sessionE?.vehicleId }));

    // 긴급 확인도 실제 기사 저장소의 전송 대기를 거친다. 확인은 수거 완료가 아니며 카운터는 재연결 전 확인으로 읽으면 안 된다.
    const urgentOrders=[ids.t5,ids.t6,ids.t7];
    const urgentSent=[];
    for(const orderId of urgentOrders)urgentSent.push(await pageSend(a,'task.pin',{taskId:'collect:'+orderId}));
    const serverPins=async()=>((await pageQuery(a,{name:'reviewList',params:{}})).body?.pins??[]).filter(p=>urgentOrders.includes(p.orderId));
    let urgentPins=await serverPins();
    check('긴급: 카운터의 세 요청이 각각 저장되고 1호 차량 범위로 남음',urgentSent.every(r=>r.outcome?.outcome==='applied')&&urgentPins.length===3&&urgentPins.every(p=>p.vehicleLabel==='1호 차량'),'요청 '+urgentPins.length+'건');
    if(urgentPins.length!==3)throw new Error('긴급 합성 요청 준비 실패');
    const target=urgentPins.find(p=>p.orderId===ids.t5);
    const openUrgent=async()=>{
      await e.locator('.pos-urgent-bar').waitFor({timeout:STEP_MS});await e.locator('.pos-urgent-bar').click();await e.locator('.pos-urgent-list').waitFor({timeout:STEP_MS});
      const row=e.locator('.pos-urgent-row').filter({has:e.locator('.pos-urgent-team strong',{hasText:target.teamName})});
      for(let i=0;i<12 && !(await row.count());i+=1){
        const next=e.locator('.pos-urgent-list').getByRole('button',{name:'다음 쪽',exact:true});
        if(!(await next.count())||!(await next.isEnabled()))break;await next.click();
      }
      await row.waitFor({timeout:STEP_MS});return row;
    };
    await e.reload();await e.locator('.sn-ledger tr.sn-row').first().waitFor({timeout:STEP_MS});
    let urgentRow=await openUrgent();await e.keyboard.press('Escape');
    await ctxE.setOffline(true);await waitBand(e,x=>/^연결 끊김/.test(x),45_000);
    urgentRow=await openUrgent();await urgentRow.getByRole('button',{name:'요청 확인',exact:true}).click();
    await e.locator('.pos-urgent-list').getByText('확인 전송 대기',{exact:true}).waitFor({timeout:STEP_MS});
    urgentPins=await serverPins();
    check('긴급: 끊긴 기사 확인은 전송 대기이고 서버의 세 요청은 아직 미확인',urgentPins.length===3&&urgentPins.every(p=>p.status==='requested'),'서버 미확인 '+urgentPins.filter(p=>p.status==='requested').length+'건');
    await shot(e,'urgent-offline-pending-360x640');
    await e.reload();await e.locator('.sn-ledger tr.sn-row').first().waitFor({timeout:STEP_MS});urgentRow=await openUrgent();
    const queuedText=(await urgentRow.textContent())??'';
    check('긴급: 오프라인 새로고침 뒤에도 확인 전송 대기와 중복 확인 차단 유지',queuedText.includes('확인 전송 대기')&&await urgentRow.locator('button').isDisabled(),queuedText.slice(-100));
    await e.keyboard.press('Escape');await ctxE.setOffline(false);
    const urgentBand=await waitBand(e,x=>/^전송 대기 0( · |$)/.test(x),30_000);
    for(let i=0;i<40;i+=1){urgentPins=await serverPins();if(urgentPins.find(p=>p.pinId===target.pinId)?.status==='acknowledged')break;await sleep(250);}
    check('긴급: 재연결 뒤 한 건만 확인되고 세 업무와 나머지 미확인 두 건 유지',/^전송 대기 0( · |$)/.test(urgentBand)&&urgentPins.length===3&&urgentPins.filter(p=>p.status==='acknowledged').length===1&&urgentPins.filter(p=>p.status==='requested').length===2,urgentPins.map(p=>p.status).join(' · '));
    for(const pin of urgentPins)await pageSend(a,'task.unpin',{pinId:pin.pinId});
    check('긴급: 지정한 세 요청 해제 뒤 해당 긴급 목록이 비어 있음',(await serverPins()).length===0,'해제 후 요청 '+(await serverPins()).length+'건');
    await e.reload();await e.locator('.sn-ledger tr.sn-row').first().waitFor({timeout:STEP_MS});

    // ── 2. 두 창: 같은 팀의 현장 수납을 같은 순간에 ───────────────────────────
    const payTask = 'collect:' + ids.pay;
    await openTask(e, APP, payTask);
    const e2 = await reopen(ctxE, APP, payTask, watch, 'E2');
    const both = [await openFieldPay(e, ['2', '0', '000']), await openFieldPay(e2, ['2', '0', '000'])];
    await shot(e2, 'e2-two-pages-pay-360x640');
    await Promise.all(both.map((x) => x.primary.click({ noWaitAfter: true })));
    /** 판이 닫혔으면(보냄 대기) 'queued', 한 줄이 떴으면 그 줄. 한 번에 읽는다(기다리지 않는 읽기). */
    const settleOne = async (page) => {
      const until = Date.now() + STEP_MS;
      while (Date.now() < until) {
        const now = await page.evaluate(() => ({
          open: !!document.querySelector('.pos-field-pay'), error: (document.querySelector('.pos-field-pay .pos-dialog-error')?.textContent ?? '').trim(),
        }));
        if (!now.open) return 'queued';
        if (now.error) return now.error;
        await sleep(100);
      }
      return 'none';
    };
    const twoOutcomes = await Promise.all([settleOne(e), settleOne(e2)]);
    const refused = twoOutcomes[0] === 'queued' ? e2 : e;
    // 막힌 창은 판을 지금 자료로 다시 묻는다(다시 누를 때 옛 바탕으로 또 막히지 않게): 받을 금액 줄이 줄어든 미수.
    const dueLine = '미수 ' + (dueBefore - 20_000).toLocaleString('ko-KR') + '원';
    const refreshed = await refused.waitForFunction((line) => (document.querySelector('.pos-field-pay-due')?.textContent ?? '').includes(line), dueLine, { timeout: STEP_MS })
      .then(() => true, () => false);
    await shot(refused, 'e2-two-pages-after-360x640');
    check('두 창: 같은 순간의 현장 수납 20,000원 → 하나만 보냄 대기, 다른 창은 `받을 금액 변경됨 · 재시도 필요`와 다시 물은 `' + dueLine + '`',
      twoOutcomes.filter((x) => x === 'queued').length === 1 && twoOutcomes.includes('받을 금액 변경됨 · 재시도 필요') && refreshed, twoOutcomes.join(' | ') + ' · ' + refreshed);
    await e2.close();
    // 막힌 쪽 판이 남았으면 목록으로 나가며 닫는다(업무 판을 떠나면 판도 사라진다).
    await openList(e, APP, date);
    const paidOnce = await (async () => {
      for (let i = 0; i < 60; i += 1) { const due = await payDue(); if (due === dueBefore - 20_000) return due; await sleep(500); }
      return payDue();
    })();
    check('두 창: 서버의 박준호 미수가 20,000원 한 번만 줄어듦(E가 Chromium에서 서명한 묶음을 서버가 받음)', paidOnce === dueBefore - 20_000, dueBefore + ' → ' + paidOnce);

    // ── 3. 저장 중 닫힌 창 ─────────────────────────────────────────────────
    await openTask(e, APP, 'collect:' + ids.first);
    await collectOnSheet(e, { wait: false });
    await e.waitForFunction(() => [...document.querySelectorAll('.pos-task-items button.sn-stamp-cell')].some((b) => !(b.getAttribute('aria-label') ?? '').endsWith('미처리')), null, { timeout: STEP_MS }).catch(() => {});
    await e.close();
    e = await reopen(ctxE, APP, 'collect:' + ids.first, watch, 'E');
    await queueDrained(e);
    await e.waitForFunction(() => {
      const cells = [...document.querySelectorAll('.pos-task-items button.sn-stamp-cell')].map((b) => b.getAttribute('aria-label') ?? '');
      return cells.length > 0 && cells.every((x) => !x.endsWith('미처리') && !x.includes('전송 대기') && !x.includes('결과 확인 중'));
    }, null, { timeout: 30_000 }).catch(() => {});
    const firstStamps = await sheetStamps(e);
    check('닫힌 창: 점선이 보이자 닫은 수거(김민수)는 다시 연 창에서 한 번 끝남(실선)', firstStamps.all > 0 && firstStamps.todo === 0 && firstStamps.pending === 0, JSON.stringify(firstStamps));
    await openTask(e, APP, 'collect:' + ids.early);
    await collectOnSheet(e, { wait: false });
    await e.close();
    e = await reopen(ctxE, APP, 'collect:' + ids.early, watch, 'E');
    // 남은 항목이 있으면 새 창이 보낸다: 보냄 대기가 빈 뒤의 도장으로 가른다(한 번 · 없음).
    await queueDrained(e);
    await sleep(1_000);
    const earlyStamps = await sheetStamps(e);
    facts.early = earlyStamps.todo === 0 ? 'one' : earlyStamps.todo === earlyStamps.all ? 'none' : 'partial';
    check('닫힌 창: 확인을 누르자마자 닫은 수거(정하늘)는 한 번이거나 없음(반쯤 없음)', earlyStamps.all > 0 && facts.early !== 'partial' && earlyStamps.pending === 0, facts.early + ' · ' + JSON.stringify(earlyStamps));

    // ── 4. F: 2호 차량 기사 휴대폰이 숨음(주머니 속) ─────────────────────────
    const ctxF = await newContext({ width: 360, height: 640 });
    const f = await ctxF.newPage();
    watch(f, 'F');
    await f.goto(APP);
    await enroll(f, codes.f);
    await login(f, STAFF.driver2, pins[STAFF.driver2]);
    await f.waitForFunction(() => /#\/driver\/\d{4}-\d{2}-\d{2}/.test(location.hash), null, { timeout: STEP_MS });
    await f.waitForSelector('.sn-footer', { timeout: STEP_MS });
    const hideF = (hidden) => f.evaluate((h) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    const hiddenReport = f.waitForRequest((req) => /\/api\/v2\/heartbeat$/.test(new URL(req.url()).pathname) && /"visibility":"hidden"/.test(req.postData() ?? ''), { timeout: STEP_MS })
      .then(() => true, () => false);
    await hideF(true);
    const reported = await hiddenReport;
    await sleep(LINK_OFFLINE_MS + 12_000);
    const v2List = await pageQuery(a, { name: 'ledgerView', params: { viewKey: 'collection_list', vehicleId: 'v2', deviceClass: 'pos' } });
    check('숨은 창: F가 숨으면 마지막 알림(visibility hidden)이 가고, 끊김 판정 뒤에도 2호 차량 수거 목록에 표시가 없음(조용함)',
      reported && v2List.status === 200 && v2List.body?.link === undefined, JSON.stringify({ reported, status: v2List.status, link: v2List.body?.link ?? null }));
    await hideF(false);

    // ── 5. E 끊김: 수거 · 수거 실패 · 현장 수납 ──────────────────────────────
    await openList(e, APP, date);
    await ctxE.setOffline(true);
    const offlineBand = await waitBand(e, (x) => /^연결 끊김/.test(x), 45_000);
    check('E: 끊기면 연결 띠 `연결 끊김`', /^연결 끊김/.test(offlineBand), offlineBand);
    for (const key of ['t5', 't6', 't7']) {
      await openTask(e, APP, 'collect:' + ids[key]);
      await collectOnSheet(e);
    }
    const t7Sheet = await sheetStamps(e);
    await shot(e, 'e5-offline-collect-360x640');
    // 전화(끊겨도 사본의 온전한 번호, O17): 오늘 열린 업무의 팀.
    await openTask(e, APP, 'collect:' + ids.later);
    await sheetAction(e, '전화').click();
    await e.locator('.pos-call').waitFor({ timeout: STEP_MS });
    const callNumber = ((await e.locator('.pos-call .pos-call-number').textContent().catch(() => '')) ?? '').trim();
    const callHref = await e.locator('.pos-call a.pos-call-link').getAttribute('href').catch(() => null);
    await shot(e, 'e5-offline-call-360x640');
    await e.locator('.pos-call').getByRole('button', { name: '닫기' }).click().catch(() => {});
    check('E: 끊긴 채 `전화` → 사본의 온전한 번호와 `tel:` 링크', callNumber === '010-0000-' + TEAM.later && /^tel:/.test(callHref ?? '') && (callHref ?? '').replace(/\D/g, '') === '0100000' + TEAM.later,
      callNumber + ' · ' + callHref);
    // 수거 실패(고객 부재 · 내일): 확인 창 없이 보냄 대기.
    await openTask(e, APP, 'collect:' + ids.absent);
    await sheetAction(e, '수거 실패').click();
    const visit = e.locator('.pos-visit');
    await visit.waitFor({ timeout: STEP_MS });
    await visit.locator('.pos-visit-choice', { hasText: '고객 부재' }).click();
    await visit.locator('.pos-visit-choice', { hasText: '내일' }).click();
    await visit.locator('.pos-visit-choice').filter({ hasNotText: '직접 입력' }).first().click();
    await visit.locator('[data-primary="true"]').click();
    await visit.waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
    // 박준호 현금 35,000원(마감 뒤에 도착할 돈), 윤서준 현금 수납(받을 돈 그대로 — 그사이 카운터도 받는다).
    await openTask(e, APP, 'collect:' + ids.pay);
    const pay35 = await openFieldPay(e, ['3', '5', '000']);
    await pay35.primary.click();
    await pay35.panel.waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
    await openTask(e, APP, 'collect:' + ids.t8);
    const pay8 = await openFieldPay(e);
    facts.t8Due = Number((/([\d,]+)원$/.exec(pay8.label)?.[1] ?? '0').replace(/,/g, ''));
    await pay8.primary.click();
    await pay8.panel.waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
    await openList(e, APP, date);
    const band6 = await waitBand(e, (x) => /^연결 끊김 · 전송 대기 6\b/.test(x), 15_000);
    const t5Row = await findRow(e, TEAM.t5);
    const t5Stamps = await rowStamps(t5Row);
    await shot(e, 'e5-offline-list-360x640');
    check('E: 끊긴 채 여섯 기록 → 띠 `연결 끊김 · 전송 대기 6` · 이도윤 줄 점선 도장 · 업무 판 점선', /^연결 끊김 · 전송 대기 6\b/.test(band6)
      && t5Stamps.some((x) => x.includes('전송 대기')) && t7Sheet.pending > 0, band6 + ' · ' + JSON.stringify(t5Stamps) + ' · ' + JSON.stringify(t7Sheet));
    check('E: 현장 수납 판의 주 버튼 `현장 수납 · 현금 35,000원` · 윤서준 `현장 수납 · 현금 …원`', pay35.label === '현장 수납 · 현금 35,000원' && facts.t8Due > 0, pay35.label + ' · ' + pay8.label);
    const receive = e.locator('.sn-footer [data-primary="true"]');
    let receiveLine = '';
    if (await receive.count() && await receive.isEnabled()) {
      await receive.click();
      await e.locator('[role="dialog"]').first().waitFor({ timeout: STEP_MS });
      receiveLine = await e.locator('[role="dialog"]').first().getByText('입고 불가 · 연결 끊김').count() ? '입고 불가 · 연결 끊김' : ((await e.locator('[role="dialog"]').first().textContent()) ?? '').slice(0, 80);
      await shot(e, 'e5-offline-receive-360x640');
      await e.keyboard.press('Escape');
      await e.locator('[role="dialog"]').first().waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
    }
    check('E: 끊긴 채 `매장 입고` → `입고 불가 · 연결 끊김`', receiveLine === '입고 불가 · 연결 끊김', receiveLine);

    // ── 6. 끊긴 채 새로 고침 → 기억한 세션으로 같은 목록 → 하나 더 ───────────
    // 새로 고친 뒤 띠의 `마지막 연결`은 켠 때가 아니라 기기 메모의 때(§18 R4-13): 다음 분으로 넘어간 뒤 새로 고쳐 같은 시각인지 본다.
    const lastBefore = /마지막 연결 (\d\d:\d\d)/.exec(band6)?.[1];
    if (lastBefore) {
      const hm = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
      for (let i = 0; i < 70 && hm() === lastBefore; i += 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await e.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    const reopened = await e.waitForSelector('.sn-ledger tr.sn-row', { timeout: STEP_MS }).then(() => true, () => false);
    const bandReload = await waitBand(e, (x) => /^연결 끊김 · 전송 대기 6\b/.test(x), 15_000);
    if (lastBefore) {
      const lastAfter = /마지막 연결 (\d\d:\d\d)/.exec(bandReload)?.[1];
      check('E: 끊긴 채 새로 고친 띠의 `마지막 연결`이 그대로(켠 때로 밀리지 않음, §18 R4-13)', lastAfter === lastBefore, lastBefore + ' → ' + (lastAfter ?? bandReload));
    }
    const t5After = await rowStamps(await findRow(e, TEAM.t5));
    await shot(e, 'e6-offline-reload-360x640');
    check('E: 끊긴 채 새로 고침 → 서버 없이 기억한 세션으로 같은 목록(이도윤 점선 · 띠 `연결 끊김 · 전송 대기 6`)',
      reopened && !(await e.locator('.pos-enroll, .pos-login').count()) && t5After.some((x) => x.includes('전송 대기')) && /^연결 끊김 · 전송 대기 6\b/.test(bandReload), bandReload);
    await openTask(e, APP, 'collect:' + ids.later);
    await collectOnSheet(e);
    await openList(e, APP, date);
    const band7 = await waitBand(e, (x) => /^연결 끊김 · 전송 대기 7\b/.test(x), 15_000);
    check('E: 새로 고친 뒤 백승현 수거 → `전송 대기 7`', /^연결 끊김 · 전송 대기 7\b/.test(band7), band7);
    // 전송 대기 목록(§17 R3-19): 더 보기 → `전송 대기 7` → 창의 쪽을 모두 넘겨 일곱 줄(수거 실패 · 현장 수납처럼 점선 도장이 없는 기록도).
    const pendingRows = await readPendingList(e);
    await shot(e, 'e6-pending-list-360x640');
    check('E: 전송 대기 목록 `전송 대기 7` → 일곱 줄 · 박준호 `현장 수납 현금 35,000원` · 수거 실패 줄', pendingRows.title === '전송 대기 7' && pendingRows.rows.length === 7
      && pendingRows.rows.some((x) => /현장 수납 현금 35,000원/.test(x)) && pendingRows.rows.some((x) => /수거 실패/.test(x)), JSON.stringify(pendingRows));

    // ── 7. 그사이 카운터 ────────────────────────────────────────────────────
    await a.goto(APP + '#/collections');
    await a.waitForSelector('.sn-ledger tr.sn-row', { timeout: STEP_MS });
    const chip = await a.waitForFunction(() => {
      const label = document.querySelector('.sn-title-chip')?.getAttribute('aria-label') ?? '';
      return /^1호 차량 연결 끊김/.test(label) ? label : null;
    }, null, { timeout: 45_000 }).then((h) => h.jsonValue(), () => '');
    await shot(a, 'a7-chip-1024x600');
    check('A: 끊긴 1호 차량 → 수거 목록 제목 줄 `1호 차량 연결 끊김 · …부터`(노랑, 수를 모름)', /^1호 차량 연결 끊김 · \d\d:\d\d부터$/.test(String(chip)), String(chip));
    // 카운터의 첫 화면(장부) 제목 줄에도 같은 표시(§17 R3-23).
    await a.goto(APP + '#/ledger');
    await a.waitForSelector('.pos-counter-row', { timeout: STEP_MS });
    const ledgerChip = await a.waitForFunction(() => {
      const text = document.querySelector('.pos-counter-link')?.textContent ?? '';
      // 새 장부는 여러 차량의 경고를 함께 보여 준다. 같은 1호 경고 한 건을 온전하게 확인한다.
      return /(?:^| · )(1호 차량 연결 끊김 · \d\d:\d\d부터)(?= · |$)/.exec(text)?.[1] ?? null;
    }, null, { timeout: 15_000 }).then((h) => h.jsonValue(), () => '');
    check('A: 장부 제목 줄에도 `1호 차량 연결 끊김 · …부터`', /^1호 차량 연결 끊김 · \d\d:\d\d부터$/.test(String(ledgerChip)), String(ledgerChip));
    const t7Notice = { text: '' };
    const returnLabel = await counterReturn(a, APP, ids.t7, t7Notice);
    check('A: 한동수 팀 반납 알림에 `1호 차량 연결 끊김 · …부터 · 수거 여부 미확인`(매장 반납 처리 전에 봄)', /1호 차량 연결 끊김 · \d\d:\d\d부터 · 수거 여부 미확인/.test(t7Notice.text), t7Notice.text.slice(0, 160));
    const v1List = await pageQuery(a, { name: 'ledgerView', params: { viewKey: 'collection_list', vehicleId: 'v1', deviceClass: 'pos' } });
    const t7Listed = (v1List.body?.rows ?? []).some((r) => r.orderId === ids.t7);
    check('A: 한동수 팀 매장 반납(`' + returnLabel + '`) → 카운터의 1호 차량 수거 목록에서 빠짐', /^반납 처리/.test(returnLabel) && v1List.status === 200 && !t7Listed, returnLabel + ' · ' + t7Listed);
    const t8Sheet = await pageQuery(a, { name: 'orderSlip', params: { orderId: ids.t8 } });
    const t8Due = t8Sheet.body?.money?.due;
    const counterPay = await pageSend(a, 'payment.take', { orderIds: [ids.t8], amount: t8Due, methodKey: 'cash' }, { expect: { dueAmount: t8Due } });
    check('A: 윤서준 팀의 같은 돈(' + t8Due + '원)을 카운터에서 현금으로 받음', counterPay.outcome?.outcome === 'applied' && t8Due === facts.t8Due,
      JSON.stringify(counterPay.outcome?.error ?? counterPay.outcome?.outcome) + ' · E ' + facts.t8Due);
    const moves = [];
    for (const key of ['t5', 't6']) moves.push(await moveToVan(a, APP, ids[key], '2호 차량', 'a7-promise-' + key + '-1024x600', shot));
    check('A: 이도윤 · 서지훈 일정 변경 창의 `유지` 줄 자리에 `1호 차량 연결 끊김 · …부터 · 수거 여부 미확인` → 2호 차량으로 옮김',
      moves.every((m) => /^1호 차량 연결 끊김 · \d\d:\d\d부터 · 수거 여부 미확인$/.test(m.warning)), JSON.stringify(moves));
    // F(2호 차량): 옮긴 두 팀이 목록에 들어오면 서지훈을 먼저 수거(연결됨).
    await f.goto(APP + '#/driver/' + date);
    const fRows = await f.waitForFunction((l) => l.every((x) => [...document.querySelectorAll('.sn-ledger tr.sn-row')].some((r) => (r.textContent ?? '').includes(x))), [TEAM.t5, TEAM.t6], { timeout: 30_000 })
      .then(() => true, () => false);
    const fT6 = await findRow(f, TEAM.t6);
    if (fT6) {
      await fT6.locator('button.sn-stamp-cell[aria-label$="미처리"]').first().click();
      const ok = f.locator('[role="dialog"] [data-primary="true"]');
      await ok.waitFor({ timeout: STEP_MS });
      await ok.click();
      await f.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: STEP_MS }).catch(() => {});
    }
    const fDone = await f.waitForFunction((l) => {
      const row = [...document.querySelectorAll('.sn-ledger tr.sn-row')].find((r) => (r.textContent ?? '').includes(l));
      const cells = row ? [...row.querySelectorAll('button.sn-stamp-cell')].map((c) => c.getAttribute('aria-label') ?? '') : [];
      return cells.length > 0 && cells.every((x) => !x.endsWith('미처리') && !x.includes('전송 대기'));
    }, TEAM.t6, { timeout: 30_000 }).then(() => true, () => false);
    const fT5 = await rowStamps(await findRow(f, TEAM.t5));
    await shot(f, 'f7-list-360x640');
    check('F: 옮긴 이도윤 · 서지훈이 2호 차량 목록에 → 서지훈을 먼저 수거(실선), 이도윤은 미처리로 남음', fRows && fDone && fT5.some((x) => x.endsWith('미처리')), JSON.stringify({ fRows, fDone, fT5 }));

    // ── 8. 마감: 카운터 역할은 권한 없음, 관리자는 본인 비밀번호로 넘김(첫 답을 잃음) ─────
    const counterStep = await closingToStep(a, APP, date);
    await shot(a, 'a8-closing-step-counter-1024x600');
    check('A(카운터 역할): 마감 막는 단계 `1호 차량 연결 끊김 · …부터 · 마감 전 전송 필요` · `권한 없음 · 관리자 확인 필요` · `관리자 승인` 없음',
      /^1호 차량 연결 끊김 · \d\d:\d\d부터 · 마감 전 전송 필요$/.test(counterStep.stepLabel) && counterStep.note === '권한 없음 · 관리자 확인 필요' && counterStep.approve === 0, JSON.stringify(counterStep));
    await a.locator('[role="dialog"]').getByRole('button', { name: '닫기', exact: true }).click().catch(() => {});
    const closingAnswers = [];
    await ctxB.route('**/api/v2/command', async (route) => {
      let body = null;
      try { body = route.request().postDataJSON(); } catch { /* 본문 없음 */ }
      if (body?.type !== 'closing.close') { await route.fallback(); return; }
      const response = await route.fetch();
      const outcome = await response.json().catch(() => null);
      closingAnswers.push({ requestId: body.requestId, outcome: outcome?.outcome, code: outcome?.error?.code, lost: closingAnswers.length === 0 });
      if (closingAnswers.length === 1) await route.abort('connectionreset');
      else await route.fulfill({ response });
    });
    const managerStep = await closingToStep(b, APP, date);
    await shot(b, 'b8-closing-step-1024x600');
    check('B(관리자): 같은 막는 단계에 `관리자 승인`', /^1호 차량 연결 끊김 · \d\d:\d\d부터 · 마감 전 전송 필요$/.test(managerStep.stepLabel) && managerStep.approve === 1 && managerStep.note === '', JSON.stringify(managerStep));
    await b.locator('[role="dialog"]').getByRole('button', { name: '관리자 승인', exact: true }).click();
    const pad = b.locator('.sn-numpad').last();
    await pad.waitFor({ timeout: STEP_MS });
    const padTitle = ((await pad.locator('.sn-keypad-title').textContent().catch(() => '')) ?? '').trim();
    for (const d of pins[STAFF.manager]) await pad.getByRole('button', { name: d, exact: true }).click();
    await pad.getByRole('button', { name: '입력', exact: true }).click();
    const kb = b.locator('.sn-kb');
    await kb.waitFor({ timeout: STEP_MS });
    for (const key of ['ㅂ', 'ㅏ', 'ㅇ', 'ㅈ', 'ㅓ', 'ㄴ']) await kb.getByRole('button', { name: key, exact: true }).click();
    await kb.locator('[data-primary="true"]').click();
    const confirmDialog = b.locator('[role="dialog"]', { hasText: '사유 · 방전' });
    await confirmDialog.waitFor({ timeout: STEP_MS });
    const closeLabel = ((await confirmDialog.locator('[data-primary="true"]').textContent()) ?? '').trim();
    await shot(b, 'b8-closing-approve-1024x600');
    await confirmDialog.locator('[data-primary="true"]').click();
    const closed = await b.waitForFunction(() => /마감 완료/.test(document.querySelector('.pos-closing-sum')?.textContent ?? ''), null, { timeout: 30_000 }).then(() => true, () => false);
    const vanRow = ((await b.locator('.pos-closing-left tr.sn-row', { has: b.locator('.pos-closing-name', { hasText: '1호 차량 현금' }) }).first().textContent().catch(() => '')) ?? '').trim();
    await shot(b, 'b8-closed-1024x600');
    await ctxB.unroute('**/api/v2/command');
    check('B: `관리자 승인` → `' + STAFF.manager + ' · 비밀번호` → 사유 `방전` → `' + closeLabel + '` → 첫 답을 잃고 같은 요청번호로 다시 보내 `applied`(APPROVAL_INVALID 아님)',
      padTitle === STAFF.manager + ' · 비밀번호' && /^마감 · /.test(closeLabel) && closed && closingAnswers.length >= 2 && closingAnswers[0].lost
        && closingAnswers.every((x) => x.requestId === closingAnswers[0].requestId && x.outcome === 'applied'),
      padTitle + ' · ' + JSON.stringify(closingAnswers));
    // 좁으면 뒤 조각(`전송 대기 있음`)부터 빠진다: 화면은 `마지막 연결 …`, 얼린 표의 조각은 둘 다.
    const frozen = (await pageQuery(b, { name: 'closingSheet', params: {} })).body;
    const frozenNote = (frozen?.cash ?? []).find((r) => r.key === 'van:v1')?.note?.map((x) => x.text) ?? [];
    check('B: 얼린 마감표의 1호 차량 현금은 `점검 이월`이고 둘째 줄은 그때의 사실(`마지막 연결 …` · `전송 대기 있음`, `전송 대기 0` 아님)', vanRow.includes('점검 이월')
      && /마지막 연결 \d\d:\d\d/.test(vanRow) && !vanRow.includes('전송 대기 0') && /^마지막 연결 \d\d:\d\d$/.test(frozenNote[0] ?? '') && frozenNote[1] === '전송 대기 있음',
      vanRow.slice(0, 80) + ' · ' + JSON.stringify(frozenNote));
    // 넘긴 마감의 흔적(§17 R3-27): 얼린 표의 이월 항목 맨 앞에 막은 차량 · 관리자 승인 · 사유.
    const overrideCarry = (frozen?.carry ?? []).find((c) => typeof c.key === 'string' && c.key.startsWith('override:'));
    const carryTitle = (overrideCarry?.title ?? []).map((x) => x.text).join('');
    const carryNote = (overrideCarry?.note ?? []).map((x) => x.text);
    check('B: 얼린 마감표의 이월 항목에 `1호 차량 · 전송 대기 …` · `관리자 승인` · `사유 · 방전`', /^1호 차량 · 전송 대기/.test(carryTitle) && carryNote.includes('관리자 승인') && carryNote.includes('사유 · 방전'),
      carryTitle + ' · ' + JSON.stringify(carryNote));

    // ── 9 · 10. E 다시 이음: 첫 묶음의 답을 잃음 → 다시 보냄 → 결과 ──────────────
    const batches = [];
    await ctxE.route('**/api/v2/commands:batch', async (route) => {
      if (batches.length === 0) {
        const response = await route.fetch();
        const body = await response.json().catch(() => null);
        batches.push({ lost: true, status: response.status(), n: body?.results?.length ?? 0 });
        await route.abort('connectionreset');
        return;
      }
      batches.push({ lost: false });
      await route.fallback();
    });
    await ctxE.setOffline(false);
    // 띠는 `전송 대기 0`에 줄 메모 수가 붙을 수 있다(`전송 대기 0 · 중복 수납 의심 1팀`, 문구 표 3-21 · plan §17 R3-26).
    const isSettled = (/** @type {string} */ x) => /^전송 대기 0( · |$)/.test(x);
    const settled = await waitBand(e, isSettled, 90_000);
    await shot(e, 'e10-settled-360x640');
    check('E: 다시 이으면 첫 묶음의 답을 잃어도(서버에는 감) 다시 보내 띠 `전송 대기 0`', isSettled(settled ?? '') && batches.length >= 2 && batches[0].lost && batches[0].status === 200 && batches[0].n > 0,
      settled + ' · ' + JSON.stringify(batches.slice(0, 3)));
    await ctxE.unroute('**/api/v2/commands:batch');
    const dotted = await e.locator('.sn-ledger button.sn-stamp-cell[aria-label*="전송 대기"], .sn-ledger button.sn-stamp-cell[aria-label*="결과 확인 중"]').count();
    const t7Row = await findRow(e, TEAM.t7);
    const t7Text = t7Row ? ((await t7Row.textContent()) ?? '') : '';
    const t5Done = await rowStamps(await findRow(e, TEAM.t5));
    await shot(e, 'e10-row-note-360x640');
    check('E: 실선 도장(점선 없음) · 한동수 줄 메모 `매장 반납 완료` · 이도윤은 1호 차량이 수거(되돌림)', dotted === 0 && t7Text.includes('매장 반납 완료')
      && t5Done.length > 0 && t5Done.every((x) => !x.endsWith('미처리') && !x.includes('전송 대기')), JSON.stringify({ dotted, t7: t7Text.slice(0, 60), t5Done }));
    await openTask(e, APP, 'collect:' + ids.t8);
    const t8Line = ((await e.locator('.pos-task-team-line').first().textContent().catch(() => '')) ?? '').trim();
    await shot(e, 'e10-duplicate-360x640');
    check('E: 윤서준 업무 판의 팀 줄 맨 앞 `중복 수납 의심`', /^중복 수납 의심/.test(t8Line), t8Line);
    const fGone = await f.waitForFunction((l) => ![...document.querySelectorAll('.sn-ledger tr.sn-row')].some((r) => (r.textContent ?? '').includes(l)), TEAM.t5, { timeout: 30_000 })
      .then(() => true, () => false);
    check('F: 이도윤은 1호 차량이 그사이 수거해 2호 차량 목록에서 빠짐', fGone);
    const wanted = [['task_moved_meanwhile', '이도윤'], ['already_returned', '한동수'], ['collect_exceeds', '서지훈'], ['late_money', '박준호'], ['possible_duplicate_money', '윤서준']];
    let reviews = [];
    for (let i = 0; i < 40; i += 1) {
      reviews = (await pageQuery(a, { name: 'reviewList', params: {} })).body?.items ?? [];
      if (wanted.every(([kind, team]) => reviews.some((r) => r.kindKey === kind && r.message.includes(team)))) break;
      await sleep(500);
    }
    const found = wanted.map(([kind, team]) => kind + ':' + reviews.filter((r) => r.kindKey === kind && r.message.includes(team)).length);
    await a.goto(APP + '#/review');
    await a.waitForSelector('.pos-review-rows', { timeout: STEP_MS }).catch(() => {});
    await shot(a, 'a10-review-1024x600');
    check('A: 확인 필요에 이도윤 업무 차량 변경 · 한동수 이미 반납 · 서지훈 수거 수량 · 박준호 마감 후 수납(35,000원) · 윤서준 중복 수납 의심',
      wanted.every(([kind, team]) => reviews.some((r) => r.kindKey === kind && r.message.includes(team)))
        && reviews.some((r) => r.kindKey === 'late_money' && r.message.includes('박준호') && r.message.includes('35,000원'))
        && !reviews.some((r) => r.kindKey === 'command_held' || r.kindKey === 'clock_suspect'), found.join(' · '));
    let aChip = null;
    for (let i = 0; i < 40; i += 1) {
      aChip = await pageQuery(a, { name: 'ledgerView', params: { viewKey: 'collection_list', vehicleId: 'v1', deviceClass: 'pos' } });
      if (aChip.status === 200 && aChip.body?.link === undefined) break;
      await sleep(500);
    }
    check('A: 다시 이은 1호 차량 → 수거 목록 표시가 사라짐', aChip?.status === 200 && aChip.body?.link === undefined, JSON.stringify(aChip?.body?.link ?? null));

    // ── 11. 사본 형식: 이 빌드가 모르는 사본 → 연결 끊김 화면 · 보냄 대기는 그대로 ──────
    await ctxE.setOffline(true);
    await waitBand(e, (x) => /^연결 끊김/.test(x), 45_000);
    await openTask(e, APP, 'collect:' + ids.format);
    await collectOnSheet(e);
    const marked = await setCopyVersion(e, 0);
    await e.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    const offlineCard = await e.waitForSelector('.pos-card-waiting', { timeout: 30_000 }).then(() => true, () => false);
    const waitingLine = offlineCard ? ((await e.locator('.pos-card-waiting').first().textContent()) ?? '').trim() : '';
    await shot(e, 'e11-format-offline-360x640');
    check('사본 형식: 이 빌드가 모르는 사본은 그리지 않고 연결 끊김 화면 `전송 대기 1`', marked && waitingLine === '전송 대기 1' && !(await e.locator('.sn-ledger').count()), waitingLine);
    await ctxE.setOffline(false);
    // 새로 고친 자리(이 업무 판)가 새 사본으로 다시 그려진다.
    const back = await e.waitForSelector('.pos-task-sheet .pos-task-items tr.sn-row, .sn-ledger tr.sn-row', { timeout: 45_000 }).then(() => true, () => false);
    await openTask(e, APP, 'collect:' + ids.format).catch(() => {});
    await e.waitForFunction(() => {
      const cells = [...document.querySelectorAll('.pos-task-items button.sn-stamp-cell')].map((b) => b.getAttribute('aria-label') ?? '');
      return cells.length > 0 && cells.every((x) => !x.endsWith('미처리') && !x.includes('전송 대기') && !x.includes('결과 확인 중'));
    }, null, { timeout: 45_000 }).catch(() => {});
    const formatStamps = await sheetStamps(e);
    const local = await localRecords(e);
    facts.local = local;
    check('사본 형식: 이으면 보낸 뒤 새 사본으로 목록이 돌아오고 조은비 수거는 실선', back && formatStamps.all > 0 && formatStamps.todo === 0 && formatStamps.pending === 0
      && local !== null && local.queue.length === 0, JSON.stringify({ back, formatStamps, queue: local?.queue.length }));

    // ── 11b. 끊긴 채 로그아웃(plan §17-2 R3-7 · R3-9): 사본은 곧바로 지우고, 다시 이어 켜면 서버 세션을 먼저 끝내고 로그인 화면(서버의 세션만으로 열지 않음) ──
    const sessionBefore = await e.evaluate(() => fetch('api/v2/session', { cache: 'no-store' }).then((r) => r.json()).then((b) => b?.session?.id ?? null, () => null));
    await ctxE.setOffline(true);
    await waitBand(e, (x) => /^연결 끊김/.test(x), 45_000);
    await e.goto(APP + '#/exit?from=driver');
    await e.waitForSelector('.pos-card', { timeout: STEP_MS });
    await e.getByRole('button', { name: '로그아웃', exact: true }).click();
    await e.locator('[role="dialog"] [data-primary="true"]').click();
    await e.waitForSelector('.pos-login', { timeout: STEP_MS });
    const afterLogout = await localSignOut(e);
    await ctxE.setOffline(false);
    await e.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    const loginBack = await e.waitForSelector('.pos-login-tile', { timeout: 45_000 }).then(() => true, () => false);
    await shot(e, 'e11b-offline-logout-login-360x640');
    const listShown = await e.locator('.sn-ledger').count();
    const sessionAfter = await e.evaluate(() => fetch('api/v2/session', { cache: 'no-store' }).then((r) => r.status, () => 0));
    const afterStart = await localSignOut(e);
    check('E: 끊긴 채 로그아웃 → 사본 · 세션 칸을 곧바로 지우고 표시를 남김, 다시 이어 켜면 서버 세션을 먼저 끝내고 목록 대신 로그인 화면',
      sessionBefore !== null && afterLogout?.marker === sessionBefore && afterLogout.snapshot === 0 && afterLogout.session === 0
        && loginBack && listShown === 0 && sessionAfter === 401 && afterStart?.marker === null,
      JSON.stringify({ sessionBefore: sessionBefore !== null, afterLogout: { ...afterLogout, marker: afterLogout?.marker === sessionBefore }, loginBack, listShown, sessionAfter, afterStart: afterStart?.marker ?? null }));

    check('페이지 오류 없음', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
    for (const ctx of [ctxA, ctxB, ctxE, ctxF]) await ctx.close();
  } catch (error) {
    check('끝까지 돌기', false, String(error?.stack ?? error).split('\n').slice(0, 4).join(' | '));
    let n = 0;
    for (const ctx of browser?.contexts() ?? []) for (const page of ctx.pages()) await shot(page, 'fail-' + (n += 1));
  } finally {
    await browser?.close().catch(() => {});
    await proxy?.close().catch(() => {});
    facts.stopped = await stopChild(server);
    writeFileSync(join(OUT, 'proxy.log'), proxyLines.join('\n') + '\n');
    // ── 12. 매장 파일(읽기 전용) ──────────────────────────────────────────
    let signatures = [];
    try {
      signatures = await databaseChecks(env, facts, check);
    } catch (error) {
      check('매장 파일 확인', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
    }
    // ── 13. 기록 ───────────────────────────────────────────────────────
    const logs = [1, 2, 3].map((n) => join(OUT, 'server-' + n + '.log')).filter(existsSync).map((file) => readFileSync(file, 'utf8')).join('\n')
      + '\n' + (existsSync(cliLog) ? readFileSync(cliLog, 'utf8') : '') + '\n' + proxyLines.join('\n');
    check('서버가 깨끗하게 멈춤(SIGTERM)', facts.stopped !== null && (facts.stopped.code === 0 || facts.stopped.signal === 'SIGTERM'), JSON.stringify(facts.stopped));
    check('서버 · 명령줄 · 앞단 기록에 처리 오류 · 예외가 없음', !/처리 오류|Unhandled|uncaught/i.test(logs), (/.*(처리 오류|Unhandled|uncaught).*/i.exec(logs) ?? [''])[0].slice(0, 200));
    const leaks = leaksIn(logs, secretsSeen);
    const signed = signatures.filter((s) => s && logs.includes(s));
    const payloadText = /"payload"|"taskId"|"lines":\[|"recordedBy"/.exec(logs)?.[0] ?? '';
    check('기록에 비밀번호 · 등록 번호 · 기기 서명 · 명령 본문이 없음', leaks.length === 0 && signed.length === 0 && payloadText === '',
      '비밀 ' + leaks.length + ' · 서명 ' + signed.length + ' · 본문 ' + (payloadText || '없음'));
    if (process.env.SKINOTE_E2E_KEEP === '1') console.log('임시 자료 폴더: ' + tmp);
    else rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => r.state === 'fail');
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ run: RUN, results }, null, 2));
  console.log('\n기사 연결 끊김 끝까지 시험: 확인 ' + results.length + '개 · 실패 ' + failed.length + ' · 기록 ' + OUT.replace(ROOT, ''));
  process.exitCode = failed.length ? 1 : 0;
}

/**
 * 12. 서버를 멈춘 뒤 매장 파일을 읽기 전용으로 연다: E의 command_log(번호 · 서명 · 시각의 출처), 돈(35,000원 한 번 · 다음 날 기록 · 1호 차량),
 * 보류 없음, 사본 열람 기록, 마감(넘긴 사유 · 차량 연결 사실), 그리고 도메인 상태로 돈 · 재고를 센다. 기기 서명 목록을 돌려준다(기록 확인).
 */
async function databaseChecks(env, facts, check) {
  const { openDatabase } = await import('@skinote/schema');
  const { openShopStore } = await import('@skinote/store');
  const { walletLeft } = await import('@skinote/domain');
  const file = join(env.SKINOTE_DATA_DIR, 'db', 'shops', SHOP + '.sqlite');
  const db = openDatabase(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT request_id, device_seq, actor_signature, time_source_key, status_key, error_code FROM command_log WHERE shop_id = ? AND device_id = ? ORDER BY device_seq')
      .all(SHOP, facts.deviceE);
    const seqs = rows.map((r) => r.device_seq);
    const gapless = seqs.length > 0 && seqs.every((s, i) => s === i + 1);
    const flagged = rows.filter((r) => r.error_code === 'BAD_SIGNATURE' || r.error_code === 'FORBIDDEN_SCOPE');
    check('파일: E의 기록 번호 1…' + seqs.length + ' 빈틈 없음 · 모두 기기 서명(86자) · 서명 · 범위 경고(BAD_SIGNATURE · FORBIDDEN_SCOPE) 없음',
      gapless && rows.every((r) => typeof r.actor_signature === 'string' && r.actor_signature.length === 86) && flagged.length === 0, JSON.stringify(seqs) + ' · 경고 ' + flagged.length);
    const sent = new Map((facts.local?.sent ?? []).map((s) => [s.requestId, s]));
    const byTask = (taskId, type) => rows.filter((r) => sent.get(r.request_id)?.taskId === taskId && (!type || sent.get(r.request_id)?.type === type));
    const ids = facts.ids;
    const before = [['collect:' + ids.t5, 'stock.collect'], ['collect:' + ids.t6, 'stock.collect'], ['collect:' + ids.t7, 'stock.collect'], ['collect:' + ids.absent, 'task.visit'],
      ['collect:' + ids.t8, 'field.collect']].map(([task, type]) => byTask(task, type)[0]?.time_source_key);
    const after = byTask('collect:' + ids.later, 'stock.collect')[0]?.time_source_key;
    check('파일: 새로 고치기 전 끊긴 기록은 wall_clock, 새로 고친 뒤(같은 창)의 수거는 monotonic', before.every((x) => x === 'wall_clock') && after === 'monotonic',
      JSON.stringify({ before, after }));
    const firstRows = byTask('collect:' + ids.first, 'stock.collect').length;
    const earlyRows = byTask('collect:' + ids.early, 'stock.collect').length;
    check('파일: 점선 뒤 닫힌 창의 수거는 한 번, 누르자마자 닫힌 창의 수거는 화면과 같게(' + facts.early + ')',
      firstRows === 1 && earlyRows === (facts.early === 'one' ? 1 : 0), JSON.stringify({ firstRows, earlyRows }));
    const outcome = (taskId, type) => byTask(taskId, type)[0]?.status_key;
    check('파일: 결과 — 이도윤 applied(되돌림) · 서지훈 needs_review · 한동수 superseded · 임하늘 applied',
      outcome('collect:' + ids.t5, 'stock.collect') === 'applied' && outcome('collect:' + ids.t6, 'stock.collect') === 'needs_review'
        && outcome('collect:' + ids.t7, 'stock.collect') === 'superseded' && outcome('collect:' + ids.absent, 'task.visit') === 'applied',
      JSON.stringify(['t5', 't6', 't7', 'absent'].map((k) => outcome('collect:' + ids[k]))));
    const held = db.prepare("SELECT count(*) AS n FROM command_log WHERE shop_id = ? AND status_key = 'held'").get(SHOP).n;
    check('파일: 보류(held) 기록 없음', held === 0, String(held));
    const pays = db.prepare('SELECT amount, collected_by_vehicle_id AS van, business_date, posting_date, request_id FROM payments WHERE shop_id = ? AND device_id = ? ORDER BY occurred_at')
      .all(SHOP, facts.deviceE);
    const next = new Date(Date.parse(facts.date + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
    const p35 = pays.filter((p) => p.amount === 35_000);
    const p20 = pays.filter((p) => p.amount === 20_000);
    check('파일: 35,000원은 한 번(답을 잃고 다시 보내도) · 1호 차량 · 영업일 ' + facts.date + ' · 기록일 ' + next + ', 두 창의 20,000원도 한 번(그날 기록)',
      p35.length === 1 && p35[0].van === 'v1' && p35[0].business_date === facts.date && p35[0].posting_date === next
        && p20.length === 1 && p20[0].posting_date === facts.date && p20[0].van === 'v1', JSON.stringify(pays));
    const copies = db.prepare("SELECT count(*) AS n FROM pii_access_log WHERE shop_id = ? AND device_id = ? AND action_key = 'working_copy'").get(SHOP, facts.deviceE).n;
    check('파일: 사본 열람 기록(working_copy)은 기기 · 차량 · 날짜마다 한 줄 + 새 번호 줄(사본마다가 아님)', copies >= 1 && copies < facts.snapshotCalls, copies + '줄 · 사본 요청 ' + facts.snapshotCalls + '번');
    const closing = db.prepare('SELECT override_reason, request_id FROM closings WHERE shop_id = ? AND business_date = ?').get(SHOP, facts.date);
    const closeEvent = closing ? db.prepare('SELECT command_json FROM events WHERE shop_id = ? AND request_id = ?').get(SHOP, closing.request_id) : null;
    const command = closeEvent ? JSON.parse(closeEvent.command_json) : null;
    const links = command?.payload?.links ?? [];
    const reasonRef = command?.payload?.override?.reason;
    check('파일: 마감은 넘긴 사유(closings.override_reason) · 정규 명령(events)에 차량 연결 사실(1호 차량 offline)과 승인, 사유는 작업 기록에 글 대신 참조',
      closing?.override_reason === '방전' && links.some((l) => l.vehicleId === 'v1' && l.state === 'offline') && typeof command?.payload?.override?.approvalId === 'string'
        && typeof reasonRef === 'object' && reasonRef !== null && !JSON.stringify(command).includes('방전'),
      JSON.stringify({ reason: closing?.override_reason ?? null, links, override: command?.payload?.override ?? null }));
    // 도메인 상태: 돈(차량 지갑의 이월) · 재고(두 번 세지 않음).
    const { fingerprintKey } = loadSecrets(env);
    const store = openShopStore(db, SHOP, { secrets: { fingerprintKey } });
    const state = store.state(Date.now());
    const order = (key) => state.orders.find((o) => o.id === ids[key]);
    const wallet = walletLeft(state, next, 'v1');
    check('돈: 다음 날 1호 차량 지갑 = 이월한 20,000원 + 늦게 온 35,000원 + 윤서준 ' + facts.t8Due + '원(한 번씩)', wallet === 20_000 + 35_000 + facts.t8Due, String(wallet));
    const t8Paid = order('t8')?.payments.filter((p) => p.methodKey !== 'deposit').map((p) => p.amount) ?? [];
    check('돈: 윤서준은 카운터 · 기사 두 번 적힘(둘 다 사실, 확인 필요가 설명)', t8Paid.length === 2 && t8Paid.every((x) => x === facts.t8Due), JSON.stringify(t8Paid));
    const over = state.orders.flatMap((o) => o.lines.filter((l) => l.collected + l.returned > l.issued).map((l) => o.teamName + ' ' + l.id));
    const t6 = order('t6');
    const t5 = order('t5');
    const t7 = order('t7');
    const sum = (o, k) => (o?.lines ?? []).filter((l) => l.returnable).reduce((n, l) => n + l[k], 0);
    const t5v2 = (t5?.splits ?? []).filter((s) => s.promise.mode === 'vehicle' && s.promise.vehicleId === 'v2' && s.quantity > 0).length;
    check('재고: 서지훈은 F의 3개만(E의 수거는 적지 않음) · 이도윤 2개 1호 차량(2호 몫 되돌림) · 한동수 매장 반납 · 받은 수가 준 수를 넘는 줄 없음',
      over.length === 0 && sum(t6, 'collected') === 3 && sum(t5, 'collected') === 2 && t5v2 === 0 && sum(t7, 'returned') === sum(t7, 'issued') && sum(t7, 'collected') === 0,
      JSON.stringify({ over, t6: sum(t6, 'collected'), t5: sum(t5, 'collected'), t5v2, t7: [sum(t7, 'returned'), sum(t7, 'collected')] }));
    return rows.map((r) => r.actor_signature).filter(Boolean);
  } finally {
    db.close();
  }
}

await main();
