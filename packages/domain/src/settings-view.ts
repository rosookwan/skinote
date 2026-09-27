// 관리 · 매장 설정의 다른 탭(매장 정보 · 장소 · 반납 타임 · 요금 · 할인 · 차량 · 직원)의 읽기 모델(shopSettings, features-1 plan §4-4).
// V8(운영 규칙, shop-rules.ts)과 같은 모양이다: 카드 · 바뀐 곳(전 → 후) · 바닥줄(`변경 3건 · 다음 기록부터 적용` · `변경 없음`) · 주 버튼
// `저장 · 3건` · 명령 하나(차량 · 직원 탭은 목록 바꿈 뒤에 직원 바꿈을 then으로). 화면은 누른 버튼의 op를 초안으로 모아 다시 묻는다: 여기서
// 초안을 복사본에 차례로 적용해(settings.ts, 새 행은 'new:<ref>') 카드와 바뀐 곳을 새로 쓴다. 초안의 한 건이 거절되면 refused(그 차례와
// 한 줄)로 알리고 그 앞까지만 보인다. 목록 카드는 누르는 칸(항목)의 격자이고, 항목을 누르면 항목 판(이름 변경 · 숨김 · 위로 · 아래로 …)이
// 열린다 — 판의 버튼마다 초안에 넣을 op와 값을 받을 단계(화면 키보드 · 숫자판 · 고르기 판)가 여기서 온다. 화면은 규칙을 계산하지 않는다.
// 글은 문구 표(docs/design/wording.md 3-11 · 3-20)의 말이다.
import type {
  ConfirmCommand, ConfirmStep, RegistryOp, RuleCard, RuleChangeLine, RuleInput, SettingsAction, SettingsListItem, SettingsOp, SettingsSheet,
  SettingsStep, SettingsTabKey, ShopSettingsParams, ShopSettingsView, StaffOp,
} from '@skinote/contract';
import { productOf } from './catalog.ts';
import type { FxArea, FxReturnSlot, FxRoleKey, FxStaff, ShopRegistry, ShopState } from './model.ts';
import { phoneText } from './order-draft.ts';
import { slotTime } from './promise-sheet.ts';
import {
  applySettingsOps, draftOf, PREVIEW_IDS, SETTINGS_LINES, SETTINGS_RANGES, slotHideRefusal, vehicleEndRefusal, vehicleOpenTaskCounts, type SettingsDraft,
} from './settings.ts';
import { iso } from './time.ts';
import type { ViewContext } from './views.ts';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR') + '원';

/** 역할 이름(roles.label, 문구 표 3-20 `관리자` · `카운터` · `기사`). */
export const ROLE_LABELS: Readonly<Record<FxRoleKey, string>> = { manager: '관리자', counter: '카운터', driver: '기사' };
const ROLE_ORDER: readonly FxRoleKey[] = ['manager', 'counter', 'driver'];

/** 탭마다 저장에 필요한 권한(서버 permissions.js와 같은 key). */
const TAB_PERMISSIONS: Readonly<Record<SettingsTabKey, readonly string[]>> = {
  info: ['settings.manage'],
  places: ['settings.manage'],
  slots: ['settings.manage'],
  pricing: ['settings.manage', 'price_list.publish'],
  fleet: ['settings.manage', 'staff.manage'],
};

/** 문구 표 3-20의 말(이 파일의 화면 글). */
const W = {
  shopName: '매장 이름',
  phone: '전화',
  none: '없음',
  cutoff: '영업일 기준 시각',
  rulesLink: '운영 규칙',
  area: '구역',
  areaAdd: '구역 추가',
  areaName: '구역 이름',
  placeAdd: '장소 추가',
  placeName: '장소 이름',
  rename: '이름 변경',
  hide: '숨김',
  unhide: '숨김 해제',
  up: '위로',
  down: '아래로',
  order: '순서 변경',
  slots: '반납 타임',
  slotAdd: '반납 타임 추가',
  slotName: '반납 타임 이름',
  slotTime: '시각 변경',
  defaultTag: '기본',
  defaultSlot: '기본 반납 타임',
  nightNotice: '야간 수거 준비',
  vehicleLate: '차량 지연 기준',
  // 차량 지연 기준의 야간 밖(`주간 60분`): `기본`은 이 화면에서 기본 반납 타임의 이름표라 한 개념 한 말로 가른다(2026-09-27 점검, 3-20 확인 대기).
  lateBase: '주간',
  lateNight: '야간',
  discount: '할인',
  discountAdd: '할인 추가',
  discountName: '할인 이름',
  discountPercent: '할인 비율',
  discountAmount: '할인 금액',
  percent: '비율',
  amount: '금액',
  target: '대상',
  use: '사용',
  unused: '미사용',
  multiDay: '2일 이상 · 1일 금액 × 일수',
  vehicles: '차량',
  vehicleAdd: '차량 추가',
  vehicleName: '차량 이름',
  end: '사용 종료',
  reuse: '다시 사용',
  collection: '수거 목록',
  staff: '직원',
  staffAdd: '직원 추가',
  staffName: '직원 이름',
  role: '역할',
  vehicle: '차량',
  pinReset: '비밀번호 재발급',
  block: '기기 막기',
  save: '저장',
  noChange: '변경 없음',
  forbidden: '권한 없음 · 관리자 확인 필요',
} as const;

const minutes = (n: number) => n + '분';
const percentText = (n: number) => n + '%';
/** 반납 타임 글('야간 22:00'). */
const slotText = (s: Pick<FxReturnSlot, 'label' | 'hour' | 'minute'>) => s.label + ' ' + slotTime(s as FxReturnSlot);
/** 상품 값 글: 권은 `1매 35,000원`, 장비는 `1일 40,000원`. */
const priceText = (reg: Pick<ShopRegistry, 'products'>, productKey: string, price: number) => {
  const p = productOf(reg, productKey);
  return (p?.unit ? '1' + p.unit : '1일') + ' ' + won(price);
};

// ── 초안 적용 ──────────────────────────────────────────────────────────

interface Applied {
  before: SettingsDraft;
  after: SettingsDraft;
  /** 받아들인 초안(거절된 건부터 뺌). */
  ops: SettingsOp[];
  refused?: { at: number; message: string };
}

function applyDraft(ctx: ViewContext, changes: readonly SettingsOp[]): Applied {
  const state = ctx.state;
  const before = draftOf(state);
  let after = draftOf(state);
  const failed = applySettingsOps(state, after, changes, PREVIEW_IDS);
  if (!failed) return { before, after, ops: [...changes] };
  // 거절된 건 앞까지만 다시 적용(반쯤 바뀐 판이 남지 않게).
  after = draftOf(state);
  const ops = changes.slice(0, failed.at);
  applySettingsOps(state, after, ops, PREVIEW_IDS);
  const message = 'message' in failed.refusal ? failed.refusal.message : (ctx.lines?.unsupported ?? '미지원 기능 · 처리 불가');
  return { before, after, ops, refused: { at: failed.at, message } };
}

/** 다음 새 행의 ref(초안에 쓴 ref와 겹치지 않게). */
function nextRef(ops: readonly SettingsOp[]): string {
  let max = 0;
  for (const op of ops) {
    const ref = 'ref' in op ? op.ref : undefined;
    const n = ref && /^n(\d+)$/.test(ref) ? Number(ref.slice(1)) : 0;
    max = Math.max(max, n);
  }
  return 'n' + (max + 1);
}

// ── 버튼 · 단계 모양 ─────────────────────────────────────────────────────

const textStep = (field: string, title: string, value = ''): SettingsStep => ({
  kind: 'input', field, input: { key: field, mode: 'text', title, min: 1, max: SETTINGS_RANGES.label, value, maxLength: SETTINGS_RANGES.label },
});
const padStep = (field: string, input: Omit<RuleInput, 'key'>): SettingsStep => ({ kind: 'input', field, input: { key: field, ...input } });

const action = (key: string, label: string, run: SettingsAction['run'], extra: Partial<Pick<SettingsAction, 'enabled' | 'reason' | 'secondLine' | 'selected'>> = {}): SettingsAction => ({
  key, label, enabled: extra.enabled ?? true, run, ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.secondLine ? { secondLine: extra.secondLine } : {}),
  ...(extra.selected ? { selected: true } : {}),
});
const opRun = (op: SettingsOp, steps?: SettingsStep[]): SettingsAction['run'] => ({ kind: 'op', op, ...(steps?.length ? { steps } : {}) });
const sheetRun = (sheet: SettingsSheet): SettingsAction['run'] => ({ kind: 'sheet', sheet });

/** 목록의 위로 · 아래로(차례 index, 모두 n). */
function moveActions(index: number, n: number, op: (toIndex: number) => SettingsOp): SettingsAction[] {
  return [
    action('up', W.up, opRun(op(index - 1)), { enabled: index > 0 }),
    action('down', W.down, opRun(op(index + 1)), { enabled: index < n - 1 }),
  ];
}

const card = (key: string, title: string, changed: ReadonlySet<string>, extra: Partial<RuleCard> = {}): RuleCard => ({
  key, title, changed: changed.has(key), inline: false, rows: [], notes: [], ...extra,
});

// ── 탭마다의 카드 ─────────────────────────────────────────────────────────

function infoCards(d: SettingsDraft, changed: ReadonlySet<string>): RuleCard[] {
  const reg = d.registry;
  const nameInput: RuleInput = {
    key: 'name', mode: 'text', title: W.shopName, min: 1, max: SETTINGS_RANGES.label, value: reg.shopName, maxLength: SETTINGS_RANGES.label,
    op: { op: 'shop.set', name: '' }, field: 'name',
  };
  const phoneInput: RuleInput = { key: 'phone', mode: 'phone', title: W.phone, min: 0, max: 0, op: { op: 'shop.set', phone: '' }, field: 'phone' };
  return [
    card('info:name', W.shopName, changed, { rows: [{ key: 'name', options: [], value: { label: reg.shopName, input: nameInput } }] }),
    card('info:phone', W.phone, changed, { rows: [{ key: 'phone', options: [], value: { label: reg.shopPhone ? phoneText(reg.shopPhone) : W.none, input: phoneInput } }] }),
    card('info:cutoff', W.cutoff, changed, { rows: [{ key: 'cutoff', label: d.settings.businessDayCutoff, options: [], link: { label: W.rulesLink, to: 'rules' } }] }),
  ];
}

function placeSheet(area: FxArea, place: FxArea['places'][number], index: number): SettingsSheet {
  const id = place.id;
  return {
    title: place.label,
    lines: [],
    actions: [
      action('rename', W.rename, opRun({ op: 'place.rename', id, label: '' }, [textStep('label', W.placeName, place.label)])),
      action('hide', place.hidden ? W.unhide : W.hide, opRun({ op: 'place.hide', id, hidden: !place.hidden })),
      ...moveActions(index, area.places.length, (toIndex) => ({ op: 'place.move', id, toIndex })),
    ],
  };
}

function placesCards(d: SettingsDraft, ops: readonly SettingsOp[], changed: ReadonlySet<string>): RuleCard[] {
  const areas = d.registry.areas;
  const ref = nextRef(ops);
  const cards = areas.map((area, index): RuleCard => {
    const areaItem: SettingsListItem = {
      key: 'area:' + area.id,
      label: area.label,
      tag: area.hidden ? W.area + ' · ' + W.hide : W.area,
      lead: true,
      ...(area.hidden ? { muted: true } : {}),
      run: sheetRun({
        title: area.label,
        lines: [],
        actions: [
          action('rename', W.rename, opRun({ op: 'area.rename', id: area.id, label: '' }, [textStep('label', W.areaName, area.label)])),
          action('hide', area.hidden ? W.unhide : W.hide, opRun({ op: 'area.hide', id: area.id, hidden: !area.hidden })),
          ...moveActions(index, areas.length, (toIndex) => ({ op: 'area.move', id: area.id, toIndex })),
        ],
      }),
    };
    const places: SettingsListItem[] = area.places.map((p, i) => ({
      key: 'place:' + p.id, label: p.label, ...(p.hidden ? { tag: W.hide, muted: true as const } : {}), run: sheetRun(placeSheet(area, p, i)),
    }));
    return card('area:' + area.id, area.label, changed, {
      list: {
        items: [areaItem, ...places],
        add: { key: 'place-add:' + area.id, label: W.placeAdd, run: opRun({ op: 'place.add', ref, areaId: area.id, label: '' }, [textStep('label', W.placeName)]) },
      },
    });
  });
  const addInput: RuleInput = {
    key: 'area-add', mode: 'text', title: W.areaName, min: 1, max: SETTINGS_RANGES.label, value: '', maxLength: SETTINGS_RANGES.label,
    op: { op: 'area.add', ref, label: '' }, field: 'label',
  };
  cards.push(card('area-add', W.area, changed, {
    inline: true,
    adds: true,
    rows: [{ key: 'area-add', options: [{ key: 'add', label: W.areaAdd, selected: false, enabled: true }], inputs: { add: addInput } }],
  }));
  return cards;
}

function slotsCards(d: SettingsDraft, ops: readonly SettingsOp[], changed: ReadonlySet<string>): RuleCard[] {
  const slots = d.settings.returnSlots;
  const defaultKey = d.settings.defaultReturnSlotKey ?? slots.find((s) => !s.hidden)?.key;
  const ref = nextRef(ops);
  const timePad = (title: string): Omit<RuleInput, 'key'> => ({ mode: 'time', title, min: 0, max: 23 * 60 + 59 });
  const items: SettingsListItem[] = slots.map((s, index) => {
    const isDefault = s.key === defaultKey;
    const hideWhy = s.hidden ? undefined : slotHideRefusal(d.registry as ShopRegistry, d.settings, s);
    const tag = isDefault ? W.defaultTag : s.hidden ? W.hide : undefined;
    return {
      key: 'slot:' + s.key,
      label: slotText(s),
      ...(tag ? { tag } : {}),
      ...(s.hidden ? { muted: true as const } : {}),
      run: sheetRun({
        title: slotText(s),
        // 숨김이 막힌 까닭은 판 위의 온전한 한 줄(`숨김 불가 · 리프트권 반납 타임`): 버튼 둘째 줄의 뒤 조각만으로는 `리프트권 반납 타임을 숨김`으로 읽혔다.
        lines: hideWhy ? [hideWhy] : [],
        actions: [
          action('rename', W.rename, opRun({ op: 'slot.update', id: s.key, label: '' }, [textStep('label', W.slotName, s.label)])),
          action('time', W.slotTime, opRun({ op: 'slot.update', id: s.key, time: '' }, [padStep('time', timePad(W.slotTime + ' · ' + slotText(s)))])),
          action('default', W.defaultSlot, opRun({ op: 'setting.default_slot', slotId: s.key }), { enabled: !isDefault && !s.hidden }),
          action('hide', s.hidden ? W.unhide : W.hide, opRun({ op: 'slot.hide', id: s.key, hidden: !s.hidden }), {
            enabled: !hideWhy, ...(hideWhy ? { reason: hideWhy } : {}),
          }),
          ...moveActions(index, slots.length, (toIndex) => ({ op: 'slot.move', id: s.key, toIndex })),
        ],
      }),
    };
  });
  const notice = d.settings.nightNoticeMinutes ?? 60;
  const late = d.settings.vehicleLate ?? { minutes: 60, nightMinutes: 60 };
  const minutesInput = (title: string, max: number, op: RegistryOp, field: string): RuleInput => ({ key: field, mode: 'minutes', title, min: 0, max, op, field });
  return [
    card('slots', W.slots, changed, {
      list: {
        items,
        add: {
          key: 'slot-add', label: W.slotAdd,
          run: opRun({ op: 'slot.add', ref, label: '', time: '' }, [textStep('label', W.slotName), padStep('time', timePad(W.slotAdd))]),
        },
      },
    }),
    card('night-notice', W.nightNotice, changed, {
      rows: [{
        key: 'night-notice', options: [],
        value: {
          label: minutes(notice) + ' 전',
          input: minutesInput(W.nightNotice + ' · ' + minutes(notice) + ' 전', SETTINGS_RANGES.notice.max, { op: 'setting.night_notice', minutes: 0 }, 'minutes'),
        },
      }],
    }),
    card('vehicle-late', W.vehicleLate, changed, {
      rows: [
        {
          key: 'late', label: W.lateBase, options: [],
          value: {
            label: minutes(late.minutes),
            input: minutesInput(W.vehicleLate + ' · ' + W.lateBase + ' ' + minutes(late.minutes), SETTINGS_RANGES.late.max,
              { op: 'setting.vehicle_late', minutes: 0, nightMinutes: late.nightMinutes }, 'minutes'),
          },
        },
        {
          key: 'late-night', label: W.lateNight, options: [],
          value: {
            label: minutes(late.nightMinutes),
            input: minutesInput(W.vehicleLate + ' · ' + W.lateNight + ' ' + minutes(late.nightMinutes), SETTINGS_RANGES.late.max,
              { op: 'setting.vehicle_late', minutes: late.minutes, nightMinutes: 0 }, 'nightMinutes'),
          },
        },
      ],
    }),
  ];
}

/** 할인 대상 글(`장비 · 리프트권`). */
const sectionsText = (reg: Pick<ShopRegistry, 'paySections'>, sections: readonly string[]) =>
  reg.paySections.filter((p) => sections.includes(p.key)).map((p) => p.label).join(' · ');

function pricingCards(d: SettingsDraft, ops: readonly SettingsOp[], changed: ReadonlySet<string>): RuleCard[] {
  const reg = d.registry;
  const ref = nextRef(ops);
  const cards: RuleCard[] = reg.paySections.map((section) => {
    const products = reg.kinds.flatMap((k) => k.products).map((key) => reg.products[key]).filter((p) => p !== undefined && p.section === section.key);
    const items: SettingsListItem[] = products.map((p) => ({
      key: 'price:' + p!.key,
      label: p!.label,
      tag: priceText(reg, p!.key, p!.price),
      run: opRun({ op: 'price.set', productKey: p!.key, amount: 0 }, [padStep('amount', {
        mode: 'amount', title: p!.label + ' · ' + priceText(reg, p!.key, p!.price), min: SETTINGS_RANGES.price.min, max: SETTINGS_RANGES.price.max,
        step: SETTINGS_RANGES.price.step,
      })]),
    }));
    // 여러 날 값은 장비만(권은 하루권): 2일 이상 · 1일 금액 × 일수(catalog 8, 지금 도메인이 셈하는 규칙 하나).
    const multiDay = products.some((p) => !p!.unit);
    return card('price:' + section.key, section.label, changed, { list: { items }, notes: multiDay ? [[{ text: W.multiDay }]] : [] });
  });
  const discountItems: SettingsListItem[] = reg.discounts.map((rule) => {
    const valueText = rule.kind === 'percent' ? percentText(rule.value) : won(rule.value);
    const valueInput: Omit<RuleInput, 'key'> = rule.kind === 'percent'
      ? { mode: 'percent', title: W.discountPercent + ' · ' + valueText, min: SETTINGS_RANGES.percent.min, max: SETTINGS_RANGES.percent.max }
      : { mode: 'amount', title: W.discountAmount + ' · ' + valueText, min: SETTINGS_RANGES.amount.min, max: SETTINGS_RANGES.amount.max, step: SETTINGS_RANGES.amount.step };
    return {
      key: 'discount:' + rule.key,
      label: rule.label,
      tag: rule.hidden ? W.unused : valueText + ' · ' + sectionsText(reg, rule.sections),
      ...(rule.hidden ? { muted: true as const } : {}),
      run: sheetRun({
        title: rule.label,
        lines: [(rule.kind === 'percent' ? W.percent : W.amount) + ' · ' + W.target + ' ' + sectionsText(reg, rule.sections)],
        // `사용` · `미사용` 둘을 두고 지금 것을 고른 것으로(2026-09-27 점검: 켜진 할인에 `미사용` 버튼 하나만 있어 지금 상태로 읽혔다).
        actions: [
          action('use', W.use, opRun({ op: 'discount.active', id: rule.key, active: true }), { selected: !rule.hidden }),
          action('unused', W.unused, opRun({ op: 'discount.active', id: rule.key, active: false }), { selected: !!rule.hidden }),
          action('value', (rule.kind === 'percent' ? W.discountPercent : W.discountAmount) + ' · ' + valueText, opRun({ op: 'discount.update', id: rule.key, value: 0 }, [padStep('value', valueInput)])),
          action('rename', W.rename, opRun({ op: 'discount.update', id: rule.key, label: '' }, [textStep('label', W.discountName, rule.label)])),
        ],
      }),
    };
  });
  // 할인 더하기: 종류(비율 · 금액) → 대상(비율만 고름, 금액은 장비) → 값 → 이름. 리프트권은 비율만(plan E9).
  const targets = reg.paySections.map((p) => ({ key: p.key, label: p.label, value: [p.key] as string[] }));
  const both = reg.paySections.length > 1 ? [{ key: 'all', label: reg.paySections.map((p) => p.label).join(' · '), value: reg.paySections.map((p) => p.key) }] : [];
  const gear = reg.paySections.filter((p) => p.key !== 'lift').map((p) => p.key);
  const addSheet: SettingsSheet = {
    title: W.discountAdd,
    lines: [],
    actions: [
      action('percent', W.percent, opRun({ op: 'discount.add', ref, label: '', kind: 'percent', value: 0, sections: [] }, [
        { kind: 'choose', field: 'sections', title: W.target, options: [...targets, ...both] },
        padStep('value', { mode: 'percent', title: W.discountPercent, min: SETTINGS_RANGES.percent.min, max: SETTINGS_RANGES.percent.max }),
        textStep('label', W.discountName),
      ])),
      action('amount', W.amount, opRun({ op: 'discount.add', ref, label: '', kind: 'amount', value: 0, sections: gear as ('gear' | 'lift')[] }, [
        padStep('value', { mode: 'amount', title: W.discountAmount, min: SETTINGS_RANGES.amount.min, max: SETTINGS_RANGES.amount.max, step: SETTINGS_RANGES.amount.step }),
        textStep('label', W.discountName),
      ]), { enabled: gear.length > 0, secondLine: sectionsText(reg, gear) }),
    ],
  };
  cards.push(card('discounts', W.discount, changed, { list: { items: discountItems, add: { key: 'discount-add', label: W.discountAdd, run: sheetRun(addSheet) } } }));
  return cards;
}

/** 다음 차량 이름(`3호 차량`): 쓰지 않은 가장 작은 번호. */
function nextVehicleName(d: SettingsDraft): string {
  for (let n = d.registry.vehicles.length + 1; n < 1000; n += 1) {
    const name = n + '호 ' + W.vehicles;
    if (!d.registry.vehicles.some((v) => v.label === name)) return name;
  }
  return '';
}

const vehicleName = (d: SettingsDraft, id: string | undefined) => d.registry.vehicles.find((v) => v.id === id)?.label ?? W.none;

/** 차량 고르기 단계(쓰는 차량만). */
const vehicleStep = (d: SettingsDraft): SettingsStep => ({
  kind: 'choose', field: 'vehicleId', title: W.vehicle, options: d.registry.vehicles.filter((v) => !v.ended).map((v) => ({ key: v.id, label: v.label, value: v.id })),
});

function staffTag(d: SettingsDraft, s: FxStaff): string {
  if (s.status !== 'active') return W.end;
  return ROLE_LABELS[s.roleKey] + (s.vehicleId ? ' · ' + vehicleName(d, s.vehicleId) : '');
}

function staffSheet(ctx: ViewContext, d: SettingsDraft, s: FxStaff): SettingsSheet {
  const active = s.status === 'active';
  const managers = d.staff.filter((x) => x.status === 'active' && x.roleKey === 'manager');
  const lastManager = s.roleKey === 'manager' && active && managers.length <= 1;
  const self = ctx.viewer?.staffId !== undefined && ctx.viewer.staffId === s.id;
  // 지금 역할 · 차량은 고른 것(남색)으로, 막힌 것만 점선 + 판 위의 한 줄 까닭(2026-09-27 점검: 지금 값과 막힌 값이 같은 모양이었다).
  const roleSheet: SettingsSheet = {
    title: W.role + ' · ' + s.name,
    lines: lastManager ? [SETTINGS_LINES.roleLastManager] : [],
    actions: ROLE_ORDER.map((role) => {
      const needsVehicle = role === 'driver' && !s.vehicleId;
      const current = role === s.roleKey;
      return action(role, ROLE_LABELS[role], opRun({ op: 'staff.update', id: s.id, role }, needsVehicle ? [vehicleStep(d)] : undefined), {
        selected: current, enabled: current || !lastManager, ...(!current && lastManager ? { reason: SETTINGS_LINES.roleLastManager } : {}),
      });
    }),
  };
  const noneBlocked = s.vehicleId !== undefined && s.roleKey === 'driver';
  const vehicleSheet: SettingsSheet = {
    title: W.vehicle + ' · ' + s.name,
    lines: noneBlocked ? [SETTINGS_LINES.driverNeedsVehicle] : [],
    actions: [
      ...d.registry.vehicles.filter((v) => !v.ended).map((v) => action('vehicle:' + v.id, v.label, opRun({ op: 'staff.update', id: s.id, vehicleId: v.id }), { selected: v.id === s.vehicleId })),
      action('none', W.none, opRun({ op: 'staff.update', id: s.id, vehicleId: null }), {
        selected: s.vehicleId === undefined, enabled: !noneBlocked, ...(noneBlocked ? { reason: SETTINGS_LINES.driverNeedsVehicle } : {}),
      }),
    ],
  };
  const devices = ctx.staffDevices?.[s.id] ?? [];
  const endWhy = self ? SETTINGS_LINES.endSelf : lastManager ? SETTINGS_LINES.endLastManager : undefined;
  return {
    title: s.name,
    lines: endWhy && active ? [endWhy] : [],
    actions: [
      action('role', W.role, sheetRun(roleSheet), { secondLine: ROLE_LABELS[s.roleKey], enabled: active }),
      action('vehicle', W.vehicle, sheetRun(vehicleSheet), { secondLine: vehicleName(d, s.vehicleId), enabled: active }),
      // 새로 더한 사람(저장 전)은 아직 계정이 없어 저장 뒤에 재발급한다.
      action('pin', W.pinReset, { kind: 'pin', staffId: s.id, name: s.name }, { enabled: active && !s.id.startsWith('new:') }),
      active
        ? action('end', W.end, opRun({ op: 'staff.active', id: s.id, active: false }), { enabled: !endWhy })
        : action('reuse', W.reuse, opRun({ op: 'staff.active', id: s.id, active: true })),
      ...devices.map((dev) => action('block:' + dev.id, W.block + ' · ' + dev.label, { kind: 'block', deviceId: dev.id, label: dev.label })),
    ],
  };
}

function fleetCards(ctx: ViewContext, d: SettingsDraft, ops: readonly SettingsOp[], changed: ReadonlySet<string>): RuleCard[] {
  const ref = nextRef(ops);
  const vehicleItems: SettingsListItem[] = d.registry.vehicles.map((v) => {
    const drivers = d.staff.filter((s) => s.status === 'active' && s.vehicleId === v.id).map((s) => s.name);
    const tag = v.ended ? W.end : drivers.length ? '담당 ' + drivers[0] + (drivers.length > 1 ? ' 외 ' + (drivers.length - 1) : '') : undefined;
    // 사용 종료의 막힘은 저장된 상태(업무 · 재고 · 현금)로 본다. 막 더한 차량은 막힘이 없다.
    const endWhy = v.ended || v.id.startsWith('new:') ? undefined : vehicleEndRefusal(ctx.state, v.id);
    const actions: SettingsAction[] = [
      action('rename', W.rename, opRun({ op: 'vehicle.rename', id: v.id, label: '' }, [textStep('label', W.vehicleName, v.label)])),
      v.ended
        ? action('reuse', W.reuse, opRun({ op: 'vehicle.active', id: v.id, active: true }))
        : action('end', W.end, opRun({ op: 'vehicle.active', id: v.id, active: false }), { enabled: !endWhy }),
    ];
    // 미처리 수거가 막았으면 그 차량의 수거 목록으로(배달은 기사의 배달 목록이라 카운터 화면이 없다).
    if (endWhy && vehicleOpenTaskCounts(ctx.state, v.id).collects > 0) actions.push(action('collection', W.collection + ' ›', { kind: 'go', to: 'collection', vehicleId: v.id }));
    return {
      key: 'vehicle:' + v.id, label: v.label, ...(tag ? { tag } : {}), ...(v.ended ? { muted: true as const } : {}),
      run: sheetRun({ title: v.label, lines: endWhy ? [endWhy] : [], actions }),
    };
  });
  const staffItems: SettingsListItem[] = d.staff.map((s) => ({
    key: 'staff:' + s.id, label: s.name, tag: staffTag(d, s), ...(s.status !== 'active' ? { muted: true as const } : {}), run: sheetRun(staffSheet(ctx, d, s)),
  }));
  const addStaff: SettingsSheet = {
    title: W.staffAdd,
    lines: [],
    actions: ROLE_ORDER.map((role) => action(role, ROLE_LABELS[role], opRun(
      { op: 'staff.add', ref, name: '', role },
      role === 'driver' ? [textStep('name', W.staffName), vehicleStep(d)] : [textStep('name', W.staffName)],
    ), { enabled: role !== 'driver' || d.registry.vehicles.some((v) => !v.ended) })),
  };
  return [
    card('vehicles', W.vehicles, changed, {
      list: {
        items: vehicleItems,
        add: { key: 'vehicle-add', label: W.vehicleAdd, run: opRun({ op: 'vehicle.add', ref, label: '' }, [textStep('label', W.vehicleName, nextVehicleName(d))]) },
      },
    }),
    card('staff', W.staff, changed, { list: { items: staffItems, add: { key: 'staff-add', label: W.staffAdd, run: sheetRun(addStaff) } } }),
  ];
}

// ── 바뀐 곳(전 → 후) ─────────────────────────────────────────────────────

interface Change extends RuleChangeLine {
  /** 바뀐 카드(이름표 `변경됨`). */
  card: string;
}

const line = (card: string, key: string, label: string, after: string, before?: string): Change => ({
  card, key, label, after, ...(before !== undefined ? { before } : {}),
});

/** 공통 id의 차례가 바뀌었는지. */
function reordered(before: readonly string[], after: readonly string[]): boolean {
  const common = after.filter((id) => before.includes(id));
  const was = before.filter((id) => common.includes(id));
  return common.some((id, i) => was[i] !== id);
}

function diff(tab: SettingsTabKey, before: SettingsDraft, after: SettingsDraft): Change[] {
  const out: Change[] = [];
  const b = before.registry;
  const a = after.registry;
  if (tab === 'info') {
    if (b.shopName !== a.shopName) out.push(line('info:name', 'shop.name', W.shopName, a.shopName, b.shopName));
    if ((b.shopPhone ?? '') !== (a.shopPhone ?? '')) {
      out.push(line('info:phone', 'shop.phone', W.phone, a.shopPhone ? phoneText(a.shopPhone) : W.none, b.shopPhone ? phoneText(b.shopPhone) : W.none));
    }
  }
  if (tab === 'places') {
    if (reordered(b.areas.map((x) => x.id), a.areas.map((x) => x.id))) out.push(line('area-add', 'areas.order', W.order, W.area));
    for (const area of a.areas) {
      const was = b.areas.find((x) => x.id === area.id);
      const cardKey = 'area:' + area.id;
      if (!was) {
        out.push(line(cardKey, 'area.add:' + area.id, W.areaAdd, area.label));
      } else {
        if (was.label !== area.label) out.push(line(cardKey, 'area.label:' + area.id, W.rename, area.label, was.label));
        if (!!was.hidden !== !!area.hidden) out.push(line(cardKey, 'area.hidden:' + area.id, area.hidden ? W.hide : W.unhide, area.label));
        if (reordered(was.places.map((p) => p.id), area.places.map((p) => p.id))) out.push(line(cardKey, 'places.order:' + area.id, W.order, area.label));
      }
      for (const place of area.places) {
        const old = was?.places.find((p) => p.id === place.id);
        if (!old) out.push(line(cardKey, 'place.add:' + place.id, W.placeAdd, area.label + ' · ' + place.label));
        else {
          if (old.label !== place.label) out.push(line(cardKey, 'place.label:' + place.id, W.rename, place.label, old.label));
          if (!!old.hidden !== !!place.hidden) out.push(line(cardKey, 'place.hidden:' + place.id, place.hidden ? W.hide : W.unhide, place.label));
        }
      }
    }
  }
  if (tab === 'slots') {
    const sb = before.settings;
    const sa = after.settings;
    if (reordered(sb.returnSlots.map((s) => s.key), sa.returnSlots.map((s) => s.key))) out.push(line('slots', 'slots.order', W.order, W.slots));
    for (const slot of sa.returnSlots) {
      const was = sb.returnSlots.find((s) => s.key === slot.key);
      if (!was) { out.push(line('slots', 'slot.add:' + slot.key, W.slotAdd, slotText(slot))); continue; }
      if (was.label !== slot.label) out.push(line('slots', 'slot.label:' + slot.key, W.rename, slot.label, was.label));
      if (was.hour !== slot.hour || was.minute !== slot.minute) out.push(line('slots', 'slot.time:' + slot.key, W.slotTime, slotText(slot), slotText(was)));
      if (!!was.hidden !== !!slot.hidden) out.push(line('slots', 'slot.hidden:' + slot.key, slot.hidden ? W.hide : W.unhide, slotText(slot)));
    }
    const slotName = (s: typeof sa, key: string | undefined) => {
      const slot = s.returnSlots.find((x) => x.key === (key ?? s.returnSlots.find((y) => !y.hidden)?.key));
      return slot ? slotText(slot) : W.none;
    };
    if (sb.defaultReturnSlotKey !== sa.defaultReturnSlotKey) {
      out.push(line('slots', 'slot.default', W.defaultSlot, slotName(sa, sa.defaultReturnSlotKey), slotName(sb, sb.defaultReturnSlotKey)));
    }
    const noticeBefore = sb.nightNoticeMinutes ?? 60;
    const noticeAfter = sa.nightNoticeMinutes ?? 60;
    if (noticeBefore !== noticeAfter) out.push(line('night-notice', 'night-notice', W.nightNotice, minutes(noticeAfter) + ' 전', minutes(noticeBefore) + ' 전'));
    const lb = sb.vehicleLate ?? { minutes: 60, nightMinutes: 60 };
    const la = sa.vehicleLate ?? { minutes: 60, nightMinutes: 60 };
    if (lb.minutes !== la.minutes) out.push(line('vehicle-late', 'late', W.vehicleLate, W.lateBase + ' ' + minutes(la.minutes), W.lateBase + ' ' + minutes(lb.minutes)));
    if (lb.nightMinutes !== la.nightMinutes) {
      out.push(line('vehicle-late', 'late-night', W.vehicleLate, W.lateNight + ' ' + minutes(la.nightMinutes), W.lateNight + ' ' + minutes(lb.nightMinutes)));
    }
  }
  if (tab === 'pricing') {
    for (const [key, p] of Object.entries(a.products)) {
      const was = b.products[key];
      if (was && was.price !== p.price) out.push(line('price:' + p.section, 'price:' + key, p.label, priceText(a, key, p.price), priceText(b, key, was.price)));
    }
    for (const rule of a.discounts) {
      const was = b.discounts.find((x) => x.key === rule.key);
      const valueText = (v: number) => (rule.kind === 'percent' ? percentText(v) : won(v));
      if (!was) { out.push(line('discounts', 'discount.add:' + rule.key, W.discountAdd, rule.label)); continue; }
      if (was.label !== rule.label) out.push(line('discounts', 'discount.label:' + rule.key, W.rename, rule.label, was.label));
      if (was.value !== rule.value) out.push(line('discounts', 'discount.value:' + rule.key, rule.label, valueText(rule.value), valueText(was.value)));
      if (!!was.hidden !== !!rule.hidden) out.push(line('discounts', 'discount.active:' + rule.key, rule.label, rule.hidden ? W.unused : W.use, was.hidden ? W.unused : W.use));
    }
  }
  if (tab === 'fleet') {
    for (const v of a.vehicles) {
      const was = b.vehicles.find((x) => x.id === v.id);
      if (!was) { out.push(line('vehicles', 'vehicle.add:' + v.id, W.vehicleAdd, v.label)); continue; }
      if (was.label !== v.label) out.push(line('vehicles', 'vehicle.label:' + v.id, W.rename, v.label, was.label));
      if (!!was.ended !== !!v.ended) out.push(line('vehicles', 'vehicle.active:' + v.id, v.ended ? W.end : W.reuse, v.label));
    }
    for (const s of after.staff) {
      const was = before.staff.find((x) => x.id === s.id);
      if (!was) { out.push(line('staff', 'staff.add:' + s.id, W.staffAdd, s.name + ' · ' + staffTag(after, s))); continue; }
      if (was.status !== s.status) { out.push(line('staff', 'staff.active:' + s.id, s.status === 'active' ? W.reuse : W.end, s.name)); continue; }
      if (was.roleKey !== s.roleKey) out.push(line('staff', 'staff.role:' + s.id, s.name + ' · ' + W.role, ROLE_LABELS[s.roleKey], ROLE_LABELS[was.roleKey]));
      if (was.vehicleId !== s.vehicleId) out.push(line('staff', 'staff.vehicle:' + s.id, s.name + ' · ' + W.vehicle, vehicleName(after, s.vehicleId), vehicleName(before, was.vehicleId)));
    }
  }
  return out;
}

// ── 읽기 모델 ──────────────────────────────────────────────────────────

/** 관리 · 매장 설정의 다른 탭(shopSettings): 저장된 값 + 초안 → 카드 · 바뀐 곳 · 바닥줄 · 주 버튼 · 명령. */
export function shopSettings(ctx: ViewContext, params: ShopSettingsParams): ShopSettingsView {
  const { state, now } = ctx;
  const tab = params.tab;
  const { before, after, ops, refused } = applyDraft(ctx, params.changes ?? []);
  const changes = diff(tab, before, after);
  const changedCards = new Set(changes.map((c) => c.card));
  const cards = tab === 'info' ? infoCards(after, changedCards)
    : tab === 'places' ? placesCards(after, ops, changedCards)
      : tab === 'slots' ? slotsCards(after, ops, changedCards)
        : tab === 'pricing' ? pricingCards(after, ops, changedCards)
          : fleetCards(ctx, after, ops, changedCards);
  const n = changes.length;
  // 보는 사람의 권한(E11): 없으면 바닥줄 · 저장 창이 까닭을 말하고 저장이 막힌다(서버가 다시 막는다).
  const missing = ctx.viewer ? TAB_PERMISSIONS[tab].filter((p) => !ctx.viewer!.permissions.includes(p)) : [];
  const rejection = missing.length ? W.forbidden : undefined;
  // 권한이 없으면 처음부터 읽기만: 칸은 눌러도 바꿈을 만들지 않는다(2026-09-27 점검: 카드를 바꿔 `저장 · 1건`까지 간 뒤에야 막혔다).
  if (rejection) cards.splice(0, cards.length, ...readOnlyCards(cards, rejection));
  const registryOps = ops.filter((op): op is RegistryOp => !op.op.startsWith('staff.'));
  const staffOps = ops.filter((op): op is StaffOp => op.op.startsWith('staff.'));
  let command: ConfirmCommand | undefined;
  let then: ConfirmStep[] | undefined;
  if (n) {
    if (registryOps.length) {
      command = { type: 'registry.update', payload: { changes: registryOps } };
      if (staffOps.length) then = [{ command: { type: 'staff.set', payload: { changes: staffOps } } }];
    } else if (staffOps.length) {
      command = { type: 'staff.set', payload: { changes: staffOps } };
    }
  }
  const footer = rejection ?? (n ? '변경 ' + n + '건 · 다음 기록부터 적용' : W.noChange);
  const label = n ? W.save + ' · ' + n + '건' : W.save;
  return {
    basis: { epoch: state.epoch, rev: state.rev },
    serverTime: iso(now),
    currentBusinessDate: state.businessDate,
    tab,
    cards,
    changes: changes.map(({ card: _card, ...rest }) => rest),
    footer,
    ...(n ? { saveTitle: '변경 ' + n + '건', unsavedTitle: '미저장 변경 ' + n + '건' } : {}),
    primary: { label, alts: n ? [label, W.save] : [W.save], enabled: n > 0 && !rejection },
    ...(command ? { command } : {}),
    ...(then ? { then } : {}),
    ...(rejection ? { rejection } : {}),
    ...(refused ? { refused } : {}),
  };
}

/**
 * 읽기만 하는 카드(권한 없는 사람, E11): 고르기 · 값 버튼은 누를 수 없고(까닭 한 줄), 목록 칸은 항목 판을 열되 그 판은 `권한 없음 · 관리자 확인 필요`
 * 한 줄과 누를 수 없는 버튼만(가는 곳 버튼 `수거 목록 ›`은 그대로). 초안에 넣을 한 건(op)이 없다.
 */
function readOnlyCards(cards: readonly RuleCard[], line: string): RuleCard[] {
  const lock = (item: SettingsListItem): SettingsListItem => {
    const run = item.run;
    if (run.kind === 'go') return item;
    if (run.kind === 'sheet') {
      return {
        ...item,
        run: {
          kind: 'sheet',
          sheet: {
            ...run.sheet, lines: [line, ...run.sheet.lines.filter((x) => x !== line)],
            actions: run.sheet.actions.map((a) => (a.run.kind === 'go' ? a : { ...a, enabled: false, reason: line })),
          },
        },
      };
    }
    return { ...item, run: { kind: 'sheet', sheet: { title: item.label, lines: [line], actions: [] } } };
  };
  return cards.map((c) => ({
    ...c,
    rows: c.rows.map((r) => {
      const { inputs: _inputs, ops: _ops, ...rest } = r;
      return {
        ...rest,
        options: r.options.map((o) => ({ ...o, enabled: false, reason: line })),
        ...(r.value ? { value: { ...r.value, enabled: false as const } } : {}),
      };
    }),
    ...(c.list ? { list: { items: c.list.items.map(lock), ...(c.list.add ? { add: lock(c.list.add) } : {}) } } : {}),
  }));
}

/** 이 탭의 카드 제목 목록(시험). */
export const settingsCardTitles = (view: Pick<ShopSettingsView, 'cards'>): string[] => view.cards.map((c) => c.title);

