// 화면 규칙 검사기(ui 4-1 · 8절, 옛 ski-rent-ops/scripts/check-pos-ui-rules.cjs를 옮겨 넓힘). npm run rules -w @skinote/pos
// 빌드한 dist를 vite preview(127.0.0.1:5183, --strictPort)로 띄우고, 매장 기기 등급(pos · pos_narrow · driver_tablet · driver_phone)의
// 검사 크기마다 그 등급의 모든 경로를 돈다. 화면마다 탭 · 쪽을 넘기고, 도장 · 주 버튼 · 옆 동작 · 머리줄 메뉴 · 동작 줄을 눌러
// 여는 확인 창 · 알림 창 · 숫자판 · 아래 판(고르기 판 · 방문 결과 판 · 차에 있는 것)을 모두 열어 재고 닫는다.
// 그 뒤 도장을 찍고(지급 · 수납 · 받음 · 매장 입고 · 못 받음 · 빨리 확인 · 연결 끊김) 체험 시계를 밤(21시 · 22시 뒤)으로 돌려 다시 잰다.
// 글자 칸(새 접수 대표자 · 현금 점검 직접 입력)은 화면 키보드(keyboardWalk): 편집 칸이 없는지, 키로 친 ㄱ ㅣ ㅁ이 `김`인지, 치는 중에는
// 안내가 없고 `입력`을 누른 뒤에만 낱자모 안내(제목은 그대로), `닫기`가 키 줄 밖인지, 자모 키 글자의 먹 높이, 쌍자음(글자로 보이는 키) ·
// 가장 넓은 글자(뷁)로 한도까지 채운 표시 칸 · 숫자 쪽을 잰다. 기사 기기 크기는 미리 보기 #/preview/keyboard(40자)에서 잰다.
// 서버 모드의 화면(기기 등록 · 기기 선택(시험 매장의 열린 등록)과 차량 선택 쪽 · 로그인 타일 쪽 · 비밀번호 숫자판 · 연결 끊김 · 로그아웃)은
// 미리 보기 #/preview/enroll · choose · login · offline · exit에서 잰다(connectWalk).
// 규칙(ui-rules-measure.mjs): 등급 최소보다 작은 글자 · 누르는 곳, 가로 넘침 · 화면 밖, 잘린 · 넘친 글자, 말줄임표,
// 스크롤 영역 · 스크롤 목록 · 반쯤 잘린 줄 · 페이지 스크롤, 주 버튼 둘 이상 · 강조색이 아닌 주 버튼, 늦지 않은 것의 빨강, 영어 글자,
// 화면이 고른 기기 등급. 크기 숫자는 DeviceProfile(@skinote/ui/device-profile)에서만 읽는다: 검사 크기(checkSizes), 최소 글자(minFontPx),
// 누르는 곳(minTargetPx), 강조색(accent), 등급 고르기(pickDeviceClass).
// 빌드하지 않는다: 먼저 npm run build. 화면은 경로 · 크기마다 한 장 이상 work/screens/rules/에 남는다(창은 제목마다 첫 장과 어긋난 장).
// 환경 변수(고치는 동안 일부만 돌릴 때): SKINOTE_RULES_ONLY(등급 키를 쉼표로, 예: pos,driver_phone),
//   SKINOTE_RULES_SIZES(크기를 쉼표로, 예: 1024x529,360x640), SKINOTE_RULES_JOBS(동시에 도는 크기 수, 기본 4),
//   SKINOTE_RULES_PORT(미리보기 서버 포트, 기본 5183 — 여러 작업이 함께 돌 때 겹치지 않게, 예: 5190),
//   SKINOTE_RULES_OUT(화면 · report.json을 남길 폴더, 기본 work/screens/rules — 함께 돌 때 서로 지우지 않게),
//   SKINOTE_RULES_SHOP=numbered(견본 매장 걸음을 모든 크기에서; 없으면 가장 좁은 크기 1024×529 · 1024×569 · 875×600 · 1024×520 · 360×640만),
//   SKINOTE_RULES_FLOW(카운터 크기에서 이 흐름만: discount · orderEdit · exchange · tickets · print · review · closing, 고치는 동안만 — 끝의 검사는 없이 돈다).
// 체험판 기본은 첫 매장(번호 · 보증금 없음)이고, 번호 · 권 보증금을 켠 견본 매장(?shop=numbered)은 그 크기들에서 따로 걷는다(numberedCounter ·
// numberedDriver: V2 `보증금 · 별도` · V4 보증금 칸 · V6 `보증금 보관 중` · 이월 두 쪽 · V7 권 추가 · 수거 보증금에 닿지 않으면 어긋남).
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
    /** 체험 자료의 견본 매장 모양: 첫 매장(기본) 또는 번호 · 권 보증금 매장(주소 ?shop=numbered, 보증금 줄 · 번호 버튼이 있는 창을 잴 때). */
    this.shop = 'first';
    this.date = null;
    /** 일정 변경 창(V9)을 이 크기에서 모두 걸었는지(첫 창만 모두, 나머지는 열어 재기만). */
    this.promiseWalked = false;
    /** 반납 확인 창(V1)을 걸었는지: 보증금 줄이 없는 첫 창 · 보증금 줄(④ ⑤)이 있는 첫 창을 따로 모두 걷는다. */
    this.returnWalked = { plain: false, deposit: false };
    /** 접수 확정 창(V4)을 이 크기에서 모두 걸었는지(첫 창만 모두, 나머지는 열어 재기만). */
    this.checkoutWalked = false;
    /** 할인 적용 창(features-1 §6)을 이 크기에서 모두 걸었는지(첫 창만 모두, 나머지는 열어 재기만). */
    this.discountWalked = false;
    /** 접수 취소 · 품목 취소 창(features-1 §5-4)을 이 크기에서 범위마다 모두 걸었는지(첫 창만 모두, 나머지는 열어 재기만). */
    this.cancelWalked = { order: false, lines: false };
    /** 즉시 교환 창(features-1 §7-5)을 이 크기에서 모두 걸었는지(첫 창만 모두, 나머지는 열어 재기만). */
    this.exchangeWalked = false;
    /** 화면 키보드를 모두 걸은 판 제목(제목마다 첫 판만 모두, 나머지는 열어 재기만). */
    this.keyboardWalked = new Set();
    /** 견본 매장(번호 · 보증금) 걸음에서 닿은 보증금 변형(numberedCounter · numberedDriver가 모두 닿았는지 본다). */
    this.seen = new Set();
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

  /** 이 모양의 주소 앞부분(첫 매장은 BASE, 번호 · 보증금 매장은 BASE?shop=numbered). */
  base() { return BASE + (this.shop === 'numbered' ? '?shop=numbered' : ''); }

  async visit(hash, selector, role = this.role, extraAllowed = []) {
    this.route(role, extraAllowed);
    await this.page.goto(this.base() + hash);
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

  /**
   * 환불 줄 자리(할인 · 취소 · 초과 수납 환불 창)의 쪽을 넘기며(셋 이상이면) 재고, 모든 쪽의 환불 줄 글을 모은다: 환불의 금액 · 수단이 숨지 않는지
   * (2026-09-27 점검). 첫 쪽으로 돌아온다.
   */
  async refundPages(dialog, measure, tag) {
    const area = dialog.locator('.pos-discount-refunds');
    const texts = [];
    const collect = async () => { for (const x of await area.locator('.pos-discount-refund:not(.is-blank) .pos-discount-refund-text').allTextContents()) texts.push(x.trim()); };
    await collect();
    const next = area.locator('.pos-discount-refund-pager').getByRole('button', { name: '다음 쪽' });
    for (let p = 2; p <= 6 && await next.count() && await next.isEnabled(); p += 1) {
      await this.click(next);
      if (measure) await measure(tag + '-refund-p' + p);
      await collect();
    }
    const prev = area.locator('.pos-discount-refund-pager').getByRole('button', { name: '이전 쪽' });
    for (let guard = 0; guard < 6 && await prev.count() && await prev.isEnabled(); guard += 1) await this.click(prev);
    return texts;
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
    if (await top.evaluate((el) => el.classList.contains('pos-discount'))) {
      await this.discountWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-cancel'))) {
      await this.cancelWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-exchange'))) {
      await this.exchangeWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-pieces-sheet'))) {
      await this.piecesWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-refund'))) {
      await this.refundWalk(name);
      return;
    }
    if (await top.evaluate((el) => el.classList.contains('pos-call'))) {
      await this.callWalk(name);
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
    // 수량 −(한 번 빼 보고 되돌린다). 줄 여럿의 수량 칸(수량으로 세는 줄의 지급 · 적재 · 배달 · 수거, 2026-09-26)이면 마지막 칸을 빼서
    // `잔여 · …` 줄이 붙은 창을 잰다(주 버튼 글에 수 · 매가 남는지도).
    const minus = top.getByRole('button', { name: '수량 감소' });
    const minusCount = await minus.count();
    if (minusCount && await minus.nth(minusCount - 1).isEnabled()) {
      await this.click(minus.nth(minusCount - 1));
      await this.scene(name + '-qty', 'dialog');
      if (minusCount > 1 && !(await top.locator('.sn-dialog-line', { hasText: /^잔여 · / }).count())) this.fail(name + '-qty', '수량 칸을 낮췄는데 `잔여 · …` 줄이 없음');
      await this.click(top.getByRole('button', { name: '수량 증가' }).nth(minusCount - 1));
    }
    if (this.shop === 'numbered' && (await top.getByText(/보증금 [\d,]+원 반환/).count())) this.seen.add('collect-deposit');
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
   * 반납 확인 창(V1, spec 3-1): 번호 하나 빼기, 반환 방법 바꾸기, 모두 빼기(번호 · 수량, 주 버튼을 누를 수 없어야 함), 수량 칸 −/+, 번호 선택 작은 창,
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
      // 수량 칸(번호 없는 매장은 모든 칸)은 −를 눌러 이 쪽의 칸을 모두 0으로.
      for (let guard = 0; guard < 60 && await minus.count(); guard += 1) await this.click(minus.first());
      await measure('-v1-none');
      const primary = top.locator('[data-primary="true"]');
      const onePage = !(await top.getByRole('button', { name: '다음 쪽' }).count());
      if (onePage && await primary.count() && await primary.isEnabled() && !/^보증금 반환/.test((await primary.textContent()) ?? '')) {
        this.fail(name + '-v1', '번호 · 수량을 모두 뺀 반납 창의 주 버튼을 누를 수 있음');
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
    if (this.shop === 'numbered' && (await dialog().locator('.sn-method-row', { hasText: '보증금' }).count())) this.seen.add('v4-deposit');
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
          // 매장 할인(끝의 `직접 입력` 앞), 그다음 직접 입력(종류 판 → 숫자판 → 사유 키보드, features-1 §6-5).
          const choices = this.top().locator('.pos-choice-button');
          await this.click(choices.nth(Math.max(0, (await choices.count()) - 2)));
          await measure('-v4-s' + (i + 1) + '-discounted');
          await this.click(discount);
          const manual = this.top().locator('.pos-choice-button', { hasText: '직접 입력' });
          if (await manual.count() && await manual.first().isEnabled()) {
            await this.click(manual);
            if (await this.manualWalk(name + '-v4-s' + (i + 1) + '-manual')) await measure('-v4-s' + (i + 1) + '-manual');
            else await this.closeTo(1);
            await this.click(discount);
          }
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
   * 직접 입력 할인의 흐름(features-1 §6-5): 종류 판(종류가 둘이면 재고 첫 종류 `금액`) → 숫자판(금액 5,000원 · 비율 15%) → 사유 키보드(`단골`).
   * over를 주면 한도 밖 값을 쳐 `한도 {금액} · 관리자 확인 필요` 한 줄과 막힌 `입력`을 보고 흐름을 닫는다. 키보드까지 입력했으면 true.
   */
  async manualWalk(name, { over = null } = {}) {
    const base = await this.dialogCount();
    if (await this.top().locator('.pos-choice-button').count()) {
      await this.scene(name + '-kind', 'dialog');
      await this.click(this.top().locator('.pos-choice-button').first());
    }
    if (!(await this.top().locator('.sn-numpad').count())) { this.fail(name, '직접 입력의 숫자판이 열리지 않음'); await this.closeTo(base - 1); return false; }
    const title = (await this.topKey()).replace(/^\d+:/, '');
    const percent = /비율/.test(title);
    const enter = () => this.top().getByRole('button', { name: '입력', exact: true });
    if (over) {
      await padKeys(this, over);
      await this.scene(name + '-over', 'dialog');
      // 한도 밖 값은 한도를 말한다(`한도 10,000원 · 관리자 확인 필요`, 2026-09-27 점검).
      if (!(await this.top().getByText(/^한도 \S+ · 관리자 확인 필요$/).count())) this.fail(name + '-over', '한도 밖 값에 `한도 {금액} · 관리자 확인 필요` 한 줄이 없음');
      if (await enter().isEnabled()) this.fail(name + '-over', '한도 밖 값인데 입력을 누를 수 있음');
      await this.closeTo(base - 1);
      return false;
    }
    await padKeys(this, percent ? ['1', '5'] : ['5', '000']);
    await this.scene(name + '-pad', 'dialog');
    await padEnter(this, name + '-pad');
    if (!(await this.page.locator('.sn-kb').count())) { this.fail(name, '숫자판 뒤 사유 키보드가 뜨지 않음'); await this.closeTo(base - 1); return false; }
    return this.keyboardWalk(name + '-reason', { submit: ['ㄷ', 'ㅏ', 'ㄴ', 'ㄱ', 'ㅗ', 'ㄹ'] });
  }

  /**
   * 할인 적용 창(features-1 §6-5, 접수증 옆 동작): 칸(장비 · 리프트권) · 할인 고르기(매장 할인 · `직접 입력`) · 환불 줄의 수단을 누르며 잰다. 창 높이는
   * 모든 상태에서 같고 한도(1024×529에서 505) 안이어야 한다. 첫 창만 모두 걷고, 확정하지 않는다.
   */
  async discountWalk(name, { full = !this.discountWalked } = {}) {
    const dialog = () => this.page.locator('.pos-discount');
    const heights = new Set();
    const limit = this.confirmLimit();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await dialog().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    await measure('-discount');
    if (full) {
      this.discountWalked = true;
      const sections = () => dialog().getByRole('group', { name: '대상', exact: true }).locator('button.sn-choice');
      const grid = () => dialog().getByRole('group', { name: '할인', exact: true }).locator('button.sn-choice');
      const sectionCount = await sections().count();
      for (let s = 0; s < Math.max(1, sectionCount); s += 1) {
        if (sectionCount > 1) { await this.click(sections().nth(s)); await measure('-discount-s' + (s + 1)); }
        for (let c = 0, n = await grid().count(); c < n; c += 1) {
          const button = grid().nth(c);
          if (!(await button.isEnabled())) continue;
          const text = ((await button.textContent()) ?? '').trim();
          await this.click(button);
          const tag = '-discount-s' + (s + 1) + 'c' + (c + 1);
          if (/^직접 입력/.test(text)) {
            if (await this.manualWalk(name + tag + '-manual')) await measure(tag);
            else await this.closeTo(1);
          } else await measure(tag);
          const methods = dialog().getByRole('group', { name: '환불', exact: true }).locator('button.sn-choice');
          for (let m = 0, mn = await methods.count(); m < mn; m += 1) {
            if ((await methods.nth(m).getAttribute('aria-pressed')) === 'true') continue;
            await this.click(methods.nth(m));
            await measure(tag + '-m' + (m + 1));
          }
        }
      }
      const next = dialog().locator('.sn-dialog-foot').getByRole('button', { name: '다음 쪽' });
      if (await next.count()) {
        for (let p = 2; await next.isEnabled(); p += 1) { await this.click(next); await measure('-discount-p' + p); }
      }
      await this.refundPages(dialog(), measure, '-discount');
    }
    if (heights.size > 1) this.fail(name + '-discount', '할인 적용 창 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > limit + 0.5) this.fail(name + '-discount', '할인 적용 창 ' + tallest + 'px > 한도 ' + limit + 'px');
  }

  /**
   * 접수 취소 · 품목 취소 창(features-1 §5-4, 접수증 옆 동작): 품목 취소는 줄마다 +(한 번씩, 쪽마다), 접수 취소는 구분(`연락 없음`), 둘 다 돈 줄의
   * 결정(환불 · 미수 결제 · 환불 없음)과 환불 줄의 수단(`현금`)을 누르며 잰다. 창 높이는 모든 상태에서 같고 한도(1024×529에서 505) 안이어야 한다.
   * 범위마다 첫 창만 모두 걷고, 확정하지 않는다(고른 것은 창을 닫으면 버려진다).
   */
  async cancelWalk(name, { full } = {}) {
    const dialog = () => this.page.locator('.pos-cancel');
    const scope = (await dialog().evaluate((el) => el.classList.contains('is-order'))) ? 'order' : 'lines';
    const walkAll = full ?? !this.cancelWalked[scope];
    const heights = new Set();
    const limit = this.confirmLimit();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await dialog().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    await measure('-cancel-' + scope);
    if (walkAll) {
      this.cancelWalked[scope] = true;
      if (scope === 'lines') {
        // 품목 칸의 쪽 넘김은 바닥줄(환불 줄 자리 안의 쪽 넘김과 다르다).
        const next = dialog().locator('.sn-dialog-foot').getByRole('button', { name: '다음 쪽' });
        for (let p = 1; p <= 10; p += 1) {
          const plus = dialog().locator('.pos-cancel-pieces').getByRole('button', { name: '수량 증가' });
          for (let i = 0, n = await plus.count(); i < n; i += 1) {
            if (!(await plus.nth(i).isEnabled())) continue;
            await this.click(plus.nth(i));
            await measure('-cancel-p' + p + 'l' + (i + 1));
          }
          if (!(await next.count()) || !(await next.isEnabled())) break;
          await this.click(next);
          await measure('-cancel-page' + (p + 1));
        }
      } else {
        const reasons = dialog().getByRole('group', { name: '구분', exact: true }).locator('button.sn-choice');
        for (let i = 0, n = await reasons.count(); i < n; i += 1) {
          if ((await reasons.nth(i).getAttribute('aria-pressed')) === 'true') continue;
          await this.click(reasons.nth(i));
          await measure('-cancel-r' + (i + 1));
        }
      }
      const decisions = () => dialog().getByRole('group', { name: '환불', exact: true }).first().locator('button.sn-choice');
      for (let d = 0, dn = await decisions().count(); d < dn; d += 1) {
        await this.click(decisions().nth(d));
        await measure('-cancel-d' + (d + 1));
        const methods = dialog().locator('.pos-discount-refund').getByRole('button', { name: '현금', exact: true });
        if (await methods.count() && (await methods.first().getAttribute('aria-pressed')) !== 'true') {
          await this.click(methods.first());
          await measure('-cancel-d' + (d + 1) + '-cash');
        }
      }
      await this.refundPages(dialog(), measure, '-cancel');
    }
    if (heights.size > 1) this.fail(name + '-cancel', '취소 창 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > limit + 0.5) this.fail(name + '-cancel', '취소 창 ' + tallest + 'px > 한도 ' + limit + 'px');
  }

  /**
   * 즉시 교환 창(features-1 §7-5, 접수증 옆 동작): 교환 품목마다(줄의 `더 보기`까지) 수량 +, 지급 사이즈를 쪽마다 하나씩 누르며 잰다. 창 높이는 모든
   * 상태에서 같고 한도(1024×529에서 505) 안이어야 한다. 첫 창만 모두 걷고, 확정하지 않는다(고른 것은 창을 닫으면 버려진다).
   */
  async exchangeWalk(name, { full = !this.exchangeWalked } = {}) {
    const dialog = () => this.page.locator('.pos-exchange');
    const heights = new Set();
    const limit = this.confirmLimit();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await dialog().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    await measure('-exchange');
    if (full) {
      this.exchangeWalked = true;
      const items = () => dialog().getByRole('group', { name: '교환 품목', exact: true }).locator('button.sn-choice');
      const sizes = () => dialog().getByRole('group', { name: '지급 사이즈', exact: true }).locator('button.sn-choice');
      const next = () => dialog().getByRole('button', { name: '다음 쪽' });
      for (let i = 0, n = await items().count(); i < n; i += 1) {
        const button = items().nth(i);
        if (((await button.textContent()) ?? '').trim() === '더 보기') { await this.click(button); await measure('-exchange-more'); break; }
        if ((await button.getAttribute('aria-pressed')) !== 'true') { await this.click(button); await measure('-exchange-i' + (i + 1)); }
        const plus = dialog().getByRole('button', { name: '수량 증가' });
        if (await plus.count() && await plus.first().isEnabled()) { await this.click(plus.first()); await measure('-exchange-i' + (i + 1) + '-plus'); }
        for (let p = 1; p <= 6; p += 1) {
          // 쪽마다 첫 사이즈 · 마지막 사이즈를 눌러 본다(요약 · 주 버튼 글이 바뀐 창).
          const count = await sizes().count();
          for (const k of [...new Set([0, count - 1])].filter((x) => x >= 0)) { await this.click(sizes().nth(k)); await measure('-exchange-i' + (i + 1) + 'p' + p + 's' + (k + 1)); }
          if (!(await next().count()) || !(await next().isEnabled())) break;
          await this.click(next());
          await measure('-exchange-i' + (i + 1) + '-page' + (p + 1));
        }
      }
    }
    if (heights.size > 1) this.fail(name + '-exchange', '즉시 교환 창 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > limit + 0.5) this.fail(name + '-exchange', '즉시 교환 창 ' + tallest + 'px > 한도 ' + limit + 'px');
  }

  /**
   * 분실 처리 · 분실 회수 · 예비권 적재 · 입고 창(features-1 §8-2, PieceSheet): 쪽마다 첫 칸의 + · −를 눌러 잰다. 창 높이는 모든 상태에서 같고 한도
   * (1024×529에서 505) 안이어야 한다. 확정하지 않는다(고른 것은 창을 닫으면 버려진다).
   */
  async piecesWalk(name) {
    const dialog = () => this.page.locator('.pos-pieces-sheet');
    const heights = new Set();
    const limit = this.confirmLimit();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await dialog().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    await measure('-pieces');
    const next = () => dialog().getByRole('button', { name: '다음 쪽' });
    for (let p = 1; p <= 6; p += 1) {
      const plus = dialog().getByRole('button', { name: '수량 증가' });
      if (await plus.count() && await plus.first().isEnabled()) { await this.click(plus.first()); await measure('-pieces-p' + p + '-plus'); }
      const minus = dialog().getByRole('button', { name: '수량 감소' });
      if (await minus.count() && await minus.first().isEnabled()) { await this.click(minus.first()); await measure('-pieces-p' + p + '-minus'); }
      if (!(await next().count()) || !(await next().isEnabled())) break;
      await this.click(next());
      await measure('-pieces-page' + (p + 1));
    }
    if (heights.size > 1) this.fail(name + '-pieces', '분실 처리 · 예비권 창 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > limit + 0.5) this.fail(name + '-pieces', '분실 처리 · 예비권 창 ' + tallest + 'px > 한도 ' + limit + 'px');
  }

  /**
   * 초과 수납의 환불 창(features-1 §9-3, RefundDialog): 환불 줄의 수단(원래 수단 · 현금)을 눌러 가며 잰다. 창 높이는 그대로이고 확인 창 한도 안.
   * 환불하지 않는다(확정은 reviewFlow가 한다).
   */
  async refundWalk(name) {
    const dialog = () => this.page.locator('.pos-refund');
    const heights = new Set();
    const limit = this.confirmLimit();
    const measure = async (suffix) => {
      await this.scene(name + suffix, 'dialog');
      const box = await dialog().boundingBox();
      if (box) heights.add(Math.round(box.height));
    };
    await measure('-refund');
    const methods = () => dialog().locator('.pos-discount-refund button.sn-choice');
    for (let i = 0, n = await methods().count(); i < n; i += 1) {
      if ((await methods().nth(i).getAttribute('aria-pressed')) === 'true') continue;
      await this.click(methods().nth(i));
      await measure('-refund-m' + (i + 1));
    }
    await this.refundPages(dialog(), measure, '-refund');
    if (heights.size > 1) this.fail(name + '-refund', '환불 창 높이가 바뀜: ' + [...heights].join(' · '));
    const tallest = Math.max(...heights);
    if (tallest > limit + 0.5) this.fail(name + '-refund', '환불 창 ' + tallest + 'px > 한도 ' + limit + 'px');
  }

  /**
   * 전화 창(features-1 §8-4, CallDialog): 번호를 크게. 기사 기기(휴대폰 · 태블릿)는 주 버튼 `전화 · 번호`(체험판은 막힘, `tel:` 링크 없음), 카운터는 번호와
   * `닫기`만(주 버튼 없음).
   */
  async callWalk(name) {
    await this.scene(name + '-call', 'dialog');
    const top = this.top();
    const number = ((await top.locator('.pos-call-number').textContent().catch(() => '')) ?? '').trim();
    const primary = top.locator('[data-primary="true"]');
    if (this.role === 'driver' && number) {
      const label = ((await primary.first().textContent().catch(() => '')) ?? '').trim();
      if (!(await primary.count())) this.fail(name + '-call', '기사 기기의 전화 창에 `전화 · 번호` 주 버튼이 없음');
      else if (label !== '전화 · ' + number && label !== '전화') this.fail(name + '-call', '전화 창 주 버튼이 `전화 · ' + number + '`이 아님: ' + label);
    }
    if (this.role !== 'driver' && (await primary.count())) this.fail(name + '-call', '카운터 전화 창에 주 버튼이 있음(번호와 닫기만)');
    if (await top.locator('a[href^="tel:"]').count()) this.fail(name + '-call', '체험판 전화 창에 `tel:` 링크가 있음(가짜 번호로 걸지 않음)');
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
    if (this.shop === 'numbered' && (await panel().getByText(/보증금/).count())) this.seen.add('ticket-deposit');
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
  async keyboardWalk(name, { submit = null, then = false } = {}) {
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
      // then: 입력 뒤 다음 창(다음 단계 숫자판 · 고르기 판, 거절 한 줄 창)이 키보드 자리에 뜨는 흐름. 키보드는 닫히고 창 수는 그대로여야 한다.
      if (then) {
        await this.settle();
        if (await sheet().count()) { this.fail(name, '입력 뒤에도 화면 키보드가 닫히지 않음'); await this.closeTo(before - 1); return false; }
        if ((await this.dialogCount()) !== before) { this.fail(name, '입력 뒤 다음 창이 뜨지 않음(창 ' + (await this.dialogCount()) + '개)'); return false; }
        return true;
      }
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

/** SKINOTE_RULES_FLOW(고치는 동안만): 카운터 크기에서 이 흐름들만 걷는다(끝의 전체 검사에는 쓰지 않는다). */
const COUNTER_FLOWS = {
  discount: (w) => discountFlow(w), orderEdit: (w) => orderEditFlow(w), exchange: (w) => exchangeFlow(w), tickets: (w) => ticketsFlow(w), print: (w) => printWalk(w),
  review: (w) => reviewFlow(w), closing: (w) => closingDay(w),
};
const FLOWS = (process.env.SKINOTE_RULES_FLOW ?? '').split(',').map((s) => s.trim()).filter((s) => s in COUNTER_FLOWS);

async function counterWalk(w) {
  w.route('counter');
  if (FLOWS.length) {
    await w.visit('#/ledger', '.sn-ledger tr.sn-row', 'counter');
    w.date = /^#\/ledger\/(\d{4}-\d{2}-\d{2})$/.exec(await w.hash())?.[1] ?? '2026-12-26';
    for (const flow of FLOWS) await COUNTER_FLOWS[flow](w);
    return;
  }
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
  if (numberedPass(w)) await numberedCounter(w);
}

/**
 * 번호 · 권 보증금을 켠 견본 매장(?shop=numbered)을 다시 잴 크기(2026-09-26 검토: 첫 매장이 체험판 기본이 된 뒤에도 보증금 변형 — V4 보증금 칸
 * 504/505의 가장 빠듯한 창, V2 `보증금 · 별도`, V6 `보증금 보관 중` · 이월 두 쪽, V7 권 추가 · 수거 보증금 — 을 계속 잰다). 가장 좁은 크기들이고,
 * SKINOTE_RULES_SHOP=numbered면 모든 크기.
 */
const NUMBERED_SIZES = new Set(['1024x529', '1024x569', '875x600', '1024x520', '360x640']);
const numberedPass = (w) => process.env.SKINOTE_RULES_SHOP === 'numbered' || NUMBERED_SIZES.has(w.size.width + 'x' + w.size.height);

/** 견본 매장 걸음의 앞뒤: 모양을 바꾸고 이 크기의 걸음 표시를 처음으로, 끝나면 첫 매장으로 되돌린다. 닿아야 할 변형이 없으면 어긋남. */
async function withNumbered(w, walk, must) {
  const saved = { checkout: w.checkoutWalked, promise: w.promiseWalked, returns: { ...w.returnWalked } };
  w.shop = 'numbered';
  w.checkoutWalked = false;
  w.promiseWalked = false;
  w.returnWalked = { plain: false, deposit: false };
  w.seen.clear();
  try {
    await walk();
  } finally {
    w.shop = 'first';
    w.checkoutWalked = saved.checkout;
    w.promiseWalked = saved.promise;
    w.returnWalked = saved.returns;
  }
  for (const [key, what] of Object.entries(must)) if (!w.seen.has(key)) w.fail('numbered-' + key, '견본 매장(번호 · 보증금) 걸음이 ' + what + '에 닿지 않음');
}

/** 카운터 크기의 견본 매장 걸음: 새 접수(V2 `보증금 · 별도` · V4 보증금 칸) → 27일 00:20 하루 마감(V6 보증금 보관 중 · 이월 두 쪽). */
async function numberedCounter(w) {
  await withNumbered(w, async () => {
    await resetTo(w, 0);
    await newOrderWalk(w);
    await resetTo(w, 8 * 60 + 40);
    await closingWalk(w);
  }, { 'v2-deposit': 'V2 선택 품목의 보증금 줄', 'v4-deposit': 'V4 접수 확정 창의 보증금 칸', 'v6-held': 'V6 `보증금 보관 중`', 'v6-p2': 'V6 이월 항목 둘째 쪽' });
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
  await settingsWalk(w);
  await discountFlow(w);
  await orderEditFlow(w);
  await exchangeFlow(w);
  await ticketsFlow(w);
  await printWalk(w);
  await reviewFlow(w);
}

// ── 리프트권 · 인쇄 · 전화(features-1 §8) ─────────────────────────────────

/** 분실 처리 · 예비권 창(PieceSheet)에서 칸 label의 수를 plus번 올리고 minus번 내린 뒤 주 버튼으로 확정한다. 창이 닫히면 true. */
async function piecesCommit(w, name, { label = null, plus = 0, minus = 0 } = {}) {
  const dialog = w.page.locator('.pos-pieces-sheet');
  await dialog.waitFor({ timeout: 5000 }).catch(() => {});
  if (!(await dialog.count())) { w.fail(name, '분실 처리 · 예비권 창이 열리지 않음'); return false; }
  const piece = () => (label ? dialog.locator('.sn-piece-line', { hasText: label }) : dialog.locator('.sn-piece-line')).first();
  const next = dialog.getByRole('button', { name: '다음 쪽' });
  for (let guard = 0; guard < 10 && !(await piece().count()) && await next.count() && await next.isEnabled(); guard += 1) await w.click(next);
  if (!(await piece().count())) { w.fail(name, '창에 `' + label + '` 칸이 없음'); await w.closeTo(0); return false; }
  for (let i = 0; i < plus; i += 1) await w.click(piece().getByRole('button', { name: '수량 증가' }));
  for (let i = 0; i < minus; i += 1) await w.click(piece().getByRole('button', { name: '수량 감소' }));
  await w.scene(name, 'dialog');
  const primary = dialog.locator('[data-primary="true"]');
  if (!(await primary.isEnabled())) { w.fail(name, '분실 처리 · 예비권 창의 주 버튼이 막힘'); await w.closeTo(0); return false; }
  await w.click(primary);
  await w.page.waitForSelector('.pos-pieces-sheet', { state: 'detached', timeout: 10_000 }).catch(() => {});
  await w.settle();
  if (await w.page.locator('.pos-pieces-sheet').count()) { w.fail(name, '확정 뒤에도 창이 남음'); await w.closeTo(0); return false; }
  return true;
}

/** 리프트권 현황 탭의 차량 칸: 쪽마다 칸마다 누를 수 있는 `예비권 적재` · `예비권 입고`를 열어 잰다. */
async function ticketVans(w, name) {
  const panel = () => w.page.locator('.pos-tickets-right');
  const next = () => panel().getByRole('button', { name: '다음 쪽' });
  for (let p = 1; p <= 6; p += 1) {
    const buttons = () => panel().locator('button.pos-tickets-van-button');
    for (let i = 0, n = await buttons().count(); i < n; i += 1) {
      if (!(await buttons().nth(i).isEnabled())) continue;
      await w.probe(buttons().nth(i), name + '-p' + p + '-' + (i + 1));
      await w.closeTo(0);
    }
    if (!(await next().count()) || !(await next().isEnabled())) break;
    await w.click(next());
    await w.scene(name + '-page' + (p + 1));
  }
}

/** 미반납 · 분실 탭의 첫 쪽 줄마다 누를 수 있는 버튼(분실 처리 · 전화 · 분실 회수)을 열어 재고, 첫 줄의 글을 누르면 그 접수증. */
async function ticketRows(w, name) {
  const rows = () => w.page.locator('.pos-tickets-line');
  for (let i = 0, n = await rows().count(); i < n; i += 1) {
    const buttons = () => rows().nth(i).locator('.pos-tickets-line-actions button');
    for (let j = 0, m = await buttons().count(); j < m; j += 1) {
      if (!(await buttons().nth(j).isEnabled())) continue;
      await w.probe(buttons().nth(j), name + '-r' + (i + 1) + 'b' + (j + 1));
      await w.closeTo(0);
    }
  }
  if (await rows().count()) {
    const opened = await w.probe(rows().first().locator('button.pos-tickets-open'), name + '-open', {
      back: async () => { await w.page.goBack(); await w.page.waitForSelector('.pos-tickets-rows', { timeout: 10_000 }); await w.settle(); },
    });
    if (opened !== 'route') w.fail(name + '-open', '미반납 · 분실 줄을 눌러도 접수증이 열리지 않음');
  }
}

/**
 * 리프트권(features-1 §8-5 rules walk `ticketsWalk`): 16:10(박준호 지급 뒤) 현황 · 세 탭 · 차량 칸의 예비권 적재 · 입고 창, 1호 차량에 예비권 2매 적재
 * → `야간권 8매`, 미반납 줄의 분실 처리 · 전화 창 · 접수증, 박준호 1매 분실 처리 → 분실 탭 → 분실 회수, 접수증 옆 동작 `분실 처리`, 23:50 최하은 팀 권의
 * 늦은 줄(빨강), 마감 이월 `리프트권 미반납` → 미반납 탭. 폭 전체의 미반납 줄은 875×600에서도 잰다. 끝에 체험 자료를 처음으로 되돌린다.
 */
async function ticketsFlow(w) {
  const page = w.page;
  await resetTo(w, 30);
  await w.visit('#/tickets', '.pos-tickets-table');
  await w.scene('tickets-status');
  if (!/리프트권$/.test(((await page.locator('.sn-title').first().textContent()) ?? '').trim())) w.fail('tickets-status', '리프트권 화면 제목이 `… 리프트권`이 아님');
  if (await page.locator('.sn-footer [data-primary="true"]').count()) w.fail('tickets-status', '리프트권 화면에 주 버튼이 있음(장부형, 주 버튼 없음)');
  await w.tabs('tickets');
  await w.visit('#/tickets', '.pos-tickets-table');
  await ticketVans(w, 'tickets-van');
  // 예비권 적재 2매 → 1호 차량 `야간권 8매`.
  await w.click(page.locator('.pos-tickets-van', { hasText: '1호 차량' }).locator('button.pos-tickets-van-button').first());
  if (await piecesCommit(w, 'tickets-load-commit', { label: '야간권', plus: 2 })) {
    await w.scene('tickets-after-load');
    if (!(await page.locator('.pos-tickets-van', { hasText: '1호 차량' }).getByText(/야간권 8매/).count())) w.fail('tickets-after-load', '예비권 2매 적재 뒤 1호 차량 칸이 `야간권 8매`가 아님');
  }
  // 미반납 탭: 줄의 버튼 · 접수증.
  await w.visit('#/tickets/unreturned', '.pos-tickets-rows');
  await w.scene('tickets-unreturned');
  await ticketRows(w, 'tickets-unreturned');
  // 박준호 3매 중 1매 분실 처리 → 분실 탭 → 분실 회수.
  const park = page.locator('.pos-tickets-line', { hasText: '박준호' });
  if (await park.count()) {
    await w.click(park.locator('.pos-tickets-line-actions button').first());
    // 분실 처리 창은 0매로 연다(2026-09-27 점검): 한 매를 고른다.
    if (await piecesCommit(w, 'tickets-loss-commit', { label: '야간권', plus: 1 })) {
      await w.visit('#/tickets/lost', '.pos-tickets-rows');
      await w.scene('tickets-lost');
      if (!(await page.locator('.pos-tickets-line', { hasText: '박준호' }).count())) w.fail('tickets-lost', '분실 처리한 박준호 팀이 분실 탭에 없음');
      await ticketRows(w, 'tickets-lost');
      await w.click(page.locator('.pos-tickets-line', { hasText: '박준호' }).locator('.pos-tickets-line-actions button').first());
      if (await piecesCommit(w, 'tickets-found-commit')) {
        await w.scene('tickets-lost-empty');
        if (!(await page.locator('.pos-tickets-empty', { hasText: '분실 없음' }).count())) w.fail('tickets-lost-empty', '분실 회수 뒤 분실 탭이 `분실 없음`이 아님');
      }
    }
  } else w.fail('tickets-unreturned', '16:10 미반납 탭에 박준호 팀이 없음');
  // 접수증 옆 동작 `분실 처리`(박준호).
  await w.visit('#/orders/o22', '.sn-slip');
  if (await openSlipAction(w, '분실 처리', 'tickets-slip-loss', '.pos-pieces-sheet')) {
    await w.piecesWalk('tickets-slip-loss');
    await w.closeTo(0);
  }
  // 23:50: 최하은 팀 권(16:58 추가, 23:05 못 받음)은 늦은 줄. 마감 이월 `리프트권 미반납` → 미반납 탭.
  await resetTo(w, 8 * 60 + 10);
  await w.visit('#/tickets/unreturned', '.pos-tickets-rows');
  await w.scene('tickets-unreturned-late');
  if (!(await page.locator('.pos-tickets-line.is-late', { hasText: '최하은' }).count())) w.fail('tickets-unreturned-late', '23:50 최하은 팀 권이 늦은 줄(빨강)이 아님');
  await ticketRows(w, 'tickets-late');
  await w.visit('#/closing/' + w.date, '.pos-closing-table');
  const carry = page.locator('.pos-closing-carry button.pos-closing-carry-press', { hasText: '리프트권 미반납' });
  if (await carry.count()) {
    await w.click(carry.first());
    await page.waitForSelector('.pos-tickets-rows', { timeout: 10_000 }).catch(() => {});
    if ((await w.hash()) !== '#/tickets/unreturned') w.fail('tickets-carry', '마감 이월 `리프트권 미반납`이 리프트권 미반납 탭을 열지 않음: ' + (await w.hash()));
    else await w.scene('tickets-from-closing');
  } else w.fail('tickets-carry', '23:50 마감 이월에 `리프트권 미반납`이 없음');
  await resetTo(w, 0);
}

// ── 확인 필요(features-1 §9) ─────────────────────────────────────────

/**
 * 확인 필요 줄의 버튼(지금 쪽 p): `확인`은 누르면 끝나므로 여기서는 누르지 않고, 다른 버튼(접수증 · 수거 목록 · 리프트권 → 경로, 환불 · 예비권 적재 → 창)은
 * 열어 재고 돌아온다. 경로에서 돌아오면 화면이 첫 쪽으로 새로 열리므로 그 쪽 p로 다시 넘긴다(아니면 다음 줄은 첫 쪽의 줄이다).
 */
async function reviewRows(w, name, p = 1) {
  const rows = () => w.page.locator('.pos-review-line');
  for (let i = 0, n = await rows().count(); i < n; i += 1) {
    const buttons = () => rows().nth(i).locator('.pos-review-actions button');
    for (let j = 0, m = await buttons().count(); j < m; j += 1) {
      const button = buttons().nth(j);
      if (!(await button.isEnabled()) || ((await button.textContent()) ?? '').trim() === '확인') continue;
      await w.probe(button, name + '-r' + (i + 1) + 'b' + (j + 1), {
        back: async () => { await w.page.goBack(); await w.page.waitForSelector('.pos-review-body', { timeout: 10_000 }); await w.settle(); await w.toPage(p); },
      });
      await w.closeTo(0);
    }
  }
}

/**
 * 확인 필요 화면의 쪽: 지금 탭의 쪽을 모두 넘기며 재고 버튼을 열어 본다. 쪽 수와 쪽마다의 줄(읽는 이름): 한 쪽에 드는 줄 수는 잰 높이가
 * 정한다(1024×600 여섯 · 1024×529 넷 · 1024×768 한 쪽에 모두).
 */
async function reviewPages(w, name) {
  const [, total] = await w.pageInfo();
  const pageRows = [];
  for (let p = 1; p <= total; p += 1) {
    await w.toPage(p);
    await w.scene(name + '-p' + p);
    pageRows.push(await w.page.locator('.pos-review-line').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? '')));
    await reviewRows(w, name + '-p' + p, p);
  }
  await w.toPage(1);
  return { total, pageRows };
}

/** 머리줄 `확인 필요`의 수(좁으면 `더 보기`에 합친 수)가 n인지. */
async function reviewBadge(w, name, n) {
  const header = w.page.locator('.sn-header-right');
  const menu = header.locator('button', { hasText: '확인 필요' });
  const holder = (await menu.count()) ? menu : header.locator('button[aria-label^="더 보기"]');
  const shown = ((await holder.locator('.sn-count, .sn-badge').first().textContent().catch(() => '')) ?? '').trim();
  if (shown !== String(n)) w.fail(name, '머리줄 `확인 필요`의 수가 ' + n + '이 아님(' + ((await menu.count()) ? '메뉴' : '더 보기') + ': `' + shown + '`)');
  if (!(await menu.count())) await w.scene(name + '-more');
}

/**
 * 확인 필요(features-1 §9-5 rules walk `reviewWalk`): 15:40 견본 한 건(머리줄 수 1, 좁은 포스는 `더 보기`의 수) → 화면 · 탭 · 줄 버튼(접수증) → 16:10에 기사
 * 기기 연결 끊김 중 김민재 · 이수진 수거와 박준호 현장 수납 · 리프트권 추가 1매(보냄 대기) → 다른 카운터가 김민재 · 이수진 매장 반납 · 박준호 수납 · 1호 차량
 * 예비권 입고 6매 → 다시 연결: 이미 반납된 수거 넷 · 초과 수납 · 예비권 기록 부족(두 쪽) → 쪽마다 버튼(환불 창 · 예비권 창 · 경로) → `확인` 한 번 →
 * 처리 완료 탭 → 환불 확정 · 예비권 적재 확정(그 줄이 사라짐) → 23:50 미입고 줄(수거 목록 · 접수증). 끝에 체험 자료를 처음으로.
 */
async function reviewFlow(w) {
  const page = w.page;
  const task = (id) => '#/driver/tasks/' + encodeURIComponent(id);
  const rows = () => page.locator('.pos-review-line');
  const count = async () => Number(/(\d+)/.exec((await page.locator('.sn-index-tab, [role="tab"]', { hasText: '미처리' }).first().textContent().catch(() => '')) ?? '')?.[1] ?? -1);
  await resetTo(w, 0);
  await w.visit('#/ledger/' + w.date, '.sn-ledger tr.sn-row');
  await reviewBadge(w, 'review-badge', 1);
  await w.visit('#/review', '.pos-review-rows');
  await w.scene('review-open');
  if (((await page.locator('.sn-title').first().textContent()) ?? '').trim() !== '확인 필요') w.fail('review-open', '확인 필요 화면 제목이 `확인 필요`가 아님');
  if (await page.locator('.sn-footer [data-primary="true"]').count()) w.fail('review-open', '확인 필요 화면에 주 버튼이 있음(장부형, 주 버튼 없음)');
  if (!(await rows().filter({ hasText: '최은정 팀 스키 1대 매장 반납 완료' }).count())) w.fail('review-open', '15:40 견본 확인 필요(최은정 팀)가 없음');
  await w.tabs('review');
  await w.visit('#/review', '.pos-review-rows');
  await reviewRows(w, 'review-open');

  // 16:10: 기사 기기 연결 끊김 중 수거 둘 · 현장 수납 · 리프트권 추가(보냄 대기).
  await resetTo(w, 30);
  await w.visit('#/exit?from=driver', '.pos-card', 'driver');
  await w.click(page.getByRole('button', { name: '연결 해제', exact: true }));
  for (const id of ['collect:o21', 'collect:o23']) {
    await w.visit(task(id), '.pos-task-sheet', 'driver');
    await w.click(page.locator('.sn-footer [data-primary="true"]'));
    if (await w.dialogCount()) await w.click(w.top().locator('[data-primary="true"]'));
    await w.closeTo(0);
  }
  await w.visit(task('collect:o22'), '.pos-task-sheet', 'driver');
  const fieldPay = page.locator('.pos-task-actions button', { hasText: '현장 수납' });
  if (await fieldPay.count() && await fieldPay.isEnabled()) {
    await w.click(fieldPay);
    await w.click(page.locator('.pos-field-pay [data-primary="true"]'));
  } else w.fail('review-queue', '16:10 박준호 팀 업무 판에 `현장 수납`이 없음');
  const addTicket = page.locator('.pos-task-actions button', { hasText: '리프트권 추가' });
  if (await addTicket.count() && await addTicket.isEnabled()) {
    await w.click(addTicket);
    await w.click(page.locator('.pos-add-ticket [data-primary="true"]'));
    if (await page.locator('.pos-field-pay').count()) { await page.keyboard.press('Escape'); await w.settle(); }
  } else w.fail('review-queue', '16:10 박준호 팀 업무 판에 `리프트권 추가`가 없음');
  await w.closeTo(0);
  // 다른 카운터: 김민재 · 이수진 매장 반납, 박준호 수납, 1호 차량 예비권 입고 6매.
  for (const id of ['o21', 'o23']) {
    await otherCounter(w, '#/orders/' + id, '.sn-slip', async (other) => {
      await other.locator('.pos-side .sn-check-press', { hasText: '반납' }).first().click();
      const store = other.locator('[role="dialog"]').getByRole('button', { name: '매장 반납 처리', exact: true });
      if (await store.count()) await store.click();
      await other.waitForSelector('.pos-return [data-primary="true"]:enabled');
      await other.waitForTimeout(300);
      await other.locator('.pos-return [data-primary="true"]').click();
      await other.waitForSelector('.pos-return', { state: 'detached', timeout: 10_000 });
    });
  }
  await otherCounter(w, '#/orders/o22', '.sn-slip', async (other) => {
    await other.locator('.pos-side [data-primary="true"]').click();
    await other.waitForSelector('[role="dialog"] [data-primary="true"]');
    await other.waitForTimeout(300);
    await other.locator('[role="dialog"] [data-primary="true"]').last().click();
    await other.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10_000 }).catch(() => {});
  });
  await otherCounter(w, '#/tickets', '.pos-tickets-table', async (other) => {
    await other.locator('.pos-tickets-van', { hasText: '1호 차량' }).locator('button.pos-tickets-van-button', { hasText: '예비권 입고' }).click();
    const sheet = other.locator('.pos-pieces-sheet');
    await sheet.waitFor();
    for (let i = 0; i < 6; i += 1) { await sheet.locator('.sn-piece-line', { hasText: '야간권' }).getByRole('button', { name: '수량 증가' }).click(); await other.waitForTimeout(120); }
    await sheet.locator('[data-primary="true"]').click();
    await other.waitForSelector('.pos-pieces-sheet', { state: 'detached', timeout: 10_000 }).catch(() => {});
  });
  await w.visit('#/exit?from=driver', '.pos-card', 'driver');
  await w.click(page.getByRole('button', { name: /^재연결/ }));
  w.route('counter');

  // 미처리 일곱(견본 · 이미 반납된 수거 넷 · 초과 수납 · 예비권 기록 부족): 1024×600은 한 쪽 여섯 줄 · 1024×529는 넷(두 쪽), 1024×768 · 1366×768은 한 쪽.
  await w.visit('#/review', '.pos-review-rows');
  await w.scene('review-many');
  const many = await count();
  if (many !== 7) w.fail('review-many', '보냄 대기 뒤 미처리 수가 7이 아님: ' + many);
  await reviewBadge(w, 'review-badge-many', many);
  // 쪽을 모두 넘기면 미처리 수만큼의 줄이 한 번씩 나온다. 첫 쪽에 다 들지 않으면 쪽을 넘긴다(쪽 수 = 올림(줄 수 / 첫 쪽 줄 수)).
  const { total: pages, pageRows } = await reviewPages(w, 'review-many');
  const labels = pageRows.flat();
  if (labels.length !== many || new Set(labels).size !== labels.length) w.fail('review-many', '쪽을 모두 넘긴 줄이 미처리 ' + many + '줄과 다름: ' + pageRows.map((r) => r.length).join(' + '));
  const perPage = pageRows[0]?.length ?? 0;
  if (!perPage || pages !== Math.ceil(many / perPage) || pageRows.slice(0, -1).some((r) => r.length !== perPage)) w.fail('review-many', '미처리 ' + many + '줄의 쪽 나눔이 어긋남: ' + pageRows.map((r) => r.length).join(' + ') + ' · ' + pages + '쪽');
  for (const text of ['김민재 팀 스키 2대 매장 반납 완료', '이수진 팀 의류 2벌 매장 반납 완료']) {
    if (!labels.some((label) => label.startsWith(text))) w.fail('review-many', '`' + text + '` 줄이 없음');
  }

  // `확인` 한 번 → 처리 완료 탭(`확인 완료 · …`).
  const first = rows().first();
  const firstText = ((await first.getAttribute('aria-label')) ?? '').trim();
  await w.click(first.locator('.pos-review-actions button', { hasText: /^확인$/ }));
  await w.settle();
  await w.scene('review-resolved');
  if ((await count()) !== many - 1) w.fail('review-resolved', '`확인` 뒤 미처리 수가 줄지 않음');
  await w.visit('#/review/done', '.pos-review-rows');
  await w.scene('review-done');
  const done = page.locator('.pos-review-line.is-done', { hasText: '확인 완료 · ' });
  if (!(await done.count()) || !(await page.locator('.pos-review-line.is-done[aria-label="' + firstText + '"]').count())) w.fail('review-done', '처리 완료 탭에 끝낸 줄(`확인 완료 · 시각`)이 없음');

  // 초과 수납의 환불 확정 · 예비권 적재 확정: 그 줄이 사라진다.
  await w.visit('#/review', '.pos-review-rows');
  const overpaid = () => page.locator('.pos-review-line', { hasText: '박준호 팀 초과 수납' });
  for (let p = 1; p <= 3 && !(await overpaid().count()); p += 1) { const [now, total] = await w.pageInfo(); if (now >= total) break; await w.toPage(now + 1); }
  if (await overpaid().count()) {
    await w.click(overpaid().locator('.pos-review-actions button', { hasText: /^환불/ }));
    const dialog = page.locator('.pos-refund');
    await dialog.waitFor({ timeout: 5000 }).catch(() => {});
    await w.scene('review-refund', 'dialog');
    const primary = dialog.locator('[data-primary="true"]');
    if (!/^환불 · /.test(((await primary.textContent()) ?? '').trim())) w.fail('review-refund', '환불 창의 주 버튼이 `환불 · …`이 아님');
    await w.click(primary);
    await page.waitForSelector('.pos-refund', { state: 'detached', timeout: 10_000 }).catch(() => {});
    await w.settle();
    await w.visit('#/review', '.pos-review-rows');
    if (await page.locator('.pos-review-line[aria-label*="초과 수납"]').count()) w.fail('review-refund', '환불 뒤에도 `초과 수납` 줄이 남음');
  } else w.fail('review-refund', '미처리에 박준호 팀 `초과 수납` 줄이 없음');
  const shortfall = () => page.locator('.pos-review-line', { hasText: '재고 기록 부족' });
  for (let p = 1; p <= 3 && !(await shortfall().count()); p += 1) { const [now, total] = await w.pageInfo(); if (now >= total) break; await w.toPage(now + 1); }
  if (await shortfall().count()) {
    await w.click(shortfall().locator('.pos-review-actions button', { hasText: '예비권 적재' }));
    if (await piecesCommit(w, 'review-spare-commit', { label: '야간권', plus: 1 })) {
      await w.visit('#/review', '.pos-review-rows');
      if (await page.locator('.pos-review-line[aria-label*="재고 기록 부족"]').count()) w.fail('review-spare-commit', '예비권 적재 뒤에도 `재고 기록 부족` 줄이 남음');
    }
  } else w.fail('review-spare', '미처리에 `1호 차량 야간권 재고 기록 부족` 줄이 없음');
  await w.scene('review-after-fix');

  // 23:50: 23:48 입고 뒤 차에 남은 헬멧(미입고) → `수거 목록` · `접수증`.
  await resetTo(w, 8 * 60 + 10);
  await w.visit('#/review', '.pos-review-rows');
  await w.scene('review-night');
  if (!(await page.locator('.pos-review-line', { hasText: '김민수 팀 헬멧 1개 미입고' }).count())) w.fail('review-night', '23:50 미처리에 `김민수 팀 헬멧 1개 미입고`가 없음');
  await reviewPages(w, 'review-night');
  await resetTo(w, 0);
}

/** 인쇄 창(막아 둔 window.print)을 부른 수와 그때 인쇄 문서의 글. */
const printed = (page) => page.evaluate(() => ({ n: window.__skinotePrinted ?? 0, text: window.__skinotePrintText ?? '' }));

/** A4 한 쪽의 인쇄 규칙(E16): 쪽 794 × 1123, 본문 14px 이상 · 쪽 번호와 인쇄 시각 12px 이상, 반쯤 잘린 줄 없음. */
async function printChecks(w, name) {
  const problems = await w.page.evaluate(() => {
    const out = [];
    const sheet = document.querySelector('.pos-print-page');
    if (!sheet) return ['인쇄 쪽이 없음'];
    const box = sheet.getBoundingClientRect();
    if (Math.round(box.width) !== 794 || Math.round(box.height) !== 1123) out.push('쪽 크기 ' + Math.round(box.width) + '×' + Math.round(box.height) + '(A4 794×1123이 아님)');
    const body = sheet.querySelector('.pos-print-body')?.getBoundingClientRect();
    for (const tr of sheet.querySelectorAll('.pos-print-table tbody tr')) {
      const b = tr.getBoundingClientRect();
      if (body && b.bottom > body.bottom + 0.5) out.push('반쯤 잘린 줄: ' + (tr.textContent ?? '').trim().slice(0, 30));
    }
    const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node.textContent ?? '').trim() || !node.parentElement) continue;
      const size = parseFloat(getComputedStyle(node.parentElement).fontSize);
      const min = node.parentElement.closest('.pos-print-foot') ? 12 : 14;
      if (size < min - 0.01) out.push('글자 ' + size + 'px < ' + min + 'px: ' + (node.textContent ?? '').trim().slice(0, 20));
    }
    return out;
  });
  for (const text of [...new Set(problems)].slice(0, 6)) w.fail(name, text);
}

/**
 * A4 인쇄(features-1 §8-5 rules walk `printWalk`): 카운터 수거 목록의 `인쇄`와 접수증 옆 동작 `인쇄`가 인쇄 창을 한 번 열고 인쇄 문서에 가린 번호
 * (`010-****-0025`)만 있는지, 인쇄 문서 화면(#/print/…, 794 × 1123, 인쇄 매체)을 인쇄 등급으로 재는지(쪽마다: 화면 규칙 + printChecks).
 */
async function printWalk(w) {
  const page = w.page;
  await resetTo(w, 0);
  await w.visit('#/collections/' + w.date, '.sn-ledger tr.sn-row');
  const before = (await printed(page)).n;
  await w.click(page.locator('.sn-footer [data-primary="true"]'));
  await page.waitForFunction((n) => (window.__skinotePrinted ?? 0) > n, before, { timeout: 10_000 }).catch(() => {});
  const list = await printed(page);
  if (list.n !== before + 1) w.fail('print-collection', '수거 목록 `인쇄`가 인쇄 창을 한 번 열지 않음(' + (list.n - before) + '번)');
  if (!/김민수/.test(list.text) || !/010-\*{4}-0025/.test(list.text)) w.fail('print-collection', '인쇄 수거 목록에 팀 · 가린 번호가 없음');
  // 손님 번호는 가린 것뿐(머리의 매장 전화 010-0000-0000은 손님 정보가 아니다).
  if (/010-0000-(?!0000)\d{4}/.test(list.text)) w.fail('print-collection', '인쇄 수거 목록에 온전한 번호가 있음');
  await w.settle();
  if (await page.locator('.pos-print-host').count()) w.fail('print-collection', '인쇄 창 뒤에도 인쇄 문서가 남음');
  await w.scene('print-collection-after');
  // 접수증 옆 동작 `인쇄`(김민수 팀).
  await w.visit('#/orders/o25', '.sn-slip');
  const slipBefore = (await printed(page)).n;
  const direct = page.locator('.pos-side-actions button', { hasText: '인쇄' });
  if (await direct.count()) await w.click(direct.first());
  else {
    await w.click(page.locator('.pos-side-actions button', { hasText: '더 보기' }));
    const choice = () => w.top().locator('.pos-choice-button', { hasText: '인쇄' });
    const next = w.top().getByRole('button', { name: '다음 쪽' });
    while (!(await choice().count()) && await next.count() && await next.isEnabled()) await w.click(next);
    if (await choice().count()) await w.click(choice().first());
  }
  await page.waitForFunction((n) => (window.__skinotePrinted ?? 0) > n, slipBefore, { timeout: 10_000 }).catch(() => {});
  const slip = await printed(page);
  if (slip.n !== slipBefore + 1) w.fail('print-slip', '접수증 `인쇄`가 인쇄 창을 한 번 열지 않음');
  if (!/대여 접수증/.test(slip.text) || !/010-\*{4}-0025/.test(slip.text) || /010-0000-(?!0000)\d{4}/.test(slip.text)) w.fail('print-slip', '인쇄 접수증에 제목 · 가린 번호가 없거나 온전한 번호가 있음');
  await w.closeTo(0);
  // 인쇄 문서 화면(A4, 인쇄 매체): 인쇄 등급으로 쪽마다 잰다.
  const sheet = await w.context.newPage();
  const saved = { page: w.page, sizeClass: w.sizeClass, allowed: w.allowed };
  try {
    await sheet.setViewportSize({ width: 794, height: 1123 });
    await sheet.emulateMedia({ media: 'print' });
    w.page = sheet;
    w.sizeClass = 'print';
    w.allowed = ['print'];
    for (const [hash, name] of [['#/print/collections/' + w.date + '?vehicle=v1', 'print-a4-collection'], ['#/print/orders/o25', 'print-a4-slip'], ['#/print/orders/o22', 'print-a4-slip-0022']]) {
      await sheet.goto(w.base() + hash);
      await sheet.waitForSelector('.pos-print-page', { timeout: 10_000 });
      await w.settle();
      const text = (await sheet.locator('.pos-print-foot').first().textContent()) ?? '';
      const total = Number(/\d+\s*\/\s*(\d+)쪽/.exec(text)?.[1] ?? 1);
      for (let p = 1; p <= total; p += 1) {
        if (p > 1) {
          await sheet.goto(w.base() + hash + (hash.includes('?') ? '&' : '?') + 'page=' + p);
          await sheet.waitForSelector('.pos-print-page', { timeout: 10_000 });
          await w.settle();
        }
        await w.scene(name + '-p' + p);
        await printChecks(w, name + '-p' + p);
      }
    }
  } finally {
    w.page = saved.page;
    w.sizeClass = saved.sizeClass;
    w.allowed = saved.allowed;
    await sheet.close();
  }
}

/** 교환 창에서 고르고(품목 · 수량 + · 지급 사이즈) 주 버튼으로 확정한다. 사이즈를 주지 않으면 고르지 않은 첫 사이즈. 창이 닫히면 true. */
async function exchangeCommit(w, name, { item = null, plus = 0, size = null } = {}) {
  const dialog = w.page.locator('.pos-exchange');
  if (item) {
    const button = dialog.getByRole('group', { name: '교환 품목', exact: true }).locator('button.sn-choice', { hasText: item });
    if (!(await button.count())) { w.fail(name, '교환 품목에 `' + item + '`이 없음'); await w.closeTo(0); return false; }
    if ((await button.first().getAttribute('aria-pressed')) !== 'true') await w.click(button.first());
  }
  for (let i = 0; i < plus; i += 1) await w.click(dialog.getByRole('button', { name: '수량 증가' }).first());
  const sizes = dialog.getByRole('group', { name: '지급 사이즈', exact: true });
  const pick = size ? sizes.getByRole('button', { name: size, exact: true }) : sizes.locator('button.sn-choice[aria-pressed="false"]');
  if (!(await pick.count())) { w.fail(name, '지급 사이즈에 `' + (size ?? '다른 사이즈') + '`이 없음'); await w.closeTo(0); return false; }
  await w.click(pick.first());
  await w.scene(name, 'dialog');
  const primary = dialog.locator('[data-primary="true"]');
  if (!(await primary.isEnabled())) { w.fail(name, '즉시 교환 주 버튼이 막힘'); await w.closeTo(0); return false; }
  await w.click(primary);
  await w.page.waitForSelector('.pos-exchange', { state: 'detached', timeout: 10_000 }).catch(() => {});
  await w.settle();
  if (await w.page.locator('.pos-exchange').count()) { w.fail(name, '확정 뒤에도 교환 창이 남음'); await w.closeTo(0); return false; }
  return true;
}

/**
 * 즉시 교환(features-1 §7-6 rules walk `exchangeWalk`): 김민재 의류(손님에게 있음) 창을 모두 걷고 사이즈 110으로 교환 → 접수증 줄 이름 · 출처 줄,
 * 박준호 헬멧(예약, 지급 전: 수량 줄 `지급 예정 사이즈`) 2개 교환 → 출처 줄, 김민재에 부츠 2개를 품목 추가(현금) · 지급한 뒤 부츠의 지급 사이즈 쪽
 * (17 사이즈)을 넘기며 잰다, 막힌 한 줄(이수진 창을 연 채 다른 카운터가 모두 반납 → `교환 불가 · 교환 대상 없음`), 번호 매장의 김민재 접수증에는
 * `즉시 교환`이 없다. 끝에 체험 자료를 처음으로 되돌린다.
 */
async function exchangeFlow(w) {
  const page = w.page;
  await resetTo(w, 0);
  const open = async (orderId, name) => {
    await w.visit('#/orders/' + orderId, '.sn-slip');
    return openSlipAction(w, '즉시 교환', name, '.pos-exchange');
  };
  // ① 김민재 의류: 모두 걸은 뒤 닫고, 새로 열어 110으로.
  if (await open('o21', 'exchange-0021')) {
    await w.exchangeWalk('exchange-0021', { full: true });
    await w.closeTo(0);
  }
  if (await open('o21', 'exchange-0021') && await exchangeCommit(w, 'exchange-0021-commit', { item: '의류', size: '110' })) {
    await slipAdjustment(w, 'exchange-slip-0021', '즉시 교환');
    if (!(await page.locator('.sn-slip', { hasText: '의류 사이즈 110' }).count())) w.fail('exchange-slip-0021', '접수증 품목 표에 지금 사이즈 `의류 사이즈 110`이 없음');
  }
  // ② 박준호 헬멧(지급 전): 수량 줄 `지급 예정 사이즈`, 2개.
  if (await open('o22', 'exchange-0022')) {
    await w.scene('exchange-0022-planned', 'dialog');
    if (!(await page.locator('.pos-exchange').getByText('지급 예정 사이즈', { exact: true }).count())) w.fail('exchange-0022-planned', '지급 전 교환의 수량 줄에 `지급 예정 사이즈`가 없음');
    if (await exchangeCommit(w, 'exchange-0022-commit', { plus: 1 })) await slipAdjustment(w, 'exchange-slip-0022', '즉시 교환');
  }
  // ③ 부츠(17 사이즈): 김민재에 부츠 2개 품목 추가(현금) → 지급 → 교환 창의 부츠 사이즈 쪽.
  await w.visit('#/orders/o21/add', '.pos-new-kinds');
  await w.click(page.locator('.pos-new-kinds .sn-kind', { hasText: '부츠' }));
  const variant = page.locator('.pos-new-pick button.sn-choice').first();
  if (await variant.count()) await w.click(variant);
  const plusBoots = page.locator('.pos-new-pick').getByRole('button', { name: '수량 증가' }).last();
  await w.click(plusBoots);
  await w.click(plusBoots);
  await w.click(page.locator('.pos-new-go'));
  if (await page.locator('.pos-checkout').count()) {
    const cash = w.top().locator('.sn-method-buttons').getByRole('button', { name: '현금', exact: true });
    if (await cash.count()) await w.click(cash.first());
    await w.click(w.top().locator('[data-primary="true"]'));
    await page.waitForSelector('.sn-slip', { timeout: 10_000 }).catch(() => {});
    await w.settle();
    const issue = page.locator('.pos-side [data-primary="true"]');
    if (await issue.count()) {
      await w.click(issue);
      const ok = w.top().locator('[data-primary="true"]');
      if (await ok.count() && await ok.isEnabled()) await w.click(ok);
      await w.closeTo(0);
    }
    if (await open('o21', 'exchange-boots')) {
      const boots = page.locator('.pos-exchange').getByRole('group', { name: '교환 품목', exact: true }).locator('button.sn-choice', { hasText: '부츠' });
      if (await boots.count()) {
        await w.click(boots.first());
        w.exchangeWalked = false;
        await w.exchangeWalk('exchange-boots', { full: true });
        const pager = page.locator('.pos-exchange').getByRole('button', { name: '다음 쪽' });
        if (!(await pager.count())) w.fail('exchange-boots', '부츠 17 사이즈인데 지급 사이즈에 쪽 넘김이 없음');
      } else w.fail('exchange-boots', '교환 품목에 부츠가 없음(품목 추가 · 지급 뒤)');
      await w.closeTo(0);
    }
  } else w.fail('exchange-boots', '부츠 품목 추가의 확정 창이 열리지 않음');
  // ④ 막힌 한 줄: 이수진 창을 연 채 다른 카운터가 모두 매장 반납 → 이 창에서 확정.
  if (await open('o23', 'exchange-0023')) {
    const size = page.locator('.pos-exchange').getByRole('group', { name: '지급 사이즈', exact: true }).locator('button.sn-choice[aria-pressed="false"]');
    await w.click(size.first());
    await otherCounter(w, '#/orders/o23', '.sn-slip', async (other) => {
      await other.locator('.pos-side .sn-check-press', { hasText: '반납' }).first().click();
      const store = other.locator('[role="dialog"]').getByRole('button', { name: '매장 반납 처리', exact: true });
      if (await store.count()) await store.click();
      await other.waitForSelector('.pos-return [data-primary="true"]:enabled');
      await other.waitForTimeout(300);
      await other.locator('.pos-return [data-primary="true"]').click();
      await other.waitForSelector('.pos-return', { state: 'detached', timeout: 10_000 });
    });
    await w.click(page.locator('.pos-exchange [data-primary="true"]'));
    await w.settle();
    await w.scene('exchange-0023-refused', 'dialog');
    if (!(await page.locator('.pos-exchange .is-alert', { hasText: '교환 불가 · 교환 대상 없음' }).count())) w.fail('exchange-0023-refused', '그사이 반납된 교환인데 창에 `교환 불가 · 교환 대상 없음`이 없음');
    await w.closeTo(0);
  }
  // ⑤ 번호 매장(번호 줄): 김민재 접수증의 옆 동작 · 더 보기에 `즉시 교환`이 없다.
  w.shop = 'numbered';
  try {
    await resetTo(w, 0);
    await w.visit('#/orders/o21', '.sn-slip');
    await w.scene('exchange-numbered-slip');
    let found = await page.locator('.pos-side-actions button', { hasText: '즉시 교환' }).count();
    const more = page.locator('.pos-side-actions button', { hasText: '더 보기' });
    if (await more.count()) {
      await w.click(more);
      const next = w.top().getByRole('button', { name: '다음 쪽' });
      for (let guard = 0; guard < 6; guard += 1) {
        found += await w.top().locator('.pos-choice-button', { hasText: '즉시 교환' }).count();
        if (!(await next.count()) || !(await next.isEnabled())) break;
        await w.click(next);
      }
      await w.closeTo(0);
    }
    if (found) w.fail('exchange-numbered-slip', '번호로 세는 줄뿐인 접수증에 `즉시 교환`이 있음');
  } finally {
    w.shop = 'first';
  }
  await resetTo(w, 0);
}

/** 취소 창에서 고르고(구분 · 결정 · 환불 수단 · 품목 수) 주 버튼으로 확정한다. 창이 닫히면 true. */
async function cancelCommit(w, name, { reason = null, decision = null, method = null, plus = [] } = {}) {
  const dialog = w.page.locator('.pos-cancel');
  for (const label of plus) {
    // 품목 칸이 쪽으로 나뉘면(1024×600은 두 개씩) 그 품목이 있는 쪽까지 넘긴다.
    const piece = () => dialog.locator('.sn-piece-line', { hasText: label }).getByRole('button', { name: '수량 증가' });
    const next = dialog.locator('.sn-dialog-foot').getByRole('button', { name: '다음 쪽' });
    for (let guard = 0; guard < 10 && !(await piece().count()) && await next.count() && await next.isEnabled(); guard += 1) await w.click(next);
    if (!(await piece().count())) { w.fail(name, '품목 취소 칸에 `' + label + '`이 없음'); await w.closeTo(0); return false; }
    if (!(await piece().first().isEnabled())) { w.fail(name, '`' + label + '`의 수량 증가가 막힘'); await w.closeTo(0); return false; }
    await w.click(piece().first());
  }
  const press = async (group, label) => {
    const button = dialog.getByRole('group', { name: group, exact: true }).first().getByRole('button', { name: label, exact: true });
    if (!(await button.count())) { w.fail(name, '`' + group + '` 줄에 `' + label + '`이 없음'); return false; }
    await w.click(button.first());
    return true;
  };
  if (reason && !(await press('구분', reason))) { await w.closeTo(0); return false; }
  if (decision && !(await press('환불', decision))) { await w.closeTo(0); return false; }
  if (method) {
    // 환불 줄이 셋 이상이면 환불 줄 자리의 쪽마다 그 수단을 누른다(첫 쪽으로 돌아온다).
    const refundNext = dialog.locator('.pos-discount-refund-pager').getByRole('button', { name: '다음 쪽' });
    for (let p = 0; p < 6; p += 1) {
      const methods = dialog.locator('.pos-discount-refund').getByRole('button', { name: method, exact: true });
      for (let i = 0, n = await methods.count(); i < n; i += 1) if ((await methods.nth(i).getAttribute('aria-pressed')) !== 'true') await w.click(methods.nth(i));
      if (!(await refundNext.count()) || !(await refundNext.isEnabled())) break;
      await w.click(refundNext);
    }
    const refundPrev = dialog.locator('.pos-discount-refund-pager').getByRole('button', { name: '이전 쪽' });
    for (let guard = 0; guard < 6 && await refundPrev.count() && await refundPrev.isEnabled(); guard += 1) await w.click(refundPrev);
  }
  await w.scene(name, 'dialog');
  const primary = dialog.locator('[data-primary="true"]');
  if (!(await primary.isEnabled())) { w.fail(name, '취소 창 주 버튼이 막힘'); await w.closeTo(0); return false; }
  await w.click(primary);
  await w.page.waitForSelector('.pos-cancel', { state: 'detached', timeout: 10_000 }).catch(() => {});
  await w.settle();
  if (await w.page.locator('.pos-cancel').count()) { w.fail(name, '확정 뒤에도 취소 창이 남음'); await w.closeTo(0); return false; }
  return true;
}

/** 오늘 장부의 쪽을 넘기며 그 끝 4자리의 줄을 찾아(보이는 쪽에서) 재고, 그 줄의 시각 칸 글에 word가 있는지 본다. */
async function ledgerRowWord(w, name, last4, word) {
  await w.visit('#/ledger/' + w.date, '.sn-ledger tr.sn-row');
  const [, total] = await w.pageInfo();
  for (let p = 1; p <= total; p += 1) {
    await w.toPage(p);
    const row = w.page.locator('.sn-ledger tr.sn-row', { hasText: last4 });
    if (!(await row.count())) continue;
    await w.scene(name);
    if (!(await row.first().getByText(word, { exact: true }).count())) w.fail(name, last4 + ' 줄에 `' + word + '`이 없음');
    if (!(await row.first().evaluate((el) => el.classList.contains('is-finished')))) w.fail(name, last4 + ' 줄이 흐리지 않음');
    await w.toPage(1);
    return;
  }
  w.fail(name, '장부에 ' + last4 + ' 줄이 없음');
}

/**
 * 품목 추가 · 접수 취소 · 품목 취소(features-1 §5-6 rules walk `orderEditWalk`): 품목 추가 화면 ① 품목(김민재 · 이서연: 결제 팀 줄이 있는 확정 창)을
 * 재고 헬멧을 더해 확정 → 출처 줄 `품목 추가`, 최하은 팀에 두 번 더해(현금 · 카드) 수납 셋 → 접수 취소 창(환불 셋, 두 줄 자리 + 쪽 넘김) · 연락
 * 없음 · 현금 → 출처 줄 · 장부 `취소` 흐린 줄 · 마감 환불 줄, 박준호 팀 리프트권 품목 취소(미수 결제 · 환불 없음 · 환불), 16:40 적재 뒤 최하은 팀 접수
 * 취소 → 차량 재고의 `접수 취소` 줄 · 마감 `확인 필요`. 끝에 체험 자료를 처음으로 되돌린다.
 */
async function orderEditFlow(w) {
  const page = w.page;
  await resetTo(w, 0);
  // 품목 추가 ① 품목과 확정 창(김민재: 결제 팀 없음).
  const addFlow = async (orderId, name, methods) => {
    for (const method of methods) {
      await w.visit('#/orders/' + orderId + '/add', '.pos-new-kinds');
      await w.scene(name + '-add');
      await w.click(page.locator('.pos-new-kinds .sn-kind', { hasText: '헬멧' }));
      const variant = page.locator('.pos-new-pick button.sn-choice').first();
      if (await variant.count()) await w.click(variant);
      await w.click(page.locator('.pos-new-pick').getByRole('button', { name: '수량 증가' }).last());
      await w.scene(name + '-add-picked');
      await w.click(page.locator('.pos-new-go'));
      if (!(await page.locator('.pos-checkout').count())) { w.fail(name + '-add', '품목 추가의 확정 창이 열리지 않음'); return false; }
      await w.checkoutWalk(name + '-add-checkout');
      const methodButton = w.top().locator('.sn-method-buttons').getByRole('button', { name: method, exact: true });
      if (await methodButton.count()) await w.click(methodButton.first());
      await w.scene(name + '-add-' + method, 'dialog');
      const primary = w.top().locator('[data-primary="true"]');
      if (!(await primary.isEnabled())) { w.fail(name + '-add', '품목 추가 확정이 막힘'); await w.closeTo(0); return false; }
      await w.click(primary);
      await page.waitForSelector('.sn-slip', { timeout: 10_000 }).catch(() => {});
      await w.settle();
      if ((await w.hash()) !== '#/orders/' + orderId) { w.fail(name + '-add', '품목 추가 뒤 접수증이 아님: ' + (await w.hash())); return false; }
    }
    return true;
  };
  if (await addFlow('o21', 'edit-0021', ['현금'])) await slipAdjustment(w, 'edit-slip-0021-added', '품목 추가');
  // 이서연(결제 팀 이정호): 확정 창의 결제 팀 줄(`이정호 팀` · `이 팀`)을 잰다(확정하지 않는다).
  await w.visit('#/orders/o36/add', '.pos-new-kinds');
  await w.click(page.locator('.pos-new-kinds .sn-kind', { hasText: '스키' }));
  await w.click(page.locator('.pos-new-pick').getByRole('button', { name: '수량 증가' }).last());
  await w.click(page.locator('.pos-new-go'));
  if (await page.locator('.pos-checkout').count()) {
    await w.click(w.top().locator('.sn-method-buttons').getByRole('button', { name: '후불', exact: true }));
    await w.scene('edit-0036-add-payer', 'dialog');
    if (!(await w.top().getByRole('button', { name: '이 팀', exact: true }).count())) w.fail('edit-0036-add-payer', '결제 팀 줄에 `이 팀`이 없음');
    else { await w.click(w.top().getByRole('button', { name: '이 팀', exact: true })); await w.scene('edit-0036-add-self', 'dialog'); }
    await w.closeTo(0);
  } else w.fail('edit-0036-add-payer', '품목 추가의 확정 창이 열리지 않음');

  // 최하은: 수납 셋(계좌이체 선입금 + 현금 + 카드) → 접수 취소(환불 셋: 두 줄 자리 + 쪽 넘김, 연락 없음, 현금) → 출처 줄 · 장부 · 마감.
  if (await addFlow('o26', 'edit-0026', ['현금', '카드'])) {
    await w.visit('#/orders/o26', '.sn-slip');
    // 창을 한 번 다 걸어 잰 뒤(구분 · 결정을 모두 누름) 닫고, 새로 열어 처음 결정(환불)의 줄을 보고 확정한다.
    if (await openSlipAction(w, '접수 취소', 'edit-0026-cancel', '.pos-cancel')) {
      await w.cancelWalk('edit-0026-cancel', { full: true });
      await w.closeTo(0);
    }
    if (await openSlipAction(w, '접수 취소', 'edit-0026-cancel', '.pos-cancel')) {
      // 환불 셋(계좌이체 · 현금 · 카드)은 모두 금액 · 수단을 가진 줄이다: 두 줄 자리를 쪽으로 넘기며 모은다(2026-09-27 점검, 숨긴 `외 1건`이 없다).
      const texts = await w.refundPages(page.locator('.pos-cancel'), (suffix) => w.scene('edit-0026-cancel' + suffix, 'dialog'), '');
      const refundLines = texts.filter((x) => /^환불 · \S+ [\d,]+원/.test(x));
      if (refundLines.length < 3) w.fail('edit-0026-cancel', '수납 셋의 환불 줄이 셋이 아님(쪽마다 금액 · 수단): ' + texts.join(' | '));
      if (texts.some((x) => x.includes('외 '))) w.fail('edit-0026-cancel', '환불 줄에 금액 없는 `외 {n}건`이 남음');
      if (await cancelCommit(w, 'edit-0026-cancel-commit', { reason: '연락 없음', decision: '환불', method: '현금' })) {
        await slipAdjustment(w, 'edit-slip-0026-cancelled', '접수 취소');
        await slipAdjustment(w, 'edit-slip-0026-refund', '환불 · 현금');
        await cancelledSlip(w, 'edit-slip-0026-state');
        await ledgerRowWord(w, 'edit-ledger-0026', '0026', '취소');
        await w.visit('#/closing/' + w.date, '.pos-closing-table');
        await w.scene('edit-closing');
        if (!(await page.locator('.pos-closing-table', { hasText: '환불' }).count())) w.fail('edit-closing', '마감 결제 수단 표에 환불 줄이 없음');
      }
    }
  }
  // 박준호 리프트권 품목 취소: 미수 결제 · 환불 없음 · 환불을 모두 재고 미수 결제로 확정 → 출처 줄.
  await w.visit('#/orders/o22', '.sn-slip');
  if (await openSlipAction(w, '품목 취소', 'edit-0022-remove', '.pos-cancel')) {
    await w.cancelWalk('edit-0022-remove', { full: true });
    await w.closeTo(0);
  }
  if (await openSlipAction(w, '품목 취소', 'edit-0022-remove', '.pos-cancel')) {
    if (await cancelCommit(w, 'edit-0022-remove-commit', { plus: ['야간권', '야간권', '야간권'], decision: '미수 결제' })) {
      await slipAdjustment(w, 'edit-slip-0022-removed', '품목 취소');
      await slipAdjustment(w, 'edit-slip-0022-due', '미수 결제');
    }
  }
  // 16:40 적재 뒤(이야기) 최하은 팀 접수 취소 → 차량 재고의 `접수 취소` 줄 · 마감 `확인 필요`(미입고).
  await resetTo(w, 60);
  await w.visit('#/orders/o26', '.sn-slip');
  if (await openSlipAction(w, '접수 취소', 'edit-0026-loaded', '.pos-cancel') && await cancelCommit(w, 'edit-0026-loaded-commit', { decision: '환불 없음' })) {
    await w.visit('#/closing/' + w.date, '.pos-closing-table');
    await w.scene('edit-closing-leftover');
    if (!(await page.getByText(/확인 필요/).count())) w.fail('edit-closing-leftover', '마감 이월 항목에 차에 남은 것의 `확인 필요`가 없음');
    // 기사 기기의 수거 목록: 주 버튼 `매장 입고`의 창에 `최하은 팀 … · 접수 취소` 줄, 입고하면 차에 남은 것이 없다.
    await w.visit('#/driver/' + w.date, '.sn-ledger', 'driver');
    const receive = page.locator('.sn-footer [data-primary="true"]');
    if (await receive.count() && await receive.isEnabled()) {
      await w.click(receive);
      await w.scene('edit-van-leftover', 'dialog');
      if (!(await w.top().getByText(/접수 취소/).count())) w.fail('edit-van-leftover', '매장 입고 창에 `접수 취소` 줄이 없음');
      const ok = w.top().locator('[data-primary="true"]');
      if (await ok.count() && await ok.isEnabled()) await w.click(ok);
      await w.closeTo(0);
      await w.scene('edit-van-received');
    } else w.fail('edit-van-leftover', '기사 수거 목록의 매장 입고를 누를 수 없음');
    w.route('counter');
  }
  await resetTo(w, 0);
}

/** 접수증 옆 동작을 연다(바로 보이거나 `더 보기` 판 안: 쪽을 넘겨 찾는다). opens(창의 선택자, 기본 할인 적용 창)가 열리면 true. */
async function openSlipAction(w, label, name, opens = '.pos-discount') {
  const direct = w.page.locator('.pos-side-actions button', { hasText: label });
  if (await direct.count()) await w.click(direct.first());
  else {
    const more = w.page.locator('.pos-side-actions button', { hasText: '더 보기' });
    if (!(await more.count())) { w.fail(name, '접수증 옆 동작에 `' + label + '`이 없음'); return false; }
    await w.click(more);
    const choice = () => w.top().locator('.pos-choice-button', { hasText: label });
    const next = w.top().getByRole('button', { name: '다음 쪽' });
    while (!(await choice().count()) && await next.count() && await next.isEnabled()) await w.click(next);
    if (!(await choice().count())) { w.fail(name, '더 보기에 `' + label + '`이 없음'); await w.closeTo(0); return false; }
    await w.click(choice().first());
  }
  // 따로 받는 창(분실 처리)은 묶음을 받은 뒤 뜬다: 잠깐 기다린다.
  await w.page.waitForSelector(opens, { timeout: 5000 }).catch(() => {});
  if (!(await w.page.locator(opens).count())) { w.fail(name, '`' + label + '` 창이 열리지 않음'); await w.closeTo(0); return false; }
  return true;
}

/** 할인 적용 창에서 고르고(할인 · 환불 수단) 주 버튼으로 확정한다. 창이 닫히면 true. */
async function discountCommit(w, name, choice, refundMethod = null, section = '장비') {
  const dialog = w.page.locator('.pos-discount');
  // 칸(창을 모두 걸은 뒤에는 마지막 칸이 골라져 있다).
  const tab = dialog.getByRole('group', { name: '대상', exact: true }).getByRole('button', { name: section, exact: true });
  if (await tab.count() && (await tab.getAttribute('aria-pressed')) !== 'true') await w.click(tab);
  const button = dialog.getByRole('group', { name: '할인', exact: true }).locator('button.sn-choice', { hasText: choice });
  if (!(await button.count())) { w.fail(name, '할인 고르기에 `' + choice + '`이 없음'); await w.closeTo(0); return false; }
  await w.click(button.first());
  if (refundMethod) {
    const method = dialog.getByRole('group', { name: '환불', exact: true }).getByRole('button', { name: refundMethod, exact: true });
    if (!(await method.count())) { w.fail(name, '환불 줄에 `' + refundMethod + '` 버튼이 없음'); await w.closeTo(0); return false; }
    await w.click(method.first());
  }
  await w.scene(name, 'dialog');
  const primary = dialog.locator('[data-primary="true"]');
  if (!(await primary.isEnabled())) { w.fail(name, '할인 적용 주 버튼이 막힘'); await w.closeTo(0); return false; }
  await w.click(primary);
  await w.page.waitForSelector('.pos-discount', { state: 'detached', timeout: 10_000 }).catch(() => {});
  await w.settle();
  if (await w.page.locator('.pos-discount').count()) { w.fail(name, '확정 뒤에도 할인 적용 창이 남음'); await w.closeTo(0); return false; }
  return true;
}

/** 접수증 품목 표(쪽을 넘기며)에 그 글의 출처 줄이 있는지. 찾으면 그 쪽을 재고 첫 쪽으로. */
/**
 * 모두 취소한 접수증(2026-09-27 점검): 머리의 `취소`, 옆 동작 · 더 보기에 `일정 변경` · `긴급 요청`이 없다(진행 중 접수만).
 */
async function cancelledSlip(w, name) {
  const page = w.page;
  if (!(await page.locator('.sn-slip-status', { hasText: '취소' }).count())) w.fail(name, '모두 취소한 접수증 머리에 `취소`가 없음');
  await w.scene(name);
  const banned = ['일정 변경', '긴급 요청'];
  for (const label of banned) {
    if (await page.locator('.pos-side-actions button', { hasText: label }).count()) w.fail(name, '모두 취소한 접수증 옆 동작에 `' + label + '`이 있음');
  }
  const more = page.locator('.pos-side-actions button', { hasText: '더 보기' });
  if (await more.count()) {
    await w.click(more);
    const next = w.top().getByRole('button', { name: '다음 쪽' });
    for (let guard = 0; guard < 6; guard += 1) {
      for (const label of banned) {
        if (await w.top().locator('.pos-choice-button', { hasText: label }).count()) w.fail(name, '모두 취소한 접수증 더 보기에 `' + label + '`이 있음');
      }
      if (!(await next.count()) || !(await next.isEnabled())) break;
      await w.click(next);
    }
    await w.closeTo(0);
  }
}

async function slipAdjustment(w, name, text) {
  const footer = w.page.locator('.sn-footer');
  const [, total] = await w.pageInfo(footer);
  let found = false;
  for (let p = 1; p <= Math.max(1, total) && !found; p += 1) {
    await w.toPage(p, footer);
    if (await w.page.locator('.sn-slip-adjust', { hasText: text }).count()) { found = true; await w.scene(name); }
  }
  await w.toPage(1, footer);
  if (!found) w.fail(name, '접수증에 출처 줄 `' + text + '`이 없음');
}

/**
 * 할인 적용(features-1 §6-5 · §6-6 rules walk): 박준호 팀(장비 미수)의 창을 모두 걷고 10% 적용 → 출처 줄 `장비 10% 할인`, 해제 → `장비 할인
 * 해제`, 김민재 팀(카드 결제 뒤) 10% → 환불 줄을 현금으로 → 출처 줄 `환불 · 현금 …` · 마감 결제 수단의 환불 줄, 카운터(?viewer=counter)의 한도 밖
 * 숫자판. 끝에 체험 자료를 처음으로 되돌린다.
 */
async function discountFlow(w) {
  const page = w.page;
  await resetTo(w, 0);
  const open = async (orderId, name) => {
    await w.visit('#/orders/' + orderId, '.sn-slip');
    return openSlipAction(w, '할인 적용', name);
  };
  if (await open('o22', 'discount-0022')) {
    await w.discountWalk('discount-0022', { full: true });
    if (await discountCommit(w, 'discount-0022-apply', '10% 할인')) await slipAdjustment(w, 'discount-slip-0022-applied', '장비 10% 할인');
  }
  if (await open('o22', 'discount-0022-off') && await discountCommit(w, 'discount-0022-off', '할인 없음')) {
    await slipAdjustment(w, 'discount-slip-0022-off', '장비 할인 해제');
  }
  if (await open('o21', 'discount-0021') && await discountCommit(w, 'discount-0021-refund', '10% 할인', '현금')) {
    await slipAdjustment(w, 'discount-slip-0021-refund', '환불 · 현금');
    await w.visit('#/closing/' + w.date, '.pos-closing-table');
    await w.scene('discount-closing');
    if (!(await page.locator('.pos-closing-table', { hasText: '환불' }).count())) w.fail('discount-closing', '마감 결제 수단 표에 환불 줄이 없음');
  }
  // 카운터(?viewer=counter, 직접 입력 한도 10,000원): 한도 밖 값의 숫자판.
  w.route('counter');
  await page.goto(BASE + '?viewer=counter#/orders/o22');
  await page.waitForSelector('.sn-slip', { timeout: 10_000 });
  await w.settle();
  if (await openSlipAction(w, '할인 적용', 'discount-viewer')) {
    const manual = page.locator('.pos-discount').getByRole('group', { name: '할인', exact: true }).locator('button.sn-choice', { hasText: '직접 입력' });
    if (await manual.count() && await manual.first().isEnabled()) {
      await w.click(manual);
      await w.manualWalk('discount-viewer-manual', { over: ['2', '0', '000'] });
    } else w.fail('discount-viewer', '카운터의 할인 적용 창에 누를 수 있는 `직접 입력`이 없음');
    await w.closeTo(0);
  }
  await resetTo(w, 0);
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
    await other.goto(w.base() + hash);
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
 *   ②③은 이어진 보증금 명령이 있는 견본 매장(?shop=numbered)에서 걷는다: 첫 매장(체험판 기본)은 권 보증금이 없다(2026-09-26). 같은 매장에서
 *   보증금 줄(④ ⑤)과 번호 버튼이 있는 반납 창(V1)도 21:10 박준호 팀 접수증으로 걷는다.
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
  w.shop = 'numbered';
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
  // 보증금 줄 · 번호 버튼이 있는 반납 창(V1): 21:10 박준호 팀(16:05 지급 · 보증금 15,000원, 19:41 일정 나뉨) 접수증의 도장 · 처리 현황 · 옆 동작.
  await resetTo(w, 330);
  await w.visit('#/orders/o22', '.sn-slip');
  await slipWalk(w, 'numbered-slip-0022');
  if (!w.returnWalked.deposit) w.fail('numbered-slip-0022', '번호 · 보증금 매장의 박준호 팀에서 보증금 줄이 있는 반납 창을 걷지 못함');
  w.shop = 'first';

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
 * 색인 탭마다(더 보기 탭의 판 포함, 준비 중인 화면), 카드의 고르기를 차례로 누르며(반납 선택 · 사용 · 지급 시 · 분실금 청구 · 미사용 → 사용 · 예약금 ·
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
  // 고르기를 차례로(카드 · 줄이 생기고 사라지며 쪽이 는다). 첫 매장(2026-09-26)은 보증금 미사용으로 저장되어 있어 먼저 `사용`을 눌러 보증금 줄
  // (입금 시점 · 미반납 시 · 값 버튼)을 연다.
  const steps = [
    ['리프트권 반납', '반납 선택 · 반납 시 기록'], ['리프트권 보증금', '사용'], ['리프트권 보증금', '지급 시'], ['리프트권 보증금', /^분실금 청구/],
    ['리프트권 보증금', '미사용'], ['리프트권 보증금', '사용'], ['리프트권 결제 · 전화 예약', '예약금'], ['당일 취소 환불', '환불 없음'], ['영업일 기준 시각', '00:00'],
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

// ── 매장 설정의 다른 탭(features-1 plan §4-4 · §4-6: settingsWalk) ───────────────────────────────

/** 정규식 글자 막기. */
const reEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 목록 칸(이름이 label인 칸, 바닥줄 쪽을 넘겨 찾는다). 없으면 null. */
async function settingsCell(w, label) {
  const target = typeof label === 'function' ? () => label(w.page)
    : () => w.page.locator('.sn-rule-item').filter({ has: w.page.locator('.sn-rule-item-label', { hasText: new RegExp('^' + reEscape(label) + '$') }) });
  await w.toPage(1);
  for (let guard = 0; guard < 8; guard += 1) {
    if (await target().count()) return target().first();
    const next = w.page.locator('.sn-footer').getByRole('button', { name: '다음 쪽' });
    if (!(await next.count()) || !(await next.isEnabled())) break;
    await w.click(next);
  }
  return null;
}

/** 목록 칸을 누른다(없으면 실패로 적고 false). */
async function pressCell(w, name, label) {
  const cell = await settingsCell(w, label);
  if (!cell) { w.fail(name, '매장 설정 목록에 칸이 없음: ' + label); return false; }
  await w.click(cell);
  return true;
}

/** 맨 위 고르기 판의 버튼(첫 줄 글이 label). */
const sheetChoice = (w, label) => w.top().locator('.pos-choice-button').filter({ has: w.page.locator('.pos-choice-text > .sn-fit:first-child', { hasText: new RegExp('^' + reEscape(label) + '$') }) });

/** 고르기 판에서 누른다(없거나 막혔으면 실패로 적고 false). */
async function pressChoice(w, name, label) {
  const choice = sheetChoice(w, label);
  if (!(await choice.count())) { w.fail(name, '항목 판에 버튼이 없음: ' + label); return false; }
  if (!(await choice.first().isEnabled())) { w.fail(name, '항목 판의 버튼이 막힘: ' + label); return false; }
  await w.click(choice);
  return true;
}

/** 숫자판에 친다(숫자 · 000). */
async function padKeys(w, digits) {
  for (const d of digits) await w.click(w.top().getByRole('button', { name: d, exact: true }));
}

/** 숫자판의 입력(막혔으면 실패로 적는다). */
async function padEnter(w, name) {
  const enter = w.top().getByRole('button', { name: '입력', exact: true });
  if (!(await enter.isEnabled())) { w.fail(name, '받는 값인데 숫자판의 입력이 막힘'); return; }
  await w.click(enter);
}

/** 바닥줄 굵은 요약. */
const footerSummary = async (w) => ((await w.page.locator('.pos-footer-back .sn-fit').first().textContent().catch(() => '')) ?? '').trim();

/** 초안을 버리고 그 탭을 새로 연다(초안은 화면에만 있다: 새로 읽으면 없다). */
async function settingsFresh(w, tab) {
  await w.visit('#/manage/settings/' + tab, '.sn-rule-card');
  await w.page.reload();
  await w.page.waitForSelector('.sn-rule-card', { timeout: 10_000 });
  await w.settle();
}

/** 항목 판 · 더하기 판에서 다른 창을 여는 버튼(초안에 바로 넣는 버튼 — 숨김 · 위로 · 사용 종료 …은 따로 걷는다). */
const OPENS = /^(이름 변경|시각 변경|역할|차량|할인 비율 · |할인 금액 · |비율|금액|관리자|카운터|기사|비밀번호 재발급|수거 목록 ›)/;

/**
 * 한 탭의 모든 목록 칸: 칸을 눌러 열린 창(항목 판 · 숫자판 · 화면 키보드)을 재고, 항목 판이면 다른 창을 여는 버튼마다 그 창(화면 키보드는 제목마다 첫
 * 판을 모두 걷는다)을 잰 뒤 닫는다. 초안을 바꾸지 않는다.
 */
async function settingsCellsWalk(w, name) {
  const page = w.page;
  const [, total] = await w.pageInfo();
  for (let p = 1; p <= total; p += 1) {
    await w.toPage(p);
    const count = await page.locator('.sn-rule-item').count();
    for (let i = 0; i < count; i += 1) {
      const cellName = name + '-p' + p + 'c' + (i + 1);
      await w.toPage(p);
      await w.click(page.locator('.sn-rule-item').nth(i));
      if (!(await w.dialogCount())) { w.fail(cellName, '목록 칸을 눌렀는데 창이 열리지 않음'); continue; }
      if (await page.locator('.sn-kb-overlay').count()) { await w.keyboardWalk(cellName); await w.closeTo(0); continue; }
      await w.scene(cellName, 'dialog');
      const choices = w.top().locator('.pos-choice-button');
      const labels = [];
      for (let j = 0, m = await choices.count(); j < m; j += 1) {
        const text = ((await choices.nth(j).locator('.pos-choice-text > .sn-fit').first().textContent()) ?? '').trim();
        if (OPENS.test(text) && await choices.nth(j).isEnabled()) labels.push(text);
      }
      await w.closeTo(0);
      for (const [j, label] of labels.entries()) {
        await w.toPage(p);
        await w.click(page.locator('.sn-rule-item').nth(i));
        const before = await w.hash();
        await w.click(sheetChoice(w, label));
        const opened = cellName + '-o' + (j + 1);
        if ((await w.hash()) !== before) {
          await w.scene(opened);
          await w.page.goBack();
          await page.waitForSelector('.sn-rule-card', { timeout: 10_000 });
          await w.settle();
          continue;
        }
        if (await page.locator('.sn-kb-overlay').count()) await w.keyboardWalk(opened);
        else if (await w.dialogCount()) await w.scene(opened, 'dialog');
        await w.closeTo(0);
      }
    }
  }
  await w.toPage(1);
}

/**
 * 매장 설정의 색인 탭(2026-09-27 점검): 어느 탭에서든 모든 탭에 닿는다(보이거나 `더 보기` 판에), 넘친 탭이 있으면 `더 보기`가 늘 있고, 보이는 탭은 설정의
 * 차례 그대로다(켜진 탭이 더 보기 자리에 이름으로 들어가지 않는다).
 */
async function settingsTabsReachable(w) {
  const all = ['매장 정보', '장소', '반납 타임', '요금 · 할인', '차량 · 직원', '운영 규칙'];
  for (const route of ['info', 'places', 'slots', 'pricing', 'fleet', 'rules']) {
    await w.visit('#/manage/settings/' + route, '.sn-rule-card');
    const name = 'set-tabs-' + route;
    const shown = (await w.page.locator('.sn-tabs [role="tab"]:not(.is-more)').allTextContents()).map((x) => x.trim());
    const more = w.page.locator('.sn-tabs .sn-tab.is-more');
    let listed = [];
    if (await more.count()) {
      if (((await more.textContent()) ?? '').trim() !== '더 보기') w.fail(name, '넘친 탭이 있는데 `더 보기`가 아님: ' + (await more.textContent()));
      await w.click(more);
      await w.scene(name + '-more', 'dialog');
      listed = (await w.top().locator('.pos-choice-button').allTextContents()).map((x) => x.trim());
      await w.closeTo(0);
    }
    const missing = all.filter((label) => !shown.includes(label) && !listed.some((x) => x.startsWith(label)));
    if (missing.length) w.fail(name, '이 탭에서 닿지 않는 탭: ' + missing.join(' · '));
    const order = shown.map((x) => all.indexOf(x)).filter((i) => i >= 0);
    if (order.some((v, i) => i > 0 && v < order[i - 1])) w.fail(name, '탭 차례가 바뀜: ' + shown.join(' · '));
  }
}

/**
 * 매장 설정의 다른 탭(features-1 plan §4-4 · §4-6): 탭마다 쪽마다 재고, 모든 목록 칸의 항목 판과 그 판이 여는 창(화면 키보드 · 숫자판 · 고르기 판)을
 * 잰다(settingsCellsWalk). 그 뒤 상태를 만들어 잰다 — 매장 정보(이름 키보드 → `변경됨` · 전화 숫자판 · `운영 규칙 ›`), 장소(겹치는 이름 →
 * `이름 중복 · 다른 이름 필요` · 숨김 · 위로 · 저장 확인 창 · 떠날 때 창), 반납 타임(더하기: 이름 → 시각, 24:00은 막힘 · 기본은 숨김 막힘 · 야간 수거
 * 준비 181분 막힘 · 차량 지연 기준), 요금 · 할인(1일 값 · 할인 비율 · 할인 추가: 비율 → 대상 → 비율 → 이름), 차량 · 직원(1호 차량의 사용 종료 막힘 ·
 * `수거 목록 ›` · 차량 추가 · 직원 차량 배정 · 직원 추가(기사: 이름 → 차량) · 비밀번호 재발급은 체험판 미지원 · 저장(목록 바꿈 + 직원 바꿈) → 새 차량
 * 사용 종료 → 다시 사용), 카운터가 보는 화면(?viewer=counter: `권한 없음 · 관리자 확인 필요` · 저장 막힘), 미리 보기(#/preview/pin 새 비밀번호 창 ·
 * #/preview/settings-many 권종 · 장소가 많은 탭의 `(계속)`). 끝에 체험 자료를 처음으로 되돌린다.
 */
async function settingsWalk(w) {
  const page = w.page;
  const footer = page.locator('.sn-footer');
  const primary = () => footer.locator('[data-primary="true"]');
  for (const tab of ['info', 'places', 'slots', 'pricing', 'fleet']) {
    await settingsFresh(w, tab);
    if ((await footerSummary(w)) !== '변경 없음') w.fail('set-' + tab, '처음 바닥줄이 `변경 없음`이 아님: ' + (await footerSummary(w)));
    if (await primary().isEnabled()) w.fail('set-' + tab, '변경 없음인데 저장을 누를 수 있음');
    await w.pages('set-' + tab);
    await settingsCellsWalk(w, 'set-' + tab);
  }
  await settingsTabsReachable(w);

  // 매장 정보: 이름(키보드) → 변경됨 · 저장 확인 창, 전화(숫자판), 영업일 기준 시각의 `운영 규칙 ›`.
  await settingsFresh(w, 'info');
  await w.click(page.locator('.sn-rule-card[aria-label="매장 이름"] .sn-rule-value'));
  if (await w.keyboardWalk('set-info-name', { submit: ['ㄱ', 'ㅏ'] })) {
    await w.scene('set-info-changed');
    if (!/^변경 1건 · 다음 기록부터 적용$/.test(await footerSummary(w))) w.fail('set-info-changed', '이름을 바꾼 뒤 바닥줄이 `변경 1건 · …`이 아님: ' + (await footerSummary(w)));
    await w.click(primary());
    await w.scene('set-info-save', 'dialog');
    await w.closeTo(0);
  }
  await w.click(page.locator('.sn-rule-card[aria-label="전화"] .sn-rule-value'));
  await w.scene('set-info-phone', 'dialog');
  await padKeys(w, ['0', '1', '0']);
  if (await w.top().getByRole('button', { name: '입력', exact: true }).isEnabled()) w.fail('set-info-phone', '세 자리 전화인데 입력을 누를 수 있음');
  await w.closeTo(0);
  await w.click(page.locator('.sn-rule-card[aria-label="영업일 기준 시각"] .sn-rule-value'));
  const unsavedFromInfo = await w.dialogCount();
  if (unsavedFromInfo) { await w.scene('set-info-leave', 'dialog'); await w.click(w.top().getByRole('button', { name: '저장 안 함', exact: true })); }
  if (!/#\/manage\/settings\/rules$/.test(await w.hash())) w.fail('set-info-link', '`운영 규칙 ›`이 운영 규칙 탭으로 가지 않음: ' + (await w.hash()));

  // 장소: 겹치는 구역 이름(거절 한 줄) · 장소 숨김 · 위로 · 저장 확인 창 · 떠날 때 창.
  await settingsFresh(w, 'places');
  const areaAdd = await settingsCell(w, (pg) => pg.locator('.sn-rule-card[aria-label="구역"]').getByRole('button', { name: '구역 추가', exact: true }));
  if (!areaAdd) w.fail('set-places-area', '장소 탭에 `구역 추가`가 없음');
  else await w.click(areaAdd);
  if (areaAdd && await w.keyboardWalk('set-places-area', { submit: ['ㅅ', 'ㅓ', 'ㄹ', 'ㅊ', 'ㅓ', 'ㄴ'], then: true })) {
    await w.settle();
    if (!(await w.dialogCount()) || !(await w.top().getByText('이름 중복 · 다른 이름 필요').count())) w.fail('set-places-dup', '겹치는 구역 이름에 `이름 중복 · 다른 이름 필요` 창이 없음');
    else await w.scene('set-places-dup', 'dialog');
    await w.closeTo(0);
  }
  if (await pressCell(w, 'set-places-hide', '설천 주차장') && await pressChoice(w, 'set-places-hide', '숨김')) await w.scene('set-places-hidden');
  if (await pressCell(w, 'set-places-up', '설천 하우스 앞') && await pressChoice(w, 'set-places-up', '위로')) await w.scene('set-places-moved');
  await w.pages('set-places-draft');
  if (await primary().isEnabled()) {
    await w.click(primary());
    await w.scene('set-places-save', 'dialog');
    await w.closeTo(0);
  } else w.fail('set-places-save', '바꾼 뒤 저장을 누를 수 없음');
  await w.click(footer.getByRole('button', { name: '관리' }));
  if (await w.dialogCount()) { await w.scene('set-places-leave', 'dialog'); await w.closeTo(0); }
  else w.fail('set-places-leave', '저장하지 않은 바꿈이 있는데 떠날 때 창이 없음');

  // 반납 타임: 더하기(이름 → 시각), 24:00 막힘, 기본의 숨김 막힘, 야간 수거 준비 · 차량 지연 기준 숫자판.
  await settingsFresh(w, 'slots');
  if (await pressCell(w, 'set-slots-add', '반납 타임 추가') && await w.keyboardWalk('set-slots-add-name', { submit: ['ㅂ', 'ㅏ', 'ㅁ'], then: true })) {
    await w.scene('set-slots-add-time', 'dialog');
    await padKeys(w, ['2', '4', '0', '0']);
    if (await w.top().getByRole('button', { name: '입력', exact: true }).isEnabled()) w.fail('set-slots-add-time', '24:00인데 입력을 누를 수 있음');
    for (let k = 0; k < 4; k += 1) await w.click(w.top().getByRole('button', { name: '정정', exact: true }));
    await padKeys(w, ['2', '0', '3', '0']);
    await padEnter(w, 'set-slots-add-time');
    await w.scene('set-slots-added');
    if (!(await settingsCell(w, '밤 20:30'))) w.fail('set-slots-added', '더한 반납 타임 칸이 없음');
  }
  if (await pressCell(w, 'set-slots-default', '오후 16:30')) {
    await w.scene('set-slots-default-sheet', 'dialog');
    if (await sheetChoice(w, '숨김').isEnabled()) w.fail('set-slots-default-sheet', '기본 반납 타임인데 숨김을 누를 수 있음');
    // 막힌 까닭은 판 위의 온전한 한 줄(2026-09-27 점검).
    if (!(await w.top().getByText('숨김 불가 · 기본 반납 타임').count())) w.fail('set-slots-default-sheet', '숨김이 막힌 판에 `숨김 불가 · 기본 반납 타임` 한 줄이 없음');
    await w.closeTo(0);
  }
  const notice = await settingsCell(w, (pg) => pg.locator('.sn-rule-card[aria-label="야간 수거 준비"] .sn-rule-value'));
  if (notice) await w.click(notice);
  else w.fail('set-slots-notice', '반납 타임 탭에 `야간 수거 준비` 값 버튼이 없음');
  await w.scene('set-slots-notice', 'dialog');
  await padKeys(w, ['1', '8', '1']);
  if (await w.top().getByRole('button', { name: '입력', exact: true }).isEnabled()) w.fail('set-slots-notice', '181분인데 입력을 누를 수 있음');
  for (let k = 0; k < 3; k += 1) await w.click(w.top().getByRole('button', { name: '정정', exact: true }));
  await padKeys(w, ['3', '0']);
  await padEnter(w, 'set-slots-notice');
  // 좁은 화면(한 칸)에서는 둘째 쪽이다: 쪽을 넘겨 찾는다.
  const late = await settingsCell(w, (pg) => pg.locator('.sn-rule-card[aria-label="차량 지연 기준"] .sn-rule-value').nth(1));
  if (late) await w.click(late);
  else w.fail('set-slots-late', '반납 타임 탭에 `차량 지연 기준` 야간 값 버튼이 없음');
  await w.scene('set-slots-late', 'dialog');
  await padKeys(w, ['1', '2', '0']);
  await padEnter(w, 'set-slots-late');
  await w.pages('set-slots-draft');

  // 요금 · 할인: 1일 값 · 할인 추가(비율 → 대상 → 비율 → 이름).
  await settingsFresh(w, 'pricing');
  if (await pressCell(w, 'set-price', '스키')) {
    await w.scene('set-price-pad', 'dialog');
    await padKeys(w, ['4', '5', '000']);
    await padEnter(w, 'set-price-pad');
    await w.scene('set-price-changed');
  }
  if (await pressCell(w, 'set-discount-add', '할인 추가') && await pressChoice(w, 'set-discount-add', '비율')) {
    await w.scene('set-discount-target', 'dialog');
    if (await pressChoice(w, 'set-discount-target', '장비')) {
      await w.scene('set-discount-value', 'dialog');
      await padKeys(w, ['1', '5']);
      await padEnter(w, 'set-discount-value');
      if (await w.keyboardWalk('set-discount-name', { submit: ['ㄷ', 'ㅏ', 'ㄴ', 'ㄱ', 'ㅗ', 'ㄹ'] })) await w.scene('set-discount-added');
    }
  }
  await w.pages('set-pricing-draft');

  // 차량 · 직원: 1호 차량의 사용 종료 막힘 · `수거 목록 ›`, 비밀번호 재발급(체험판 미지원), 차량 추가 · 직원 배정 · 직원 추가 → 저장 → 사용 종료 → 다시 사용.
  await settingsFresh(w, 'fleet');
  if (await pressCell(w, 'set-fleet-v1', '1호 차량')) {
    await w.scene('set-fleet-v1', 'dialog');
    if (await sheetChoice(w, '사용 종료').isEnabled()) w.fail('set-fleet-v1', '업무가 남은 1호 차량인데 사용 종료를 누를 수 있음');
    // 미처리 업무는 가는 곳과 맞게 수거 · 배달로 나눠 말한다(wording 3-20 `2026-09-27 점검 반영`).
    if (!(await w.top().getByText(/^사용 종료 불가 · 미처리 (수거 \d+건|배달 \d+건|수거 \d+ · 배달 \d+)$/).count())) w.fail('set-fleet-v1', '사용 종료 막힘의 한 줄이 없음');
    if (await pressChoice(w, 'set-fleet-v1', '수거 목록 ›')) {
      if (!/#\/collections/.test(await w.hash())) w.fail('set-fleet-v1', '`수거 목록 ›`이 수거 목록으로 가지 않음: ' + (await w.hash()));
      await settingsFresh(w, 'fleet');
    }
  }
  if (await pressCell(w, 'set-fleet-pin', '문태오') && await pressChoice(w, 'set-fleet-pin', '비밀번호 재발급')) {
    await w.scene('set-fleet-pin', 'dialog');
    await w.closeTo(0);
  }
  if (await pressCell(w, 'set-fleet-add', '차량 추가')) {
    await w.scene('set-fleet-add', 'dialog');
    await w.click(page.locator('.sn-kb').locator('[data-primary="true"]'));
    await w.scene('set-fleet-added');
  }
  if (await pressCell(w, 'set-fleet-assign', '서하준') && await pressChoice(w, 'set-fleet-assign', '차량')) {
    await w.scene('set-fleet-assign', 'dialog');
    await pressChoice(w, 'set-fleet-assign', '3호 차량');
  }
  if (await pressCell(w, 'set-fleet-staff', '직원 추가') && await pressChoice(w, 'set-fleet-staff', '기사')) {
    if (await w.keyboardWalk('set-fleet-staff-name', { submit: ['ㄱ', 'ㅏ', 'ㅇ', 'ㄷ', 'ㅏ', 'ㅇ', 'ㅗ', 'ㄴ'], then: true })) {
      await w.scene('set-fleet-staff-vehicle', 'dialog');
      await pressChoice(w, 'set-fleet-staff-vehicle', '2호 차량');
    }
  }
  await w.pages('set-fleet-draft');
  if (await primary().isEnabled()) {
    await w.click(primary());
    await w.scene('set-fleet-save', 'dialog');
    const next = () => w.top().getByRole('button', { name: '다음 쪽' });
    for (let p = 2; await next().count() && await next().isEnabled(); p += 1) { await w.click(next()); await w.scene('set-fleet-save-p' + p, 'dialog'); }
    await w.click(w.top().locator('[data-primary="true"]'));
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10_000 }).catch(() => {});
    await w.settle();
    await w.scene('set-fleet-saved');
    if ((await footerSummary(w)) !== '변경 없음') w.fail('set-fleet-saved', '저장 뒤 바닥줄이 `변경 없음`이 아님: ' + (await footerSummary(w)));
    for (const [step, label] of [['end', '사용 종료'], ['reuse', '다시 사용']]) {
      if (await pressCell(w, 'set-fleet-' + step, '3호 차량') && await pressChoice(w, 'set-fleet-' + step, label)) {
        await w.scene('set-fleet-' + step);
        await w.click(primary());
        await w.click(w.top().locator('[data-primary="true"]'));
        await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10_000 }).catch(() => {});
        await w.settle();
        await w.scene('set-fleet-' + step + '-saved');
      }
    }
  } else w.fail('set-fleet-save', '바꾼 뒤 저장을 누를 수 없음');

  // 카운터가 보는 매장 설정: 권한 없음 · 저장 막힘.
  w.route('counter');
  await page.goto(BASE + '?viewer=counter#/manage/settings/places');
  await page.waitForSelector('.sn-rule-card', { timeout: 10_000 });
  await w.settle();
  await w.scene('set-viewer-counter');
  if ((await footerSummary(w)) !== '권한 없음 · 관리자 확인 필요') w.fail('set-viewer-counter', '카운터에게 `권한 없음 · 관리자 확인 필요`가 없음: ' + (await footerSummary(w)));
  // 읽기만(2026-09-27 점검): 항목 판은 `권한 없음 · 관리자 확인 필요` 한 줄과 누를 수 없는 버튼, 초안이 생기지 않는다(`변경됨` · `저장 · 1건` 없음).
  if (await pressCell(w, 'set-viewer-counter', '설천 주차장')) {
    await w.scene('set-viewer-counter-sheet', 'dialog');
    if (!(await w.top().getByText('권한 없음 · 관리자 확인 필요').count())) w.fail('set-viewer-counter-sheet', '권한 없는 사람의 항목 판에 `권한 없음 · 관리자 확인 필요`가 없음');
    const hide = sheetChoice(w, '숨김');
    if (await hide.count() && await hide.first().isEnabled()) w.fail('set-viewer-counter-sheet', '권한 없는 사람이 `숨김`을 누를 수 있음');
    await w.closeTo(0);
  }
  for (const tab of ['places', 'slots', 'pricing', 'fleet']) {
    await page.goto(BASE + '?viewer=counter#/manage/settings/' + tab);
    await page.waitForSelector('.sn-rule-card', { timeout: 10_000 }).catch(() => {});
    await w.settle();
    await w.scene('set-viewer-counter-' + tab);
    const enabled = page.locator('.sn-rule-card button.sn-choice:enabled, .sn-rule-card button.sn-rule-value:enabled');
    if (await enabled.count()) w.fail('set-viewer-counter-' + tab, '권한 없는 사람이 누를 수 있는 고르기 · 값 버튼: ' + (await enabled.first().textContent()));
    if (await page.locator('.sn-rule-card .sn-chip', { hasText: '변경됨' }).count()) w.fail('set-viewer-counter-' + tab, '권한 없는 사람에게 `변경됨`이 생김');
    if (await primary().isEnabled()) w.fail('set-viewer-counter-' + tab, '권한 없는 사람이 저장을 누를 수 있음');
  }

  // 미리 보기: 새 비밀번호 창, 권종 · 장소가 많은 탭.
  await w.visit('#/preview/pin', '.pos-pin-digits');
  await w.scene('set-preview-pin', 'dialog');
  // 한 번만 보이는 새 비밀번호 창의 버튼은 `확인` 하나(2026-09-27 점검: `닫기`도 같은 일을 해 잘못 누르면 비밀번호를 잃었다).
  if (await w.top().getByRole('button', { name: '닫기', exact: true }).count()) w.fail('set-preview-pin', '새 비밀번호 창에 `닫기`가 있음');
  for (const tab of ['pricing', 'places']) {
    await w.visit('#/preview/settings-many?tab=' + tab, '.sn-rule-card');
    await w.pages('set-many-' + tab);
  }
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
  if (w.shop === 'numbered' && (await page.locator('.pos-new-side', { hasText: '보증금' }).count())) w.seen.add('v2-deposit');
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
  // 막는 단계(features-1 §9-3): 주 버튼 `마감` → 창 안의 한 줄 `1호 차량 기록 1건 전송 대기 · 마감 전 전송 필요` · `재확인`(주 버튼) · `닫기`.
  const closePrimary = page.locator('.sn-footer [data-primary="true"]');
  if (await closePrimary.count() && await closePrimary.isEnabled()) {
    await w.click(closePrimary);
    const step = w.top().locator('.sn-review-step');
    if (!(await step.count())) w.fail('v6-blocked-step', '막힌 마감의 주 버튼이 막는 단계 창을 열지 않음');
    else {
      await w.scene('v6-blocked-step', 'dialog');
      if (!/전송 대기 · 마감 전 전송 필요$/.test((await step.getAttribute('aria-label')) ?? '')) w.fail('v6-blocked-step', '막는 단계 한 줄이 `… 전송 대기 · 마감 전 전송 필요`가 아님');
      await w.click(w.top().locator('[data-primary="true"]'));
      await w.scene('v6-blocked-recheck', 'dialog');
      if (!(await w.top().locator('.sn-review-step').count())) w.fail('v6-blocked-recheck', '아직 막혔는데 `재확인` 뒤 막는 단계가 사라짐');
      await w.closeTo(0);
      if (await page.locator('.pos-closing-sum', { hasText: '마감 완료' }).count()) w.fail('v6-blocked-step', '막는 단계 창을 닫았는데 마감됨');
    }
  } else w.fail('v6-blocked-step', '막힌 마감의 주 버튼 `마감`을 누를 수 없음(막는 단계 창)');
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
 * 하루 마감(V6) 27일 00:20: 점검 전(#before, 1024×569 · 1024×529도 한 쪽) → 점검 이월(이월 항목이 여섯 이상이면 두 쪽) → 돈통 점검 판(틀린
 * 금액 · 사유 · 직접 입력 판) → 500,000원 · 잔돈 착오로 셈(예상 505,000원) → 이월한 봉투의 점검(35,000원: 돈통 예상이 바뀌어 재점검 차례) →
 * 재점검 540,000원 → 마감 → 마감 완료 · 마감표 인쇄 → 이월 항목 누름. 첫 매장(2026-09-26)은 권 보증금이 없어 시안의 숫자(510,000 · 545,000원 ·
 * 이월 항목 5 · 6)보다 보증금 5,000원 · 보증금 보관 중 한 줄이 적다. 이 크기의 체험 자료는 마감된 채로 끝난다(뒤 걸음 없음).
 */
async function closingWalk(w) {
  const page = w.page;
  const primary = () => page.locator('.sn-footer [data-primary="true"]');
  const action = (re) => page.locator('.pos-closing-table .sn-cell-action', { hasText: re });
  const expectPrimary = async (scene, re) => {
    const got = (await primary().count()) ? ((await primary().textContent()) ?? '') : '';
    if (!re.test(got)) w.fail(scene, '마감 화면 주 버튼이 ' + re + '이 아님: ' + got);
  };
  // 센 금액: 첫 매장은 돈통 예상 505,000 → 차량 현금 35,000 뒤 540,000(보증금 없음), 견본 매장(보증금)은 510,000 → 545,000(spec 2-4).
  const numbered = w.shop === 'numbered';
  const amounts = numbered ? { drawer: ['5', '0', '5', '000'], recount: ['5', '4', '5', '000'] } : { drawer: ['5', '0', '0', '000'], recount: ['5', '4', '0', '000'] };
  await w.visit('#/closing/' + w.date, '.pos-closing-table');
  await w.scene('v6-before');
  await expectPrimary('v6-before', /^차량 현금 점검 · 35,000원$/);
  if (await page.locator('.pos-closing .sn-pager, .sn-footer .sn-pager').count()) w.fail('v6-before', '마감 화면(이월 항목 4 · 5)이 한 쪽이 아님');
  if (numbered && (await page.locator('.pos-closing', { hasText: '보증금 보관 중' }).count())) w.seen.add('v6-held');
  await w.click(action(/^점검 이월$/));
  await w.scene('v6-deferred');
  const next = page.locator('.pos-closing-carry-head').getByRole('button', { name: '다음 쪽' });
  const carryCount = Number(/(\d+)/.exec((await page.locator('.pos-closing-carry-title').textContent()) ?? '')?.[1] ?? 0);
  if (!(await next.count())) { if (carryCount >= 6) w.fail('v6-deferred', '이월 항목 ' + carryCount + '이 쪽을 넘기지 않음'); }
  else {
    await w.click(next);
    await w.scene('v6-deferred-p2');
    if (numbered) w.seen.add('v6-p2');
    await w.click(page.locator('.pos-closing-carry-head').getByRole('button', { name: '이전 쪽' }));
  }
  await expectPrimary('v6-deferred', /^돈통 점검$/);
  await w.click(primary());
  await w.cashCheckWalk('v6-drawer', { commit: { digits: amounts.drawer, reason: '잔돈 착오' } });
  await w.scene('v6-counted');
  await expectPrimary('v6-counted', /^마감 · 12월 26일$/);
  await w.click(action(/^점검$/));
  await w.cashCheckWalk('v6-van', { commit: { digits: ['3', '5', '000'] } });
  await w.scene('v6-van-checked');
  await expectPrimary('v6-van-checked', /^돈통 점검$/);
  await w.click(action(/^재점검$/));
  await w.cashCheckWalk('v6-recount', { commit: { digits: amounts.recount } });
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
  if (numberedPass(w)) await numberedDriver(w);
}

/** 기사 크기의 견본 매장 걸음: 배달 · 업무 판(V7: 리프트권 추가의 `보증금 5,000원`, 수거 창의 `권 N매 보증금 … 반환`). */
async function numberedDriver(w) {
  await withNumbered(w, async () => {
    // 견본 매장 체험 자료를 처음(15:40)으로(초기화는 카운터 나가기 화면에만 있다, deliveryWalk의 reset과 같음).
    await w.visit('#/exit', '.pos-card', 'counter');
    await w.click(w.page.getByRole('button', { name: '체험 자료 초기화', exact: true }));
    await w.click(w.top().getByRole('button', { name: '초기화', exact: true }));
    await w.closeTo(0);
    await deliveryWalk(w);
  }, { 'ticket-deposit': 'V7 리프트권 추가 판의 보증금', 'collect-deposit': 'V7 수거 창의 보증금 반환 줄' });
}

/**
 * 서버 모드의 화면(계획 work/impl-server/plan.md 6-3 · 6-4): 체험판 미리 보기로 이 크기의 등급에서 잰다.
 *   #/preview/enroll: 기기 등록(화면 안 숫자판) → 12자리(넷씩 끊어 보임) → 입력(체험판 미지원 한 줄).
 *   #/preview/choose: 기기 선택(종류 셋: 기사 등급이면 기사 휴대폰이 먼저이고 보라 주 버튼, 카운터 등급이면 카운터(포스)가 먼저이고
 *   주황 주 버튼) → 카운터(바로 보냄: 한 줄) → 기사 휴대폰 → 차량 선택(견본 차량 타일, 어느 크기에서나 기사 등급: 태블릿 크기의 `이전`도
 *   56px) → 차량(한 줄) → 이전. ?many면 기사 태블릿 → 차량 24대의 쪽마다. ?none이면 차량 없는 매장(한 줄 `차량 없음 · 관리자 확인
 *   필요`, 기사 기기 버튼은 눌리지 않음).
 *   #/preview/login?open: 스스로 붙은 기기의 로그인(매장 이름 줄의 기기 모양, 바닥줄의 `기기 선택`, 많으면 쪽 넘김과 함께).
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

  const noteSettled = () => page.waitForFunction(() => {
    const note = document.querySelector('.pos-choose-note');
    return !!note && (note.textContent ?? '').trim() !== '처리 중';
  }, null, { timeout: 5_000 }).catch(() => {});
  const bigChoice = (name) => page.locator('.pos-choose .pos-big-choice', { hasText: name });
  await w.visit('#/preview/choose' + query(''), '.pos-choose', role);
  await w.scene('choose');
  const choices = page.locator('.pos-choose .pos-big-choice');
  const kinds = (await choices.allTextContents()).map((text) => text.trim());
  // 차례와 주 버튼은 이 화면의 등급을 따른다(휴대폰 폭의 기사가 카운터를 잘못 고르지 않게).
  const order = driver ? ['기사 휴대폰', '기사 태블릿', '카운터'] : ['카운터', '기사 휴대폰', '기사 태블릿'];
  if (kinds.length !== 3 || order.some((name, i) => !(kinds[i] ?? '').startsWith(name))) {
    w.fail('choose', '종류 버튼 차례가 ' + order.join(' · ') + '이 아님: ' + kinds.join(' | '));
  }
  const firstPrimary = (await page.locator('.pos-choose .pos-big-choice[data-primary="true"]').allTextContents()).map((text) => text.trim());
  if (firstPrimary.length !== 1 || !(firstPrimary[0] ?? '').startsWith(order[0])) {
    w.fail('choose', '주 버튼이 첫 버튼(' + order[0] + ') 하나가 아님: ' + firstPrimary.join(' | '));
  }
  await w.click(bigChoice('카운터'));
  await noteSettled();
  await w.scene('choose-note');
  if (!(await page.locator('.pos-choose-note').count())) w.fail('choose-note', '카운터를 보낸 뒤 한 줄이 없음');
  await w.click(bigChoice('기사 휴대폰'));
  await page.waitForSelector('.pos-choose-tile', { timeout: 5_000 }).catch(() => {});
  // 차량 선택은 앱처럼 기사 등급이다(카운터 크기에서도: 1024×600 기사 태블릿 가로의 `이전`이 56px).
  w.route('driver');
  await w.scene('choose-vehicle');
  const vanTiles = await page.locator('.pos-choose-tile').allTextContents();
  if ((await page.locator('.pos-choose-vehicles h1').textContent())?.trim() !== '차량 선택' || vanTiles.length < 1) {
    w.fail('choose-vehicle', '차량 선택 화면 · 차량 타일이 없음: ' + vanTiles.join(', '));
  }
  await w.click(page.locator('.pos-choose-tile').first());
  await noteSettled();
  await w.scene('choose-vehicle-note');
  if (!(await page.locator('.pos-choose-note').count())) w.fail('choose-vehicle-note', '차량을 보낸 뒤 한 줄이 없음');
  await w.click(page.locator('.pos-choose-foot').getByRole('button', { name: '이전', exact: true }));
  w.route(role);
  if ((await choices.count()) !== 3) w.fail('choose-back', '이전을 눌러도 종류 버튼으로 돌아오지 않음');
  await w.visit('#/preview/choose' + query('many'), '.pos-choose', role);
  await w.click(bigChoice('기사 태블릿'));
  await page.waitForSelector('.pos-choose-tile', { timeout: 5_000 }).catch(() => {});
  w.route('driver');
  const vanPager = page.locator('.pos-choose-foot');
  const [, vanPages] = await w.pageInfo(vanPager);
  if (vanPages < 2) w.fail('choose-many', '차량 24대가 한 쪽에 들어감(쪽 넘김을 재지 못함): ' + (await page.locator('.pos-choose-tile').count()) + '대');
  for (let p = 1; p <= vanPages; p += 1) {
    await w.toPage(p, vanPager);
    await w.scene('choose-many-p' + p);
  }
  // 차량 없는 매장: 기사 기기 버튼은 눌리지 않고 까닭을 한 줄로(카운터 등급은 카운터(포스)가 주 버튼, 기사 등급은 주 버튼이 없음).
  await w.visit('#/preview/choose' + query('none'), '.pos-choose', role);
  await w.scene('choose-no-vans');
  const noVanLine = ((await page.locator('.pos-choose-note').textContent().catch(() => '')) ?? '').trim();
  if (noVanLine !== '차량 없음 · 관리자 확인 필요') w.fail('choose-no-vans', '차량이 없는데 한 줄이 없음: ' + noVanLine);
  const live = (await page.locator('.pos-choose .pos-big-choice:enabled').allTextContents()).map((text) => text.trim());
  if (live.length !== 1 || !(live[0] ?? '').startsWith('카운터')) w.fail('choose-no-vans', '차량이 없을 때 누를 수 있는 버튼이 카운터(포스) 하나가 아님: ' + live.join(' | '));
  const noVanPrimary = await page.locator('.pos-choose [data-primary="true"]').count();
  if (noVanPrimary !== (driver ? 0 : 1)) w.fail('choose-no-vans', '차량이 없을 때의 주 버튼 수 ' + noVanPrimary);

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
  // 스스로 붙은 기기(시험 매장의 열린 등록): 매장 이름 줄의 기기 모양, 바닥줄의 `기기 선택`(쪽 넘김과 함께).
  for (const extra of ['open', 'open&many']) {
    await w.visit('#/preview/login' + query(extra), '.pos-login-tile', role);
    const release = page.locator('.pos-login-foot').getByRole('button', { name: '기기 선택', exact: true });
    const label = 'login-' + extra.replace('&', '-');
    await w.scene(label);
    if (!(await release.count())) w.fail(label, '스스로 붙은 기기의 로그인 화면에 기기 선택이 없음');
    if (extra === 'open') {
      await w.click(release);
      await w.scene(label + '-note');
    } else {
      const openPager = page.locator('.pos-login-foot');
      const [, openPages] = await w.pageInfo(openPager);
      if (openPages > 1) {
        await w.toPage(openPages, openPager);
        await w.scene(label + '-p' + openPages);
      }
    }
  }

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
  // 인쇄 창(features-1 E16)은 막아 두고, 부른 수와 그때 인쇄 문서의 글을 남긴다(printWalk가 본다).
  await context.addInitScript(() => {
    window.print = () => {
      window.__skinotePrinted = (window.__skinotePrinted ?? 0) + 1;
      window.__skinotePrintText = document.querySelector('.pos-print-host')?.textContent ?? '';
    };
  });
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
