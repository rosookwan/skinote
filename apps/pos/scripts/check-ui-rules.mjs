// 화면 규칙 검사기(ui 4-1 · 8절, 옛 ski-rent-ops/scripts/check-pos-ui-rules.cjs를 옮겨 넓힘). npm run rules -w @skinote/pos
// 빌드한 dist를 vite preview(127.0.0.1:5183, --strictPort)로 띄우고, 매장 기기 등급(pos · pos_narrow · driver_tablet · driver_phone)의
// 검사 크기마다 그 등급의 모든 경로를 돈다. 화면마다 탭 · 쪽을 넘기고, 도장 · 주 버튼 · 옆 동작 · 머리줄 메뉴 · 동작 줄을 눌러
// 여는 확인 창 · 알림 창 · 숫자판 · 아래 판(고르기 판 · 방문 결과 판 · 차에 있는 것)을 모두 열어 재고 닫는다.
// 그 뒤 도장을 찍고(지급 · 수납 · 받음 · 매장 입고 · 못 받음 · 빨리 확인 · 연결 끊김) 체험 시계를 밤(21시 · 22시 뒤)으로 돌려 다시 잰다.
// 규칙(ui-rules-measure.mjs): 등급 최소보다 작은 글자 · 누르는 곳, 가로 넘침 · 화면 밖, 잘린 · 넘친 글자, 말줄임표,
// 스크롤 영역 · 스크롤 목록 · 반쯤 잘린 줄 · 페이지 스크롤, 주 버튼 둘 이상 · 강조색이 아닌 주 버튼, 늦지 않은 것의 빨강, 영어 글자,
// 화면이 고른 기기 등급. 크기 숫자는 DeviceProfile(@skinote/ui/device-profile)에서만 읽는다: 검사 크기(checkSizes), 최소 글자(minFontPx),
// 누르는 곳(minTargetPx), 강조색(accent), 등급 고르기(pickDeviceClass).
// 빌드하지 않는다: 먼저 npm run build. 화면은 경로 · 크기마다 한 장 이상 work/screens/rules/에 남는다(창은 제목마다 첫 장과 어긋난 장).
// 환경 변수(고치는 동안 일부만 돌릴 때): SKINOTE_RULES_ONLY(등급 키를 쉼표로, 예: pos,driver_phone),
//   SKINOTE_RULES_SIZES(크기를 쉼표로, 예: 1024x529,360x640), SKINOTE_RULES_JOBS(동시에 도는 크기 수, 기본 4).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SHOP_DEVICE_CLASS_KEYS } from '@skinote/contract';
import { DEVICE_PROFILES, pickDeviceClass } from '@skinote/ui/device-profile';
import { RULES, RULE_LABELS, measureRules } from './ui-rules-measure.mjs';

const APP = fileURLToPath(new URL('../', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DIST = join(APP, 'dist');
const OUT = join(REPO, 'work/screens/rules');
const PORT = 5183;
const BASE = 'http://127.0.0.1:' + PORT + '/';
const JOBS = Math.max(1, Number(process.env.SKINOTE_RULES_JOBS ?? 4) || 4);
const ONLY = (process.env.SKINOTE_RULES_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SIZES = (process.env.SKINOTE_RULES_SIZES ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** 늦은 것의 모양(여기서만 빨강을 허락한다): 늦음 색 글자(.tone-late)와 늦은 줄(.is-late, 줄 앞 빨간 띠). */
const LATE_SELECTOR = '.tone-late,.is-late';
const LATE_TOKENS = ['--sn-late', '--sn-late-wash'];

/** 등급마다 재는 값(DeviceProfile에서 읽음). */
const PROFILES = Object.fromEntries(Object.entries(DEVICE_PROFILES).map(([key, p]) => [key, { minFont: p.minFontPx, minTarget: p.minTargetPx, accent: p.accent }]));
const COUNTER_CLASSES = SHOP_DEVICE_CLASS_KEYS.filter((key) => pickDeviceClass(DEVICE_PROFILES[key].checkSizes[0], 'counter') === key);
const DRIVER_CLASSES = SHOP_DEVICE_CLASS_KEYS.filter((key) => pickDeviceClass(DEVICE_PROFILES[key].checkSizes[0], 'driver') === key);

// ── 준비: dist · 미리보기 서버 ─────────────────────────────────────────

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

async function reachable(url) {
  try { return (await fetch(url)).ok; } catch { return false; }
}

async function startPreview() {
  const require = createRequire(import.meta.url);
  const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const child = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let exited = false;
  child.on('exit', () => { exited = true; });
  for (let i = 0; i < 100; i += 1) {
    if (exited) throw new Error('미리보기 서버가 멈췄습니다(포트 ' + PORT + '을 다른 것이 쓰고 있나요?)\n' + log.trim());
    if (await reachable(BASE)) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('미리보기 서버를 띄우지 못했습니다: ' + BASE + '\n' + log.trim());
}

// ── 한 크기의 걸음(화면 · 창을 재고 찍는다) ──────────────────────────────

class Walk {
  constructor({ browser, context, page, sizeClass, size, report }) {
    Object.assign(this, { browser, context, page, sizeClass, size, report });
    this.tag = sizeClass + '-' + size.width + 'x' + size.height;
    this.seq = 0;
    this.shotTitles = new Set();
    this.allowed = [sizeClass];
    this.role = 'counter';
    this.date = null;
  }

  /** 화면이 가라앉을 때까지(글꼴을 읽고, DOM이 60ms 동안 바뀌지 않을 때까지, 길어도 2.5초). */
  async settle() {
    await this.page.evaluate(() => new Promise((resolve) => {
      const start = performance.now();
      let last = start;
      const observer = new MutationObserver(() => { last = performance.now(); });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const tick = () => {
        const now = performance.now();
        if ((now - last > 60 && now - start > 40) || now - start > 2500) { observer.disconnect(); resolve(); }
        else requestAnimationFrame(tick);
      };
      document.fonts.ready.then(() => requestAnimationFrame(tick));
    }));
  }

  hash() { return this.page.evaluate(() => window.location.hash); }

  /** 이 경로의 역할(카운터 · 기사)과 크기로 화면이 골라야 할 등급. */
  route(role, extraAllowed = []) {
    this.role = role;
    this.allowed = [...new Set([pickDeviceClass(this.size, role), ...extraAllowed])];
  }

  async visit(hash, selector, role = this.role, extraAllowed = []) {
    this.route(role, extraAllowed);
    await this.page.goto(BASE + hash);
    await this.page.waitForSelector(selector, { timeout: 10_000 });
    await this.settle();
  }

  async click(locator) {
    await locator.first().click();
    await this.settle();
  }

  dialogs() { return this.page.locator('[role="dialog"]:visible'); }
  top() { return this.dialogs().last(); }
  async dialogCount() { return this.dialogs().count(); }
  async topKey() {
    const n = await this.dialogCount();
    return n ? n + ':' + ((await this.top().locator('h2').first().textContent().catch(() => '')) ?? '').trim() : '0';
  }

  fail(scene, text) {
    this.report.push({ size: this.tag, sizeClass: this.sizeClass, scene, kind: 'run', problems: { run: [{ text }] } });
  }

  /** 지금 화면(창이 열려 있으면 그 창)을 재고 기록한다. 화면은 늘 찍고, 창은 제목마다 첫 장과 어긋난 장만 찍는다. */
  async scene(name, kind = 'screen') {
    const result = await this.page.evaluate(measureRules, {
      profiles: PROFILES, sizeClass: this.sizeClass, allowedDevices: this.allowed, lateTokens: LATE_TOKENS, lateSelector: LATE_SELECTOR,
    });
    this.seq += 1;
    const bad = Object.keys(result.problems).length > 0;
    const titleKey = kind + ':' + (result.dialogTitle || name);
    let file;
    if (kind === 'screen' || bad || !this.shotTitles.has(titleKey)) {
      this.shotTitles.add(titleKey);
      file = this.tag + '-' + String(this.seq).padStart(3, '0') + '-' + name.replace(/[^a-z0-9-]+/gi, '-') + '.png';
      await this.page.screenshot({ path: join(OUT, file) });
    }
    this.report.push({
      size: this.tag, sizeClass: this.sizeClass, scene: name, kind, route: await this.hash(), device: result.device,
      title: result.dialogTitle || undefined, min: { font: result.minFont, target: result.minTarget }, primaries: result.primaries,
      ...(file ? { file } : {}), problems: result.problems,
    });
  }

  /** 맨 위 창을 닫는다(닫기 · 이전, 없으면 Esc). n개가 남을 때까지. */
  async closeTo(n) {
    for (let guard = 0; guard < 12 && (await this.dialogCount()) > n; guard += 1) {
      const top = this.top();
      const close = top.getByRole('button', { name: '닫기', exact: true });
      const back = top.getByRole('button', { name: '이전', exact: true });
      if (await close.count()) await this.click(close);
      else if (await back.count()) await this.click(back);
      else { await this.page.keyboard.press('Escape'); await this.settle(); }
    }
    if ((await this.dialogCount()) > n) throw new Error('창을 닫지 못했습니다: ' + (await this.topKey()));
  }

  /**
   * 누르고 무엇이 열렸는지 본다: 새 창 → 창 걷기(재고 안의 선택지까지) → 닫기, 다른 경로 → 재고 돌아오기.
   * back: 경로가 바뀌었을 때 돌아오는 법(기본 브라우저 뒤로).
   */
  async probe(locator, name, { back, depth = 0 } = {}) {
    const beforeHash = await this.hash();
    const beforeCount = await this.dialogCount();
    const beforeKey = await this.topKey();
    await this.click(locator);
    const afterCount = await this.dialogCount();
    const afterKey = await this.topKey();
    if (afterCount > beforeCount || (afterCount > 0 && afterKey !== beforeKey)) {
      await this.dialogWalk(name, { opener: locator, depth });
      await this.closeTo(Math.min(beforeCount, afterCount > beforeCount ? beforeCount : afterCount - 1));
      return 'dialog';
    }
    if ((await this.hash()) !== beforeHash) {
      await this.scene(name);
      if (back) await back();
      else { await this.page.goBack(); await this.settle(); }
      return 'route';
    }
    return 'none';
  }

  /** 열린 창을 잰다: 결제 수단 · 수량 · 알림 창의 다른 동작 · 고르기 판의 선택지 · 방문 결과 판의 단계. */
  async dialogWalk(name, { opener, depth = 0 } = {}) {
    const top = this.top();
    if (await top.locator('.pos-visit').count() || (await top.evaluate((el) => el.classList.contains('pos-visit')))) {
      await this.visitWalk(name);
      return;
    }
    await this.scene(name, 'dialog');
    if (depth > 1) return;
    // 결제 수단(누른 것이 짙어진다)
    const methods = top.locator('.pos-method');
    for (let i = 0, n = await methods.count(); i < n; i += 1) {
      if ((await methods.nth(i).getAttribute('aria-pressed')) === 'true') continue;
      await this.click(methods.nth(i));
      await this.scene(name + '-method' + (i + 1), 'dialog');
    }
    // 수량 −(한 번 빼 보고 되돌린다)
    const minus = top.getByRole('button', { name: '수량 감소' });
    if (await minus.count() && await minus.isEnabled()) {
      await this.click(minus);
      await this.scene(name + '-qty', 'dialog');
      await this.click(top.getByRole('button', { name: '수량 증가' }));
    }
    // 차에 있는 것의 쪽
    const next = top.getByRole('button', { name: '다음 쪽' });
    if (await next.count()) {
      for (let p = 2; await next.isEnabled(); p += 1) { await this.click(next); await this.scene(name + '-p' + p, 'dialog'); }
    }
    // 숫자판(끝 4자리): 없는 번호 → 한 문장
    const keys = top.locator('.sn-keypad');
    if (await keys.count()) {
      for (const d of '9999') await this.click(top.getByRole('button', { name: d, exact: true }));
      await this.click(top.getByRole('button', { name: '찾기', exact: true }));
      await this.scene(name + '-none', 'dialog');
      return;
    }
    // 고르기 판(더 보기 · 여러 팀 · 빨리 확인 목록): 선택지마다 다시 열고 눌러 본다.
    const choices = top.locator('.pos-choice-button');
    const choiceCount = await choices.count();
    if (choiceCount && opener) {
      for (let i = 0; i < choiceCount; i += 1) {
        if (i > 0) {
          await this.closeTo(0);
          await this.click(opener);
        }
        await this.probe(this.top().locator('.pos-choice-button').nth(i), name + '-c' + (i + 1), { depth: depth + 1 });
        await this.closeTo(0);
      }
      return;
    }
    // 알림 창의 다른 동작(주 버튼이 아닌 것): 매장에서 … · 지금 수납 · 접수증 열기 → 다음 창 · 경로
    const extras = top.locator('.pos-notice-actions button:not([data-primary="true"])');
    if (await extras.count()) await this.probe(extras.first(), name + '-then', { depth: depth + 1 });
  }

  /** 방문 결과 판(수거 실패): 사유 → 재방문 → 날짜 → 이전 → 오늘 → 재방문 시각 → 직접 입력 → 기록 확인. 저장하지 않는다(submit: 저장한다). */
  async visitWalk(name, submit = false) {
    const top = this.top();
    const button = (label) => top.getByRole('button', { name: label, exact: true });
    await this.scene(name + '-reason', 'dialog');
    await this.click(top.locator('.pos-visit-choice').first());
    await this.scene(name + '-when', 'dialog');
    await this.click(button('날짜'));
    await this.scene(name + '-date', 'dialog');
    await this.click(button('이전'));
    await this.click(button('오늘'));
    await this.scene(name + '-time', 'dialog');
    await this.click(button('직접 입력'));
    await this.scene(name + '-custom', 'dialog');
    for (const d of '2350') await this.click(button(d));
    await this.scene(name + '-custom-typed', 'dialog');
    await this.click(button('확인'));
    await this.scene(name + '-review', 'dialog');
    if (submit) {
      await this.click(top.locator('[data-primary="true"]'));
    }
  }

  /** 바닥줄 쪽 넘김 '1 / 3쪽'의 [지금, 모두]. */
  async pageInfo(scope = this.page.locator('.sn-footer')) {
    const text = await scope.locator('.sn-pager-text').first().textContent({ timeout: 500 }).catch(() => '');
    const m = /(\d+)\s*\/\s*(\d+)/.exec(text ?? '');
    return m ? [Number(m[1]), Number(m[2])] : [1, 1];
  }

  async toPage(target, scope = this.page.locator('.sn-footer')) {
    for (let guard = 0; guard < 20; guard += 1) {
      const [now] = await this.pageInfo(scope);
      if (now === target) return;
      await this.click(scope.getByRole('button', { name: now < target ? '다음 쪽' : '이전 쪽' }));
    }
  }

  /** 쪽마다 재고(onPage가 있으면 그 쪽에서 더 한다) 첫 쪽으로 돌아온다. measure: false면 재지 않고 onPage만. */
  async pages(name, onPage, { measure = true } = {}) {
    const [, total] = await this.pageInfo();
    for (let p = 1; p <= total; p += 1) {
      await this.toPage(p);
      if (measure) await this.scene(name + '-p' + p);
      if (onPage) await onPage(p);
    }
    await this.toPage(1);
  }

  /** 색인 탭마다 쪽마다(넘친 탭은 더 보기 판에서 고른다). 끝나면 첫 탭. */
  async tabs(name) {
    const tabs = this.page.locator('.sn-tabs [role="tab"]');
    const n = await tabs.count();
    for (let i = 0; i < n; i += 1) {
      const tab = tabs.nth(i);
      if (await tab.evaluate((el) => el.classList.contains('is-more'))) {
        await this.click(tab);
        await this.scene(name + '-tabs-more', 'dialog');
        const choices = this.top().locator('.pos-choice-button');
        const m = await choices.count();
        for (let j = 0; j < m; j += 1) {
          if (j > 0) await this.click(tabs.nth(i));
          await this.click(this.top().locator('.pos-choice-button').nth(j));
          await this.pages(name + '-tabmore' + (j + 1));
        }
        continue;
      }
      await this.click(tab);
      await this.pages(name + '-tab' + (i + 1));
    }
    await this.click(tabs.first());
  }

  /** 머리줄: 끝 4자리 · 메뉴 · 더 보기 · 알림(장부 · 나가기는 경로라 따로 걷는다). */
  async header(name) {
    const header = this.page.locator('.sn-header');
    const find = header.getByRole('button', { name: '끝 4자리' });
    if (await find.count()) await this.probe(find, name + '-find');
    const buttons = header.locator('.sn-header-right button');
    const labels = [];
    for (let i = 0, n = await buttons.count(); i < n; i += 1) {
      labels.push(((await buttons.nth(i).getAttribute('aria-label')) ?? (await buttons.nth(i).textContent()) ?? '').trim());
    }
    for (const [i, label] of labels.entries()) {
      if (label === '끝 4자리' || label === '나가기') continue;
      const button = header.locator('.sn-header-right button').nth(i);
      await this.probe(button, name + '-head' + (i + 1));
      await this.closeTo(0);
    }
  }

  /** 줄 안의 누르는 것(도장 칸 · 전화 칸)을 모두 눌러 창을 잰다. */
  async rowButtons(name, rows = this.page.locator('.sn-ledger tr.sn-row')) {
    for (let i = 0, n = await rows.count(); i < n; i += 1) {
      const buttons = rows.nth(i).locator('button.sn-stamp-cell, button.sn-cell-action');
      for (let j = 0, m = await buttons.count(); j < m; j += 1) {
        if (!(await buttons.nth(j).isEnabled())) continue;
        await this.probe(rows.nth(i).locator('button.sn-stamp-cell, button.sn-cell-action').nth(j), name + '-r' + (i + 1) + 's' + (j + 1));
        await this.closeTo(0);
      }
    }
  }

  /** 새 탭(같은 브라우저 문맥, 체험 자료를 나눠 씀)을 카운터 첫 검사 크기로 열어 일을 시킨다. */
  async counterTab(act) {
    const desk = await this.context.newPage();
    const size = DEVICE_PROFILES.pos.checkSizes[0];
    await desk.setViewportSize({ width: size.width, height: size.height });
    try { await act(desk); } finally { await desk.close(); }
  }
}

// ── 내용 검사(규칙 검사 밖에서 사람이 잃으면 안 되는 것) ──────────────────────

/** 장부의 끝나지 않은 줄마다 정렬 기준인 시각이 보이는지(시각 칸이든 팀 칸 앞에 합쳐졌든). 좁은 포스에서 시각이 사라지지 않게. */
async function ledgerTimes(w, name) {
  const missing = await w.page.evaluate(() => [...document.querySelectorAll('.sn-ledger.is-ledger tr.sn-row:not(.is-finished)')]
    .filter((row) => !/\d{2}:\d{2}/.test((row.querySelector('.is-time')?.textContent ?? '') + ' ' + (row.querySelector('.is-team')?.textContent ?? '')))
    .map((row) => row.innerText.replace(/\s+/g, ' ').trim().slice(0, 40)));
  if (missing.length) w.fail(name, '시각이 안 보이는 장부 줄 ' + missing.length + '개: ' + missing.slice(0, 3).join(' / '));
}

/** 수거 목록의 줄마다 장소 이름표가 보이는지(온전한 이름이나 짧은 이름). 기사에게 장소가 가장 중요하다. */
async function placeTags(w, name) {
  const missing = await w.page.evaluate(() => [...document.querySelectorAll('.sn-ledger tr.sn-row .sn-tag-slot')]
    .filter((slot) => !(slot.querySelector('.sn-tag')?.textContent ?? '').trim())
    .map((slot) => (slot.closest('tr')?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)));
  if (missing.length) w.fail(name, '장소 이름표가 빠진 줄 ' + missing.length + '개: ' + missing.slice(0, 3).join(' / '));
}

// ── 카운터(pos · pos_narrow) ────────────────────────────────────────────

async function slipWalk(w, name) {
  await w.scene(name);
  const footer = w.page.locator('.sn-footer');
  const [, itemPages] = await w.pageInfo(footer);
  for (let p = 1; p <= itemPages; p += 1) {
    await w.toPage(p, footer);
    if (p > 1) await w.scene(name + '-items-p' + p);
    const stamps = w.page.locator('.sn-slip-items button.sn-stamp-cell');
    for (let j = 0, m = await stamps.count(); j < m; j += 1) {
      await w.probe(w.page.locator('.sn-slip-items button.sn-stamp-cell').nth(j), name + '-i' + p + 's' + (j + 1));
      await w.closeTo(0);
    }
  }
  await w.toPage(1, footer);
  const primary = w.page.locator('.pos-side [data-primary="true"]');
  if (await primary.count()) { await w.probe(primary, name + '-next'); await w.closeTo(0); }
  const side = w.page.locator('.pos-side-actions button');
  for (let j = 0, m = await side.count(); j < m; j += 1) {
    await w.probe(w.page.locator('.pos-side-actions button').nth(j), name + '-side' + (j + 1));
    await w.closeTo(0);
  }
}

/** 장부 → 줄마다 접수증 → '‹ 장부'(온 쪽으로 돌아온다). */
async function everySlip(w) {
  const [, total] = await w.pageInfo();
  for (let p = 1; p <= total; p += 1) {
    await w.toPage(p);
    const count = await w.page.locator('.sn-ledger tr.sn-row .sn-cell-open').count();
    for (let i = 0; i < count; i += 1) {
      const open = w.page.locator('.sn-ledger tr.sn-row .sn-cell-open').nth(i);
      const last4 = /\b(\d{4})\b/.exec((await open.textContent()) ?? '')?.[1] ?? 'p' + p + 'r' + (i + 1);
      await open.click();
      await w.page.waitForSelector('.sn-slip');
      await w.settle();
      await slipWalk(w, 'slip-' + last4);
      await w.click(w.page.locator('.pos-footer-back').getByRole('button', { name: '장부' }));
      await w.page.waitForSelector('.sn-ledger tr.sn-row');
      await w.settle();
      const [now] = await w.pageInfo();
      if (now !== p) { w.fail('slip-' + last4, '‹ 장부가 ' + p + '쪽이 아니라 ' + now + '쪽으로 돌아옴'); await w.toPage(p); }
    }
  }
  await w.toPage(1);
}

async function collectionWalk(w, name) {
  await w.tabs(name);
  await w.pages(name + '-tags', () => placeTags(w, name + '-tags'), { measure: false });
  // 빨리 확인 줄: 전화 · 줄 열기(둘 이상이면 목록 판)
  const pin = w.page.locator('.sn-pin');
  if (await pin.count()) {
    const call = pin.getByRole('button', { name: '전화' });
    if (await call.count()) { await w.probe(call, name + '-pin-call'); await w.closeTo(0); }
    const open = pin.locator('button.sn-pin-open');
    if (await open.count()) {
      const res = await w.probe(open, name + '-pin-open');
      await w.closeTo(0);
      if (res === 'none') await w.scene(name + '-pin-selected');
      await deselect(w);
    }
  }
  // 쪽마다: 도장 · 전화 칸, 줄 하나 고르기 → 동작 줄
  await w.pages(name + '-rows', async (p) => {
    await w.rowButtons(name + '-p' + p);
    const first = w.page.locator('.sn-ledger tr.sn-row .sn-cell-open').first();
    if (await first.count()) {
      await w.click(first);
      await w.scene(name + '-p' + p + '-selected');
      if (p === 1) await rowBarWalk(w, name + '-bar');
      await deselect(w);
    }
  }, { measure: false });
  const primary = w.page.locator('.sn-footer [data-primary="true"]');
  if (await primary.count() && await primary.isEnabled()) { await w.probe(primary, name + '-primary'); await w.closeTo(0); }
}

async function deselect(w) {
  const selected = w.page.locator('.sn-ledger tr.sn-row[data-selected="true"] .sn-cell-open');
  if (await selected.count()) await w.click(selected);
}

/** 고른 줄의 동작 줄: 창을 여는 동작은 열어 재고 닫고, 순서 동작(▲ · ▼ · 맨 위로 · 시간순)은 눌러 잰다. */
async function rowBarWalk(w, name) {
  const bar = () => w.page.getByRole('toolbar');
  const labels = [];
  const buttons = bar().locator('button');
  for (let i = 0, n = await buttons.count(); i < n; i += 1) {
    labels.push({ label: ((await buttons.nth(i).getAttribute('aria-label')) ?? (await buttons.nth(i).textContent()) ?? '').trim(), enabled: await buttons.nth(i).isEnabled() });
  }
  const moves = new Set(['위로', '아래로', '맨 위로', '닫기']);
  for (const [i, { label, enabled }] of labels.entries()) {
    if (!enabled || moves.has(label)) continue;
    if (!(await bar().count())) break;
    const target = bar().getByRole('button', { name: label, exact: true });
    if (!(await target.count())) continue;
    await w.probe(target, name + '-a' + (i + 1), {
      back: async () => { await w.page.goBack(); await w.page.waitForSelector('.sn-ledger tr.sn-row'); await w.settle(); },
    });
    await w.closeTo(0);
  }
  for (const label of ['아래로', '위로', '맨 위로']) {
    if (!(await bar().count())) break;
    const target = bar().getByRole('button', { name: label, exact: true });
    if (await target.count() && await target.isEnabled()) {
      await w.click(target);
      await w.scene(name + '-' + { 아래로: 'down', 위로: 'up', '맨 위로': 'top' }[label]);
    }
  }
  // 시간순 되돌리기는 확인 창을 거친다: 열어 재고 되돌린 뒤, 닫기로 고르기를 끝낸다.
  const reset = bar().getByRole('button', { name: '시간순 정렬', exact: true });
  if (await reset.count() && await reset.isEnabled()) {
    await w.click(reset);
    if (await w.dialogCount()) {
      await w.scene(name + '-reset', 'dialog');
      const ok = w.top().locator('[data-primary="true"]');
      if (await ok.count()) await w.click(ok);
      await w.closeTo(0);
    }
    await w.scene(name + '-after-reset');
  }
  const close = bar().getByRole('button', { name: '닫기', exact: true });
  if (await bar().count() && await close.count()) {
    await w.click(close);
    if (await bar().count()) w.fail(name, '동작 줄의 닫기가 고르기를 끝내지 않음');
  }
}

async function counterWalk(w) {
  w.route('counter');
  await w.visit('#/', '.pos-card', 'counter');
  await w.scene('start');
  await w.visit('#/orders/none', '.pos-card');
  await w.scene('slip-missing');

  // 장부(날짜 없는 주소 → 오늘 주소)
  await w.visit('#/ledger', '.sn-ledger tr.sn-row');
  const date = /^#\/ledger\/(\d{4}-\d{2}-\d{2})$/.exec(await w.hash())?.[1];
  if (!date) w.fail('ledger', '#/ledger가 오늘 장부 주소로 바뀌지 않음: ' + (await w.hash()));
  w.date = date ?? '2026-12-26';
  await w.tabs('ledger');
  await w.pages('ledger-times', () => ledgerTimes(w, 'ledger-times'), { measure: false });
  await w.header('ledger');
  await w.pages('ledger-stamps', (p) => w.rowButtons('ledger-p' + p), { measure: false });
  const primary = w.page.locator('.sn-footer [data-primary="true"]');
  await w.probe(primary, 'ledger-primary');
  await w.closeTo(0);
  await everySlip(w);

  // 카운터 수거 목록
  await w.visit('#/collections/' + w.date, '.sn-ledger tr.sn-row');
  await collectionWalk(w, 'collection');

  // 나가기
  await w.visit('#/exit', '.pos-card');
  await w.scene('exit');
  await w.probe(w.page.getByRole('button', { name: '체험 자료 초기화', exact: true }), 'exit-reset');
  await w.closeTo(0);

  await counterFlow(w);
  await counterNight(w);
}

/** 도장을 찍은 뒤의 모양: 지급 → 수납 → 빨리 확인 → 순서 바꿈. */
async function counterFlow(w) {
  await w.visit('#/ledger/' + w.date, '.sn-ledger tr.sn-row');
  const todoStamp = 'button.sn-stamp-cell[aria-label$="미처리"]';
  const issue = w.page.locator('.sn-ledger tr.sn-row ' + todoStamp).first();
  if (await issue.count()) {
    const row = w.page.locator('.sn-ledger tr.sn-row', { has: w.page.locator(todoStamp) }).first();
    const team = /\b(\d{4})\b/.exec((await row.locator('.sn-cell-open').textContent()) ?? '')?.[1] ?? '';
    await w.click(issue);
    const commit = w.top().locator('[data-primary="true"]');
    if (await commit.count()) {
      await w.click(commit);
      await w.closeTo(0);
      await w.scene('flow-ledger-after-stamp');
      const again = w.page.locator('.sn-ledger tr.sn-row .sn-cell-open', { hasText: team }).first();
      if (await again.count()) {
        await w.click(again);
        await w.page.waitForSelector('.sn-slip');
        await w.settle();
        await w.scene('flow-slip-after-stamp');
        const next = w.page.locator('.pos-side [data-primary="true"]');
        if (await next.count()) {
          await w.click(next);
          const methods = w.top().locator('.pos-method');
          if (await methods.count() > 1) await w.click(methods.nth(1));
          const ok = w.top().locator('[data-primary="true"]');
          if (await ok.count()) { await w.click(ok); await w.closeTo(0); }
          await w.scene('flow-slip-after-next');
        }
      }
    } else {
      await w.closeTo(0);
    }
  }
  // 카운터 수거 목록에서 빨리 확인 · 순서
  await w.visit('#/collections/' + w.date, '.sn-ledger tr.sn-row');
  const rows = w.page.locator('.sn-ledger tr.sn-row .sn-cell-open');
  if (await rows.count() > 1) {
    await w.click(rows.nth(1));
    const pin = w.page.getByRole('toolbar').getByRole('button', { name: '긴급 요청', exact: true });
    if (await pin.count()) {
      await w.click(pin);
      const ok = w.top().locator('[data-primary="true"]');
      if (await ok.count()) { await w.click(ok); await w.closeTo(0); }
    }
    await w.closeTo(0);
    await deselect(w);
    await w.pages('flow-collection-after-pin');
    const open = w.page.locator('.sn-pin button.sn-pin-open');
    if (await open.count()) { await w.probe(open, 'flow-collection-pins'); await w.closeTo(0); }
  }
}

/** 체험 시계를 21:10 · 22:10 뒤로: 야간 수거 준비 줄, 늦은 줄(빨강), 마감 주 버튼. */
async function counterNight(w) {
  const advance = async (hours, tens) => {
    await w.visit('#/exit', '.pos-card');
    for (let i = 0; i < hours; i += 1) await w.click(w.page.getByRole('button', { name: '+1시간', exact: true }));
    for (let i = 0; i < tens; i += 1) await w.click(w.page.getByRole('button', { name: '+10분', exact: true }));
  };
  await advance(5, 3);
  await w.visit('#/ledger/' + w.date, '.sn-ledger tr.sn-row');
  await w.pages('night-ledger');
  await w.probe(w.page.locator('.sn-header').getByRole('button', { name: /^알림/ }), 'night-alerts');
  await w.closeTo(0);
  await w.visit('#/collections/' + w.date, '.sn-ledger tr.sn-row');
  await w.pages('night-collection');
  await advance(1, 0);
  await w.visit('#/ledger/' + w.date, '.sn-ledger tr.sn-row');
  await w.tabs('late-ledger');
  await w.pages('late-ledger-times', () => ledgerTimes(w, 'late-ledger-times'), { measure: false });
  // 늦은 줄의 접수증(늦은 미수는 돈 칸만 빨강)
  const late = w.page.locator('.sn-ledger tr.sn-row.is-late .sn-cell-open');
  if (await late.count()) {
    await w.click(late.first());
    await w.page.waitForSelector('.sn-slip');
    await w.settle();
    await w.scene('late-slip');
    await w.click(w.page.locator('.pos-footer-back').getByRole('button', { name: '장부' }));
    await w.page.waitForSelector('.sn-ledger tr.sn-row');
    await w.settle();
  }
  await w.probe(w.page.locator('.sn-footer [data-primary="true"]'), 'late-primary');
  await w.closeTo(0);
}

// ── 기사(driver_tablet · driver_phone) ─────────────────────────────────

async function driverFind(w, name) {
  const side = w.page.locator('.sn-keypad.is-side');
  const firstTeam = (await w.page.locator('.sn-ledger tr.sn-row .sn-cell-open').first().textContent()) ?? '';
  const last4 = /\b(\d{4})\b/.exec(firstTeam)?.[1];
  if (await side.count()) {
    for (const d of '9999') await w.click(side.getByRole('button', { name: d, exact: true }));
    await w.click(side.getByRole('button', { name: '찾기', exact: true }));
    await w.scene(name + '-side-none');
    if (last4) {
      for (const d of last4) await w.click(side.getByRole('button', { name: d, exact: true }));
      await w.click(side.getByRole('button', { name: '찾기', exact: true }));
      await w.scene(name + '-side-found');
      await deselect(w);
    }
    return;
  }
  const open = w.page.locator('.sn-header').getByRole('button', { name: '끝 4자리' });
  if (!(await open.count())) { w.fail(name, '끝 4자리 숫자판을 열 곳이 없음'); return; }
  await w.probe(open, name);
  await w.closeTo(0);
  if (last4) {
    await w.click(open);
    for (const d of last4) await w.click(w.top().getByRole('button', { name: d, exact: true }));
    await w.click(w.top().getByRole('button', { name: '찾기', exact: true }));
    await w.scene(name + '-found');
    await w.closeTo(0);
    await deselect(w);
  }
}

async function driverWalk(w) {
  // 처음 화면에서 기사 태블릿(휴대폰 크기면 기사 휴대폰)
  await w.visit('#/', '.pos-card', 'counter');
  await w.scene('start');
  const phone = w.sizeClass === 'driver_phone';
  w.route('driver');
  await w.click(w.page.getByRole('button', { name: phone ? /기사 휴대폰/ : /기사 태블릿/ }));
  await w.page.waitForSelector('.sn-ledger tr.sn-row');
  await w.settle();
  w.date = /#\/driver\/(\d{4}-\d{2}-\d{2})/.exec(await w.hash())?.[1] ?? '2026-12-26';
  const list = async () => { await w.visit('#/driver/' + w.date, '.sn-ledger tr.sn-row', 'driver'); };

  await w.tabs('driver');
  await w.pages('driver-tags', () => placeTags(w, 'driver-tags'), { measure: false });
  // 빨리 확인 줄
  const pin = w.page.locator('.sn-pin');
  if (await pin.count()) {
    await w.probe(pin.getByRole('button', { name: '전화' }), 'driver-pin-call');
    await w.closeTo(0);
    const res = await w.probe(pin.locator('button.sn-pin-open'), 'driver-pin-open');
    await w.closeTo(0);
    if (res === 'none') await w.scene('driver-pin-selected');
    await deselect(w);
  }
  await driverFind(w, 'driver-find');
  await w.header('driver');
  // 쪽마다: 받음 도장 · 전화 칸, 줄 고르기 → 동작 줄(첫 쪽에서는 동작마다)
  await w.pages('driver-rows', async (p) => {
    await w.rowButtons('driver-p' + p);
    const first = w.page.locator('.sn-ledger tr.sn-row .sn-cell-open').first();
    if (await first.count()) {
      await w.click(first);
      await w.scene('driver-p' + p + '-selected');
      await deselect(w);
    }
  }, { measure: false });
  await rowMoves(w, 'driver-bar');

  await driverFlow(w, list);
  if (w.sizeClass === 'driver_tablet') {
    // 넓은 화면에서 휴대폰 모양으로 보기(틀이 들어가면 휴대폰 등급)
    await w.visit('#/driver/' + w.date + '?device=phone', '.sn-ledger tr.sn-row', 'driver', ['driver_phone']);
    await w.pages('driver-phone-frame');
  }
  await driverNight(w, list);
}

async function rowMoves(w, name) {
  const first = w.page.locator('.sn-ledger tr.sn-row .sn-cell-open').nth(1);
  if (!(await first.count())) return;
  await w.click(first);
  await rowBarWalk(w, name);
  await deselect(w);
}

/** 받음 → 매장 입고 → 못 받음 남기기 → 연결 끊김(보냄 대기) → 다시 연결 → 카운터가 빨리 확인 하나 더. */
async function driverFlow(w, list) {
  await list();
  const todo = () => w.page.locator('.sn-ledger tr.sn-row button.sn-stamp-cell[aria-label$="미처리"]').first();
  if (await todo().count()) {
    await w.click(todo());
    await w.scene('flow-confirm-collect', 'dialog');
    await w.click(w.top().locator('[data-primary="true"]'));
    await w.closeTo(0);
    await w.scene('flow-after-collect');
  }
  const receive = w.page.locator('.sn-footer [data-primary="true"]');
  if (await receive.count() && await receive.isEnabled()) {
    await w.click(receive);
    await w.scene('flow-confirm-receive', 'dialog');
    const ok = w.top().locator('[data-primary="true"]');
    if (await ok.count()) await w.click(ok);
    await w.closeTo(0);
    await w.scene('flow-after-receive');
  }
  const second = w.page.locator('.sn-ledger tr.sn-row .sn-cell-open').nth(1);
  if (await second.count()) {
    await w.click(second);
    const miss = w.page.getByRole('toolbar').getByRole('button', { name: '수거 실패', exact: true });
    if (await miss.count() && await miss.isEnabled()) {
      await w.click(miss);
      await w.visitWalk('flow-visit', true);
      await w.closeTo(0);
      await w.pages('flow-after-visit');
    } else {
      await deselect(w);
    }
  }
  // 연결 끊김(체험): 나가기 → 연결 끊기 → 받음 도장 점선 · 연결 띠 → 매장 입고는 연결 뒤 → 다시 연결
  await w.visit('#/exit?from=driver', '.pos-card', 'driver');
  await w.scene('exit-driver');
  await w.click(w.page.getByRole('button', { name: '연결 해제', exact: true }));
  await w.scene('exit-driver-offline');
  await list();
  if (await todo().count()) {
    const row = w.page.locator('.sn-ledger tr.sn-row', { has: w.page.locator('button.sn-stamp-cell[aria-label$="미처리"]') }).first();
    const team = /\b(\d{4})\b/.exec((await row.locator('.sn-cell-open').textContent()) ?? '')?.[1] ?? '';
    await w.click(todo());
    const ok = w.top().locator('[data-primary="true"]');
    if (await ok.count()) await w.click(ok);
    await w.closeTo(0);
    await w.pages('flow-offline');
    const pending = w.page.locator('.sn-ledger tr.sn-row', { hasText: team }).locator('button.sn-stamp-cell[aria-label*="전송 대기"]');
    if (await pending.count()) { await w.probe(pending, 'flow-offline-pending'); await w.closeTo(0); }
  }
  const receive2 = w.page.locator('.sn-footer [data-primary="true"]');
  if (await receive2.count() && await receive2.isEnabled()) { await w.probe(receive2, 'flow-offline-receive'); await w.closeTo(0); }
  await w.visit('#/exit?from=driver', '.pos-card', 'driver');
  await w.scene('exit-driver-waiting');
  await w.click(w.page.getByRole('button', { name: /^재연결/ }));
  await list();
  await w.scene('flow-after-sync');

  // 카운터 탭에서 빨리 확인 둘(받지 않은 줄) → 기사 목록 맨 위 '빨리 확인 1건 더' → 목록 판
  let sent = 0;
  await w.counterTab(async (desk) => {
    await desk.goto(BASE + '#/collections/' + w.date);
    await desk.waitForSelector('.sn-ledger tr.sn-row');
    await desk.evaluate(() => document.fonts.ready);
    for (const pick of [-1, -2]) {
      const rows = desk.locator('.sn-ledger tr.sn-row', { has: desk.locator('button.sn-stamp-cell[aria-label$="미처리"]') }).locator('.sn-cell-open');
      const n = await rows.count();
      if (n + pick < 0) break;
      await rows.nth(n + pick).click();
      const pinButton = desk.getByRole('toolbar').getByRole('button', { name: '긴급 요청', exact: true });
      if (!(await pinButton.count()) || !(await pinButton.isEnabled())) continue;
      await pinButton.click();
      const ok = desk.locator('[role="dialog"] [data-primary="true"]');
      await ok.or(desk.locator('[role="dialog"]')).first().waitFor();
      if (await ok.count()) { await ok.click(); await desk.locator('[role="dialog"]').waitFor({ state: 'detached' }); sent += 1; }
      else await desk.keyboard.press('Escape');
    }
    if (sent < 2) await desk.screenshot({ path: join(OUT, w.tag + '-counter-tab-pin.png') });
  });
  await w.page.locator('.sn-pin').waitFor({ timeout: 3000 }).catch(() => {});
  await w.settle();
  await w.scene('flow-two-pins');
  if (sent < 2 || !(await w.page.locator('.sn-pin').count())) w.fail('flow-two-pins', '카운터가 보낸 긴급 요청이 기사 목록에 없음(보낸 수 ' + sent + ')');
  const open = w.page.locator('.sn-pin button.sn-pin-open');
  if (await open.count()) { await w.probe(open, 'flow-pin-list'); await w.closeTo(0); }
  const ack = w.page.locator('.sn-pin').getByRole('button', { name: '확인', exact: true });
  if (await ack.count()) { await w.click(ack); await w.scene('flow-pin-ack'); }
}

async function driverNight(w, list) {
  await w.visit('#/exit?from=driver', '.pos-card', 'driver');
  for (let i = 0; i < 6; i += 1) await w.click(w.page.getByRole('button', { name: '+1시간', exact: true }));
  await w.scene('exit-driver-night');
  await list();
  await w.pages('late-driver');
}

// ── 실행 ─────────────────────────────────────────────────────────────

async function runSize(browser, sizeClass, size) {
  const report = [];
  const context = await browser.newContext({ viewport: size, locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const w = new Walk({ browser, context, page, sizeClass, size, report });
  const started = Date.now();
  try {
    if (DRIVER_CLASSES.includes(sizeClass)) await driverWalk(w);
    else await counterWalk(w);
  } catch (error) {
    const shot = w.tag + '-error.png';
    await page.screenshot({ path: join(OUT, shot) }).catch(() => {});
    report.push({ size: w.tag, sizeClass, scene: 'error', kind: 'run', file: shot, problems: { run: [{ text: String(error?.message ?? error).split('\n').slice(0, 6).join(' / ') }] } });
  }
  if (errors.length) report.push({ size: w.tag, sizeClass, scene: 'console', kind: 'run', problems: { console: errors.map((text) => ({ text: text.slice(0, 300) })) } });
  await context.close();
  return { tag: w.tag, report, seconds: Math.round((Date.now() - started) / 1000) };
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('빌드한 앱이 없습니다: ' + DIST + '\n먼저 npm run build 를 실행하세요(이 검사기는 빌드하지 않습니다).');
    process.exit(1);
  }
  const built = statSync(join(DIST, 'index.html')).mtimeMs;
  const source = Math.max(newestMtime(join(APP, 'src')), newestMtime(join(REPO, 'packages/ui/src')), newestMtime(join(REPO, 'packages/contract')), newestMtime(join(REPO, 'packages/layout/src')));
  if (source > built) console.warn('주의: 소스가 빌드보다 새롭습니다. 고친 것을 보려면 npm run build 를 먼저 하세요.');

  const classes = SHOP_DEVICE_CLASS_KEYS.filter((key) => !ONLY.length || ONLY.includes(key));
  const jobs = classes
    .flatMap((key) => DEVICE_PROFILES[key].checkSizes.map((size) => ({ key, size: { width: size.width, height: size.height } })))
    .filter((job) => !SIZES.length || SIZES.includes(job.size.width + 'x' + job.size.height));
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const server = await startPreview();
  const browser = await chromium.launch();
  const results = [];
  try {
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next];
        next += 1;
        const result = await runSize(browser, job.key, job.size);
        results.push(result);
        const bad = result.report.filter((r) => Object.keys(r.problems ?? {}).length).length;
        console.log((bad ? '✗ ' : '✓ ') + result.tag + '  장면 ' + result.report.filter((r) => r.kind !== 'run').length + '개 · 어긋난 장면 ' + bad + '개 · ' + result.seconds + '초');
      }
    };
    await Promise.all(Array.from({ length: Math.min(JOBS, jobs.length) }, worker));
  } finally {
    await browser.close();
    server.kill();
  }

  const order = jobs.map((j) => j.key + '-' + j.size.width + 'x' + j.size.height);
  results.sort((a, b) => order.indexOf(a.tag) - order.indexOf(b.tag));
  const report = results.flatMap((r) => r.report);
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), url: BASE, counterClasses: COUNTER_CLASSES, driverClasses: DRIVER_CLASSES, report }, null, 2));

  const failing = report.filter((r) => Object.keys(r.problems ?? {}).length);
  const totals = {};
  for (const entry of failing) {
    console.log('\n✗ ' + entry.size + ' ' + entry.scene + (entry.title ? ' [' + entry.title + ']' : '') + (entry.file ? '  ' + entry.file : ''));
    for (const [rule, rows] of Object.entries(entry.problems)) {
      totals[rule] = (totals[rule] ?? 0) + rows.length;
      for (const row of rows.slice(0, 4)) console.log('    ' + (RULE_LABELS[rule] ?? rule) + ': ' + JSON.stringify(row));
    }
  }
  const scenes = report.filter((r) => r.kind !== 'run');
  const shots = report.filter((r) => r.file).length;
  console.log('\n크기 ' + results.length + '개 · 잰 장면 ' + scenes.length + '개(화면 ' + scenes.filter((r) => r.kind === 'screen').length + ' · 창 ' + scenes.filter((r) => r.kind === 'dialog').length + ')'
    + ' · 통과 ' + (scenes.length - scenes.filter((r) => Object.keys(r.problems).length).length) + '개 · 어긋난 장면 ' + failing.length + '개 · 찍은 화면 ' + shots + '장');
  if (failing.length) console.log('규칙별: ' + [...RULES, 'run', 'console'].filter((k) => totals[k]).map((k) => (RULE_LABELS[k] ?? k) + ' ' + totals[k]).join(' · '));
  console.log('찍은 화면 · report.json: ' + OUT);
  process.exitCode = failing.length ? 1 : 0;
}

await main();
