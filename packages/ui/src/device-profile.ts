// 기기 등급(ui 3-7, DeviceProfile). 크기 규칙은 여기 한 곳에만 있고, 부품 · 칸 맞춤 · 쪽 나누기 · 규칙 검사기가 이 값을 읽는다.
// 등급은 잰 화면 크기와 역할로 고른다(카운터 직원이 태블릿을 쓰면 pos_narrow, 기사가 휴대폰을 쓰면 driver_phone).
// React 없이도 읽히도록 순수 모듈로 둔다(서버의 설정 명령 · 시험이 같은 값을 쓴다).
import type { DeviceClassKey, ShopDeviceClassKey } from '@skinote/contract';
import type { ConfirmWindowSpec, KeyboardSpec } from '@skinote/layout';

/** 등급의 화면 키보드 크기: 모양 고르기 값(layout KeyboardSpec) + 자모 키의 글자 크기(--sn-kb-glyph). */
export type KeyboardProfile = KeyboardSpec & { glyphPx: number };

export interface Size {
  width: number;
  height: number;
}

export type AccentKey = 'orange' | 'purple' | 'navy' | 'mono';

export interface DeviceProfile {
  key: DeviceClassKey;
  /** 검사 크기(촬영 · 규칙 검사 · 설정 시험이 도는 크기). */
  checkSizes: readonly Size[];
  /** 이 등급에서 허락하는 가장 작은 글자(매장 기기 16px, 알림 점 하나만 예외). */
  minFontPx: number;
  /** em 폭의 기준 글자 크기(칸 폭 = em × baseFontPx). */
  baseFontPx: number;
  bodyFontPx: number;
  /** 문장(알림 창 · 종이 한 장 화면의 설명)의 줄 간격(배수). 창 안 줄 수를 셀 때도 이 값으로 센다. */
  bodyLineHeight: number;
  titleFontPx: number;
  /** 주 버튼 · 숫자판 숫자. */
  bigFontPx: number;
  /** 누르는 곳의 최소 높이(쪽 넘김 버튼 · 도장 칸 포함). */
  minTargetPx: number;
  /** 자주 되풀이해 누르는 버튼(▲ · ▼)의 최소 폭. */
  repeatTargetPx: number;
  primaryButtonPx: number;
  primaryFullWidth: boolean;
  headerPx: number;
  titleTabsPx: number;
  footerPx: number;
  /** 오프라인 연결 띠(보일 때만 쪽 높이에서 뺀다). */
  connectionStripPx: number;
  /** 표 머리(장부). 기사 목록은 0. */
  tableHeadPx: number;
  rowPx: number;
  /** 한 줄에 칸이 안 들어갈 때의 두 줄 줄(ui 4-2 c). */
  stackedRowPx: number;
  /** 줄 높이가 두 줄을 허락하는지(휴대폰 64px 두 줄 줄: 품목이 둘째 줄로). */
  secondLineRows: boolean;
  groupTitlePx: number;
  nowLinePx: number;
  pinRowPx: number;
  /** 목록 높이가 이보다 낮으면 쪽마다 묶음 제목을 하나로 합칠 수 있다(docs/42 2-3 규칙 5). */
  combineHeadingsBelowPx: number;
  /** 장부 판 좌우 여백(책상 틈 + 종이 안 여백). 판 폭 = 화면 폭 − 2 × sheetInsetPx. */
  sheetInsetPx: number;
  deskGapPx: number;
  /** 종이 한 장 화면(처음 화면 · 나가기)의 종이 최대 폭과 큰 고르기 버튼 높이. */
  plain: { cardMaxPx: number; choicePx: number };
  /** 등급의 칸 수(ui 3-7): 메뉴 · 탭 · 빠른 결제 수단 · 한 쪽 결제 칸 · 옆 동작. */
  capacity: { menu: number; tabs: number; quickMethods: number; paymentSectionsPerPage: number; sideActions: number };
  accent: AccentKey;
  /** 접수증(6-2)의 고정 높이 · 오른쪽 판. 접수증이 없는 등급은 null. */
  slip: { titlePx: number; fieldsPx: number; promisePx: number; moneyPx: number; sidePanelPx: number; gapPx: number } | null;
  confirm: ConfirmWindowSpec;
  keypad: { keyPx: number; displayPx: number; titlePx: number; loadPx: number; sidePanelPx: number; sidePanelMinHeightPx: number; allowSide: boolean };
  /**
   * 화면 키보드(한글 글자판, HangulKeyboard): 키 높이 · 사이 · 판 여백 · 판 최대 폭(null = 화면 폭 전체) · 제목 줄 · 표시 칸 여백과
   * 자모 키의 글자 크기(glyphPx). 두벌식 줄 배치와 자모 차례 격자 가운데 무엇을 쓸지는 잰 판 크기로 layout fitKeyboard가 고른다(계획 7-2).
   */
  keyboard: KeyboardProfile;
  /** 도장 그림(누르는 곳은 칸 전체). */
  stamp: { markPx: number; miniMarkPx: number };
  /**
   * 남는 높이를 나눠 쓰는 줄(layout fillRows: 기사 업무 판 V7의 품목 줄 60 ~ 88, spec 3-8)과 화면 위로 올라오는 아래 판(현장 수납 ·
   * 리프트권 추가, ui 6-5)의 최대 높이. 휴대폰 업무 판은 한 칸 세로라 줄 최소가 누르는 곳(56)이다.
   */
  fill: { rowMinPx: number; rowMaxPx: number; panelMaxPx: number };
  /**
   * 쪽 나누기의 한 쪽 줄 수 · 카드 폭(시안의 수, spec 3-1 · 3-6 · 3-7 · 3-9): 반납 창 품목 칸 3줄(창 500 ≤ 1024×529의 한도), 부분 결제 판 3줄,
   * 마감 이월 항목 5줄, 운영 규칙 카드의 가장 작은 폭 = 누르는 곳 9칸(474 카드). 잰 높이가 더 적으면 화면이 줄인다.
   */
  pages: { returnPieceRows: number; partialPayRows: number; closingCarryRows: number; ruleCardMinTargets: number };
  space: { xs: number; s: number; m: number; l: number };
  radius: { s: number; m: number; paper: number };
  line: { hair: number; strong: number; stamp: number };
}

const SPACE = { xs: 4, s: 8, m: 12, l: 16 } as const;
const PAGES = { returnPieceRows: 3, partialPayRows: 3, closingCarryRows: 5, ruleCardMinTargets: 9 } as const;
const RADIUS = { s: 8, m: 10, paper: 4 } as const;
const LINE = { hair: 1, strong: 2, stamp: 3 } as const;
const STAMP = { markPx: 48, miniMarkPx: 24 } as const;

const POS_CONFIRM: ConfirmWindowSpec = {
  sideMarginPx: 32, maxWidthPx: 860, marginYPx: 24, compactMarginYPx: 12, minHeightPx: 504,
  titlePx: 56, sectionPx: 104, payerRowPx: 64, primaryRowPx: 72, paddingXPx: 24, methodButtonMinPx: 110, methodGapPx: 12,
};
const DRIVER_CONFIRM: ConfirmWindowSpec = {
  sideMarginPx: 16, maxWidthPx: 720, marginYPx: 16, compactMarginYPx: 8, minHeightPx: 360,
  titlePx: 56, sectionPx: 104, payerRowPx: 0, primaryRowPx: 80, paddingXPx: 16, methodButtonMinPx: 110, methodGapPx: 12,
};
const POS_SLIP = { titlePx: 60, fieldsPx: 40, promisePx: 32, moneyPx: 40, sidePanelPx: 280, gapPx: 16 };
const KEYPAD = { keyPx: 56, displayPx: 56, titlePx: 40, loadPx: 48, sidePanelPx: 268, sidePanelMinHeightPx: 600 };
const PLAIN = { cardMaxPx: 672, choicePx: 72 };
/**
 * 화면 키보드(계획 7-2): 포스는 860 폭까지(확인 창과 같은 폭), 기사 태블릿 900, 휴대폰은 화면 폭 전체. 제목 줄에 `닫기`가 있어 그 줄은
 * 키 높이(56)다. 자모 키 글자는 36: 한글 호환 자모(ㅂ · ㄱ · ㄴ)는 글자 크기의 절반쯤(0.47 ~ 0.52)으로 그려져서 24로는 먹 높이가 12px
 * 남짓이라 가장 낮은 ㄴ도 16px을 넘게(약 17px) 키운다(규칙 검사가 잰 먹 높이로 본다, 30이면 휴대폰에서 14px대였다).
 */
const POS_KEYBOARD: KeyboardProfile = { keyPx: 56, gapPx: 8, insetPx: 12, maxWidthPx: 860, titlePx: 40, displayPadPx: 12, glyphPx: 36 };
const TABLET_KEYBOARD: KeyboardProfile = { ...POS_KEYBOARD, maxWidthPx: 900 };
const PHONE_KEYBOARD: KeyboardProfile = { keyPx: 56, gapPx: 6, insetPx: 8, maxWidthPx: null, titlePx: 56, displayPadPx: 8, glyphPx: 36 };
/** 줄 최소 · 최대(V7 60 ~ 88, V6 52 ~ 88)와 아래 판 최대 높이(ui 6-5: 440). */
const PANEL_MAX_PX = 440;

const pos: DeviceProfile = {
  key: 'pos',
  checkSizes: [{ width: 1024, height: 600 }, { width: 1024, height: 569 }, { width: 1024, height: 529 }, { width: 1024, height: 768 }, { width: 1366, height: 768 }],
  minFontPx: 16, baseFontPx: 16, bodyFontPx: 17, bodyLineHeight: 1.45, titleFontPx: 24, bigFontPx: 20,
  minTargetPx: 52, repeatTargetPx: 64, primaryButtonPx: 56, primaryFullWidth: false,
  headerPx: 60, titleTabsPx: 60, footerPx: 72, connectionStripPx: 32, tableHeadPx: 40,
  rowPx: 52, stackedRowPx: 88, secondLineRows: false, groupTitlePx: 40, nowLinePx: 24, pinRowPx: 64, combineHeadingsBelowPx: 640,
  sheetInsetPx: 30, deskGapPx: 12,
  plain: PLAIN,
  capacity: { menu: 3, tabs: 6, quickMethods: 4, paymentSectionsPerPage: 3, sideActions: 3 },
  accent: 'orange',
  slip: POS_SLIP,
  confirm: POS_CONFIRM,
  keypad: { ...KEYPAD, allowSide: false },
  keyboard: POS_KEYBOARD,
  stamp: STAMP, fill: { rowMinPx: 52, rowMaxPx: 88, panelMaxPx: PANEL_MAX_PX }, pages: PAGES, space: SPACE, radius: RADIUS, line: LINE,
};

const posNarrow: DeviceProfile = {
  ...pos,
  key: 'pos_narrow',
  checkSizes: [{ width: 907, height: 648 }, { width: 875, height: 600 }],
  capacity: { menu: 2, tabs: 5, quickMethods: 4, paymentSectionsPerPage: 3, sideActions: 2 },
};

const driverTablet: DeviceProfile = {
  key: 'driver_tablet',
  checkSizes: [{ width: 1024, height: 520 }, { width: 1024, height: 600 }, { width: 1280, height: 720 }],
  minFontPx: 16, baseFontPx: 16, bodyFontPx: 18, bodyLineHeight: 1.45, titleFontPx: 22, bigFontPx: 22,
  minTargetPx: 56, repeatTargetPx: 72, primaryButtonPx: 72, primaryFullWidth: false,
  headerPx: 60, titleTabsPx: 56, footerPx: 80, connectionStripPx: 32, tableHeadPx: 0,
  rowPx: 60, stackedRowPx: 88, secondLineRows: false, groupTitlePx: 40, nowLinePx: 24, pinRowPx: 64, combineHeadingsBelowPx: 640,
  sheetInsetPx: 16, deskGapPx: 8,
  plain: PLAIN,
  capacity: { menu: 2, tabs: 4, quickMethods: 3, paymentSectionsPerPage: 1, sideActions: 2 },
  accent: 'purple',
  slip: null,
  confirm: DRIVER_CONFIRM,
  keypad: { ...KEYPAD, allowSide: true },
  keyboard: TABLET_KEYBOARD,
  stamp: STAMP, fill: { rowMinPx: 60, rowMaxPx: 88, panelMaxPx: PANEL_MAX_PX }, pages: PAGES, space: SPACE, radius: RADIUS, line: LINE,
};

const driverPhone: DeviceProfile = {
  ...driverTablet,
  key: 'driver_phone',
  checkSizes: [{ width: 360, height: 640 }, { width: 390, height: 740 }, { width: 412, height: 780 }],
  titleFontPx: 20, bigFontPx: 20,
  primaryButtonPx: 64, primaryFullWidth: true,
  headerPx: 56, titleTabsPx: 56, footerPx: 72,
  rowPx: 64, secondLineRows: true,
  // 휴대폰은 팀 칸이 좁아 합친 묶음 제목의 쪽에서 줄마다 반납 타임('16:30 · ')을 붙일 수 없다: 묶음 제목을 합치지 않는다.
  combineHeadingsBelowPx: 0,
  capacity: { menu: 1, tabs: 3, quickMethods: 2, paymentSectionsPerPage: 1, sideActions: 1 },
  keypad: { ...KEYPAD, allowSide: false },
  keyboard: PHONE_KEYBOARD,
  // 한 칸 세로 업무 판(360×640): 팀 · 품목 줄 · 돈 줄 · 반납 일정 · 2 × 2 버튼이 한 화면에 들도록 품목 줄은 누르는 곳 높이부터.
  fill: { rowMinPx: 56, rowMaxPx: 88, panelMaxPx: PANEL_MAX_PX },
};

/** 인쇄: 크기는 인쇄 틀이 정한다. A4 794px(96dpi, 여백 뺌) 기준의 뼈대 값. */
const print: DeviceProfile = {
  ...pos,
  key: 'print',
  checkSizes: [{ width: 794, height: 1123 }],
  minFontPx: 12, baseFontPx: 12, bodyFontPx: 12, bodyLineHeight: 1.3, titleFontPx: 18, bigFontPx: 14,
  minTargetPx: 0, repeatTargetPx: 0, primaryButtonPx: 0, headerPx: 0, titleTabsPx: 40, footerPx: 24, connectionStripPx: 0, tableHeadPx: 28,
  rowPx: 28, stackedRowPx: 48, groupTitlePx: 28, nowLinePx: 0, pinRowPx: 0, sheetInsetPx: 0, deskGapPx: 0,
  capacity: { menu: 0, tabs: 0, quickMethods: 0, paymentSectionsPerPage: 0, sideActions: 0 },
  accent: 'mono',
};

/** 공급자의 숨은 플랫폼 관리자 콘솔 전용 등급(14px 예외). 매장 화면은 이 등급을 고르지 않는다. */
const admin: DeviceProfile = {
  ...pos,
  key: 'admin',
  checkSizes: [{ width: 1440, height: 810 }],
  minFontPx: 14, baseFontPx: 14, bodyFontPx: 14, bodyLineHeight: 1.4, titleFontPx: 22, bigFontPx: 16,
  minTargetPx: 40, repeatTargetPx: 48, primaryButtonPx: 44, headerPx: 64, titleTabsPx: 56, footerPx: 64, tableHeadPx: 36, rowPx: 44,
  capacity: { menu: 8, tabs: 8, quickMethods: 4, paymentSectionsPerPage: 3, sideActions: 4 },
  accent: 'navy',
};

export const DEVICE_PROFILES: Readonly<Record<DeviceClassKey, DeviceProfile>> = {
  pos,
  pos_narrow: posNarrow,
  driver_tablet: driverTablet,
  driver_phone: driverPhone,
  print,
  admin,
};

export function deviceProfile(key: DeviceClassKey): DeviceProfile {
  return DEVICE_PROFILES[key];
}

/** 매장 기기의 역할. 카운터 · 관리자는 포스 등급, 기사는 기사 등급. */
export type DeviceRole = 'counter' | 'manager' | 'driver';

/** 폭이 이보다 좁으면 기사 휴대폰(가로로 돌린 휴대폰 640 · 740 · 780 포함). */
const DRIVER_PHONE_BELOW_WIDTH = 768;
/** 폭이 이보다 좁으면 좁은 포스(907 · 875, 1024의 110 · 125% 확대). */
const POS_NARROW_BELOW_WIDTH = 1024;

/** 잰 크기(CSS px)와 역할로 등급을 고른다. 설치한 PWA의 줄어든 높이(1024×529)도 pos다. */
export function pickDeviceClass(size: Size, role: DeviceRole): ShopDeviceClassKey {
  if (role === 'driver') return size.width < DRIVER_PHONE_BELOW_WIDTH ? 'driver_phone' : 'driver_tablet';
  return size.width < POS_NARROW_BELOW_WIDTH ? 'pos_narrow' : 'pos';
}

const px = (n: number) => n + 'px';

/** 부품의 CSS가 읽는 크기 변수. 부품 CSS에는 크기 숫자가 없고 이 변수만 쓴다. */
export function profileCssVars(profile: DeviceProfile): Record<string, string> {
  const slip = profile.slip ?? POS_SLIP;
  return {
    '--sn-font-min': px(profile.minFontPx),
    '--sn-font-base': px(profile.baseFontPx),
    '--sn-font-body': px(profile.bodyFontPx),
    '--sn-line-body': String(profile.bodyLineHeight),
    '--sn-font-title': px(profile.titleFontPx),
    '--sn-font-big': px(profile.bigFontPx),
    /** 확인 창 칸의 굵은 품목 이름(반납 창 품목 칸, spec 3-1: 주 버튼 글자 + 2 = 포스 22px). */
    '--sn-font-name': px(profile.bigFontPx + profile.space.xs / 2),
    '--sn-target': px(profile.minTargetPx),
    '--sn-target-repeat': px(profile.repeatTargetPx),
    '--sn-primary-h': px(profile.primaryButtonPx),
    '--sn-header-h': px(profile.headerPx),
    '--sn-title-h': px(profile.titleTabsPx),
    '--sn-footer-h': px(profile.footerPx),
    '--sn-strip-h': px(profile.connectionStripPx),
    '--sn-thead-h': px(profile.tableHeadPx),
    '--sn-row-h': px(profile.rowPx),
    '--sn-row2-h': px(profile.stackedRowPx),
    '--sn-group-h': px(profile.groupTitlePx),
    '--sn-now-h': px(profile.nowLinePx),
    '--sn-pin-h': px(profile.pinRowPx),
    '--sn-inset': px(profile.sheetInsetPx),
    '--sn-card-max': px(profile.plain.cardMaxPx),
    '--sn-choice-h': px(profile.plain.choicePx),
    '--sn-desk-gap': px(profile.deskGapPx),
    '--sn-paper-pad': px(Math.max(0, profile.sheetInsetPx - profile.deskGapPx)),
    '--sn-slip-title-h': px(slip.titlePx),
    '--sn-slip-fields-h': px(slip.fieldsPx),
    '--sn-slip-promise-h': px(slip.promisePx),
    '--sn-slip-money-h': px(slip.moneyPx),
    '--sn-slip-side': px(slip.sidePanelPx),
    '--sn-slip-gap': px(slip.gapPx),
    '--sn-confirm-title-h': px(profile.confirm.titlePx),
    '--sn-confirm-primary-h': px(profile.confirm.primaryRowPx),
    '--sn-confirm-pad': px(profile.confirm.paddingXPx),
    /** 확정 창의 두 줄 결제 칸(104)과 결제 팀 줄(64, ui 4-5). */
    '--sn-confirm-section-h': px(profile.confirm.sectionPx),
    '--sn-confirm-payer-h': px(profile.confirm.payerRowPx),
    '--sn-method-min': px(profile.confirm.methodButtonMinPx),
    '--sn-key': px(profile.keypad.keyPx),
    '--sn-keypad-display': px(profile.keypad.displayPx),
    '--sn-keypad-title': px(profile.keypad.titlePx),
    '--sn-keypad-load': px(profile.keypad.loadPx),
    '--sn-keypad-side': px(profile.keypad.sidePanelPx),
    /** 화면 키보드(HangulKeyboard): 키 높이 · 사이 · 판 여백 · 판 최대 폭 · 제목 줄 · 표시 칸 여백. 한 칸 폭 · 표시 칸 높이는 부품이 잰 값으로 깐다. */
    '--sn-kb-key': px(profile.keyboard.keyPx),
    '--sn-kb-gap': px(profile.keyboard.gapPx),
    '--sn-kb-inset': px(profile.keyboard.insetPx),
    '--sn-kb-max': profile.keyboard.maxWidthPx === null ? 'none' : px(profile.keyboard.maxWidthPx),
    '--sn-kb-title': px(profile.keyboard.titlePx),
    '--sn-kb-display-pad': px(profile.keyboard.displayPadPx),
    '--sn-kb-glyph': px(profile.keyboard.glyphPx),
    '--sn-stamp': px(profile.stamp.markPx),
    '--sn-panel-max': px(profile.fill.panelMaxPx),
    '--sn-stamp-mini': px(profile.stamp.miniMarkPx),
    '--sn-space-xs': px(profile.space.xs),
    '--sn-space-s': px(profile.space.s),
    '--sn-space-m': px(profile.space.m),
    '--sn-space-l': px(profile.space.l),
    '--sn-radius-s': px(profile.radius.s),
    '--sn-radius-m': px(profile.radius.m),
    '--sn-radius-paper': px(profile.radius.paper),
    '--sn-line': px(profile.line.hair),
    '--sn-line-strong': px(profile.line.strong),
    '--sn-line-stamp': px(profile.line.stamp),
  };
}
