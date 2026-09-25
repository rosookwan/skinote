// 화면 규칙 검사기(ui 4-1 · 8절, 옛 ski-rent-ops/scripts/check-pos-ui-rules.cjs를 옮겨 넓힘). npm run rules -w @skinote/pos
// 빌드한 dist를 vite preview(127.0.0.1:5183, --strictPort)로 띄우고, 매장 기기 등급(pos · pos_narrow · driver_tablet · driver_phone)의
// 검사 크기마다 그 등급의 모든 경로를 돈다. 화면마다 탭 · 쪽을 넘기고, 도장 · 주 버튼 · 옆 동작 · 머리줄 메뉴 · 동작 줄을 눌러
// 여는 확인 창 · 알림 창 · 숫자판 · 아래 판(고르기 판 · 방문 결과 판 · 차에 있는 것)을 모두 열어 재고 닫는다.
// 그 뒤 도장을 찍고(지급 · 수납 · 받음 · 매장 입고 · 못 받음 · 빨리 확인 · 연결 끊김) 체험 시계를 밤(21시 · 22시 뒤)으로 돌려 다시 잰다.
// 글자 칸(새 접수 대표자 · 현금 점검 직접 입력)은 화면 키보드(keyboardWalk): 편집 칸이 없는지, 키로 친 ㄱ ㅣ ㅁ이 `김`인지, 치는 중에는
// 안내가 없고 `입력`을 누른 뒤에만 낱자모 안내(제목은 그대로), `닫기`가 키 줄 밖인지, 자모 키 글자의 먹 높이, 쌍자음(글자로 보이는 키) ·
// 가장 넓은 글자(뷁)로 한도까지 채운 표시 칸 · 숫자 쪽을 잰다. 기사 기기 크기는 미리 보기 #/preview/keyboard(40자)에서 잰다.
// 서버 모드의 화면(기기 등록 · 로그인 타일 쪽 · 비밀번호 숫자판 · 연결 끊김 · 로그아웃)은 미리 보기 #/preview/enroll · login · offline ·
// exit에서 잰다(connectWalk).
// 규칙(ui-rules-measure.mjs): 등급 최소보다 작은 글자 · 누르는 곳, 가로 넘침 · 화면 밖, 잘린 · 넘친 글자, 말줄임표,
// 스크롤 영역 · 스크롤 목록 · 반쯤 잘린 줄 · 페이지 스크롤, 주 버튼 둘 이상 · 강조색이 아닌 주 버튼, 늦지 않은 것의 빨강, 영어 글자,
// 화면이 고른 기기 등급. 크기 숫자는 DeviceProfile(@skinote/ui/device-profile)에서만 읽는다: 검사 크기(checkSizes), 최소 글자(minFontPx),
// 누르는 곳(minTargetPx), 강조색(accent), 등급 고르기(pickDeviceClass).
// 빌드하지 않는다: 먼저 npm run build. 화면은 경로 · 크기마다 한 장 이상 work/screens/rules/에 남는다(창은 제목마다 첫 장과 어긋난 장).
// 환경 변수(고치는 동안 일부만 돌릴 때): SKINOTE_RULES_ONLY(등급 키를 쉼표로, 예: pos,driver_phone),
//   SKINOTE_RULES_SIZES(크기를 쉼표로, 예: 1024x529,360x640), SKINOTE_RULES_JOBS(동시에 도는 크기 수, 기본 4),
//   SKINOTE_RULES_PORT(미리보기 서버 포트, 기본 5183 — 여러 작업이 함께 돌 때 겹치지 않게, 예: 5190),
//   SKINOTE_RULES_OUT(화면 · report.json을 남길 폴더, 기본 work/screens/rules — 함께 돌 때 서로 지우지 않게).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SHOP_DEVICE_CLASS_KEYS } from '@skinote/contract';
import { DEVICE_PROFILES, pickDeviceClass } from '@skinote/ui/device-profile';
import { RULES, RULE_LABELS, measureRules } from './ui-rules-measure.mjs';

const APP = fileURLToPath(new URL('../', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DIST = join(APP, 'dist');
const OUT = process.env.SKINOTE_RULES_OUT ? resolve(REPO, process.env.SKINOTE_RULES_OUT) : join(REPO, 'work/screens/rules');
const PORT = Number(process.env.SKINOTE_RULES_PORT ?? 5183) || 5183;
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
  // 포트에 이미 무엇이 떠 있으면(다른 작업의 서버 · 다른 앱) 그 화면을 재게 되므로 멈춘다(--strictPort는 늦게 실패한다).
  if (await reachable(BASE)) throw new Error('포트 ' + PORT + '을 이미 다른 것이 쓰고 있습니다. SKINOTE_RULES_PORT로 다른 포트를 고르세요.');
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
    /** 일정 변경 창(V9)을 이 크기에서 모두 걸었는지(첫 창만 모두, 나머지는 열어 재기만). */
    this.promiseWalked = false;
    /** 반납 확인 창(V1)을 걸었는지: 보증금 줄이 없는 첫 창 · 보증금 줄(④ ⑤)이 있는 첫 창을 따로 모두 걷는다. */
    this.returnWalked = { plain: false, deposit: false };
    /** 접수 확정 창(V4)을 이 크기에서 모두 걸었는지(첫 창만 모두, 나머지는 열어 재기만). */
    this.checkoutWalked = false;
    /** 화면 키보드를 모두 걸은 판 제목(제목마다 첫 판만 모두, 나머지는 열어 재기만). */
    this.keyboardWalked = new Set();
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
    if (await top.evaluate((el) => el.classList.contains('pos-promise'))) {
      await this.promiseWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-return'))) {
      await this.returnWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-checkout'))) {
      await this.checkoutWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-partial'))) {
      await this.partialWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-field-pay'))) {
      await this.fieldPayWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-add-ticket'))) {
      await this.addTicketWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-cash-check'))) {
      await this.cashCheckWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('sn-kb-overlay'))) {
      await this.keyboardWalk(name);
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

  /** 확인 창 높이의 한도(ui 4-5 confirmWindow: 1024×529는 505). DeviceProfile의 confirm 값으로 센다. */
  confirmLimit() {
    const spec = DEVICE_PROFILES[this.sizeClass].confirm;
    const roomy = this.size.height - 2 * spec.marginYPx;
    return roomy >= spec.minHeightPx ? roomy : this.size.height - 2 * spec.compactMarginYPx;
  }

  /**
   * 일정 변경 창(V9, spec 3-2): 수량 +/−, 반납 타임, 구역 → 장소(두 줄 구역 · 더 보기), 매장 직접(수거 차량 줄은 자리만), 수거 차량,
   * 내일(리프트권이면 한 줄 알림, 장비만이면 연장 값), 다른 날 › 작은 창, 쪽 넘김을 누르며 잰다. 창 높이는 모든 상태에서 같고 한도
   * (1024×529에서 505) 안이어야 한다. 크기마다 첫 창만 모두 걷고, 다른 접수증의 창은 열어 재기만 한다. 확정하지 않는다.
   */
  async promiseWalk(name) {
    const top = this.top();
    const heights = new Set();
    const limit = this.confirmLimit();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await this.top().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    const click = async (locator) => { if (await locator.count() && await locator.first().isEnabled()) { await this.click(locator.first()); return true; } return false; };
    await measure('-v9');
    if (!this.promiseWalked) {
      this.promiseWalked = true;
      const plus = top.locator('.sn-step button[aria-label="수량 증가"]');
      for (let i = 0, n = await plus.count(); i < n; i += 1) await click(plus.nth(i));
      await measure('-v9-qty');
      if (await click(top.locator('.sn-step button[aria-label="수량 감소"]:enabled'))) await measure('-v9-minus');
      const time = () => top.getByRole('group', { name: '반납 시각' });
      const slots = time().locator('button.sn-choice:enabled');
      for (let i = 0, n = await slots.count(); i < n; i += 1) {
        const label = ((await slots.nth(i).textContent()) ?? '').trim();
        if (/내일|다른 날|더 보기/.test(label)) continue;
        await click(time().locator('button.sn-choice:enabled').nth(i));
      }
      await measure('-v9-slot');
      const place = () => top.getByRole('group', { name: '반납 장소' });
      const areas = await place().locator('button.sn-choice').count();
      for (let i = 1; i < areas; i += 1) {
        await click(place().locator('button.sn-choice').nth(i));
        await measure('-v9-area' + i);
        const more = place().getByRole('button', { name: '더 보기', exact: true });
        if (await click(more)) await measure('-v9-area' + i + '-more');
        // 장소 하나(‹ 구역 다음 첫 장소)를 고르면 구역 줄로 돌아오고 그 구역이 두 줄.
        await click(place().locator('button.sn-choice').nth(1));
        await measure('-v9-area' + i + '-picked');
      }
      if (await click(place().getByRole('button', { name: '매장 직접', exact: true }))) await measure('-v9-store');
      await click(place().locator('button.sn-choice').nth(1));
      await click(place().locator('button.sn-choice').nth(1));
      await click(top.getByRole('group', { name: '수거 차량' }).locator('button.sn-choice[aria-pressed="false"]'));
      await measure('-v9-vehicle');
      if (await click(time().getByRole('button', { name: '내일', exact: true }))) {
        await measure('-v9-tomorrow');
        await click(time().getByRole('button', { name: '내일', exact: true }));
      }
      if (await click(time().getByRole('button', { name: /다른 날/ }))) {
        await this.scene(name + '-v9-days', 'dialog');
        await click(this.top().locator('.pos-choice-button'));
        await measure('-v9-other-day');
      }
    }
    // 변경 품목이 넷을 넘는 창(이민호 팀 5줄 …)은 어느 창이든 쪽마다 잰다(쪽을 넘겨도 창 높이가 그대로여야 함).
    const next = top.getByRole('button', { name: '다음 쪽' });
    for (let p = 2; p <= 6 && await click(next); p += 1) await measure('-v9-p' + p);
    if (heights.size > 1) this.fail(name + '-v9', '일정 변경 창 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > limit + 0.5) this.fail(name + '-v9', '일정 변경 창 ' + tallest + 'px > 한도 ' + limit + 'px');
  }

  /**
   * 반납 확인 창(V1, spec 3-1): 번호 하나 빼기, 반환 방법 바꾸기, 모두 빼기(주 버튼을 누를 수 없어야 함), 수량 칸 −/+, 번호 선택 작은 창,
   * 품목 칸 쪽 넘김을 누르며 잰다. 창 높이는 모든 상태에서 같고 한도(1024×529에서 505) 안이어야 한다. 크기마다 보증금 줄이 없는 첫 창과
   * 있는 첫 창을 모두 걷고, 다른 창은 열어 재기만 한다(늦은 반납의 빨강 한 줄은 장면 이름 -v1-late). 확정하지 않는다.
   */
  async returnWalk(name) {
    const top = this.top();
    const heights = new Set();
    const limit = this.confirmLimit();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await this.top().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    const late = (await top.locator('.pos-return-lead .tone-late').count()) > 0;
    await measure(late ? '-v1-late' : '-v1');
    const kind = (await top.locator('.pos-return-refund').count()) ? 'deposit' : 'plain';
    if (!this.returnWalked[kind]) {
      this.returnWalked[kind] = true;
      const pressed = () => top.locator('.sn-piece[aria-pressed="true"]');
      if (await pressed().count()) { await this.click(pressed().last()); await measure('-v1-one'); }
      const refund = top.getByRole('group', { name: '보증금 반환 방법' }).locator('button.sn-choice[aria-pressed="false"]:enabled');
      if (await refund.count()) { await this.click(refund.first()); await measure('-v1-refund'); }
      const minus = top.locator('.sn-piece-line button[aria-label="수량 감소"]:enabled');
      if (await minus.count()) { await this.click(minus.first()); await measure('-v1-qty'); }
      const picker = top.locator('.sn-piece-line .sn-pieces > button.sn-choice:not(.sn-piece)');
      if (await picker.count()) {
        const before = await this.dialogCount();
        await this.click(picker.first());
        await this.scene(name + '-v1-picker', 'dialog');
        await this.closeTo(before);
      }
      for (let guard = 0; guard < 40 && await pressed().count(); guard += 1) await this.click(pressed().first());
      await measure('-v1-none');
      const primary = top.locator('[data-primary="true"]');
      if (!(await top.locator('.sn-piece-line button[aria-label="수량 감소"]').count()) && await primary.count() && await primary.isEnabled()) {
        this.fail(name + '-v1', '번호를 모두 뺀 반납 창의 주 버튼을 누를 수 있음');
      }
    }
    // 품목 칸이 쪽을 넘기는 창(이민호 팀 5줄 …)은 어느 창이든 쪽마다 잰다(쪽을 넘겨도 창 높이가 그대로여야 함).
    const next = top.getByRole('button', { name: '다음 쪽' });
    for (let p = 2; p <= 6 && await next.count() && await next.isEnabled(); p += 1) { await this.click(next); await measure('-v1-p' + p); }
    if (heights.size > 1) this.fail(name + '-v1', '반납 창 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > limit + 0.5) this.fail(name + '-v1', '반납 창 ' + tallest + 'px > 한도 ' + limit + 'px');
  }

  /**
   * 접수 확정 창(V4, spec 3-3): 칸마다 수단을 모두 눌러 보고(`기타` 작은 창 → 첫 수단), 칸마다 `할인 적용 ›` 작은 창(할인 → 할인 없음),
   * 장비 `후불` → 결제 팀 줄(팀 버튼마다, `다른 팀 찾기 · 끝 4자리` 숫자판: 없는 번호 → 한 줄, 0032 → 찾은 팀), 리프트권 `기타` →
   * `다른 팀 결제`(숫자판 0032 → 그 칸만 다른 팀), `#card`(장비 카드)를 잰다. 창 높이는 모든 상태에서 같고(결제 팀 줄은 자리만 남음)
   * 한도(1024×529에서 505) 안이어야 한다. 크기마다 첫 창만 모두 걷는다. 확정하지 않는다(확정은 newOrderConfirm).
   */
  async checkoutWalk(name) {
    const dialog = () => this.page.locator('.pos-checkout');
    const heights = new Set();
    const limit = this.confirmLimit();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await dialog().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    const click = async (locator) => { if (await locator.count() && await locator.first().isEnabled()) { await this.click(locator.first()); return true; } return false; };
    const keypad = async (digits) => {
      for (const d of digits) await this.click(this.top().getByRole('button', { name: d, exact: true }));
      await this.click(this.top().getByRole('button', { name: '찾기', exact: true }));
    };
    await measure('-v4');
    if (!this.checkoutWalked) {
      this.checkoutWalked = true;
      const labels = await dialog().locator('.sn-method-row:not(.is-single)').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
      const methods = (label) => dialog().getByRole('group', { name: label + ' 결제 수단', exact: true });
      for (const [i, label] of labels.entries()) {
        const buttons = () => methods(label).locator('button.sn-choice:not(.sn-method-discount)');
        const n = await buttons().count();
        for (let j = 0; j < n; j += 1) {
          const button = buttons().nth(j);
          if (!(await button.isEnabled())) continue;
          const text = ((await button.textContent()) ?? '').trim();
          await this.click(button);
          if (/^기타/.test(text) && (await this.dialogCount()) > 1) {
            await this.scene(name + '-v4-s' + (i + 1) + '-other', 'dialog');
            await this.click(this.top().locator('.pos-choice-button').first());
          }
          await measure('-v4-s' + (i + 1) + 'm' + (j + 1));
        }
        const discount = dialog().getByRole('button', { name: label + ' 할인 적용', exact: true });
        if (await click(discount)) {
          await this.scene(name + '-v4-s' + (i + 1) + '-discount', 'dialog');
          await this.click(this.top().locator('.pos-choice-button').last());
          await measure('-v4-s' + (i + 1) + '-discounted');
          await this.click(discount);
          await this.click(this.top().locator('.pos-choice-button').first());
        }
      }
      if (labels.length) {
        // 장비 후불 → 결제 팀 줄: 팀 버튼마다, 다른 팀 찾기(없는 번호 → 한 줄, 0032 → 찾은 팀).
        await click(methods(labels[0]).getByRole('button', { name: '후불', exact: true }));
        await measure('-v4-later');
        const teams = () => dialog().getByRole('group', { name: '결제 팀', exact: true }).locator('button.sn-choice');
        for (let j = 0, n = await teams().count(); j < n; j += 1) {
          await click(teams().nth(j));
          await measure('-v4-payer' + (j + 1));
        }
        if (await click(dialog().getByRole('button', { name: /^다른 팀 찾기/ }))) {
          await this.scene(name + '-v4-find', 'dialog');
          await keypad('9999');
          await this.scene(name + '-v4-find-none', 'dialog');
          for (let k = 0; k < 4; k += 1) await this.click(this.top().getByRole('button', { name: '정정', exact: true }));
          await keypad('0032');
          if ((await this.dialogCount()) > 1) await this.closeTo(1);
          await measure('-v4-found');
        }
        // 마지막 두 줄 칸(리프트권)의 기타 → 다른 팀 결제: 그 칸만 찾은 팀.
        const last = labels[labels.length - 1];
        if (await click(methods(last).getByRole('button', { name: /^기타/ }))) {
          const otherTeam = this.top().locator('.pos-choice-button', { hasText: '다른 팀 결제' });
          if (await click(otherTeam)) {
            await keypad('0032');
            if ((await this.dialogCount()) > 1) await this.closeTo(1);
            await measure('-v4-section-payer');
          } else await this.closeTo(1);
        }
        // #card: 장비 카드(후불인 칸이 줄어 결제 팀 줄 자리만), 리프트권 현금.
        await click(methods(labels[0]).getByRole('button', { name: '카드', exact: true }));
        await click(methods(last).getByRole('button', { name: '현금', exact: true }));
        await measure('-v4-card');
      }
    }
    if (heights.size > 1) this.fail(name + '-v4', '접수 확정 창 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > limit + 0.5) this.fail(name + '-v4', '접수 확정 창 ' + tallest + 'px > 한도 ' + limit + 'px');
  }

  /**
   * 일괄 수납의 부분 결제 판(V5, spec 3-6): 품목 줄 −, `균등 분할` · `잔여 전체 선택`(누를 수 있으면), 쪽 넘김을 누르며 잰다. 창 높이는 모든
   * 상태에서 같고 한도(1024×529에서 505) 안이어야 한다. 고른 수를 돌려주지 않는다(주 버튼은 부르는 쪽이 누른다).
   */
  async partialWalk(name) {
    const dialog = () => this.page.locator('.pos-partial');
    const heights = new Set();
    const limit = this.confirmLimit();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await dialog().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    await measure('-v5p');
    const minus = dialog().locator('.sn-step button[aria-label="수량 감소"]:enabled');
    if (await minus.count()) { await this.click(minus.first()); await measure('-v5p-minus'); }
    const presets = dialog().locator('.pos-partial-presets button');
    for (let i = (await presets.count()) - 1; i >= 0; i -= 1) {
      if (!(await presets.nth(i).isEnabled())) continue;
      await this.click(presets.nth(i));
      await measure('-v5p-preset' + (i + 1));
    }
    const next = dialog().getByRole('button', { name: '다음 쪽' });
    if (await next.count() && await next.isEnabled()) { await this.click(next); await measure('-v5p-p2'); await this.click(dialog().getByRole('button', { name: '이전 쪽' })); }
    if (heights.size > 1) this.fail(name + '-v5p', '부분 결제 판 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > limit + 0.5) this.fail(name + '-v5p', '부분 결제 판 ' + tallest + 'px > 한도 ' + limit + 'px');
  }

  /** 아래 판(V7 현장 수납 · 리프트권 추가)의 높이: 연 동안 그대로이고 판 한도(DeviceProfile fill.panelMaxPx, 휴대폰은 전체 화면) 안. */
  panelLimit() {
    const profile = DEVICE_PROFILES[this.sizeClass];
    return profile.primaryFullWidth ? this.size.height : Math.min(profile.fill.panelMaxPx, this.size.height);
  }

  /**
   * 현장 수납 판(V7, ui 6-5): 금액 숫자(35 · 000) · 정정, 수단마다(카드 · 현금 · 계좌이체), 후불 처리는 누르지 않는다. 판 높이는 그대로이고
   * 한도 안이어야 한다. 수납하지 않는다(닫기는 부르는 쪽).
   */
  async fieldPayWalk(name) {
    const panel = () => this.page.locator('.pos-field-pay');
    const heights = new Set();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await panel().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    await measure('-v7pay');
    for (const key of ['3', '5', '000']) await this.click(panel().getByRole('button', { name: key, exact: true }));
    await measure('-v7pay-typed');
    const methods = panel().locator('.sn-choices button.sn-choice');
    for (let i = 0, n = await methods.count(); i < n; i += 1) {
      if ((await methods.nth(i).getAttribute('aria-pressed')) === 'true') continue;
      await this.click(methods.nth(i));
      await measure('-v7pay-m' + (i + 1));
    }
    for (let k = 0; k < 8; k += 1) await this.click(panel().getByRole('button', { name: '정정', exact: true }));
    await measure('-v7pay-cleared');
    if (heights.size > 1) this.fail(name + '-v7pay', '현장 수납 판 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > this.panelLimit() + 0.5) this.fail(name + '-v7pay', '현장 수납 판 ' + tallest + 'px > 한도 ' + this.panelLimit() + 'px');
  }

  /** 리프트권 추가 판(V7): 권종 버튼, 수량 +/−. 판 높이는 그대로이고 한도 안. 추가하지 않는다. */
  async addTicketWalk(name) {
    const panel = () => this.page.locator('.pos-add-ticket');
    const heights = new Set();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await panel().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    await measure('-v7ticket');
    const plus = panel().locator('.sn-step button[aria-label="수량 증가"]');
    if (await plus.count() && await plus.isEnabled()) { await this.click(plus); await measure('-v7ticket-plus'); }
    const minus = panel().locator('.sn-step button[aria-label="수량 감소"]');
    if (await minus.count() && await minus.isEnabled()) { await this.click(minus); await measure('-v7ticket-minus'); }
    if (heights.size > 1) this.fail(name + '-v7ticket', '리프트권 추가 판 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > this.panelLimit() + 0.5) this.fail(name + '-v7ticket', '리프트권 추가 판 ' + tallest + 'px > 한도 ' + this.panelLimit() + 'px');
  }

  /**
   * 하루 마감(V6)의 점검 판(spec 3-7): 빈 판, 틀린 금액(차액 · 사유 선택: 주 버튼 막힘), `직접 입력 ›` 글자 판, 사유(주 버튼 풀림), 맞는 금액
   * (차액 0원: 사유 줄은 자리만)을 누르며 잰다. 판 높이는 모든 상태에서 같고 판 한도 안이어야 한다. commit이면 끝에 digits로 적고 판의
   * 주 버튼을 누른다(판이 닫힌다), 아니면 닫기.
   */
  async cashCheckWalk(name, { commit = null } = {}) {
    const panel = () => this.page.locator('.pos-cash-check');
    const heights = new Set();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await panel().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    const key = async (digits) => { for (const d of digits) await this.click(panel().getByRole('button', { name: d, exact: true })); };
    const clear = async () => { for (let k = 0; k < 10; k += 1) await this.click(panel().getByRole('button', { name: '정정', exact: true })); };
    const primary = () => panel().locator('[data-primary="true"]');
    await measure('-v6pad');
    await key(['1', '000']);
    await measure('-v6pad-diff');
    if (await primary().isEnabled()) this.fail(name + '-v6pad', '차액의 사유를 고르기 전에 점검 판의 주 버튼을 누를 수 있음');
    const manual = panel().getByRole('button', { name: /^직접 입력/ });
    if (await manual.count()) {
      // 직접 입력 사유(40자): 화면 키보드. 크기마다 첫 판은 모두 걷는다. 적지 않는 걸음(commit 없음)에서는 짧은 사유를 쳐서 넣어 본다
      // (사유가 골라져 주 버튼이 풀린다, 판은 적지 않고 닫는다). 적는 걸음은 칩 사유만 쓴다(마감 흐름을 바꾸지 않게).
      await this.click(manual);
      const typed = await this.keyboardWalk(name + '-v6pad-note', commit ? {} : { submit: ['ㅊ', 'ㅏ', 'ㄱ', 'ㅇ', 'ㅗ'] });
      if (typed) {
        await measure('-v6pad-manual');
        if (!(await primary().isEnabled())) this.fail(name + '-v6pad-manual', '직접 입력 사유를 넣은 뒤에도 점검 판의 주 버튼이 막힘');
      }
    }
    const reason = panel().getByRole('button', { name: '잔돈 착오', exact: true });
    if (await reason.count() && await reason.isEnabled()) {
      await this.click(reason);
      await measure('-v6pad-reason');
      if (!(await primary().isEnabled())) this.fail(name + '-v6pad', '사유를 고른 뒤에도 점검 판의 주 버튼이 막힘');
    }
    await clear();
    await measure('-v6pad-cleared');
    if (heights.size > 1) this.fail(name + '-v6pad', '점검 판 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > this.panelLimit() + 0.5) this.fail(name + '-v6pad', '점검 판 ' + tallest + 'px > 한도 ' + this.panelLimit() + 'px');
    if (!commit) return;
    await key(commit.digits);
    if (commit.reason) await this.click(panel().getByRole('button', { name: commit.reason, exact: true }));
    await this.scene(name + '-v6pad-commit', 'dialog');
    await this.click(primary());
    await this.page.waitForSelector('.pos-cash-check', { state: 'detached', timeout: 10_000 });
    await this.settle();
  }

  /**
   * 화면 키보드(HangulKeyboard, 계획 work/impl-server/plan.md 7-5): 판을 재고, 편집 칸이 없는지(운영체제 자판이 뜰 곳 없음) · 판이 화면 안인지
   * 본다. 제목마다 첫 판은 모두 걷는다: 자모 키 글자의 먹 높이 · `닫기`가 키 줄 밖 → 비우기 → 키로 ㄱ ㅣ ㅁ(`김`) → ㅅ(치는 중: 안내 없음 ·
   * `입력` 눌림) → `입력`(낱자모: 판이 닫히지 않고 제목 아래 회색 안내, 제목은 그대로) → 정정(안내가 사라짐) → 쌍자음(ㄱ → ㄲ, 한 번만) →
   * 가장 넓은 글자 뷁을 실제 자판(두벌식 글쇠 자리)으로 한도 + 1번(한도에서 멈춤) → 숫자 쪽 → 한글 쪽. submit(자모 키 이름들)이 있으면
   * 끝에 비우고 그 키로 쳐서 `입력`(판이 닫힘, true), 없으면 `닫기`.
   */
  async keyboardWalk(name, { submit = null } = {}) {
    const page = this.page;
    const sheet = () => page.locator('.sn-kb');
    const key = (label) => sheet().getByRole('button', { name: label, exact: true });
    const value = () => page.locator('.sn-kb-display').getAttribute('data-value');
    const enter = () => sheet().locator('[data-primary="true"]');
    const before = await this.dialogCount();
    await this.scene(name, 'dialog');
    const bad = await page.evaluate(() => {
      const kb = document.querySelector('.sn-kb');
      const problems = [];
      if (!kb) return ['화면 키보드 판이 없음'];
      if (kb.closest('[role="dialog"]')?.querySelector('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) problems.push('판 안에 편집 칸이 있음(운영체제 자판이 뜬다)');
      const active = document.activeElement;
      if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) problems.push('초점이 편집 칸에 있음: ' + active.tagName);
      if (kb.getAttribute('data-fits') === 'false') problems.push('이 크기에 맞는 키보드 모양이 없음');
      const r = kb.getBoundingClientRect();
      if (r.top < -0.5 || r.bottom > window.innerHeight + 0.5 || r.left < -0.5 || r.right > window.innerWidth + 0.5) problems.push('판이 화면 밖: ' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(','));
      return problems;
    });
    for (const text of bad) this.fail(name, text);
    const title = (await this.topKey()).replace(/^\d+:/, '');
    const full = !this.keyboardWalked.has(title);
    this.keyboardWalked.add(title);
    const clear = async () => {
      for (let guard = 0; guard < 60 && (await value()); guard += 1) await key('정정').click();
      await this.settle();
    };
    const press = async (labels) => { for (const label of labels) await this.click(key(label)); };
    if (full) {
      const maxLength = Number(await sheet().getAttribute('data-max'));
      // 자모 키 글자의 먹 높이(글자 크기가 아니라 그려진 자음의 높이: 한글 호환 자모는 글자 크기의 절반쯤) ≥ 가장 작은 글자 크기.
      const ink = await page.evaluate(() => {
        const canvas = document.createElement('canvas').getContext('2d');
        const consonants = new Set([...'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎㄲㄸㅃㅆㅉ']);
        const heights = [];
        for (const el of document.querySelectorAll('.sn-kb .sn-kb-key.is-jamo')) {
          const text = el.textContent ?? '';
          if (!consonants.has(text)) continue;
          const cs = getComputedStyle(el);
          canvas.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
          const m = canvas.measureText(text);
          heights.push([text, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent]);
        }
        const inRows = [...document.querySelectorAll('.sn-kb .sn-kb-keys button')].some((b) => b.textContent === '닫기');
        return { heights, inRows, device: document.querySelector('.sn-kb')?.closest('.sn-root')?.getAttribute('data-device') ?? '' };
      });
      const minInk = PROFILES[ink.device]?.minFont ?? 16;
      const small = ink.heights.filter(([, h]) => h < minInk - 0.5).map(([text, h]) => text + ' ' + h.toFixed(1) + 'px');
      if (!ink.heights.length) this.fail(name, '자모 키를 찾지 못함');
      if (small.length) this.fail(name, '자모 키 글자의 먹 높이가 ' + minInk + 'px보다 작음: ' + small.join(', '));
      if (ink.inRows) this.fail(name, '닫기가 키 줄 안에 있음(치던 글을 묻지 않고 버리는 키가 글쇠 사이에)');
      await clear();
      if (await enter().isEnabled()) this.fail(name, '빈 글인데 입력을 누를 수 있음');
      await press(['ㄱ', 'ㅣ', 'ㅁ']);
      await this.scene(name + '-kb-typed', 'dialog');
      if ((await value()) !== '김') this.fail(name + '-kb-typed', '키 ㄱ ㅣ ㅁ이 김이 아님: ' + (await value()));
      await press(['ㅅ']);
      await this.scene(name + '-kb-typing', 'dialog');
      if ((await value()) !== '김ㅅ') this.fail(name + '-kb-typing', '김 + ㅅ이 김ㅅ이 아님: ' + (await value()));
      if (!(await enter().isEnabled())) this.fail(name + '-kb-typing', '치는 중(새 글자의 자음)인데 입력이 막힘');
      if (await sheet().locator('.sn-kb-note').count()) this.fail(name + '-kb-typing', '치는 중인데 낱자모 안내가 뜸');
      await this.click(enter());
      await this.scene(name + '-kb-incomplete', 'dialog');
      if ((await this.dialogCount()) < before) this.fail(name + '-kb-incomplete', '낱자모가 남은 글이 입력됨');
      if (!(await sheet().locator('.sn-kb-note').count())) this.fail(name + '-kb-incomplete', '입력 뒤 낱자모 안내 한 줄이 없음');
      if (!(await sheet().locator('h2.sn-kb-title').isVisible())) this.fail(name + '-kb-incomplete', '안내가 뜨며 제목이 가려짐');
      await press(['정정']);
      if (await sheet().locator('.sn-kb-note').count()) this.fail(name + '-kb-incomplete', '다음 키 뒤에도 안내가 남음');
      await this.click(sheet().getByRole('button', { name: '쌍자음' }));
      await this.scene(name + '-kb-shift', 'dialog');
      await press(['ㄲ']);
      if ((await value()) !== '김ㄲ') this.fail(name + '-kb-shift', '쌍자음 + ㄱ이 ㄲ이 아님: ' + (await value()));
      if ((await sheet().getByRole('button', { name: '쌍자음' }).getAttribute('aria-pressed')) !== 'false') this.fail(name + '-kb-shift', '쌍자음이 한 번 뒤에 풀리지 않음');
      await clear();
      // 가장 넓은 글자로 한도까지(실제 자판: 뷁 = Q N P F R). 한도 + 1번째는 버려진다.
      for (let i = 0; i <= maxLength; i += 1) for (const code of ['KeyQ', 'KeyN', 'KeyP', 'KeyF', 'KeyR']) await page.keyboard.press(code);
      await this.settle();
      await this.scene(name + '-kb-full', 'dialog');
      const filled = [...((await value()) ?? '')];
      if (!maxLength || filled.length !== maxLength || filled.some((ch) => ch !== '뷁')) this.fail(name + '-kb-full', '뷁으로 한도까지 채우지 못함: ' + filled.length + '자 / 한도 ' + maxLength);
      const spill = await page.evaluate(() => {
        const display = document.querySelector('.sn-kb-display').getBoundingClientRect();
        const text = document.querySelector('.sn-kb-text').getBoundingClientRect();
        return text.top < display.top - 0.5 || text.bottom > display.bottom + 0.5 || text.right > display.right + 0.5 ? [text.top, text.bottom, display.top, display.bottom].map(Math.round).join(',') : '';
      });
      if (spill) this.fail(name + '-kb-full', '한도까지 친 글이 표시 칸 밖: ' + spill);
      await this.click(key('숫자'));
      await this.scene(name + '-kb-number', 'dialog');
      await press(['1']);
      await this.click(key('한글'));
    }
    if (submit) {
      await clear();
      await press(submit);
      await this.click(enter());
      if ((await this.dialogCount()) >= before) { this.fail(name, '입력 뒤에도 화면 키보드가 닫히지 않음'); await this.closeTo(before - 1); return false; }
      return true;
    }
    await this.closeTo(before - 1);
    return false;
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
  // 처리 현황의 누르는 줄(그 단계를 접수 전체로: 반납 줄은 모든 줄의 반납 창, 차량 담당이면 알림 → 매장 반납 처리).
  const checks = w.page.locator('.pos-side .sn-check-press');
  for (let j = 0, m = await checks.count(); j < m; j += 1) {
    await w.probe(w.page.locator('.pos-side .sn-check-press').nth(j), name + '-check' + (j + 1));
    await w.closeTo(0);
  }
  const side = w.page.locator('.pos-side-actions button');
  for (let j = 0, m = await side.count(); j < m; j += 1) {
    await w.probe(w.page.locator('.pos-side-actions button').nth(j), name + '-side' + (j + 1));
    await w.closeTo(0);
  }
}

/** 오늘 장부의 쪽을 넘기며 끝 4자리가 last4인 줄의 접수증을 연다. 찾으면 true. */
async function openSlipOf(w, last4) {
  await w.visit('#/ledger/' + w.date, '.sn-ledger tr.sn-row');
  const [, total] = await w.pageInfo();
  for (let p = 1; p <= total; p += 1) {
    await w.toPage(p);
    const open = w.page.locator('.sn-ledger tr.sn-row .sn-cell-open', { hasText: last4 });
    if (await open.count()) {
      await open.first().click();
      await w.page.waitForSelector('.sn-slip');
      await w.settle();
      return true;
    }
  }
  return false;
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
  await connectWalk(w);

  await v2CounterRoutes(w);
  await counterFlow(w);
  await counterNight(w);
}

/**
 * 둘째 판 화면(docs/design/screens-v2)의 경로를 그 화면의 걸음(탭 · 쪽 · 창 · 상태)으로 걷는다(work/impl-v2/plan.md 6절): 새 접수(V2 · V3) ·
 * 접수 확정(V4) · 일괄 수납(V5) · 하루 마감(V6, 15:40) · 관리와 매장 설정 · 운영 규칙(V8).
 */
async function v2CounterRoutes(w) {
  await newOrderWalk(w);
  await groupPayWalk(w);
  await conflictWalks(w);
  await closingDay(w);
  await rulesWalk(w);
}

/** 체험 자료를 처음(15:40)으로 되돌리고 체험 시계를 minutes만큼(나가기 화면의 +1시간 · +10분). */
async function resetTo(w, minutes) {
  const page = w.page;
  await w.visit('#/exit', '.pos-card', 'counter');
  await w.click(page.getByRole('button', { name: '체험 자료 초기화', exact: true }));
  await w.click(w.top().getByRole('button', { name: '초기화', exact: true }));
  await w.closeTo(0);
  for (let m = minutes; m >= 60; m -= 60) await w.click(page.getByRole('button', { name: '+1시간', exact: true }));
  for (let m = minutes % 60; m >= 10; m -= 10) await w.click(page.getByRole('button', { name: '+10분', exact: true }));
}

/** 다른 카운터(같은 브라우저의 둘째 탭, 같은 체험 자료): 먼저 처리한다. 둘째 탭의 화면은 재지 않는다. */
async function otherCounter(w, hash, selector, act) {
  const other = await w.context.newPage();
  other.setDefaultTimeout(8000);
  // 둘째 탭은 넓은 카운터(접수증 표의 도장 칸이 칸마다 보이는 크기)에서 누른다: 재는 것은 첫 탭뿐이다.
  await other.setViewportSize({ width: 1366, height: 768 });
  try {
    await other.goto(BASE + hash);
    await other.waitForSelector(selector, { timeout: 10_000 });
    await other.waitForTimeout(300);
    await act(other);
    await other.waitForTimeout(300);
  } finally {
    await other.close();
  }
}

/**
 * 막히는 상태(검토 반영, 두 탭): 다른 카운터가 먼저 처리한 뒤 이 창에서 누르면 뜨는 한 줄 · 버튼을 잰다.
 *   ① 일괄 수납(V5) 충돌 알림 `이정호 팀 90,000원 수납 완료 · 다른 카운터` + `제외 후 수납` · `닫기` → 제외 뒤(보낼 것이 없으면 스스로 보내지 않음)
 *   ② 지급 창(ConfirmFlow)의 이어진 명령이 막힘: 지급은 되었는데 보증금 입금 충돌 → 창 안 한 줄(.pos-dialog-error)
 *   ③ 반납 창(V1)의 보증금 반환이 막힘: 한 줄(is-alert) → 이 창에서 지금 자료로 다시(새 요청번호)
 *   ④ 일정 변경 창(V9) 충돌: 그사이 매장 반납 → 요약 자리의 한 줄(is-alert)
 */
async function conflictWalks(w) {
  const page = w.page;
  // ① 16:40 일괄 수납.
  await resetTo(w, 60);
  await w.visit('#/orders/o32/pay', '.pos-group-table');
  await otherCounter(w, '#/orders/o32/pay', '.pos-group-table', async (other) => {
    await other.locator('.pos-group-go').click();
    await other.waitForURL(/#\/orders\/o32$/, { timeout: 10_000 });
  });
  await w.click(page.locator('.pos-group-go'));
  await page.waitForSelector('[role="dialog"]');
  await w.settle();
  await w.scene('v5-conflict', 'dialog');
  const exclude = w.top().getByRole('button', { name: '제외 후 수납', exact: true });
  if (await exclude.count()) {
    await w.click(exclude);
    await w.scene('v5-excluded');
    // 제외하고 나니 보낼 것이 없다: 스스로 보내지 않고(주 버튼 흐림), 줄을 눌러도 보내지 않는다.
    const box = page.locator('.pos-group-table [role="checkbox"]');
    if (await box.count()) await w.click(box.first());
    await w.settle();
    if (!/\/pay$/.test(await w.hash())) w.fail('v5-excluded', '제외 후 수납 뒤 주 버튼 없이 수납이 보내짐: ' + (await w.hash()));
  } else w.fail('v5-conflict', '충돌 알림에 `제외 후 수납`이 없음');
  await w.closeTo(0);

  // ② 15:40 박준호 지급(보증금 입금이 이어짐): 다른 카운터가 권 줄만 지급 · 보증금 입금.
  await resetTo(w, 0);
  await w.visit('#/orders/o22', '.sn-slip');
  await w.click(page.locator('.pos-side [data-primary="true"]'));
  await page.waitForSelector('[role="dialog"]');
  await w.settle();
  await otherCounter(w, '#/orders/o22', '.sn-slip', async (other) => {
    await other.locator('.sn-slip tr.sn-row', { hasText: '야간권' }).locator('.sn-stamp-cell[aria-label^="지급"]').click();
    await other.waitForSelector('[role="dialog"] [data-primary="true"]');
    await other.locator('[role="dialog"] [data-primary="true"]').click();
    await other.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10_000 });
  });
  await w.click(w.top().locator('[data-primary="true"]'));
  await w.settle();
  await w.scene('issue-chain-error', 'dialog');
  if (!(await w.top().locator('.pos-dialog-error').count())) w.fail('issue-chain-error', '이어진 보증금 입금이 막혔는데 창에 한 줄이 없음');
  await w.closeTo(0);

  // ③ 21:30 박준호 반납(모든 줄) · 다른 카운터가 권 줄만 반납 · 보증금 반환.
  await resetTo(w, 350);
  await w.visit('#/orders/o22', '.sn-slip');
  const openReturn = async (target) => {
    await target.locator('.pos-side .sn-check-press', { hasText: '반납' }).first().click();
    await target.locator('[role="dialog"]').getByRole('button', { name: '매장 반납 처리', exact: true }).click();
    await target.waitForSelector('.pos-return');
  };
  await openReturn(page);
  await w.settle();
  await otherCounter(w, '#/orders/o22', '.sn-slip', async (other) => {
    await other.locator('.sn-slip tr.sn-row', { hasText: '야간권' }).locator('.sn-stamp-cell[aria-label^="반납"]').click();
    await other.locator('[role="dialog"]').getByRole('button', { name: '매장 반납 처리', exact: true }).click();
    await other.waitForSelector('.pos-return [data-primary="true"]:enabled');
    await other.waitForTimeout(300);
    await other.locator('.pos-return [data-primary="true"]').click();
    await other.waitForSelector('.pos-return', { state: 'detached', timeout: 10_000 });
  });
  await w.click(page.locator('.pos-return [data-primary="true"]'));
  await w.settle();
  await w.scene('v1-chain-error', 'dialog');
  if (!(await page.locator('.pos-return .is-alert').count())) w.fail('v1-chain-error', '보증금 반환이 막혔는데 반납 창에 한 줄이 없음');
  await w.closeTo(0);

  // ④ 19:40 박준호 일정 변경(보드 1 → 두솔동) · 그사이 다른 카운터가 보드를 매장에서 받음.
  await resetTo(w, 240);
  await w.visit('#/orders/o22', '.sn-slip');
  const side = page.locator('.pos-side-actions').getByRole('button', { name: '일정 변경', exact: true });
  if (await side.count()) await w.click(side);
  else {
    await w.click(page.locator('.pos-side-actions').getByRole('button', { name: '더 보기' }));
    await w.click(w.top().getByRole('button', { name: '일정 변경', exact: true }));
  }
  await page.waitForSelector('.pos-promise');
  await w.click(page.locator('.pos-promise [role="group"][aria-label="보드 수량"] button[aria-label="수량 증가"]'));
  await w.click(page.locator('.pos-promise').getByRole('button', { name: /^솔마을/ }));
  await w.click(page.locator('.pos-promise').getByRole('button', { name: '두솔동', exact: true }));
  await otherCounter(w, '#/orders/o22', '.sn-slip', async (other) => {
    await other.locator('.sn-slip tr.sn-row', { hasText: '보드' }).locator('.sn-stamp-cell[aria-label^="반납"]').click();
    await other.locator('[role="dialog"]').getByRole('button', { name: '매장 반납 처리', exact: true }).click();
    await other.waitForSelector('.pos-return [data-primary="true"]:enabled');
    await other.waitForTimeout(300);
    await other.locator('.pos-return [data-primary="true"]').click();
    await other.waitForSelector('.pos-return', { state: 'detached', timeout: 10_000 });
  });
  await w.click(page.locator('.pos-promise [data-primary="true"]'));
  await w.settle();
  await w.scene('v9-conflict', 'dialog');
  if (!(await page.locator('.pos-promise .is-alert').count())) w.fail('v9-conflict', '그사이 반납된 일정 변경인데 창에 한 줄이 없음');
  await w.closeTo(0);
  // 뒤 걸음은 15:40에서 시작한다.
  await resetTo(w, 0);
}

/** 운영 규칙 카드의 버튼을 찾아 누른다(바닥줄 쪽을 넘겨 찾는다). 없으면 실패로 적고 false. */
async function rulesPress(w, name, cardTitle, button) {
  const footer = w.page.locator('.sn-footer');
  const target = () => w.page.locator('.sn-rule-card[aria-label="' + cardTitle + '"]').getByRole('button', typeof button === 'string' ? { name: button, exact: true } : { name: button });
  await w.toPage(1);
  for (let guard = 0; guard < 6; guard += 1) {
    if (await target().count()) { await w.click(target()); return true; }
    const next = footer.getByRole('button', { name: '다음 쪽' });
    if (!(await next.count()) || !(await next.isEnabled())) break;
    await w.click(next);
  }
  w.fail(name, '운영 규칙 카드 `' + cardTitle + '`에 버튼이 없음: ' + String(button));
  return false;
}

/** 운영 규칙의 숫자판(금액 · 시각): 빈 판을 재고, 받지 않는 값이면 `입력`이 막혔는지 보고, 받는 값을 넣는다. */
async function rulesPad(w, name, { refused, digits }) {
  const pad = () => w.top();
  const key = async (list) => { for (const d of list) await w.click(pad().getByRole('button', { name: d, exact: true })); };
  await w.scene(name + '-pad', 'dialog');
  if (refused) {
    await key(refused);
    await w.scene(name + '-pad-refused', 'dialog');
    if (await pad().getByRole('button', { name: '입력', exact: true }).isEnabled()) w.fail(name, '범위 밖의 값인데 숫자판의 입력을 누를 수 있음: ' + refused.join(''));
    for (let i = 0; i < 6; i += 1) await w.click(pad().getByRole('button', { name: '정정', exact: true }));
  }
  await key(digits);
  await w.scene(name + '-pad-typed', 'dialog');
  await w.click(pad().getByRole('button', { name: '입력', exact: true }));
  if (await w.dialogCount()) w.fail(name, '숫자판의 입력이 판을 닫지 않음');
}

/**
 * 관리(카드 목록)와 매장 설정 · 운영 규칙(V8, spec 3-9). 관리 카드(매장 설정 · 마감)를 눌러 재고 돌아온다. 운영 규칙: 변경 없음(저장 막힘) 쪽마다,
 * 색인 탭마다(더 보기 탭의 판 포함, 준비 중인 화면), 카드의 고르기를 차례로 누르며(반납 선택 · 지급 시 · 분실금 청구 · 미사용 → 사용 · 예약금 ·
 * 당일 결제 · 환불 없음 · 00:00 · 03:00) 재고, 값 버튼의 금액 숫자판(1매 5,000원 › · 1매 35,000원 › · 팀당 50,000원 ›)과 직접 입력의 시각 숫자판
 * (12:00은 입력 막힘 → 05:00), 긴 상태의 쪽마다, 떠날 때 창(‹ 관리 · 다른 탭 · 머리줄 장부), 저장 확인 창(쪽마다)을 잰다. 저장해 변경 없음으로
 * 돌아오는지, 저장 안 함이 관리로 가는지 본 뒤 체험 자료를 처음으로 되돌린다(뒤 걸음은 15:40 · 이 매장의 운영 규칙에서 시작한다).
 */
async function rulesWalk(w) {
  const page = w.page;
  const footer = page.locator('.sn-footer');
  const primary = () => footer.locator('[data-primary="true"]');
  const summary = async () => ((await page.locator('.pos-footer-back .sn-fit').first().textContent().catch(() => '')) ?? '').trim();
  const back = async () => { await page.goBack(); await page.waitForSelector('.pos-manage-card', { timeout: 10_000 }); await w.settle(); };
  await w.visit('#/manage', '.pos-manage-card');
  await w.scene('manage');
  for (let i = 0, n = await page.locator('.pos-manage-card').count(); i < n; i += 1) {
    await w.probe(page.locator('.pos-manage-card').nth(i), 'manage-c' + (i + 1), { back });
  }
  const rules = async () => { await w.visit('#/manage/settings/rules', '.sn-rule-card'); };
  await rules();
  if (await primary().isEnabled()) w.fail('v8', '변경 없음인데 저장을 누를 수 있음');
  if ((await summary()) !== '변경 없음') w.fail('v8', '바닥줄이 `변경 없음`이 아님: ' + (await summary()));
  await w.pages('v8');
  await w.tabs('v8-tab');
  await rules();
  // 고르기를 차례로(카드 · 줄이 생기고 사라지며 쪽이 는다).
  const steps = [
    ['리프트권 반납', '반납 선택 · 반납 시 기록'], ['리프트권 보증금', '지급 시'], ['리프트권 보증금', /^분실금 청구/], ['리프트권 보증금', '미사용'],
    ['리프트권 보증금', '사용'], ['리프트권 결제 · 전화 예약', '예약금'], ['당일 취소 환불', '환불 없음'], ['영업일 기준 시각', '00:00'],
  ];
  for (const [i, [cardTitle, button]] of steps.entries()) {
    if (await rulesPress(w, 'v8-s' + (i + 1), cardTitle, button)) await w.scene('v8-s' + (i + 1));
  }
  if (!/^변경 \d+건 · 다음 기록부터 적용$/.test(await summary())) w.fail('v8-s', '바꾼 뒤 바닥줄이 `변경 N건 · 다음 기록부터 적용`이 아님: ' + (await summary()));
  // 값 버튼 · 직접 입력의 숫자판.
  if (await rulesPress(w, 'v8-amount', '리프트권 보증금', '1매 5,000원 ›')) await rulesPad(w, 'v8-amount', { digits: ['6', '000'] });
  if (await rulesPress(w, 'v8-loss', '리프트권 보증금', '1매 35,000원 ›')) await rulesPad(w, 'v8-loss', { digits: ['4', '0', '000'] });
  if (await rulesPress(w, 'v8-prepay', '리프트권 결제 · 전화 예약', '팀당 50,000원 ›')) await rulesPad(w, 'v8-prepay', { digits: ['3', '0', '000'] });
  if (await rulesPress(w, 'v8-cutoff', '영업일 기준 시각', '직접 입력')) await rulesPad(w, 'v8-cutoff', { refused: ['1', '2', '0', '0'], digits: ['0', '5', '0', '0'] });
  await w.pages('v8-long');
  // 떠날 때 창: ‹ 관리 · 다른 탭 · 머리줄 장부(닫으면 그대로).
  const leave = async (name, target) => {
    const before = await w.hash();
    await w.click(target);
    if (!(await w.dialogCount())) { w.fail(name, '저장하지 않은 바꿈이 있는데 떠날 때 창이 없음'); if ((await w.hash()) !== before) await rules(); return; }
    await w.scene(name, 'dialog');
    const title = ((await w.top().locator('h2').first().textContent()) ?? '').trim();
    if (!/^미저장 변경 \d+건$/.test(title)) w.fail(name, '떠날 때 창 제목이 `미저장 변경 N건`이 아님: ' + title);
    await w.closeTo(0);
    if ((await w.hash()) !== before) w.fail(name, '떠날 때 창을 닫았는데 화면을 떠남');
  };
  await leave('v8-leave-back', footer.getByRole('button', { name: '관리' }));
  await leave('v8-leave-tab', page.locator('.sn-tabs .sn-tab').first());
  await leave('v8-leave-home', page.locator('.sn-header .sn-header-home'));
  // 저장 확인 창(쪽마다) → 저장 → 변경 없음.
  await w.click(primary());
  await w.scene('v8-save', 'dialog');
  const dialogNext = () => w.top().getByRole('button', { name: '다음 쪽' });
  for (let p = 2; await dialogNext().count() && await dialogNext().isEnabled(); p += 1) { await w.click(dialogNext()); await w.scene('v8-save-p' + p, 'dialog'); }
  await w.click(w.top().locator('[data-primary="true"]'));
  await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10_000 }).catch(() => {});
  await w.settle();
  if ((await summary()) !== '변경 없음') w.fail('v8-saved', '저장 뒤 바닥줄이 `변경 없음`이 아님: ' + (await summary()));
  await w.pages('v8-saved');
  // 저장 안 함: 하나 바꾸고 ‹ 관리 → 저장 안 함 → 관리.
  await rulesPress(w, 'v8-discard', '당일 취소 환불', '환불');
  await w.click(footer.getByRole('button', { name: '관리' }));
  if (await w.dialogCount()) await w.click(w.top().getByRole('button', { name: '저장 안 함', exact: true }));
  if (!/^#\/manage$/.test(await w.hash())) w.fail('v8-discard', '저장 안 함이 관리로 가지 않음: ' + (await w.hash()));
  // 체험 자료를 처음으로(바꾼 운영 규칙 · 기준 시각이 뒤 걸음에 남지 않게).
  await w.visit('#/exit', '.pos-card');
  await w.click(page.getByRole('button', { name: '체험 자료 초기화', exact: true }));
  await w.click(w.top().getByRole('button', { name: '초기화', exact: true }));
  await w.closeTo(0);
}

/** 27일 00:20: 기준 시각 00:00은 옛 기준과 새 기준 사이라 저장 확인 창이 까닭(`변경 불가 · 06:00 이후 가능`)을 보이고 저장이 막힌다. */
async function rulesRefusedWalk(w) {
  await w.visit('#/manage/settings/rules', '.sn-rule-card');
  if (!(await rulesPress(w, 'v8-refused', '영업일 기준 시각', '00:00'))) return;
  await w.click(w.page.locator('.sn-footer [data-primary="true"]'));
  await w.scene('v8-refused', 'dialog');
  if (!(await w.top().getByText('변경 불가 · 06:00 이후 가능').count())) w.fail('v8-refused', '27일 00:20에 00:00 저장 창에 거절 까닭이 없음');
  if (await w.top().locator('[data-primary="true"]').isEnabled()) w.fail('v8-refused', '거절되는 저장을 누를 수 있음');
  await w.closeTo(0);
  await w.click(w.page.locator('.sn-footer').getByRole('button', { name: '관리' }));
  await w.scene('v8-refused-leave', 'dialog');
  await w.click(w.top().getByRole('button', { name: '저장 안 함', exact: true }));
}

/**
 * 일괄 수납(V5, spec 3-6): 이정호 팀 접수증의 처리 현황 `수납` → #/orders/o32/pay(15:40: 이서연 팀 · 새 접수 한지민 팀까지). 체험 자료를
 * 처음으로 되돌려 체험 시계를 16:40(+1시간, 뒷이야기의 새 접수 네 팀)으로 옮겨 다시 연 뒤: 쪽마다, `미수` 탭(줄 하나 켜고 끄기), 줄 고름 끄기 · 켜기, 이민호 팀(0042)의 부분 결제
 * 판(partialWalk, 그다음 의류를 빼고 `선택`: 줄이 `부분 · …`), 수단(현금 · 계좌이체 · `기타` 판 → 첫 수단 → 카드), 팀 추가(없는 번호 → 한 줄,
 * 0028 → 더한 줄, 0024 → `받을 금액 없음` 알림)를 잰다. 끝으로 수납을 확정해 접수증으로 돌아오는지 보고, 체험 자료를 처음으로 되돌린다(뒤 걸음은
 * 15:40에서 시작한다).
 */
async function groupPayWalk(w) {
  const page = w.page;
  const click = async (locator) => { if (await locator.count() && await locator.first().isEnabled()) { await w.click(locator.first()); return true; } return false; };
  const open = async (name) => {
    await w.visit('#/orders/o32', '.sn-slip');
    // 처리 현황의 `수납` 줄(낮은 화면에서는 `외 N건`으로 접힘) → 옆 동작 `수납` → 더 보기 안의 `수납`.
    const row = page.locator('.pos-side .sn-check-press', { hasText: '수납' });
    const side = page.locator('.pos-side-actions').getByRole('button', { name: '수납', exact: true });
    if (await row.count()) await w.click(row.first());
    else if (await side.count()) await w.click(side);
    else {
      await w.click(page.locator('.pos-side-actions').getByRole('button', { name: '더 보기' }));
      await w.click(w.top().getByRole('button', { name: '수납', exact: true }));
    }
    await page.waitForSelector('.pos-group-table', { timeout: 10_000 });
    await w.settle();
    if (!/^#\/orders\/o32\/pay$/.test(await w.hash())) w.fail(name, '이정호 팀 접수증의 수납이 일괄 수납을 열지 않음: ' + (await w.hash()));
  };
  const keypad = async (digits) => {
    for (const d of digits) await w.click(w.top().getByRole('button', { name: d, exact: true }));
    await w.click(w.top().getByRole('button', { name: '찾기', exact: true }));
  };
  const tab = (re) => page.locator('.pos-group [role="tab"]', { hasText: re });
  const checks = () => page.locator('.pos-group-table [role="checkbox"]');
  const reset = async () => {
    await w.visit('#/exit', '.pos-card');
    await w.click(page.getByRole('button', { name: '체험 자료 초기화', exact: true }));
    await w.click(w.top().getByRole('button', { name: '초기화', exact: true }));
    await w.closeTo(0);
  };
  await open('v5-1540');
  await w.scene('v5-1540');
  // 체험 시계는 페이지가 열린 동안 흐른다: 처음으로 되돌려 15:40에서 +1시간(16:40, 16:41 일괄 수납 사건 전).
  await reset();
  await w.click(page.getByRole('button', { name: '+1시간', exact: true }));
  await open('v5');
  await w.pages('v5-rows');
  // 미수 탭: 고른 팀이 먼저(보이는 체크 = 주 버튼 금액, 검토 반영), 그다음 더할 미수 팀. 박준호 팀을 켜고(합계 · 주 버튼이 바뀜) 끄기.
  await w.click(tab(/^미수/));
  await w.pages('v5-unpaid');
  // 좁은 화면에서는 팀 칸의 끝 4자리가 규칙대로 빠질 수 있어, 보이는 글자가 아니라 줄의 data-team으로 찾는다.
  const footerNext = () => page.locator('.sn-footer').getByRole('button', { name: '다음 쪽' });
  const nextFooterPage = async () => {
    const next = footerNext();
    if (!(await next.count()) || (await next.first().isDisabled())) return false;
    await w.click(next);
    return true;
  };
  const park = () => page.locator('.pos-group-table tr[data-team$="0022"]').locator('[role="checkbox"]');
  for (let guard = 0; guard < 4 && !(await park().count()); guard += 1) if (!(await nextFooterPage())) break;
  if (await park().count()) {
    await w.click(park());
    await w.scene('v5-unpaid-on');
    await w.click(park());
  } else w.fail('v5-unpaid', '미수 탭에 박준호 팀(0022)이 없음');
  await w.toPage(1);
  await w.click(tab(/팀 결제/));
  // 줄 고름 끄기 · 켜기.
  await w.click(checks().nth(1));
  await w.scene('v5-off');
  if (!/5팀|6팀/.test((await page.locator('.pos-group-go').textContent()) ?? '')) w.fail('v5-off', '고름을 끈 뒤 주 버튼의 팀 수가 줄지 않음');
  await w.click(checks().nth(1));
  // 부분 결제 판(이민호 팀): 걷고, 의류를 빼고 선택.
  const minho = () => page.locator('.pos-group-table tr[data-team$="0042"]').locator('.pos-group-part');
  for (let guard = 0; guard < 4 && !(await minho().count()); guard += 1) if (!(await nextFooterPage())) break;
  if (await minho().count()) {
    await w.probe(minho(), 'v5-part');
    await w.closeTo(0);
    await w.click(minho());
    const partial = page.locator('.pos-partial');
    await click(partial.getByRole('button', { name: '잔여 전체 선택', exact: true }));
    for (const [item, n] of [['의류 사이즈 95', 2], ['의류 사이즈 100', 1]]) {
      for (let i = 0; i < n; i += 1) await click(partial.locator('[role="group"][aria-label="' + item + ' 수량"] button[aria-label="수량 감소"]'));
    }
    await w.scene('v5-part-picked', 'dialog');
    await w.click(partial.locator('[data-primary="true"]'));
    await w.scene('v5-part');
    if (!(await page.locator('.pos-group-part', { hasText: '부분 ·' }).count()) && !(await page.locator('.pos-group-part', { hasText: '165,000원' }).count())) {
      w.fail('v5-part', '부분 결제 뒤 이민호 팀 줄의 버튼이 부분 금액이 아님');
    }
  } else w.fail('v5-part', '이민호 팀(0042) 줄이 없음');
  await w.toPage(1);
  // 수단: 현금 · 계좌이체 · 기타 판 → 첫 수단 → 카드.
  const method = (label) => page.locator('.sn-method-grid').getByRole('button', { name: label });
  for (const label of ['현금', '계좌이체']) { await w.click(method(label)); await w.scene('v5-method-' + label); }
  await w.click(method(/^기타/));
  await w.scene('v5-other', 'dialog');
  await w.click(w.top().locator('.pos-choice-button').first());
  await w.scene('v5-other-method');
  await w.click(method('카드'));
  // 팀 추가 · 끝 4자리: 없는 번호 → 한 줄, 0028(윤서준) → 목록 끝, 0024(최은정, 받을 금액 없음) → 알림.
  const add = page.locator('.sn-footer').getByRole('button', { name: /팀 추가/ });
  await w.click(add);
  await w.scene('v5-add', 'dialog');
  await keypad('9999');
  await w.scene('v5-add-none', 'dialog');
  for (let k = 0; k < 4; k += 1) await w.click(w.top().getByRole('button', { name: '정정', exact: true }));
  await keypad('0028');
  await w.closeTo(0);
  await w.pages('v5-added');
  if (!/7팀|8팀/.test((await tab(/팀 결제/).textContent()) ?? '')) w.fail('v5-added', '팀 추가 뒤 탭의 팀 수가 오르지 않음: ' + (await tab(/팀 결제/).textContent()));
  await w.click(add);
  await keypad('0024');
  await w.scene('v5-add-dropped', 'dialog');
  await w.closeTo(0);
  // 수납 확정 → 접수증.
  await w.click(page.locator('.pos-group-go'));
  await page.waitForSelector('.sn-slip', { timeout: 10_000 });
  await w.settle();
  await w.scene('v5-done-slip');
  if ((await w.hash()) !== '#/orders/o32') w.fail('v5-done-slip', '수납 뒤 이정호 팀 접수증이 아님: ' + (await w.hash()));
  // 체험 자료를 처음으로(15:40): 뒤 걸음(counterFlow · counterNight)은 15:40에서 시작한다.
  await reset();
}

/**
 * 새 접수 ① 품목 · ② 일정(V2 · V3, spec 3-4 · 3-5): 빈 초안 → 대표자(화면 키보드) · 연락처(숫자판) · 인원 → 종류 타일마다(쪽마다) 열어
 * 규격 · 수량을 누르고(부츠 `규격 더 보기 ›` 작은 창, 줄의 더 보기) → 선택 품목 줄 · 판의 쪽 → ② 일정: 전화 예약 창(수령일 · 다른 날 ·
 * 수령 시각 · 직접 입력 숫자판 · 수령 장소 구역 → 장소), 차량 배달 창, 반납일 · 다른 날, 반납 타임, 반납 장소의 구역 작은 창,
 * `다음 · 결제` · 탭 ③ → V4 접수 확정 창(checkoutWalk) → ① 탭 → `‹ 장부`(초안을 지움). 끝에 한 팀을 확정해 본다(newOrderConfirm).
 */
async function newOrderWalk(w) {
  const page = w.page;
  const click = async (locator) => { if (await locator.count() && await locator.first().isEnabled()) { await w.click(locator.first()); return true; } return false; };
  await w.visit('#/orders/new', '.pos-new');
  await w.scene('v2-empty');
  // 대표자: 화면 키보드(편집 칸 없음, 포스에 실제 자판이 없다). 모두 걸은 뒤 키로 이민호를 쳐서 넣는다.
  await w.click(page.locator('.pos-new-field.is-name'));
  await w.keyboardWalk('v2-name', { submit: ['ㅇ', 'ㅣ', 'ㅁ', 'ㅣ', 'ㄴ', 'ㅎ', 'ㅗ'] });
  if ((await page.locator('.pos-new-field.is-name').getAttribute('aria-label')) !== '대표자 이민호 · 이름 입력') w.fail('v2-name', '키로 친 대표자 이름이 칸에 없음');
  // 연락처: 숫자판(카운터 자판으로도 친다)
  await w.click(page.locator('.pos-new-field.is-phone'));
  await w.scene('v2-phone', 'dialog');
  for (const d of '0100000') await w.click(w.top().getByRole('button', { name: d, exact: true }));
  await page.keyboard.type('0042');
  await w.settle();
  await w.scene('v2-phone-typed', 'dialog');
  await w.click(w.top().getByRole('button', { name: '입력', exact: true }));
  const people = page.locator('.pos-new-people').getByRole('button', { name: '수량 증가' });
  for (let i = 0; i < 4; i += 1) await w.click(people);
  await w.scene('v2-leader');
  // 종류 타일: 쪽마다 타일마다 열고, 규격(첫 규격 · 작은 창) · 수량 +2 −1.
  const footer = page.locator('.sn-footer');
  const [, tilePages] = await w.pageInfo(footer);
  for (let p = 1; p <= tilePages; p += 1) {
    await w.toPage(p, footer);
    const tiles = page.locator('.pos-new-kinds .sn-kind');
    for (let i = 0, n = await tiles.count(); i < n; i += 1) {
      await w.click(page.locator('.pos-new-kinds .sn-kind').nth(i));
      await w.scene('v2-tile-p' + p + '-' + (i + 1));
      const open = page.locator('.pos-new-open');
      const moreSheet = open.getByRole('button', { name: /^규격 더 보기/ });
      if (await moreSheet.count()) {
        await w.click(moreSheet);
        await w.scene('v2-tile-p' + p + '-' + (i + 1) + '-sizes', 'dialog');
        const next = w.top().getByRole('button', { name: '다음 쪽' });
        if (await click(next)) await w.scene('v2-tile-p' + p + '-' + (i + 1) + '-sizes-p2', 'dialog');
        await w.click(w.top().locator('.pos-choice-button').last());
      } else {
        const option = open.locator('.sn-choice[aria-pressed="false"]:enabled').filter({ hasNotText: '더 보기' });
        await click(option);
      }
      const rowMore = open.getByRole('button', { name: '더 보기', exact: true });
      if (await click(rowMore)) await w.scene('v2-tile-p' + p + '-' + (i + 1) + '-more');
      const plus = open.getByRole('button', { name: '수량 증가' });
      await click(plus);
      await click(plus);
      await click(open.getByRole('button', { name: '수량 감소' }));
      await w.scene('v2-tile-p' + p + '-' + (i + 1) + '-qty');
    }
  }
  await w.toPage(1, footer);
  // 선택 품목 판: 줄을 누르면 그 종류가 열리고, 줄이 넘치면 판 안의 쪽.
  await click(page.locator('.pos-new-side .sn-list-press').first());
  await w.scene('v2-picked-row');
  const side = page.locator('.pos-new-side');
  if (await click(side.getByRole('button', { name: '다음 쪽' }))) await w.scene('v2-picked-p2');
  // ② 일정
  await w.click(page.locator('.pos-new-tabs [role="tab"]').nth(1));
  await page.waitForSelector('.pos-new-schedule');
  await w.settle();
  await w.scene('v3');
  const group = (label) => page.getByRole('group', { name: label, exact: true });
  // 전화 예약 창: 수령일 · 다른 날 · 수령 시각 · 직접 입력 · 수령 장소
  await w.click(group('수령 방법').locator('button.sn-choice').nth(1));
  await w.scene('v3-reserve', 'dialog');
  const win = () => w.top();
  await click(win().getByRole('group', { name: '수령일' }).getByRole('button', { name: '오늘', exact: true }));
  await w.scene('v3-reserve-today', 'dialog');
  await click(win().getByRole('group', { name: '수령일' }).locator('button.sn-choice').last());
  await w.scene('v3-reserve-days', 'dialog');
  await w.click(w.top().locator('.pos-choice-button').first());
  await w.scene('v3-reserve-other-day', 'dialog');
  await click(win().getByRole('group', { name: '수령 시각' }).locator('button.sn-choice:enabled').first());
  await click(win().getByRole('group', { name: '수령 시각' }).locator('button.sn-choice').last());
  await w.scene('v3-reserve-time-pad', 'dialog');
  await page.keyboard.type('1920');
  await w.settle();
  await w.click(w.top().getByRole('button', { name: '입력', exact: true }));
  await w.scene('v3-reserve-custom-time', 'dialog');
  const reservePlace = () => win().getByRole('group', { name: '수령 장소' });
  const areaCount = await reservePlace().locator('button.sn-choice').count();
  for (let i = 1; i < areaCount; i += 1) {
    await click(reservePlace().locator('button.sn-choice').nth(i));
    await w.scene('v3-reserve-area' + i, 'dialog');
    if (await click(reservePlace().getByRole('button', { name: '더 보기', exact: true }))) await w.scene('v3-reserve-area' + i + '-more', 'dialog');
    await click(reservePlace().locator('button.sn-choice').nth(1));
  }
  await w.scene('v3-reserve-place', 'dialog');
  await w.closeTo(0);
  await w.scene('v3-reserved');
  // 전화 예약의 접수 확정 창(V4: 리프트권 선입금이라 `후불`을 누를 수 없고 보증금 칸이 없음)을 열어 잰다(검토 반영: 변형마다 따로).
  await checkoutVariant(w, 'v3r-next');
  // 차량 배달 창: 배달 시각 · 직접 입력 · 배달 장소
  await w.click(group('수령 방법').locator('button.sn-choice').nth(2));
  await w.scene('v3-deliver', 'dialog');
  await click(win().getByRole('group', { name: '배달 시각' }).locator('button.sn-choice').nth(1));
  await click(win().getByRole('group', { name: '배달 시각' }).locator('button.sn-choice').last());
  await w.scene('v3-deliver-time-pad', 'dialog');
  await page.keyboard.type('1810');
  await w.settle();
  await w.click(w.top().getByRole('button', { name: '입력', exact: true }));
  const deliverPlace = () => win().getByRole('group', { name: '배달 장소' });
  await click(deliverPlace().locator('button.sn-choice').nth(1));
  await w.scene('v3-deliver-area', 'dialog');
  await click(deliverPlace().locator('button.sn-choice').nth(1));
  await w.scene('v3-deliver-place', 'dialog');
  await w.closeTo(0);
  await w.scene('v3-delivered');
  // 차량 배달의 접수 확정 창(V4)을 열어 잰다.
  await checkoutVariant(w, 'v3d-next');
  await w.click(group('수령 방법').locator('button.sn-choice').first());
  // 반납일 · 다른 날 · 반납 시각
  await click(group('반납일').getByRole('button', { name: '내일', exact: true }));
  await w.scene('v3-tomorrow');
  await click(group('반납일').locator('button.sn-choice').last());
  await w.scene('v3-days', 'dialog');
  await w.click(w.top().locator('.pos-choice-button').last());
  await w.scene('v3-other-day');
  await click(group('반납일').getByRole('button', { name: '오늘', exact: true }));
  const slots = group('반납 시각').locator('button.sn-choice:enabled');
  for (let i = 0, n = await slots.count(); i < n; i += 1) await click(group('반납 시각').locator('button.sn-choice:enabled').nth(i));
  await w.scene('v3-slot');
  // 반납 장소: 구역마다 작은 창 → 첫 장소
  const areas = await group('반납 장소').locator('button.sn-choice').count();
  for (let i = 1; i < areas; i += 1) {
    await click(group('반납 장소').locator('button.sn-choice').nth(i));
    await w.scene('v3-area' + i, 'dialog');
    await w.click(w.top().locator('.pos-choice-button').first());
  }
  await w.scene('v3-place');
  await click(group('반납 장소').getByRole('button', { name: '매장 직접', exact: true }));
  // 다음 · 결제 → V4 접수 확정 창(수단 · 할인 · 결제 팀 · 찾기 숫자판 · #card), 탭 ③도 같은 창.
  const primary = page.locator('.pos-new-side [data-primary="true"]');
  if (await primary.count() && await primary.isEnabled()) { await w.probe(primary, 'v3-next'); await w.closeTo(0); }
  const payTab = page.locator('.pos-new-tabs [role="tab"]').nth(2);
  if (await payTab.isEnabled()) { await w.probe(payTab, 'v3-tab-pay'); await w.closeTo(0); }
  // ① 탭으로 돌아가 초안이 그대로인지. `‹ 장부`로 떠나도 초안은 남고(검토 반영: 손님 응대로 끊겨도 잃지 않음), `새 접수`를 다시 누르면
  // 그대로 열린다. 버리는 것은 바닥줄 `접수 취소`(묻는 창 → `접수 취소`)뿐이다.
  await w.click(page.locator('.pos-new-tabs [role="tab"]').first());
  await page.waitForSelector('.pos-new-kinds');
  await w.settle();
  await w.scene('v2-back');
  if (!(await page.locator('.pos-new-side .sn-list-row').count())) w.fail('v2-back', '① 탭으로 돌아오니 선택 품목이 비었음');
  await w.click(page.locator('.pos-footer-back').getByRole('button', { name: '장부' }));
  await page.waitForSelector('.sn-ledger tr.sn-row');
  await w.settle();
  if (!(await page.evaluate(() => sessionStorage.getItem('sn-new-order')))) w.fail('v2-leave', '‹ 장부 뒤에 새 접수 초안이 사라짐');
  await w.click(page.locator('.sn-footer [data-primary="true"]'));
  await page.waitForSelector('.pos-new-kinds');
  await w.settle();
  await w.scene('v2-reopened');
  if (!(await page.locator('.pos-new-side .sn-list-row').count())) w.fail('v2-reopened', '새 접수를 다시 여니 선택 품목이 비었음');
  // 바닥줄 `접수 취소` → 묻는 창(창의 다른 동작이 초안을 버리므로 probe로 걷지 않고 재기만) → `접수 취소`.
  await w.click(page.locator('.pos-footer-back').getByRole('button', { name: '접수 취소', exact: true }));
  await w.scene('v2-discard', 'dialog');
  await w.click(w.top().locator('.pos-notice-actions').getByRole('button', { name: '접수 취소', exact: true }));
  await page.waitForSelector('.sn-ledger tr.sn-row');
  await w.settle();
  if (await page.evaluate(() => sessionStorage.getItem('sn-new-order'))) w.fail('v2-discard', '접수 취소 뒤에도 새 접수 초안이 남음');
  await newOrderConfirm(w);
}

/**
 * 전화 예약 · 차량 배달로 바꾼 ② 일정에서 `다음 · 결제`를 누를 수 있으면 접수 확정 창(V4)을 열어 잰다(창 높이 · 한도는 checkoutWalk가 변형마다
 * 따로). 모든 버튼을 누르는 걸음은 현장 접수의 첫 창만 한다(checkoutWalked를 잠시 켠다).
 */
async function checkoutVariant(w, name) {
  const primary = w.page.locator('.pos-new-side [data-primary="true"]');
  if (!(await primary.count()) || !(await primary.isEnabled())) return;
  const walked = w.checkoutWalked;
  w.checkoutWalked = true;
  await w.probe(primary, name);
  await w.closeTo(0);
  w.checkoutWalked = walked;
}

/**
 * 접수 확정(V4 → order.create): 대표자 · 연락처 · 스키 1 → ② 일정 → ③ 결제 → 장비 후불 · 결제 팀 이정호 · 0032 → `접수 확정` → 새 접수의
 * 접수증(주소가 #/orders/<새 id>, 초안이 지워짐, 돈 줄 `이정호 팀 결제 예정`). 이 크기의 체험 자료에 한 팀이 더해진다(끝 4자리 0099).
 */
async function newOrderConfirm(w) {
  const page = w.page;
  await w.visit('#/orders/new', '.pos-new');
  await w.click(page.locator('.pos-new-field.is-name'));
  await w.keyboardWalk('v4-name', { submit: ['ㅎ', 'ㅏ', 'ㄴ', 'ㅈ', 'ㅣ', 'ㅁ', 'ㅣ', 'ㄴ'] });
  await w.click(page.locator('.pos-new-field.is-phone'));
  await page.keyboard.type('01000000099');
  await w.settle();
  await w.click(w.top().getByRole('button', { name: '입력', exact: true }));
  await w.click(page.locator('.pos-new-kinds .sn-kind').first());
  await w.click(page.locator('.pos-new-open').getByRole('button', { name: '수량 증가' }));
  await w.click(page.locator('.pos-new-side [data-primary="true"]'));
  await page.waitForSelector('.pos-new-schedule');
  await w.settle();
  await w.click(page.locator('.pos-new-side [data-primary="true"]'));
  await page.waitForSelector('.pos-checkout');
  await w.settle();
  const dialog = page.locator('.pos-checkout');
  await w.click(dialog.getByRole('group', { name: '장비 결제 수단', exact: true }).getByRole('button', { name: '후불', exact: true }));
  // 결제 팀 줄의 다른 팀은 끝 4자리로 찾은 팀만(검토 반영): `다른 팀 찾기 · 끝 4자리` → 카운터 자판 0032 · Enter.
  await w.click(dialog.getByRole('button', { name: /^다른 팀 찾기/ }));
  await page.keyboard.type('0032');
  await page.keyboard.press('Enter');
  await w.settle();
  if ((await w.dialogCount()) > 1) await w.closeTo(1);
  if (!(await dialog.getByRole('group', { name: '결제 팀', exact: true }).getByRole('button', { name: '이정호 · 0032', exact: true }).count())) {
    w.fail('v4-confirm', '끝 4자리 0032(카운터 자판)로 결제 팀을 찾지 못함');
  }
  await w.scene('v4-confirm', 'dialog');
  await w.click(dialog.locator('[data-primary="true"]'));
  await page.waitForSelector('.sn-slip', { timeout: 10_000 });
  await w.settle();
  await w.scene('v4-done-slip');
  const hash = await w.hash();
  if (!/^#\/orders\/n\d+$/.test(hash)) w.fail('v4-done-slip', '접수 확정 뒤 새 접수증이 아님: ' + hash);
  if (await page.evaluate(() => sessionStorage.getItem('sn-new-order'))) w.fail('v4-done-slip', '접수 확정 뒤에도 새 접수 초안이 남음');
  if (!(await page.locator('.sn-slip', { hasText: '이정호 팀 결제 예정' }).count())) w.fail('v4-done-slip', '새 접수증 돈 줄에 결제 팀이 없음');
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

/**
 * 체험 시계를 21:10 · 22:10 · 27일 00:10으로: 야간 수거 준비 줄, 늦은 줄(빨강), 22:10의 주 버튼(마지막 반납 타임 심야 24:00 전이라
 * 새 접수), 24:00 뒤의 마감 주 버튼. 체험판은 뒷이야기가 켜져 있어 그 사이의 사건(16:05 박준호 지급 · 보증금 …)이 적힌다.
 */
async function counterNight(w) {
  const advance = async (hours, tens) => {
    await w.visit('#/exit', '.pos-card');
    for (let i = 0; i < hours; i += 1) await w.click(w.page.getByRole('button', { name: '+1시간', exact: true }));
    for (let i = 0; i < tens; i += 1) await w.click(w.page.getByRole('button', { name: '+10분', exact: true }));
  };
  await advance(5, 3);
  await w.visit('#/ledger/' + w.date, '.sn-ledger tr.sn-row');
  await w.pages('night-ledger');
  // 21:10 박준호 팀(16:05 지급 · 보증금 15,000원, 19:41 일정 나뉨): 처리 현황 반납 → 매장 반납 처리 → 보증금 줄이 있는 반납 창(V1).
  await w.visit('#/orders/o22', '.sn-slip');
  await slipWalk(w, 'night-slip-0022');
  await w.probe(w.page.locator('.sn-header').getByRole('button', { name: /^알림/ }), 'night-alerts');
  await w.closeTo(0);
  // 21:10 이민호 팀(16:26 새 접수 · 16:27 지급, 품목 5줄 · 권 4매 보증금 20,000원, 매장 반납): 줄마다 반납 창, 처리 현황 반납(5줄 반납 창의
  // 쪽 넘김), 옆 동작 일정 변경(변경 품목 5줄 → 쪽 넘김, plan.md 6절 V9 'pager when > 4 lines').
  if (await openSlipOf(w, '0042')) await slipWalk(w, 'night-slip-0042');
  else w.fail('night-slip-0042', '21:10 장부에 이민호 팀(0042) 줄이 없음');
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
  // 심야 24:00(마지막 반납 타임) 뒤: 26일 영업일 장부(06:00 전)의 주 버튼이 마감.
  await advance(2, 0);
  await w.visit('#/ledger/' + w.date, '.sn-ledger tr.sn-row');
  await w.pages('after-midnight-ledger');
  // 늦은 반납(27일 00:10: 22:00 차량 수거가 남은 팀): 처리 현황 반납 → 매장 반납 처리 → 반납 창의 빨강 한 줄 `반납 지연 · 일정 22:00`.
  const lateRow = w.page.locator('.sn-ledger tr.sn-row.is-late', { has: w.page.locator('.is-time', { hasText: '반납' }) }).locator('.sn-cell-open');
  if (!(await lateRow.count())) w.fail('late-return', '27일 00:10 장부 첫 쪽에 늦은 반납 줄이 없음');
  if (await lateRow.count()) {
    await w.click(lateRow.first());
    await w.page.waitForSelector('.sn-slip');
    await w.settle();
    const back = w.page.locator('.pos-side .sn-check-press', { hasText: '반납' });
    if (await back.count()) { await w.probe(back.first(), 'late-return'); await w.closeTo(0); }
    await w.visit('#/ledger/' + w.date, '.sn-ledger tr.sn-row');
  }
  const close = w.page.locator('.sn-footer [data-primary="true"]');
  if (!/마감/.test((await close.textContent()) ?? '')) w.fail('after-midnight-ledger', '24:00 뒤 장부 주 버튼이 마감이 아님: ' + ((await close.textContent()) ?? ''));
  await w.probe(close, 'close-primary');
  await w.closeTo(0);
  // 27일 00:20(00:15 정하늘 반납 뒤, 00:32 차량 현금 점검 전): 운영 규칙의 기준 시각 거절(V8)을 보고, 하루 마감을 끝까지 걷는다(이 크기의 마지막 걸음).
  await advance(0, 1);
  await rulesRefusedWalk(w);
  await closingWalk(w);
}

/**
 * 하루 마감(V6, spec 3-7) 15:40(관리 → 마감의 길): 화면 · 이월 항목 줄마다(접수증 · 장부 탭으로 갔다 옴) · 주 버튼(돈통 점검 판을 걷고 닫음).
 * 마감하지 않는다.
 */
async function closingDay(w) {
  const page = w.page;
  await w.visit('#/closing/' + w.date, '.pos-closing-table');
  await w.scene('v6-1540');
  await closingCarry(w, 'v6-1540');
  await w.probe(page.locator('.sn-footer [data-primary="true"]'), 'v6-1540-primary');
  await w.closeTo(0);
  // 영업 중(15:40) 마감은 한 번 묻는다(검토 반영): 돈통을 세고 `마감 · 12월 26일` → 확인 창 `26일 반납 예정 … · 1호 차량 미입고` → 닫기.
  await w.click(page.locator('.sn-footer [data-primary="true"]'));
  await page.waitForSelector('.pos-cash-check');
  for (const key of ['3', '0', '0', '000']) await w.click(page.locator('.pos-cash-check').getByRole('button', { name: key, exact: true }));
  await w.click(page.locator('.pos-cash-check [data-primary="true"]'));
  await page.waitForSelector('.pos-cash-check', { state: 'detached' });
  await w.settle();
  await w.scene('v6-1540-counted');
  await w.click(page.locator('.sn-footer [data-primary="true"]'));
  if (!(await w.dialogCount())) w.fail('v6-1540-confirm', '영업 중 마감이 묻지 않고 바로 닫힘');
  else {
    await w.scene('v6-1540-confirm', 'dialog');
    await w.closeTo(0);
    if (await page.locator('.pos-closing-sum', { hasText: '마감 완료' }).count()) w.fail('v6-1540-confirm', '확인 창을 닫았는데 마감됨');
  }
  // 기사 기기에 전송 대기가 있으면 마감이 막힌다(바닥줄 `1호 차량 · 전송 대기 있음`): 연결을 끊고 순서를 하나 바꾼 뒤 마감 화면.
  await w.visit('#/exit?from=driver', '.pos-card', 'driver');
  await w.click(page.getByRole('button', { name: '연결 해제', exact: true }));
  await w.visit('#/driver/' + w.date, '.sn-ledger tr.sn-row', 'driver');
  await w.click(page.locator('.sn-ledger tr.sn-row .sn-cell-open').first());
  const down = page.getByRole('toolbar').getByRole('button', { name: '아래로', exact: true });
  if (await down.count() && await down.isEnabled()) await w.click(down);
  else await w.click(page.getByRole('toolbar').getByRole('button', { name: '위로', exact: true }));
  await w.visit('#/closing/' + w.date, '.pos-closing-table', 'counter');
  await w.scene('v6-blocked');
  if (!(await page.locator('.pos-closing-sum', { hasText: '전송 대기 있음' }).count())) w.fail('v6-blocked', '전송 대기가 있는데 마감 바닥줄에 막힘 한 줄이 없음');
  await w.visit('#/exit?from=driver', '.pos-card', 'driver');
  await w.click(page.getByRole('button', { name: /^재연결/ }));
  w.route('counter');
}

/** 이월 항목 줄을 모두 눌러 본다(쪽마다): 접수증 · 장부 탭으로 가서 재고 돌아온다. */
async function closingCarry(w, name) {
  const next = () => w.page.locator('.pos-closing-carry-head').getByRole('button', { name: '다음 쪽' });
  for (let p = 1; p <= 4; p += 1) {
    const rows = w.page.locator('.pos-closing-carry button.pos-closing-carry-press');
    for (let i = 0, n = await rows.count(); i < n; i += 1) {
      await w.probe(w.page.locator('.pos-closing-carry button.pos-closing-carry-press').nth(i), name + '-carry-p' + p + '-' + (i + 1), {
        back: async () => { await w.page.goBack(); await w.page.waitForSelector('.pos-closing-table', { timeout: 10_000 }); await w.settle(); },
      });
    }
    if (!(await next().count()) || !(await next().isEnabled())) break;
    await w.click(next());
  }
  const prev = w.page.locator('.pos-closing-carry-head').getByRole('button', { name: '이전 쪽' });
  while (await prev.count() && await prev.isEnabled()) await w.click(prev);
}

/**
 * 하루 마감(V6) 27일 00:20: 점검 전(#before, 1024×569 · 1024×529도 한 쪽) → 점검 이월(이월 항목 6 · 두 쪽) → 돈통 점검 판(틀린 금액 · 사유 ·
 * 직접 입력 판) → 505,000원 · 잔돈 착오로 셈 → 이월한 봉투의 점검(35,000원: 돈통 예상이 바뀌어 재점검 차례) → 재점검 545,000원 → 마감 →
 * 마감 완료 · 마감표 인쇄 → 이월 항목 누름. 이 크기의 체험 자료는 마감된 채로 끝난다(뒤 걸음 없음).
 */
async function closingWalk(w) {
  const page = w.page;
  const primary = () => page.locator('.sn-footer [data-primary="true"]');
  const action = (re) => page.locator('.pos-closing-table .sn-cell-action', { hasText: re });
  const expectPrimary = async (scene, re) => {
    const got = (await primary().count()) ? ((await primary().textContent()) ?? '') : '';
    if (!re.test(got)) w.fail(scene, '마감 화면 주 버튼이 ' + re + '이 아님: ' + got);
  };
  await w.visit('#/closing/' + w.date, '.pos-closing-table');
  await w.scene('v6-before');
  await expectPrimary('v6-before', /^차량 현금 점검 · 35,000원$/);
  if (await page.locator('.pos-closing .sn-pager, .sn-footer .sn-pager').count()) w.fail('v6-before', '마감 화면(이월 항목 5)이 한 쪽이 아님');
  await w.click(action(/^점검 이월$/));
  await w.scene('v6-deferred');
  const next = page.locator('.pos-closing-carry-head').getByRole('button', { name: '다음 쪽' });
  if (!(await next.count())) w.fail('v6-deferred', '이월 항목 6이 쪽을 넘기지 않음');
  else { await w.click(next); await w.scene('v6-deferred-p2'); await w.click(page.locator('.pos-closing-carry-head').getByRole('button', { name: '이전 쪽' })); }
  await expectPrimary('v6-deferred', /^돈통 점검$/);
  await w.click(primary());
  await w.cashCheckWalk('v6-drawer', { commit: { digits: ['5', '0', '5', '000'], reason: '잔돈 착오' } });
  await w.scene('v6-counted');
  await expectPrimary('v6-counted', /^마감 · 12월 26일$/);
  await w.click(action(/^점검$/));
  await w.cashCheckWalk('v6-van', { commit: { digits: ['3', '5', '000'] } });
  await w.scene('v6-van-checked');
  await expectPrimary('v6-van-checked', /^돈통 점검$/);
  await w.click(action(/^재점검$/));
  await w.cashCheckWalk('v6-recount', { commit: { digits: ['5', '4', '5', '000'] } });
  await w.scene('v6-ready');
  await expectPrimary('v6-ready', /^마감 · 12월 26일$/);
  await w.click(primary());
  // 영업이 끝난 뒤(00:20, 반납 예정 · 차량 미입고 없음)에는 묻지 않는다. 물으면 재고 확정.
  if (await w.dialogCount()) {
    await w.scene('v6-confirm', 'dialog');
    await w.click(w.top().locator('[data-primary="true"]'));
  }
  await w.scene('v6-closed');
  if (!(await page.locator('.pos-closing-sum', { hasText: '12월 26일 마감 완료' }).count())) w.fail('v6-closed', '마감 뒤 `12월 26일 마감 완료`가 없음');
  await w.probe(page.getByRole('button', { name: '마감표 인쇄', exact: true }), 'v6-print');
  await w.closeTo(0);
  await closingCarry(w, 'v6-closed');
  // 마감한 영업일의 장부: 제목 옆 `마감 완료`.
  await w.visit('#/ledger/' + w.date, '.sn-ledger tr.sn-row');
  await w.scene('ledger-closed');
  if (!(await page.locator('.sn-title-tag', { hasText: '마감 완료' }).count())) w.fail('ledger-closed', '마감한 장부 제목 옆에 `마감 완료`가 없음');
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

  await deliveryWalk(w);
  await driverFlow(w, list);
  if (w.sizeClass === 'driver_tablet') {
    // 넓은 화면에서 휴대폰 모양으로 보기(틀이 들어가면 휴대폰 등급)
    await w.visit('#/driver/' + w.date + '?device=phone', '.sn-ledger tr.sn-row', 'driver', ['driver_phone']);
    await w.pages('driver-phone-frame');
  }
  await driverNight(w, list);
  await driverKeyboard(w);
  await connectWalk(w);
}

/**
 * 서버 모드의 화면(계획 work/impl-server/plan.md 6-3 · 6-4): 체험판 미리 보기로 이 크기의 등급에서 잰다.
 *   #/preview/enroll: 기기 등록(화면 안 숫자판) → 12자리(넷씩 끊어 보임) → 입력(체험판 미지원 한 줄).
 *   #/preview/login?many: 직원 타일 24개(쪽마다) → 타일 → 비밀번호 숫자판(가린 표시 ● ● ● ●) → 입력(한 줄) → 닫기. 셋이면 한 쪽.
 *   #/preview/offline: 연결 끊김(마지막 연결 · 재시도). #/preview/exit: 로그인한 기기의 나가기와 로그아웃 묻는 창.
 * 기사 크기는 ?device=tablet · phone(기사 등급), 포스 크기는 카운터 등급.
 */
async function connectWalk(w) {
  const page = w.page;
  const driver = DRIVER_CLASSES.includes(w.sizeClass);
  const role = driver ? 'driver' : 'counter';
  const device = driver ? 'device=' + (w.sizeClass === 'driver_phone' ? 'phone' : 'tablet') : '';
  const query = (extra) => { const q = [extra, device].filter(Boolean).join('&'); return q ? '?' + q : ''; };
  await w.visit('#/preview/enroll' + query(''), '.pos-enroll', role);
  await w.scene('enroll');
  const pad = page.locator('.pos-enroll .sn-numpad');
  if (await pad.getByRole('button', { name: '입력', exact: true }).isEnabled()) w.fail('enroll', '빈 등록 번호인데 입력을 누를 수 있음');
  for (const d of '123456789012') await w.click(pad.getByRole('button', { name: d, exact: true }));
  await w.scene('enroll-typed');
  const shown = ((await pad.locator('.sn-numpad-display').textContent()) ?? '').trim();
  if (shown !== '1234-5678-9012') w.fail('enroll-typed', '등록 번호가 넷씩 끊어 보이지 않음: ' + shown);
  await w.click(pad.getByRole('button', { name: '입력', exact: true }));
  await page.waitForSelector('.pos-enroll .sn-keypad-note', { timeout: 5_000 }).catch(() => {});
  await w.scene('enroll-note');
  if (!(await pad.locator('.sn-keypad-note').count())) w.fail('enroll-note', '보낸 뒤 한 줄이 없음');

  await w.visit('#/preview/login' + query('many'), '.pos-login-tile', role);
  const pager = page.locator('.pos-login-pager');
  const [, total] = await w.pageInfo(pager);
  if (total < 2) w.fail('login', '타일 24개가 한 쪽에 들어감(쪽 넘김을 재지 못함): ' + (await page.locator('.pos-login-tile').count()) + '개');
  for (let p = 1; p <= total; p += 1) {
    await w.toPage(p, pager);
    await w.scene('login-p' + p);
  }
  await w.toPage(1, pager);
  await w.click(page.locator('.pos-login-tile').first());
  await w.scene('login-pin', 'dialog');
  for (const d of '4821') await w.click(w.top().getByRole('button', { name: d, exact: true }));
  await w.scene('login-pin-typed', 'dialog');
  const masked = ((await w.top().locator('.sn-numpad-display').textContent()) ?? '').trim();
  if (masked !== '● ● ● ●' || (await w.top().textContent())?.includes('4821')) w.fail('login-pin-typed', '비밀번호가 가려 보이지 않음: ' + masked);
  await w.click(w.top().getByRole('button', { name: '입력', exact: true }));
  await page.waitForSelector('.sn-sheet-overlay .sn-keypad-note', { timeout: 5_000 }).catch(() => {});
  await w.scene('login-pin-note', 'dialog');
  await w.closeTo(0);
  await w.visit('#/preview/login' + query(''), '.pos-login-tile', role);
  await w.scene('login-few');

  await w.visit('#/preview/offline' + query(''), '.pos-card', role);
  await w.scene('offline');
  await w.visit('#/preview/exit' + query(''), '.pos-card', role);
  await w.scene('exit-session');
  await w.probe(page.getByRole('button', { name: '로그아웃', exact: true }), 'exit-logout');
  await w.closeTo(0);
}

/**
 * 기사 기기의 화면 키보드(계획 7-5): 기사 화면에는 아직 글자 칸이 없어 체험판 미리 보기 #/preview/keyboard(40자)를 이 크기의 기사 등급으로
 * 열어 모두 걷고, 키로 이름(박기사)을 쳐서 넣은 뒤 종이를 잰다. 휴대폰 틀이 들어가는 태블릿 크기에서는 틀 안(360×640)에서도 모두 걷는다.
 */
async function driverKeyboard(w) {
  const phone = w.sizeClass === 'driver_phone';
  await w.visit('#/preview/keyboard?device=' + (phone ? 'phone' : 'tablet'), '.sn-kb', 'driver');
  await w.keyboardWalk('driver-kb', { submit: ['ㅂ', 'ㅏ', 'ㄱ', 'ㄱ', 'ㅣ', 'ㅅ', 'ㅏ'] });
  await w.scene('driver-kb-done');
  if ((await w.page.locator('.pos-preview-text').textContent()) !== '박기사') w.fail('driver-kb-done', '키로 친 이름이 종이에 없음');
  if (!phone) {
    w.keyboardWalked.clear();
    await w.visit('#/preview/keyboard?device=phone', '.sn-kb', 'driver', ['driver_phone']);
    await w.keyboardWalk('driver-kb-phone-shape');
  }
}

/**
 * 업무 판(V7) 한 장을 걷는다: 화면, 품목 표의 도장 칸마다(확인 창 · 한 줄 알림), 표의 쪽(휴대폰은 표 아래 쪽 넘김), 오른쪽 판의 큰 버튼마다
 * (현장 수납 판 · 리프트권 추가 판 · 방문 결과 판 · 전화), 주 버튼(확인 창), 머리줄(끝 4자리 숫자판 · 차량 재고 · 알림). 확정하지 않는다.
 * 줄 · 버튼 높이는 연결 띠를 늘 뺀 높이라, 연결되어 있으면 품목 표 아래 · 반납 일정 위에 띠만큼 남는다(spec 3-8).
 */
async function taskWalk(w, name) {
  const page = w.page;
  await w.scene(name);
  const sheetPager = page.locator('.pos-task-pager');
  const stamps = () => page.locator('.pos-task-items button.sn-stamp-cell');
  const walkStamps = async (suffix) => {
    for (let i = 0, n = await stamps().count(); i < n; i += 1) {
      await w.probe(stamps().nth(i), name + suffix + '-s' + (i + 1));
      await w.closeTo(0);
    }
  };
  await walkStamps('');
  // 품목 표의 쪽: 태블릿은 바닥줄, 휴대폰은 표 아래.
  const footerPages = (await w.pageInfo())[1];
  if (footerPages > 1) await w.pages(name + '-rows', async (p) => { if (p > 1) await walkStamps('-p' + p); });
  else if (await sheetPager.count()) {
    const [, total] = await w.pageInfo(sheetPager);
    for (let p = 2; p <= total; p += 1) { await w.toPage(p, sheetPager); await w.scene(name + '-p' + p); await walkStamps('-p' + p); }
    await w.toPage(1, sheetPager);
  }
  const actions = page.locator('.pos-task-actions button');
  for (let i = 0, n = await actions.count(); i < n; i += 1) {
    if (!(await actions.nth(i).isEnabled())) continue;
    await w.probe(actions.nth(i), name + '-b' + (i + 1));
    await w.closeTo(0);
  }
  const primary = page.locator('.sn-footer [data-primary="true"]');
  if (await primary.count() && await primary.isEnabled()) { await w.probe(primary, name + '-primary'); await w.closeTo(0); }
  await w.header(name);
}

/**
 * 기사 배달 목록 · 업무 판(V7, spec 3-8 · ui 6-5): 15:40 배달 목록(탭 · 쪽 · 도장 칸 · 전화 · 머리줄) → 팀 칸 → 업무 판(싣기 전: 적재 처리) 걷기 →
 * `‹ 배달 목록`(그 목록으로). 처음으로 되돌려 16:50(16:40 적재 뒤) 업무 판 걷기 → 연결 끊김: 띠 · 배달 처리(전송 대기 점선) · 리프트권 추가 →
 * 곧바로 현장 수납 판 → 수납(보냄 대기) → 재연결 → `배달 완료`. 수거 업무 판(박준호 팀, 권 보증금 줄) 걷기, 태블릿에서는 휴대폰 모양 틀.
 * 끝에 체험 자료를 처음으로(뒤 걸음 driverFlow는 15:40에서 시작한다).
 */
async function deliveryWalk(w) {
  const page = w.page;
  const task = (id, device = '') => '#/driver/tasks/' + encodeURIComponent(id) + device;
  const list = async () => { await w.visit('#/driver/' + w.date + '/deliveries', '.sn-ledger tr.sn-row', 'driver'); };
  const reset = async () => {
    await w.visit('#/exit', '.pos-card', 'counter');
    await w.click(page.getByRole('button', { name: '체험 자료 초기화', exact: true }));
    await w.click(w.top().getByRole('button', { name: '초기화', exact: true }));
    await w.closeTo(0);
  };
  const openTask = async (name) => {
    await list();
    await w.click(page.locator('.sn-ledger tr.sn-row .sn-cell-open').first());
    await page.waitForSelector('.pos-task-sheet', { timeout: 10_000 });
    await w.settle();
    if ((await w.hash()).split('?')[0] !== task('deliver:o26')) w.fail(name, '배달 목록의 팀 칸이 업무 판을 열지 않음: ' + (await w.hash()));
  };
  const driverExit = async () => { await w.visit('#/exit?from=driver', '.pos-card', 'driver'); };

  await list();
  await w.tabs('v7-deliveries');
  await w.rowButtons('v7-deliveries-rows');
  await w.header('v7-deliveries');
  await openTask('v7-1540');
  await taskWalk(w, 'v7-1540');
  await w.click(page.locator('.pos-task-footer .pos-footer-back button'));
  await page.waitForSelector('.sn-ledger tr.sn-row', { timeout: 10_000 });
  await w.settle();
  if (!/\/deliveries/.test(await w.hash())) w.fail('v7-back', '‹ 배달 목록이 배달 목록으로 돌아가지 않음: ' + (await w.hash()));
  await w.scene('v7-back-list');

  // 16:50: 16:40 적재 뒤(배달 미처리), 시안 V7의 상태.
  await reset();
  await w.click(page.getByRole('button', { name: '+1시간', exact: true }));
  await w.click(page.getByRole('button', { name: '+10분', exact: true }));
  await openTask('v7');
  await taskWalk(w, 'v7');
  const primaryText = (await page.locator('.sn-footer [data-primary="true"]').textContent()) ?? '';
  if (!/배달 처리/.test(primaryText)) w.fail('v7', '16:50 업무 판의 주 버튼이 배달 처리가 아님: ' + primaryText);

  // 연결 끊김(체험): 띠 · 배달 처리(전송 대기) · 리프트권 추가 → 곧바로 현장 수납 판 → 수납(전송 대기) → 재연결.
  await driverExit();
  await w.click(page.getByRole('button', { name: '연결 해제', exact: true }));
  await w.visit(task('deliver:o26'), '.pos-task-sheet', 'driver');
  await w.scene('v7-offline');
  await w.click(page.locator('.sn-footer [data-primary="true"]'));
  await w.scene('v7-offline-confirm', 'dialog');
  await w.click(w.top().locator('[data-primary="true"]'));
  await w.closeTo(0);
  await w.scene('v7-offline-delivered');
  if (!(await page.locator('.pos-task-items .sn-stamp.is-pending').count())) w.fail('v7-offline-delivered', '연결 끊김 중 배달 처리한 도장이 점선(전송 대기)이 아님');
  const ticket = page.locator('.pos-task-actions button', { hasText: '리프트권 추가' });
  if (await ticket.count() && await ticket.isEnabled()) {
    await w.click(ticket);
    await w.click(w.top().locator('[data-primary="true"]'));
    await page.locator('.pos-field-pay').waitFor({ timeout: 5000 }).catch(() => {});
    await w.settle();
    if (!(await page.locator('.pos-field-pay').count())) w.fail('v7-offline-pay', '리프트권 추가 뒤 현장 수납 판이 열리지 않음');
    else {
      await w.scene('v7-offline-pay', 'dialog');
      await w.click(w.top().locator('[data-primary="true"]'));
      await w.closeTo(0);
    }
    await w.scene('v7-offline-paid');
  }
  await driverExit();
  await w.scene('v7-offline-exit');
  await w.click(page.getByRole('button', { name: /^재연결/ }));
  await w.visit(task('deliver:o26'), '.pos-task-sheet', 'driver');
  await w.scene('v7-done');
  const progress = (await page.locator('.pos-task-footer .pos-footer-back').textContent()) ?? '';
  if (w.sizeClass === 'driver_tablet' && !/배달 완료/.test(progress)) w.fail('v7-done', '재연결 뒤 바닥줄이 배달 완료가 아님: ' + progress);
  await list();
  await w.scene('v7-done-list');

  // 수거 업무 판(박준호 팀, 16:05 지급 · 권 보증금 15,000원): 수거 칸 · 돈 줄 둘째 줄 · 수거 실패.
  await w.visit(task('collect:o22'), '.pos-task-sheet', 'driver');
  await taskWalk(w, 'v7-collect');
  if (w.sizeClass === 'driver_tablet') {
    // 넓은 화면에서 휴대폰 모양으로 보기(틀이 들어가면 휴대폰 등급).
    await w.visit(task('collect:o22', '?device=phone'), '.pos-task-sheet', 'driver', ['driver_phone']);
    await w.scene('v7-phone-frame-collect');
    await w.visit('#/driver/' + w.date + '/deliveries?device=phone', '.sn-ledger tr.sn-row', 'driver', ['driver_phone']);
    await w.scene('v7-phone-frame-deliveries');
    await w.click(page.locator('.sn-ledger tr.sn-row .sn-cell-open').first());
    await page.waitForSelector('.pos-task-sheet', { timeout: 10_000 });
    await w.settle();
    await w.scene('v7-phone-frame');
  }
  await reset();
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
