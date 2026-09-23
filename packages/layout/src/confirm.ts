// 접수 확정 창의 폭과 높이(ui 4-5). 칸마다 두 줄(1줄 = 칸 이름 · 받을 금액 · 할인, 2줄 = 수단 버튼 + 나중에 + 다른 수단).
// 한 쪽에 들어가는 칸 수는 잰 창 높이로 정하고, 넘치면 '다음 칸 ›'으로 쪽을 넘긴다. 숫자는 DeviceProfile에서 온다.

export interface ConfirmWindowSpec {
  /** 창 폭 = min(화면 폭 − 2 × sideMarginPx, maxWidthPx). */
  sideMarginPx: number;
  maxWidthPx: number;
  /** 창 위아래 여백. 여백을 두면 가장 작은 창(minHeightPx)이 안 들어갈 때 compactMarginYPx로 줄인다. */
  marginYPx: number;
  compactMarginYPx: number;
  minHeightPx: number;
  titlePx: number;
  sectionPx: number;
  payerRowPx: number;
  primaryRowPx: number;
  /** 창 안 좌우 여백(수단 버튼 줄의 폭 계산). */
  paddingXPx: number;
  methodButtonMinPx: number;
  methodGapPx: number;
}

export interface ConfirmWindowLayout {
  widthPx: number;
  heightPx: number;
  /** 제목 + 칸들 + 결제할 팀 줄 + 주 버튼 줄로 한 쪽에 들어가는 칸 수(적어도 1). */
  sectionsPerPage: number;
  pageCount: number;
  /** 수단 줄에 들어가는 버튼 수(빠른 수단 + 나중에 + 다른 수단). */
  methodButtonsFit: number;
  /** 버튼으로 보일 빠른 수단 수(나머지는 '다른 수단' 안). */
  quickShown: number;
  /** 가장 작은 창도 들어가지 않는다. */
  tooSmall: boolean;
}

/**
 * @param sectionCount 결제 칸 수(장비 · 리프트권 · 보증금 · 판매 …)
 * @param quickMethods quick = 1인 수단 수(등급의 빠른 수단 칸 수로 이미 자른 값)
 * @param maxSectionsPerPage 등급의 '한 쪽 결제 칸' 수(ui 3-7). 창이 더 높아도 한 쪽에 이보다 많이 넣지 않는다.
 */
export function confirmWindow(viewport: { width: number; height: number }, spec: ConfirmWindowSpec, sectionCount: number, quickMethods: number, maxSectionsPerPage = Number.POSITIVE_INFINITY): ConfirmWindowLayout {
  const widthPx = Math.min(viewport.width - 2 * spec.sideMarginPx, spec.maxWidthPx);
  const roomy = viewport.height - 2 * spec.marginYPx;
  const heightPx = roomy >= spec.minHeightPx ? roomy : viewport.height - 2 * spec.compactMarginYPx;
  const chrome = spec.titlePx + spec.payerRowPx + spec.primaryRowPx;
  const sectionsPerPage = Math.max(1, Math.min(maxSectionsPerPage, Math.floor((heightPx - chrome) / spec.sectionPx)));
  const pageCount = Math.max(1, Math.ceil(sectionCount / sectionsPerPage));
  const inner = widthPx - 2 * spec.paddingXPx;
  const methodButtonsFit = Math.max(0, Math.floor((inner + spec.methodGapPx) / (spec.methodButtonMinPx + spec.methodGapPx)));
  // '나중에'와 '다른 수단'은 늘 보이고, 남는 자리에 빠른 수단.
  const quickShown = Math.max(0, Math.min(quickMethods, methodButtonsFit - 2));
  return {
    widthPx,
    heightPx,
    sectionsPerPage,
    pageCount,
    methodButtonsFit,
    quickShown,
    tooSmall: heightPx < chrome + spec.sectionPx || methodButtonsFit < 3,
  };
}

/** 수단 버튼 n개가 차지하는 폭(각 최소 폭 + 사이). */
export function methodRowWidth(buttons: number, spec: Pick<ConfirmWindowSpec, 'methodButtonMinPx' | 'methodGapPx'>): number {
  return buttons <= 0 ? 0 : buttons * spec.methodButtonMinPx + (buttons - 1) * spec.methodGapPx;
}
