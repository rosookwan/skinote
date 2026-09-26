// 둘째 판 시안 맞춤 검사(work/impl-v2/plan.md 6절). npm run match -w @skinote/pos
// 채택한 코드 시안(docs/design/screens-v2)의 명세 spec.json이 화면마다 적어 둔 주 버튼 글(primary)과 꼭 보여야 할 글(mustShow,
// 상태 변형 variants 포함)이 앱 화면에도 그대로 있는지 본다. 명세의 checkFrames(설치한 앱의 1024×569 · 1024×529, 기사 1024×520 …)도 그 크기로
// 같은 장면을 돌려 본다(틀마다 mustShow가 있으면 그것, 없으면 그 상태의 mustShow). 앱을 체험 자료로 열어 시안의 시각까지 체험 시계를 돌리고(뒷이야기 사건이
// 그 사이의 일을 적는다, fixture/story.ts), 그 화면 · 창을 연 뒤 글을 잰다. 크기는 시안의 틀(포스 1024×600, 기사 1024×600).
// 화면 규칙(글자 크기 · 누르는 곳 · 넘침)은 check-ui-rules.mjs가 13개 크기에서 본다. 여기서는 글과 예시 자료만 본다.
// 단계마다 자기 화면의 장면(SCENES)을 더한다. 장면이 없는 화면은 '아직'으로 적고 실패로 세지 않는다.
// 설계 문서와 시안이 달라 문서를 따른 글은 DIFFERENCES에 까닭과 함께 적는다(검사가 그 글을 기대하지 않음).
// 체험 자료는 첫 매장 모양이다(2026-09-26 사장님 답, README D7): 번호 스티커 · 권 번호가 없어 모든 품목을 수량으로 세고(V1 −/+),
// 손님 권 보증금이 없다(V1 · V2 · V3 · V4 · V6 · V8의 보증금 글). 시안은 번호 · 보증금 매장으로 그린 것이라 그 글은 DIFFERENCES에 적었다.
// SKINOTE_MATCH_SHOP=numbered면 번호 · 권 보증금을 켠 견본 매장(?shop=numbered, 시안이 그린 매장)으로 같은 장면을 돌리고 첫 매장의 까닭(번호 없음 ·
// 보증금 없음)을 빼고 시안의 글 그대로를 기대한다(2026-09-26 검토: 보증금 변형의 시안 글이 까닭 목록에만 덮여 있지 않게).
// 빌드하지 않는다: 먼저 npm run build. 환경 변수: SKINOTE_MATCH_PORT(기본 5184), SKINOTE_MATCH_ONLY(V1,V9 …), SKINOTE_MATCH_SHOP(numbered).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const APP = fileURLToPath(new URL('../', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SPEC = JSON.parse(readFileSync(join(REPO, 'docs/design/screens-v2/spec.json'), 'utf8'));
const OUT = join(REPO, 'work/impl-v2/match');
const PORT = Number(process.env.SKINOTE_MATCH_PORT ?? 5184) || 5184;
const BASE = 'http://127.0.0.1:' + PORT + '/';
const ONLY = (process.env.SKINOTE_MATCH_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/** 체험 자료의 매장 모양: 첫 매장(기본) · 견본 매장(numbered: 번호 · 권 보증금, 시안이 그린 매장). */
const SHOP = process.env.SKINOTE_MATCH_SHOP === 'numbered' ? 'numbered' : 'first';
const SHOP_QUERY = SHOP === 'numbered' ? '?shop=numbered' : '';
/** 시안의 틀(포스 1024×600, 기사도 1024×600에서 그림). checkFrames는 그 크기로 따로. */
const FRAME = { width: 1024, height: 600 };

/**
 * 화면(V1 …)마다 그 시안의 순간으로 가는 장면. (page, h) → 그 화면 · 창이 열린 상태로 끝낸다.
 * variant 키('all' · 'store' …)마다 따로 두면 그 상태 변형도 잰다. 단계가 채운다(plan.md 5절 표의 '맞춤 장면').
 * 예) V1: { default: async (page, h) => { await h.clockTo(21, 30); await h.open('#/orders/o22'); … }, all: … }
 */
const SCENES = {
  // V1 반납 확인 창(3단계): 21:30 박준호 팀 접수증 → 처리 현황 `반납`(모든 줄) → 알림 `1호 차량 수거 예정 · 22:00` → `매장 반납 처리`.
  // #all은 처음 연 상태(모두 골라짐), 그린 상태는 안 가져온 보드 1 · 헬멧 1 · 권 1매를 뺀 뒤(첫 매장은 번호가 없어 칸마다 −, 시안은 5 · 15 · 33번).
  V1: {
    default: async (page, h) => {
      await openReturn(page, h);
      if (SHOP === 'numbered') {
        // 견본 매장: 안 가져온 번호(보드 5 · 헬멧 15 · 권 33번)를 눌러 뺀다(시안 그대로).
        for (const no of ['5번', '15번', '33번']) {
          await page.locator('.pos-return .sn-piece', { hasText: new RegExp('^' + no + '$') }).first().click();
          await h.settle();
        }
        return;
      }
      for (const item of ['보드', '헬멧', '야간권 성인']) {
        await page.locator('.pos-return [role="group"][aria-label="' + item + ' 수량"] button[aria-label="수량 감소"]').click();
        await h.settle();
      }
    },
    all: async (page, h) => { await openReturn(page, h); },
  },
  // V2 · V3 새 접수(4단계): 16:25 이민호 팀 — 대표자 · 연락처 · 4명, 스키 4 · 의류 95 × 2 · 100 × 1 · 헬멧 중 1 · 야간권 4매, 의류 100을 연 채.
  // V3은 그 초안으로 `다음 · 일정`. 체험 시계는 10분씩 돌므로 16:20에서 이 페이지의 시계만 5분 앞으로 민다(page.clock).
  V2: { default: async (page, h) => { await openNewOrder(page, h); } },
  V3: {
    default: async (page, h) => {
      await openNewOrder(page, h);
      await page.locator('.pos-new-side [data-primary="true"]').click();
      await page.waitForSelector('.pos-new-schedule');
    },
  },
  // V4 접수 확정 창(5단계): V2 · V3의 초안(16:25 이민호 팀) → `다음 · 결제`. 그린 상태는 장비 `후불` → 결제 팀 `이정호 · 0032`,
  // #card는 처음 연 상태(장비 카드 · 리프트권 현금, 칸의 기본 수단).
  V4: {
    default: async (page, h) => {
      await openCheckout(page, h);
      await page.locator('.pos-checkout').getByRole('group', { name: '장비 결제 수단' }).getByRole('button', { name: '후불', exact: true }).click();
      await h.settle();
      // 결제 팀 줄의 다른 팀은 이 창에서 끝 4자리로 찾은 팀만 보인다(검토 반영): `다른 팀 찾기 · 끝 4자리` → 0032 → 찾기(카운터 자판).
      await page.locator('.pos-checkout').getByRole('button', { name: '다른 팀 찾기 · 끝 4자리', exact: true }).click();
      await page.waitForSelector('.sn-keypad');
      await page.keyboard.type('0032');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.sn-keypad', { state: 'detached' });
      await h.settle();
    },
    card: async (page, h) => { await openCheckout(page, h); },
  },
  // V5 일괄 수납(6단계): 16:40 이정호 팀 접수증 → 처리 현황 `수납` → 일괄 수납(6팀 485,000원). #part는 이민호 팀 `부분 결제 ›` → 처음(남은
  // 것 모두)에서 의류 95 × 2 · 100 × 1을 빼고 `선택 · 165,000원`(425,000원).
  V5: {
    default: async (page, h) => { await openGroupPay(page, h); },
    part: async (page, h) => {
      await openGroupPay(page, h);
      await page.locator('.pos-group-table tr', { hasText: '0042' }).locator('.pos-group-part').click();
      await page.waitForSelector('.pos-partial');
      await h.settle();
      const minus = (item) => page.locator('.pos-partial [role="group"][aria-label="' + item + ' 수량"] button[aria-label="수량 감소"]');
      for (const [item, n] of [['의류 사이즈 95', 2], ['의류 사이즈 100', 1]]) for (let i = 0; i < n; i += 1) { await minus(item).click(); await h.settle(); }
      await page.locator('.pos-partial [data-primary="true"]').click();
      await page.waitForSelector('.pos-partial', { state: 'detached' });
      await h.settle();
    },
  },
  // V6 하루 마감(8단계): 27일 00:40(00:15 정하늘 반납 · 00:32 차량 현금 점검 뒤)의 마감 화면. #drawer는 돈통을 세기 전, 그린 상태는 주 버튼
  // `돈통 점검` → 점검 판에 540,000원(첫 매장은 보증금이 없어 시안의 545,000원 − 5,000원) → 판의 주 버튼(마감 차례). #before는 00:31(00:32 점검
  // 전): 체험 시계를 00:30으로 돌리고 이 페이지의 시계만 1분 앞으로(page.clock).
  V6: {
    default: async (page, h) => {
      await openClosing(page, h);
      await page.locator('.sn-footer [data-primary="true"]').click();
      await page.waitForSelector('.pos-cash-check');
      // 첫 매장 540,000원(보증금 없음), 견본 매장은 시안의 545,000원(보증금 5,000원 포함).
      for (const key of SHOP === 'numbered' ? ['5', '4', '5', '000'] : ['5', '4', '0', '000']) await page.locator('.pos-cash-check').getByRole('button', { name: key, exact: true }).click();
      await h.settle();
      await page.locator('.pos-cash-check [data-primary="true"]').click();
      await page.waitForSelector('.pos-cash-check', { state: 'detached' });
      await h.settle();
    },
    before: async (page, h) => {
      await page.clock.install();
      await h.clockTo(0, 30, 1);
      await page.clock.fastForward('01:00');
      await h.open('#/closing/2026-12-26', '.pos-closing-table');
    },
    drawer: async (page, h) => { await openClosing(page, h); },
  },
  // V7 기사 업무 판(7단계): 16:55 기사 태블릿 배달 목록 → 최하은 팀 칸 → 업무 판(16:40 적재, 배달 미처리). 체험 시계는 10분씩 돌므로 16:40에서
  // 이 페이지의 시계만 앞으로 민다(page.clock). #offline은 16:48에 기사 기기의 연결을 끊고(나가기 `연결 해제`) 수거 목록에서 순서 변경 둘
  // (▼ · ▲, 보냄 대기 2)을 한 뒤 16:55의 업무 판: 띠 `연결 끊김 · 전송 대기 2 · 마지막 연결 16:48`.
  V7: {
    default: async (page, h) => { await openTask(page, h); },
    offline: async (page, h) => { await openTask(page, h, true); },
  },
  // V8 매장 설정 · 운영 규칙(9단계): 15:40 관리 → 매장 설정. 시안의 그린 상태는 저장하지 않은 세 곳(전: 반납 선택 · 반납 시 기록 · 보증금 미사용 ·
  // 00:00)이다. 장면은 시안의 전 값을 먼저 저장해 두고 이 매장 값으로 되돌린다. 첫 매장(2026-09-26)의 저장된 값은 반납 필수 · 보증금 미사용 ·
  // 06:00이라 되돌리는 곳은 두 곳이다(`변경 2건` · `저장 · 2건`, 보증금 카드는 `미사용` 한 줄): 보증금 줄의 글은 DIFFERENCES.
  V8: {
    default: async (page, h) => {
      await h.open('#/manage', '.pos-manage-card');
      await page.locator('.pos-manage-card', { hasText: '매장 설정' }).click();
      await page.waitForSelector('.sn-rule-card');
      await h.settle();
      // 카드가 두 쪽이면(1024×569 · 529) 그 카드가 있는 쪽으로 가서 누르고, 끝에는 첫 쪽으로 돌아온다(틀의 mustShow `1 / 2쪽`).
      const first = async () => {
        const prev = page.locator('.sn-footer').getByRole('button', { name: '이전 쪽' });
        while (await prev.count() && await prev.isEnabled()) { await prev.click(); await h.settle(); }
      };
      const toCard = async (card) => {
        for (let guard = 0; guard < 4 && !(await page.locator('.sn-rule-card[aria-label="' + card + '"]').count()); guard += 1) {
          await page.locator('.sn-footer').getByRole('button', { name: '다음 쪽' }).click();
          await h.settle();
        }
      };
      const press = async (card, name) => {
        await first();
        await toCard(card);
        await page.locator('.sn-rule-card[aria-label="' + card + '"]').getByRole('button', { name, exact: true }).click();
        await h.settle();
      };
      await press('리프트권 반납', '반납 선택 · 반납 시 기록');
      await press('리프트권 보증금', '미사용');
      await press('영업일 기준 시각', '00:00');
      await page.locator('.sn-footer [data-primary="true"]').click();
      await page.locator('[role="dialog"] [data-primary="true"]').click();
      await page.waitForSelector('[role="dialog"]', { state: 'detached' });
      await h.settle();
      await press('리프트권 반납', '반납 필수');
      // 견본 매장의 저장된 값은 보증금 사용: 되돌리는 곳이 시안처럼 셋(`변경 3건`).
      if (SHOP === 'numbered') await press('리프트권 보증금', '사용');
      await press('영업일 기준 시각', '06:00');
      await first();
    },
  },
  // V9 일정 변경(2단계): 19:40 박준호 팀 접수증 → 옆 동작 `일정 변경`(좁으면 더 보기 안) → 보드 · 헬멧 · 권 1씩 → 솔마을 › → 두솔동.
  V9: {
    default: async (page, h) => { await openPromise(page, h); },
    store: async (page, h) => {
      await openPromise(page, h);
      await page.locator('.pos-promise').getByRole('button', { name: '매장 직접', exact: true }).click();
    },
  },
};

/** V1 시안의 순간(21:30, 박준호 팀이 매장에 옴): 반납 창을 모든 줄로 연다. */
async function openReturn(page, h) {
  await h.clockTo(21, 30);
  await h.open('#/orders/o22', '.sn-slip');
  await page.locator('.pos-side .sn-check-press', { hasText: '반납' }).first().click();
  await h.settle();
  await page.locator('[role="dialog"]').getByRole('button', { name: '매장 반납 처리', exact: true }).click();
  await page.waitForSelector('.pos-return');
  await h.settle();
}

/** V2 시안의 순간(16:25): 새 접수에 이민호 팀의 초안을 화면이 누르는 길 그대로 넣는다. */
async function openNewOrder(page, h) {
  await page.clock.install();
  await h.clockTo(16, 20);
  await page.clock.fastForward('05:00');
  await h.open('#/orders/new', '.pos-new-kinds');
  await page.locator('.pos-new-field.is-name').click();
  // 대표자는 화면 키보드(편집 칸 없음): 카운터 자판의 두벌식 자리로 ㅇ ㅣ ㅁ ㅣ ㄴ ㅎ ㅗ = 이민호.
  for (const code of ['KeyD', 'KeyL', 'KeyA', 'KeyL', 'KeyS', 'KeyG', 'KeyH']) await page.keyboard.press(code);
  await page.locator('.sn-kb [data-primary="true"]').click();
  await page.locator('.pos-new-field.is-phone').click();
  await page.keyboard.type('01000000042');
  await page.getByRole('dialog').getByRole('button', { name: '입력', exact: true }).click();
  await h.settle();
  for (let i = 0; i < 4; i += 1) await page.locator('.pos-new-people').getByRole('button', { name: '수량 증가' }).click();
  const tile = async (name) => {
    const hit = page.locator('.pos-new-kinds .sn-kind', { has: page.locator('.sn-kind-name', { hasText: new RegExp('^' + name + '$') }) });
    for (let guard = 0; guard < 4 && !(await hit.count()); guard += 1) await page.locator('.sn-footer').getByRole('button', { name: '다음 쪽' }).click();
    await hit.click();
    await h.settle();
  };
  const variant = async (re) => { await page.locator('.pos-new-open .sn-choice', { hasText: re }).click(); await h.settle(); };
  const add = async (n) => { for (let i = 0; i < n; i += 1) { await page.locator('.pos-new-open').getByRole('button', { name: '수량 증가' }).click(); await h.settle(); } };
  await tile('스키'); await add(4);
  await tile('의류'); await variant(/^95/); await add(2); await variant(/^100/); await add(1);
  await tile('헬멧'); await variant(/^중/); await add(1);
  await tile('리프트권'); await variant(/^야간권/); await add(4);
  const back = page.locator('.sn-footer').getByRole('button', { name: '이전 쪽' });
  while (await back.count() && await back.isEnabled()) await back.click();
  await tile('의류'); await variant(/^100/);
}

/** V4 시안의 순간(16:25 초안 → ② 일정 → ③ 결제): 접수 확정 창을 칸의 기본 수단으로 연다. */
async function openCheckout(page, h) {
  await openNewOrder(page, h);
  await page.locator('.pos-new-side [data-primary="true"]').click();
  await page.waitForSelector('.pos-new-schedule');
  await h.settle();
  await page.locator('.pos-new-side [data-primary="true"]').click();
  await page.waitForSelector('.pos-checkout');
  await h.settle();
}

/** V5 시안의 순간(16:40, 새 접수 네 팀 지급 뒤): 이정호 팀 접수증의 처리 현황 `수납`으로 일괄 수납을 연다. */
async function openGroupPay(page, h) {
  await h.clockTo(16, 40);
  await h.open('#/orders/o32', '.sn-slip');
  const row = page.locator('.pos-side .sn-check-press', { hasText: '수납' });
  if (await row.count()) await row.first().click();
  else await page.locator('.pos-side-actions').getByRole('button', { name: '수납', exact: true }).click();
  await page.waitForSelector('.pos-group-table');
  await h.settle();
}

/** V6 시안의 순간(27일 00:40, 차량 현금 점검 뒤 · 돈통 점검 전): 장부의 주 버튼 `마감`(24:00 뒤)으로 마감 화면을 연다. */
async function openClosing(page, h) {
  await h.clockTo(0, 40, 1);
  await h.open('#/ledger/2026-12-26', '.sn-ledger tr.sn-row');
  await page.locator('.sn-footer [data-primary="true"]').click();
  await page.waitForSelector('.pos-closing-table');
  await h.settle();
}

/** V7 시안의 순간(16:55, 기사 태블릿): 배달 목록의 최하은 팀 칸 → 업무 판. offline이면 16:48에 끊고 보냄 대기 둘. */
async function openTask(page, h, offline = false) {
  await page.clock.install();
  await h.clockTo(16, 40);
  if (offline) {
    await page.clock.fastForward('08:00');
    await h.open('#/exit?from=driver', '.pos-card');
    await page.getByRole('button', { name: '연결 해제', exact: true }).click();
    await h.settle();
    // 16:30 묶음(김민재 · 이수진, 수거 완료)의 첫 줄을 아래로 · 위로: 순서 변경 둘이 보냄 대기에 쌓인다.
    await h.open('#/driver/2026-12-26', '.sn-ledger tr.sn-row');
    await page.locator('.sn-ledger tr.sn-row .sn-cell-open').first().click();
    await h.settle();
    await page.getByRole('toolbar').getByRole('button', { name: '아래로', exact: true }).click();
    await h.settle();
    await page.getByRole('toolbar').getByRole('button', { name: '위로', exact: true }).click();
    await h.settle();
    await page.clock.fastForward('07:00');
  } else {
    await page.clock.fastForward('15:00');
  }
  await h.open('#/driver/2026-12-26/deliveries', '.sn-ledger tr.sn-row');
  await page.locator('.sn-ledger tr.sn-row .sn-cell-open').first().click();
  await page.waitForSelector('.pos-task-sheet');
  await h.settle();
}

/** V9 시안의 순간(19:40, 스키 0 · 보드 1 · 헬멧 1 · 권 1매 → 22:00 솔마을 두솔동 · 1호 차량). */
async function openPromise(page, h) {
  await h.clockTo(19, 40);
  await h.open('#/orders/o22', '.sn-slip');
  const side = page.locator('.pos-side-actions').getByRole('button', { name: '일정 변경', exact: true });
  if (await side.count()) await side.click();
  else {
    await page.locator('.pos-side-actions').getByRole('button', { name: '더 보기' }).click();
    await page.locator('[role="dialog"]').getByRole('button', { name: '일정 변경', exact: true }).click();
  }
  await page.waitForSelector('.pos-promise');
  const plus = (item) => page.locator('.pos-promise [role="group"][aria-label="' + item + ' 수량"] button[aria-label="수량 증가"]');
  for (const item of ['보드', '헬멧', '야간권 성인']) { await plus(item).click(); await h.settle(); }
  await page.locator('.pos-promise').getByRole('button', { name: /^솔마을/ }).click();
  await h.settle();
  await page.locator('.pos-promise').getByRole('button', { name: '두솔동', exact: true }).click();
  await h.settle();
}

/** 시안의 글 중 설계 문서를 따라 앱이 다르게 쓰는 것(화면 · 글 → 까닭). 검사는 이 글을 기대하지 않는다. */
/** 첫 매장(2026-09-26 사장님 답, README D7)의 까닭 두 가지. */
const NO_NUMBERS = '첫 매장은 장비 관리 번호 · 권 번호가 없어 모든 칸이 −/+ 수량(README D7 1 · 2, ui 3-1 count)';
const NO_DEPOSIT = '첫 매장은 손님 권 보증금이 없음(권 카드 1,000원은 스키장 권 값 안의 돈, README D7 3 · 4)';

const DIFFERENCES = {
  V1: {
    // 2026-09-25 검토: 접수증 일정 줄은 누르는 곳이 아니라(21px 글 줄, 52px 누르는 곳을 둘 자리 없음) `›`를 뺐다. 일정 변경은 옆 동작
    // `일정 변경`(plan §8 D90). 앱의 글은 `수령 16:00 · 매장 · 반납 일정 2건`.
    '수령 16:00 · 매장 · 반납 일정 2건 ›': '일정 줄 `›` 뺌(누르는 곳 아님), plan §8 D90',
    // 첫 매장: 번호 버튼 대신 −/+(앱 ① `전체 선택 · 미반납 수량 감소`, wording.md 3-18 확인 대기), ④ ⑤ 줄 없음(창이 96 짧음, spec 3-1).
    '전체 선택 · 미반납 번호 해제': NO_NUMBERS + ' → 앱 `전체 선택 · 미반납 수량 감소`',
    '17번': NO_NUMBERS, '18번': NO_NUMBERS, '5번': NO_NUMBERS, '12번': NO_NUMBERS, '14번': NO_NUMBERS, '15번': NO_NUMBERS,
    '31번': NO_NUMBERS, '32번': NO_NUMBERS, '33번': NO_NUMBERS,
    // 일정이 하나인 수량 칸의 둘째 줄은 차량 수거 장소만(−/+의 수와 같은 수를 두 번 쓰지 않음, 2026-09-26 검토): `설천` · `두솔동`.
    '설천 2대': NO_NUMBERS + ' → 수량 칸 둘째 줄 `설천`', '두솔동 1대': NO_NUMBERS + ' → 수량 칸 둘째 줄 `두솔동`',
    '권 2매 보증금 10,000원 반환 · 매장 기준 1매 5,000원 · 잔여 보증금 5,000원(권 1매)': NO_DEPOSIT,
    '권 3매 보증금 15,000원 반환 · 매장 기준 1매 5,000원 · 잔여 보증금 없음': NO_DEPOSIT,
    '반환 방법': NO_DEPOSIT, '현금': NO_DEPOSIT + '(반환 방법 버튼)',
    '미수 차감 · 120,000원 → 110,000원': NO_DEPOSIT, '미수 차감 · 120,000원 → 105,000원': NO_DEPOSIT,
    '반납 처리 · 스키 2 · 헬멧 2 · 권 2매 · 보증금 10,000원': NO_DEPOSIT + ' → 앱 `반납 처리 · 스키 2 · 헬멧 2 · 권 2매`',
    '반납 처리 · 6개 · 3매 · 보증금 15,000원': NO_DEPOSIT + ' → 앱 `반납 처리 · 6개 · 3매`',
  },
  V2: {
    '보증금 · 매장 기준 1매 5,000원': NO_DEPOSIT + ' → 앱 권 줄 둘째 줄 `1매 35,000원`',
    '보증금 · 별도 20,000원': NO_DEPOSIT + '(합계 아래 줄 없음)',
  },
  V3: {
    '야간권 4매 · 보증금 20,000원 별도': NO_DEPOSIT + ' → 앱 `야간권 4매`',
  },
  V4: {
    '리프트권 보증금': NO_DEPOSIT + '(보증금 칸 없음, 칸 둘)',
    '4매 · 매장 기준 1매 5,000원 · 반납 시 반환': NO_DEPOSIT,
    '현금 20,000원': NO_DEPOSIT,
    '받을 금액 현금 160,000원 = 리프트권 140,000원 + 보증금 20,000원': NO_DEPOSIT + ' → 앱 `받을 금액 현금 140,000원`',
    '받을 금액 카드 225,000원 · 현금 160,000원 (현금 중 보증금 20,000원)': NO_DEPOSIT + ' → 앱 `받을 금액 카드 225,000원 · 현금 140,000원`',
    '접수 확정 · 현금 160,000원': NO_DEPOSIT + ' → 앱 `접수 확정 · 현금 140,000원`',
    '접수 확정 · 카드 225,000원 · 현금 160,000원': NO_DEPOSIT + ' → 앱 `접수 확정 · 카드 225,000원 · 현금 140,000원`',
  },
  V6: {
    '예상 545,000원 · 보증금 5,000원 포함': NO_DEPOSIT + ' → 앱 `예상 540,000원`(시재 100,000 + 현금 수납 440,000)',
    '실제 545,000원 · 차액 0원': NO_DEPOSIT + ' → 앱 `실제 540,000원 · 차액 0원`',
    '이월 항목 · 5': NO_DEPOSIT + '(보증금 보관 중 줄 없음) → 앱 `이월 항목 · 4`',
    '보증금 보관 중 · 리프트권 1매 · 5,000원': NO_DEPOSIT + '(안 돌아온 권은 청구 없이 `리프트권 미반납 · 1매 · 지연`만)',
    '최하은 · 0026 · 돈통 보관': NO_DEPOSIT,
  },
  V8: {
    // 첫 매장의 저장된 값은 보증금 미사용: 되돌리는 곳이 두 곳이고, 보증금 카드는 `미사용` + 회색 한 줄 `보증금 미사용`.
    '1매 5,000원 ›': NO_DEPOSIT + '(보증금 미사용이면 값 버튼 없음)',
    '입금 시점': NO_DEPOSIT + '(보증금 미사용이면 줄 없음)', '접수 시': NO_DEPOSIT, '미입금: 지급 시': NO_DEPOSIT, '지급 시': NO_DEPOSIT,
    '미반납 시': NO_DEPOSIT, '보증금 몰수': NO_DEPOSIT, '분실금 청구': NO_DEPOSIT, '보증금 공제': NO_DEPOSIT,
    '변경 3건 · 다음 기록부터 적용': '첫 매장 저장 값(보증금 미사용)으로 되돌리는 곳이 둘 → 앱 `변경 2건 · 다음 기록부터 적용`',
    '저장 · 3건': '첫 매장 저장 값으로 되돌리는 곳이 둘 → 앱 `저장 · 2건`',
    '1 / 2쪽': '보증금 미사용 카드가 짧아(한 줄 + 회색 한 줄) 1024×569 · 529에서도 카드가 한 쪽에 들 수 있음',
  },
};

const norm = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

async function reachable(url) {
  try { return (await fetch(url)).ok; } catch { return false; }
}

async function startPreview() {
  if (await reachable(BASE)) throw new Error('포트 ' + PORT + '을 이미 다른 것이 쓰고 있습니다. SKINOTE_MATCH_PORT로 다른 포트를 고르세요.');
  const require = createRequire(import.meta.url);
  const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const child = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  child.on('exit', () => { exited = true; });
  for (let i = 0; i < 100; i += 1) {
    if (exited) throw new Error('미리보기 서버가 멈췄습니다(포트 ' + PORT + ')');
    if (await reachable(BASE)) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('미리보기 서버를 띄우지 못했습니다: ' + BASE);
}

/** 장면이 쓰는 도우미: 경로 열기, 체험 시계 맞추기(나가기 화면의 +1시간 · +10분), 화면이 가라앉기를 기다리기. */
function helpers(page) {
  const settle = () => page.evaluate(() => new Promise((resolve) => {
    let last = performance.now();
    const start = last;
    const observer = new MutationObserver(() => { last = performance.now(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const tick = () => {
      const now = performance.now();
      if ((now - last > 80 && now - start > 40) || now - start > 3000) { observer.disconnect(); resolve(); }
      else requestAnimationFrame(tick);
    };
    document.fonts.ready.then(() => requestAnimationFrame(tick));
  }));
  const open = async (hash, selector = 'body') => { await page.goto(BASE + SHOP_QUERY + hash); await page.waitForSelector(selector); await settle(); };
  /** 체험 시계를 12월 26일(dayOffset 0) 또는 27일(1)의 hh:mm까지 앞으로(분 단위는 10분으로 내림). */
  const clockTo = async (hh, mm, dayOffset = 0) => {
    await open('#/exit', '.pos-card');
    const text = await page.locator('.pos-card-line').first().textContent();
    const m = /(\d{2}):(\d{2})/.exec(text ?? '');
    if (!m) throw new Error('체험 시계를 읽지 못했습니다: ' + text);
    const now = Number(m[1]) * 60 + Number(m[2]);
    const target = dayOffset * 24 * 60 + hh * 60 + mm;
    let minutes = Math.max(0, target - now);
    for (; minutes >= 60; minutes -= 60) await page.getByRole('button', { name: '+1시간', exact: true }).click();
    for (; minutes >= 10; minutes -= 10) await page.getByRole('button', { name: '+10분', exact: true }).click();
    await settle();
  };
  return { page, settle, open, clockTo };
}

/** 지금 화면(창이 열려 있으면 창과 뒤 화면 모두)의 글과 주 버튼. */
async function readScreen(page) {
  return page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const primaries = [...document.querySelectorAll('[data-primary="true"]')].filter(visible).map((el) => el.textContent ?? '');
    const dialog = [...document.querySelectorAll('[role="dialog"]')].filter(visible).at(-1);
    return { text: document.body.innerText, primary: dialog ? (dialog.querySelector('[data-primary="true"]')?.textContent ?? '') : primaries.at(-1) ?? '' };
  });
}

/** 첫 매장만의 까닭(번호 없음 · 보증금 없음 · 첫 매장 저장 값): 견본 매장 걸음에서는 시안의 글 그대로를 기대한다. */
const FIRST_ONLY = (reason) => reason.startsWith(NO_NUMBERS) || reason.startsWith(NO_DEPOSIT) || reason.startsWith('첫 매장') || reason.startsWith('보증금 미사용 카드');

function compare(code, expected, got) {
  const skip = new Set(Object.entries(DIFFERENCES[code] ?? {}).filter(([, reason]) => SHOP === 'first' || !FIRST_ONLY(reason)).map(([text]) => text));
  const text = norm(got.text);
  const missing = (expected.mustShow ?? []).filter((s) => !skip.has(s) && !text.includes(norm(s)));
  const primaryOk = !expected.primary || skip.has(expected.primary) || norm(got.primary) === norm(expected.primary);
  return { missing, primary: primaryOk ? null : { expected: expected.primary, got: norm(got.primary) } };
}

async function main() {
  if (!existsSync(join(APP, 'dist/index.html'))) {
    console.error('빌드한 앱이 없습니다. 먼저 npm run build 를 실행하세요.');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  if (SHOP === 'numbered') console.log('견본 매장(번호 · 권 보증금, ?shop=numbered): 첫 매장의 까닭 없이 시안의 글 그대로');
  const screens = SPEC.screens.filter((s) => !ONLY.length || ONLY.includes(s.code));
  const server = await startPreview();
  const browser = await chromium.launch();
  let failed = 0;
  let pending = 0;
  let checked = 0;
  try {
    for (const screen of screens) {
      const scenes = SCENES[screen.code];
      if (!scenes) { pending += 1; console.log('· ' + screen.code + ' ' + screen.title + ' — 장면 아직'); continue; }
      const base = [{ key: 'default', primary: screen.primary, mustShow: screen.mustShow }, ...(screen.variants ?? [])].map((st) => ({ ...st, size: FRAME }));
      // 명세의 틀(checkFrames): 그 크기로 같은 장면(틀의 hash가 가리키는 상태, 없으면 기본). mustShow는 틀의 것, 없으면 그 상태의 것.
      const frames = (screen.checkFrames ?? []).map((f) => {
        const key = f.hash ? f.hash.replace(/^#/, '') : 'default';
        const st = base.find((x) => x.key === key) ?? base[0];
        return { ...st, key, size: { width: f.w, height: f.h }, mustShow: f.mustShow ?? st.mustShow };
      });
      for (const state of [...base, ...frames]) {
        const at = state.size === FRAME ? '' : ' @' + state.size.width + 'x' + state.size.height;
        const scene = scenes[state.key];
        if (!scene) { pending += 1; console.log('· ' + screen.code + ' #' + state.key + at + ' — 장면 아직'); continue; }
        const context = await browser.newContext({ viewport: state.size, locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
        const page = await context.newPage();
        try {
          const h = helpers(page);
          await h.open('#/', '.pos-card');
          await scene(page, h);
          await h.settle();
          const result = compare(screen.code, state, await readScreen(page));
          const bad = result.missing.length > 0 || result.primary !== null;
          await page.screenshot({ path: join(OUT, (SHOP === 'numbered' ? 'numbered-' : '') + screen.code + '-' + state.key + (at ? '-' + state.size.width + 'x' + state.size.height : '') + '.png') });
          if (bad) failed += 1;
          checked += 1;
          console.log((bad ? '✗ ' : '✓ ') + screen.code + ' #' + state.key + at);
          for (const s of result.missing) console.log('    없는 글: ' + s);
          if (result.primary) console.log('    주 버튼: ' + result.primary.got + ' (시안 ' + result.primary.expected + ')');
        } catch (error) {
          failed += 1;
          checked += 1;
          console.log('✗ ' + screen.code + ' #' + state.key + at + ' — ' + String(error?.message ?? error).split('\n')[0]);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('\n시안 맞춤: 장면 ' + checked + '개(틀 포함) · 어긋남 ' + failed + ' · 장면 아직 ' + pending + ' · 그림 ' + OUT);
  process.exitCode = failed ? 1 : 0;
}

await main();
