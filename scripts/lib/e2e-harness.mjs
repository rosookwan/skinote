// 끝까지 시험(e2e) 두 개가 함께 쓰는 것(work/impl-offline/plan.md §11 S4): 빈 포트, 자식 프로세스(서버 · 명령줄), 확인 기록, 화면 찍기, 기기 등록 ·
// 로그인 걸음, 페이지 안의 조회 · 명령. 쓰는 곳: scripts/check-server-e2e.mjs(서버 모드), scripts/check-offline-e2e.mjs(기사 연결 끊김 S6).
// 시험마다의 걸음(매장 · 직원 · 기기 · 확인)은 각 스크립트에 둔다. 브라우저 · 서버를 띄우는 순서도 스크립트의 몫이다.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DIST = join(ROOT, 'apps/pos/dist');
export const SERVER_MAIN = join(ROOT, 'packages/server/src/main.js');
export const SHOP_CLI = join(ROOT, 'packages/server/bin/shop.js');
/** 화면 한 걸음을 기다리는 시간. */
export const STEP_MS = 15_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 확인 기록: check(이름, 참, 덧붙임) · blocked(이름, 까닭) · results(모두). */
export function makeReporter() {
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
  return { results, check, blocked };
}

/** 화면 찍기(글꼴을 기다린 뒤, 실패해도 멈추지 않음). */
export function makeShot(outDir) {
  return async (page, name) => {
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.screenshot({ path: join(outDir, name + '.png') }).catch(() => {});
  };
}

/** 비어 있는 포트(잠깐 잡았다 놓는다). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** 자식 프로세스(뒤에서, 기록 파일). */
export function startChild(args, env, logFile) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  const keep = (b) => { chunks.push(b); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.log = () => Buffer.concat(chunks).toString('utf8');
  child.on('exit', () => { try { writeFileSync(logFile, child.log()); } catch { /* 폴더가 없음 */ } });
  return child;
}

/** 자식 프로세스를 멈춘다(SIGTERM, 10초 뒤 SIGKILL). 멈춘 모양(끝 코드 · 신호)을 돌려준다. */
export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return child ? { code: child.exitCode, signal: child.signalCode } : null;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await Promise.race([exited, sleep(12_000)]);
  clearTimeout(timer);
  return { code: child.exitCode, signal: child.signalCode };
}

export async function waitHealthy(port, child, ms = 30_000) {
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
export function runCli(args, env, logFile) {
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

/** provision의 표준 출력(직원 · 역할 · 비밀번호 표) → { 이름: 비밀번호 }. */
export const pinsOf = (out) => Object.fromEntries(out.trim().split('\n').slice(1).map((line) => line.split('\t')).map(([name, , pin]) => [name, pin]));

/** device-code의 표준 출력 → 12자리 등록 번호(없으면 null). 넷씩 끊은 모양도 함께(기록에서 찾을 비밀). */
export function codeOf(out) {
  const m = /등록 번호\t(\d{4}-\d{4}-\d{4})/.exec(out);
  return m ? { digits: m[1].replace(/-/g, ''), shown: m[1] } : null;
}

/** 기록에 새어 나간 비밀(숫자 경계로 찾는다: 짧은 비밀번호가 `1234ms` 같은 기록 숫자 안에 우연히 든 것은 새지 않은 것이다). */
export function leaksIn(logs, secrets) {
  const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return secrets.filter((s) => s && new RegExp('(?<!\\d)' + escape(s) + '(?!\\d)(?!ms)').test(logs));
}

// ── 브라우저 걸음 ─────────────────────────────────────────────────────────

/** 기기 등록: 화면 숫자판의 키로 12자리 → 입력 → 로그인 화면. */
export async function enroll(page, code) {
  await page.waitForSelector('.pos-enroll', { timeout: STEP_MS });
  const pad = page.locator('.pos-enroll .sn-numpad');
  for (const d of code) await pad.getByRole('button', { name: d, exact: true }).click();
  const shown = (await pad.locator('.sn-numpad-display').textContent())?.trim();
  await pad.getByRole('button', { name: '입력', exact: true }).click();
  await page.waitForSelector('.pos-login-tile', { timeout: STEP_MS });
  return shown;
}

/** 로그인: 직원 타일 → 비밀번호 숫자판(가린 표시) → 입력. 잠김 · 틀림이면 판의 한 줄을 돌려준다(되면 null). */
export async function login(page, name, pin, { expectApp = true } = {}) {
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
export async function pageQuery(page, body) {
  return page.evaluate(async (payload) => {
    const session = await fetch('api/v2/session', { cache: 'no-store' });
    if (session.status !== 200) return { status: session.status };
    const { csrf } = await session.json();
    const res = await fetch('api/v2/query', { method: 'POST', headers: { 'content-type': 'application/json', 'x-skinote-csrf': csrf }, body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);
}

/** 앞단 주소 기준 명령 하나(페이지 안에서, 쿠키 + 세션의 CSRF, 새 요청번호). 결과 { requestId, outcome }. */
export async function pageSend(page, type, payload, extra = {}) {
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

/** 끝 4자리로 접수 id(오늘 장부의 첫 팀). 카운터 세션의 페이지. */
export async function orderOf(page, last4) {
  const found = await pageQuery(page, { name: 'findLast4', params: { last4 } });
  return found.body?.matches?.[0]?.orderId ?? null;
}
