// 화면 규칙 검사(ui 8절, 옛 scripts/pos-ui-rules.cjs를 옮겨 넓힘). 빌드한 포스 앱(vite preview)을 Playwright로 열어
// 크기마다 화면을 차례로 누르며 찍고, 사람이 화면에서 알아챌 것을 잰다:
//   ① 16px 미만 글자 ② 잘린 글자(맞추지 못한 TextFit · 넘친 버튼 글자) ③ 말줄임표 ④ 등급 최소보다 작은 누르는 곳
//   ⑤ 가로 넘침 · 페이지 스크롤 · 스크롤 영역 ⑥ 화면 밖으로 나간 것 ⑦ 반쯤 잘린 줄 ⑧ 주 버튼 둘 이상 ⑨ 영어 글자
//   ⑩ 늦음이 아닌 곳의 빨강. 창(role=dialog)이 열려 있으면 그 창 안만 잰다(뒤의 화면은 앞 장면에서 쟀다).
// 크기 · 최소 글자 · 누르는 곳은 DeviceProfile(@skinote/ui/device-profile)의 등급 값에서, 늦음 빨강은 디자인 토큰(--sn-late)에서 읽는다
// (여기에 숫자를 따로 적지 않는다). 포스 등급(pos · pos_narrow)과 기사 등급(driver_tablet · driver_phone)의 검사 크기를 모두 돌고,
// 1024×600의 125% 확대는 참고 크기(어긋남을 세지 않음)다. 기사 장면은 야간 수거 목록(C3)을 줄 고르기 · 순서 · 못 받음 · 받음 도장 ·
// 끝 4자리 · 빨리 확인 · 차에 있는 것 · 매장 입고 · 연결 끊김(보냄 대기)까지 누르고, 카운터 창에서 빨리 확인을 하나 더 보낸다.
// 단위 시험(npm test)에 넣지 않는다(Pages CI에 브라우저가 없음). 실행: npm run build && npm run test:ui
//   환경 변수: SKINOTE_UI_URL(기본 http://127.0.0.1:5181/, 없으면 vite preview를 5181에 띄움), SKINOTE_UI_OUT(기본 work/screens/step3),
//   SKINOTE_UI_ONLY(pos 또는 driver: 한 벌만)
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { DEVICE_PROFILES } from '@skinote/ui/device-profile';

const ROOT = new URL('../', import.meta.url);
const URL_BASE = process.env.SKINOTE_UI_URL ?? 'http://127.0.0.1:5181/';
const OUT = new URL((process.env.SKINOTE_UI_OUT ?? 'work/screens/step3').replace(/\/?$/, '/'), ROOT);
const ONLY = process.env.SKINOTE_UI_ONLY ?? '';

/** 매장 기기 등급과 그 장면 묶음(포스 · 기사). */
const CLASS_KIND = { pos: 'pos', pos_narrow: 'pos', driver_tablet: 'driver', driver_phone: 'driver' };

/** 등급의 검사 크기(DeviceProfile.checkSizes)와 그 등급의 최소 글자 · 누르는 곳. */
const ALL_SIZES = Object.entries(CLASS_KIND).flatMap(([cls, kind]) => DEVICE_PROFILES[cls].checkSizes.map((size) => ({
  name: (kind === 'driver' ? 'driver-' : '') + size.width + 'x' + size.height,
  width: size.width,
  height: size.height,
  minFont: DEVICE_PROFILES[cls].minFontPx,
  minTarget: DEVICE_PROFILES[cls].minTargetPx,
  kind,
})));
/** 참고 크기: 1024×600을 125%로 확대한 CSS px(등급은 pos_narrow). 어긋남을 세지 않는다. */
const ZOOM = 125;
const first = DEVICE_PROFILES.pos.checkSizes[0];
const ALL_EXTRA = [{
  name: 'zoom' + ZOOM + '-' + Math.round((first.width * 100) / ZOOM) + 'x' + Math.round((first.height * 100) / ZOOM),
  width: Math.round((first.width * 100) / ZOOM),
  height: Math.round((first.height * 100) / ZOOM),
  minFont: DEVICE_PROFILES.pos_narrow.minFontPx,
  minTarget: DEVICE_PROFILES.pos_narrow.minTargetPx,
  kind: 'pos',
}];

/** 늦음 빨강(디자인 토큰 --sn-late)을 rgb() 글로. */
function lateRgb() {
  const css = readFileSync(new URL('packages/ui/src/styles/tokens.css', ROOT), 'utf8');
  const hex = /--sn-late:\s*#([0-9A-Fa-f]{6})\s*;/.exec(css)?.[1];
  if (!hex) throw new Error('디자인 토큰에 --sn-late가 없다');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 'rgb(' + r + ', ' + g + ', ' + b + ')';
}
const LATE_RGB = lateRgb();
const SIZES = ALL_SIZES.filter((s) => !ONLY || s.kind === ONLY);
const EXTRA = ALL_EXTRA.filter((s) => !ONLY || s.kind === ONLY);

// ── 페이지 안에서 도는 잼(바깥 변수를 쓰지 않는다) ─────────────────────────────────
export function measure(options) {
  const minFont = options.minFont;
  const minTarget = options.minTarget;
  const lateRgb = options.lateRgb;
  const vw = innerWidth;
  const vh = innerHeight;
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const root = dialogs.at(-1) ?? document.body;
  const all = [...root.querySelectorAll('*')].filter(visible);
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const name = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };
  const sample = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const row = (el, extra = {}) => ({ el: name(el), text: sample(el), ...extra });

  const smallText = all.filter((el) => ownText(el) && parseFloat(getComputedStyle(el).fontSize) < minFont - 0.01)
    .map((el) => row(el, { px: parseFloat(getComputedStyle(el).fontSize) }));

  const clipped = all.filter((el) => {
    if (el.matches('[data-fits="false"]')) return true;
    const s = getComputedStyle(el);
    const hides = ['hidden', 'clip'].includes(s.overflowX) || ['hidden', 'clip'].includes(s.overflowY);
    if ((ownText(el) || el.tagName === 'BUTTON') && el.scrollWidth > el.clientWidth + 1 && (hides || el.tagName === 'BUTTON')) return true;
    return false;
  }).map((el) => row(el, { need: el.scrollWidth, has: el.clientWidth }));

  const texts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || !n.textContent.trim() || !visible(parent) || parent.closest('script,style')) continue;
    texts.push({ parent, text: n.textContent.trim() });
  }
  const ellipsis = [
    ...texts.filter((t) => /…|\.\.\./.test(t.text)).map((t) => row(t.parent)),
    ...all.filter((el) => getComputedStyle(el).textOverflow === 'ellipsis').map((el) => row(el, { css: 'text-overflow' })),
  ];
  const latin = [
    ...texts.filter((t) => /[A-Za-z]/.test(t.text)).map((t) => row(t.parent)),
    ...all.filter((el) => /[A-Za-z]/.test(el.getAttribute('aria-label') ?? '')).map((el) => row(el, { aria: true })),
  ];

  const targets = all.filter((el) => el.matches('button,a[href],select,input:not([type="hidden"]),[role="button"],[role="tab"]'));
  const shortTargets = targets.map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.height < minTarget - 0.5 || r.width < minTarget - 0.5)
    .map(({ el, r }) => row(el, { w: Math.round(r.width), h: Math.round(r.height) }));

  const doc = document.documentElement;
  const pageOverflow = {
    horizontal: Math.max(doc.scrollWidth, document.body.scrollWidth) > vw + 1,
    vertical: Math.max(doc.scrollHeight, document.body.scrollHeight) > vh + 1,
  };
  const scrollAreas = [...document.querySelectorAll('*')].filter(visible).filter((el) => {
    const s = getComputedStyle(el);
    return (['auto', 'scroll'].includes(s.overflowY) && el.scrollHeight > el.clientHeight + 1) || (['auto', 'scroll'].includes(s.overflowX) && el.scrollWidth > el.clientWidth + 1);
  }).map((el) => row(el));

  const offscreen = all.filter((el) => ownText(el) || el.matches('button,[role="button"],[role="tab"]')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1;
  }).map((el) => { const r = el.getBoundingClientRect(); return row(el, { right: Math.round(r.right), bottom: Math.round(r.bottom) }); });

  // 반쯤 잘린 줄: 장부 줄 · 남은 일 줄이 담긴 칸(목록 판) 밖으로 나가면.
  const halfCut = [];
  for (const [container, item] of [['.sn-ledger', '.sn-row'], ['.sn-slip-items', '.sn-row'], ['.sn-checklist-list', '.sn-check'], ['.sn-dialog', '.sn-dialog-foot'], ['.sn-keypad', '.sn-key'], ['.sn-dialog', '.pos-van-row']]) {
    for (const box of root.querySelectorAll(container)) {
      if (!visible(box)) continue;
      const b = box.getBoundingClientRect();
      for (const it of box.querySelectorAll(item)) {
        if (!visible(it)) continue;
        const r = it.getBoundingClientRect();
        if (r.bottom > b.bottom + 1 || r.top < b.top - 1) halfCut.push(row(it, { in: container }));
      }
    }
  }

  const primaries = all.filter((el) => el.matches('[data-primary="true"]')).map((el) => row(el));

  // 빨강(늦음 색)은 늦은 것의 모양(.tone-late, 늦은 줄의 빨간 띠)에만.
  const redNotLate = all.filter((el) => ownText(el) && getComputedStyle(el).color === lateRgb && !el.closest('.tone-late')).map((el) => row(el));

  return { dialog: dialogs.length > 0, smallText, clipped, ellipsis, latin, shortTargets, pageOverflow, scrollAreas, offscreen, halfCut, primaries, redNotLate };
}

const RULES = ['smallText', 'clipped', 'ellipsis', 'latin', 'shortTargets', 'scrollAreas', 'offscreen', 'halfCut', 'redNotLate'];
const LABELS = {
  smallText: '16px 미만 글자', clipped: '잘린 글자', ellipsis: '말줄임표', latin: '영어 글자', shortTargets: '작은 누르는 곳',
  scrollAreas: '스크롤 영역', offscreen: '화면 밖', halfCut: '반쯤 잘린 줄', redNotLate: '늦음이 아닌 빨강', pageOverflow: '가로 넘침 · 페이지 스크롤',
  primaries: '주 버튼 둘 이상',
};

export function problems(result) {
  const out = {};
  for (const rule of RULES) if (result[rule].length) out[rule] = result[rule];
  if (result.pageOverflow.horizontal || result.pageOverflow.vertical) out.pageOverflow = [result.pageOverflow];
  if (result.primaries.length > 1) out.primaries = result.primaries;
  return out;
}

// ── 장면 ─────────────────────────────────────────────────────────────

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function posScenes(page, shoot) {
  const go = async (hash, selector) => {
    await page.goto(URL_BASE + hash);
    await page.waitForSelector(selector, { timeout: 10_000 });
    await settle(page);
  };
  const click = async (locator) => { await locator.first().click(); await settle(page); };
  const dialog = page.locator('[role="dialog"]');
  const closeDialog = async () => { await click(dialog.last().getByRole('button', { name: '닫기' })); };

  await go('#/', '.pos-card');
  await shoot('01-start');

  await click(page.getByRole('button', { name: /카운터/ }));
  await page.waitForSelector('.sn-row');
  await settle(page);
  await shoot('02-ledger-p1');
  const next = page.getByRole('button', { name: '다음 쪽' });
  const pages = await page.locator('.sn-pager-text').textContent().catch(() => '');
  const pageCount = Number(/\/\s*(\d+)/.exec(pages ?? '')?.[1] ?? '1');
  for (let i = 2; i <= pageCount; i += 1) {
    await click(next);
    await shoot('03-ledger-p' + i);
  }
  for (let i = 2; i <= pageCount; i += 1) await click(page.getByRole('button', { name: '이전 쪽' }));

  // 머리줄 끝 4자리 → 없는 번호 → 박준호 팀 접수증
  await click(page.getByRole('button', { name: '끝 4자리' }));
  await shoot('04-find-keypad');
  for (const d of '9999') await click(dialog.getByRole('button', { name: d, exact: true }));
  await click(dialog.getByRole('button', { name: '찾기' }));
  await shoot('05-find-none');
  for (let i = 0; i < 4; i += 1) await click(dialog.getByRole('button', { name: '정정' }));
  for (const d of '0022') await click(dialog.getByRole('button', { name: d, exact: true }));
  await click(dialog.getByRole('button', { name: '찾기' }));
  await page.waitForSelector('.sn-slip');
  await settle(page);
  await shoot('06-slip-from-find');
  await click(page.locator('.pos-footer-back').getByRole('button', { name: '장부' }));
  await page.waitForSelector('.sn-row');
  await settle(page);

  // 주 버튼 새 접수 → 한 문장 알림
  await click(page.locator('.sn-footer [data-primary="true"]'));
  await shoot('07-new-order-notice');
  await closeDialog();

  // 박준호 팀 지급 도장 → 확인 창 → 찍기 → 도장에 시각, 줄은 자리를 지킴
  const park = page.locator('tr.sn-row', { hasText: '박준호' });
  await click(park.getByRole('button', { name: /^지급 미처리/ }));
  await shoot('08-confirm-issue');
  await click(dialog.locator('[data-primary="true"]'));
  await dialog.waitFor({ state: 'detached' });
  await settle(page);
  await shoot('09-ledger-after-issue');

  // 줄을 눌러 접수증 → 다음 할 일(수납) → 수단 고르기 → 찍기
  await click(park.locator('.sn-cell-open'));
  await page.waitForSelector('.sn-slip');
  await settle(page);
  await shoot('10-slip-next-pay');
  await click(page.locator('.pos-side [data-primary="true"]'));
  await shoot('11-confirm-pay');
  await click(dialog.getByRole('button', { name: '현금' }));
  await click(dialog.locator('[data-primary="true"]'));
  await dialog.waitFor({ state: 'detached' });
  await settle(page);
  await shoot('12-slip-after-pay');
  const more = page.locator('.pos-side').getByRole('button', { name: '더 보기' });
  if (await more.count()) {
    await click(more);
    await shoot('13-slip-more');
    await closeDialog();
  }
  // 품목 한 줄 도장(수량 −/+)
  await go('#/orders/o32', '.sn-slip');
  await shoot('14-slip-family-payer');
  await click(page.locator('.sn-slip-items tr.sn-row').first().getByRole('button', { name: /^지급 미처리/ }));
  await shoot('15-confirm-line-qty');
  await closeDialog();
  await go('#/orders/o26', '.sn-slip');
  await shoot('16-slip-delivery');
  await go('#/orders/o27', '.sn-slip');
  await shoot('17-slip-late-unpaid');

  // 빨리 확인(N12): 서지훈 팀(22:00 설천 주차장, 차량 수거) 접수증의 옆 동작 → 확인 창 → 보내기 → 약속 줄에 '빨리 확인 보냄'
  await go('#/orders/o31', '.sn-slip');
  const pinAction = page.locator('.pos-side').getByRole('button', { name: '긴급 요청' });
  if (await pinAction.count()) await click(pinAction);
  else { await click(page.locator('.pos-side').getByRole('button', { name: '더 보기' })); await click(dialog.getByRole('button', { name: '긴급 요청' })); }
  await shoot('26-confirm-pin');
  await click(dialog.locator('[data-primary="true"]'));
  await dialog.waitFor({ state: 'detached' });
  await settle(page);
  await shoot('27-slip-after-pin');

  // 카운터의 수거 목록(N3): 머리줄 메뉴 → 빨리 확인 두 건(1건 더), 줄 고르기 → 동작 줄, 받음 칸 → 한 문장
  await go('#/ledger', '.sn-row');
  const menuItem = page.locator('.sn-header').getByRole('button', { name: '수거 목록' });
  if (await menuItem.count()) await click(menuItem);
  else { await click(page.locator('.sn-header').getByRole('button', { name: '더 보기' })); await click(dialog.getByRole('button', { name: '수거 목록' })); }
  await page.waitForSelector('.sn-row');
  await settle(page);
  await shoot('28-collection-p1');
  const cNext = page.getByRole('button', { name: '다음 쪽' });
  const cPages = Number(/\/\s*(\d+)/.exec((await page.locator('.sn-pager-text').textContent().catch(() => '')) ?? '')?.[1] ?? '1');
  for (let i = 2; i <= cPages; i += 1) { await click(cNext); await shoot('29-collection-p' + i); }
  for (let i = 2; i <= cPages; i += 1) await click(page.getByRole('button', { name: '이전 쪽' }));
  await click(page.locator('tr.sn-row', { hasText: '이수진' }).locator('.sn-cell-open'));
  await shoot('30-collection-selected');
  await click(page.getByRole('toolbar').getByRole('button', { name: '위로' }));
  await shoot('31-collection-moved');
  await click(page.getByRole('toolbar').getByRole('button', { name: '긴급 요청' }));
  await shoot('32-collection-confirm-pin');
  await closeDialog();
  await click(page.locator('tr.sn-row', { hasText: '이수진' }).locator('.sn-cell-open'));
  await click(page.locator('tr.sn-row', { hasText: '김민재' }).getByRole('button', { name: /^수거 미처리/ }));
  await shoot('33-collection-stamp-notice');
  await closeDialog();

  // '‹ 장부'(장부에서 열지 않았으면 오늘 장부) → 미수 탭
  await go('#/orders/o27', '.sn-slip');
  await click(page.locator('.pos-footer-back').getByRole('button', { name: '장부' }));
  await page.waitForSelector('.sn-row');
  await settle(page);
  await click(page.getByRole('tab', { name: /^미수/ }));
  await shoot('18-ledger-unpaid-tab');
  await click(page.getByRole('tab', { name: /^전체/ }));

  // 나가기 → 처음 자료로 되돌리기 창
  const exit = page.getByRole('button', { name: '나가기' });
  if (await exit.count()) await click(exit);
  else { await click(page.getByRole('button', { name: '더 보기' })); await click(dialog.getByRole('button', { name: '나가기' })); }
  await page.waitForSelector('.pos-card');
  await shoot('19-exit');
  await click(page.getByRole('button', { name: '체험 자료 초기화', exact: true }));
  await shoot('20-exit-reset');
  await click(dialog.locator('[data-primary="true"]'));

  // 체험 시계: 21:10(야간 수거 준비 안내 · 늦은 줄), 알림, 22:10(마지막 반납 타임 뒤 → 주 버튼 마감)
  for (let i = 0; i < 5; i += 1) await click(page.getByRole('button', { name: '+1시간', exact: true }));
  for (let i = 0; i < 3; i += 1) await click(page.getByRole('button', { name: '+10분', exact: true }));
  await click(page.getByRole('button', { name: '장부', exact: true }));
  await page.waitForSelector('.sn-row');
  await settle(page);
  await shoot('22-ledger-night-prep');
  await click(page.getByRole('button', { name: /^알림/ }));
  await shoot('23-alerts');
  await closeDialog();
  await go('#/exit', '.pos-card');
  await click(page.getByRole('button', { name: '+1시간', exact: true }));
  await click(page.getByRole('button', { name: '장부', exact: true }));
  await page.waitForSelector('.sn-row');
  await settle(page);
  await shoot('24-ledger-after-last-slot');
  await click(page.locator('.sn-footer [data-primary="true"]'));
  await shoot('25-close-day-notice');
  await closeDialog();
}

/** 기사 기기 장면(C3 야간 수거 목록). counter: 같은 브라우저의 다른 탭(카운터 크기)에서 빨리 확인을 보낼 때 쓴다. */
async function driverScenes(page, shoot, counter) {
  const go = async (hash, selector) => {
    await page.goto(URL_BASE + hash);
    await page.waitForSelector(selector, { timeout: 10_000 });
    await settle(page);
  };
  const click = async (locator) => { await locator.first().click(); await settle(page); };
  const dialog = page.locator('[role="dialog"]');
  const closeDialog = async () => { await click(dialog.last().getByRole('button', { name: '닫기' })); };
  const header = page.locator('.sn-header');
  const bar = page.getByRole('toolbar');
  const row = (name) => page.locator('tr.sn-row', { hasText: name });
  /** 머리줄 버튼(좁으면 더 보기 안). */
  const headerAction = async (name) => {
    const direct = header.getByRole('button', { name, exact: true });
    if (await direct.count()) await click(direct);
    else { await click(header.getByRole('button', { name: '더 보기' })); await click(dialog.getByRole('button', { name })); }
  };
  const pageCount = async () => Number(/\/\s*(\d+)/.exec((await page.locator('.sn-pager-text').textContent().catch(() => '')) ?? '')?.[1] ?? '1');

  await go('#/driver/2026-12-26', '.sn-row');
  await shoot('d01-list-p1');
  const pages = await pageCount();
  for (let i = 2; i <= pages; i += 1) { await click(page.getByRole('button', { name: '다음 쪽' })); await shoot('d02-list-p' + i); }
  for (let i = 2; i <= pages; i += 1) await click(page.getByRole('button', { name: '이전 쪽' }));

  // 줄을 고르면 바닥줄 자리에 동작 줄(▲ · ▼ · 맨 위로 · 못 받음 · 전화), ▲로 한 반납 타임 안에서 위로
  await click(row('이수진').locator('.sn-cell-open'));
  await shoot('d03-row-selected');
  await click(bar.getByRole('button', { name: '위로' }));
  await shoot('d04-moved-up');

  // 못 받음 → 방문 결과 판(모두 버튼): 고객 부재 → 날짜 보기 → 뒤로 → 오늘 다시 → 직접 입력 22:30 → 남기기
  await click(bar.getByRole('button', { name: '수거 실패' }));
  await shoot('d05-visit-reason');
  await click(dialog.getByRole('button', { name: '고객 부재' }));
  await shoot('d06-visit-when');
  await click(dialog.getByRole('button', { name: '날짜' }));
  await shoot('d07-visit-date');
  await click(dialog.getByRole('button', { name: '이전', exact: true }));
  await click(dialog.getByRole('button', { name: '오늘', exact: true }));
  await shoot('d08-visit-time');
  await click(dialog.getByRole('button', { name: '직접 입력' }));
  for (const d of '2230') await click(dialog.getByRole('button', { name: d, exact: true }));
  await shoot('d09-visit-custom');
  await click(dialog.getByRole('button', { name: '확인', exact: true }));
  await shoot('d10-visit-review');
  await click(dialog.locator('[data-primary="true"]'));
  await dialog.waitFor({ state: 'detached' });
  await settle(page);
  await shoot('d11-after-visit');

  // 받음 도장: 확인 창 → 찍기 → '받음 15:4x'
  await click(row('김민재').getByRole('button', { name: /^수거 미처리/ }));
  await shoot('d12-confirm-collect');
  await click(dialog.locator('[data-primary="true"]'));
  await dialog.waitFor({ state: 'detached' });
  await settle(page);
  await shoot('d13-after-collect');

  // 끝 4자리: 높이 600px 이상 태블릿은 오른쪽 판, 그 밖은 머리줄 '끝 4자리' → 아래 판
  const side = page.locator('.sn-keypad.is-side');
  const pad = (await side.count()) ? side : dialog;
  if (!(await side.count())) { await click(header.getByRole('button', { name: '끝 4자리' })); await shoot('d14-find-sheet'); }
  for (const d of '9999') await click(pad.getByRole('button', { name: d, exact: true }));
  await click(pad.getByRole('button', { name: '찾기' }));
  await shoot('d15-find-none');
  for (const d of '0031') await click(pad.getByRole('button', { name: d, exact: true }));
  await click(pad.getByRole('button', { name: '찾기' }));
  if (await dialog.count()) await dialog.waitFor({ state: 'detached' });
  await settle(page);
  await shoot('d16-found');
  await click(row('서지훈').locator('.sn-cell-open')); // 고른 줄 풀기

  // 빨리 확인 줄: 전화 → 한 문장, 확인
  await click(page.locator('.sn-pin').getByRole('button', { name: '전화', exact: true }));
  await shoot('d17-pin-call');
  await closeDialog();
  await click(page.locator('.sn-pin').getByRole('button', { name: '확인', exact: true }));
  await shoot('d18-pin-acknowledged');

  // 차에 있는 것(메뉴) → 매장 입고(주 버튼, 보라) → 확인 창 → 입고
  await headerAction('차량 재고');
  await shoot('d19-van-stock');
  await closeDialog();
  await click(page.locator('.sn-footer [data-primary="true"]'));
  await shoot('d20-confirm-receive');
  await click(dialog.locator('[data-primary="true"]'));
  await dialog.waitFor({ state: 'detached' });
  await settle(page);
  await shoot('d21-after-receive');

  // 연결 끊김(체험): 나가기 → 연결 끊기 → 수거 목록 → 받음 도장이 점선(보냄 대기), 연결 띠 → 다시 연결하면 보냄
  await headerAction('나가기');
  await page.waitForSelector('.pos-card');
  await settle(page);
  await shoot('d22-exit-driver');
  await click(page.getByRole('button', { name: '연결 해제', exact: true }));
  await click(page.getByRole('button', { name: '수거 목록', exact: true }));
  await page.waitForSelector('.sn-row');
  await settle(page);
  await click(row('김민수').getByRole('button', { name: /^수거 미처리/ }));
  await click(dialog.locator('[data-primary="true"]'));
  await dialog.waitFor({ state: 'detached' });
  await settle(page);
  await shoot('d23-offline-pending');
  await click(row('김민수').getByRole('button', { name: /^수거 완료/ }));
  await shoot('d24-pending-notice');
  await closeDialog();
  await headerAction('나가기');
  await page.waitForSelector('.pos-card');
  await settle(page);
  await shoot('d25-exit-offline');
  await click(page.getByRole('button', { name: /^재연결/ }));
  await click(page.getByRole('button', { name: '수거 목록', exact: true }));
  await page.waitForSelector('.sn-row');
  await settle(page);
  await shoot('d26-after-sync');

  // 카운터 탭(같은 브라우저, 카운터 크기)에서 백승현 팀에 빨리 확인 → 기사 목록 맨 위 줄이 '빨리 확인 1건 더'
  await counter(async (desk) => {
    await desk.goto(URL_BASE + '#/orders/o35');
    await desk.waitForSelector('.sn-slip');
    await settle(desk);
    const deskDialog = desk.locator('[role="dialog"]');
    const direct = desk.locator('.pos-side').getByRole('button', { name: '긴급 요청' });
    if (await direct.count()) await direct.first().click();
    else { await desk.locator('.pos-side').getByRole('button', { name: '더 보기' }).first().click(); await deskDialog.getByRole('button', { name: '긴급 요청' }).first().click(); }
    await deskDialog.locator('[data-primary="true"]').first().click();
    await deskDialog.waitFor({ state: 'detached' });
  });
  await page.waitForTimeout(500);
  await settle(page);
  await shoot('d27-two-pins');
  await click(page.locator('.sn-pin-open'));
  await shoot('d28-pin-list');
  await closeDialog();
}

// ── 실행 ─────────────────────────────────────────────────────────────

async function reachable(url) {
  try { return (await fetch(url)).ok; } catch { return false; }
}

async function ensureServer() {
  if (await reachable(URL_BASE)) return null;
  // npx를 거치면 리눅스에서 kill()이 vite를 멈추지 못한다. node로 vite를 바로 띄운다.
  const viteBin = new URL('node_modules/vite/bin/vite.js', ROOT).pathname;
  const child = spawn(process.execPath, [viteBin, 'preview', '--port', '5181', '--strictPort', '--host', '127.0.0.1'], { cwd: new URL('apps/pos/', ROOT), stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    if (await reachable(URL_BASE)) return child;
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('미리보기 서버를 띄우지 못했다: ' + URL_BASE);
}

async function main() {
const server = await ensureServer();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const report = [];
let failures = 0;
try {
  for (const size of [...SIZES, ...EXTRA]) {
    // 서비스 워커는 막는다(화면 검사는 매번 새 빌드를 받는다; 오프라인 열기는 scripts/check-pwa.mjs가 본다).
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const shoot = async (scene) => {
      const file = size.name + '-' + scene + '.png';
      await page.screenshot({ path: new URL(file, OUT).pathname });
      const result = await page.evaluate(measure, { minFont: size.minFont, minTarget: size.minTarget, lateRgb: LATE_RGB });
      const found = problems(result);
      const extra = EXTRA.includes(size);
      if (!extra) failures += Object.keys(found).length;
      report.push({ size: size.name, scene, file, dialog: result.dialog, primaries: result.primaries.length, extra, problems: found });
    };
    const counter = async (act) => {
      const desk = await context.newPage();
      await desk.setViewportSize({ width: first.width, height: first.height });
      try { await act(desk); } finally { await desk.close(); }
    };
    try {
      if (size.kind === 'driver') await driverScenes(page, shoot, counter);
      else await posScenes(page, shoot);
    } catch (error) {
      report.push({ size: size.name, scene: 'error', problems: { run: [{ text: String(error.message ?? error).slice(0, 300) }] } });
      if (!EXTRA.includes(size)) failures += 1;
    }
    if (errors.length) {
      report.push({ size: size.name, scene: 'console', problems: { console: errors.map((text) => ({ text })) } });
      if (!EXTRA.includes(size)) failures += 1;
    }
    await context.close();
  }
} finally {
  await browser.close();
  server?.kill();
}

writeFileSync(new URL('report.json', OUT), JSON.stringify({ generatedAt: new Date().toISOString(), url: URL_BASE, report }, null, 2));
for (const entry of report) {
  const keys = Object.keys(entry.problems ?? {});
  const tag = entry.extra ? ' (참고)' : '';
  console.log((keys.length ? '✗ ' : '✓ ') + entry.size + ' ' + entry.scene + tag + (keys.length ? '  ' + keys.map((k) => (LABELS[k] ?? k) + ' ' + entry.problems[k].length).join(' · ') : ''));
  for (const k of keys) for (const p of entry.problems[k].slice(0, 4)) console.log('    ' + (LABELS[k] ?? k) + ': ' + JSON.stringify(p));
}
const scenesChecked = report.filter((e) => e.file && !e.extra).length;
console.log('\n검사 장면 ' + scenesChecked + '개(참고 크기 제외) · 어긋남 ' + failures + '건 · 찍은 화면: ' + OUT.pathname);
process.exitCode = failures ? 1 : 0;
}

// 다른 스크립트가 measure만 가져다 쓸 때는 돌지 않는다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
