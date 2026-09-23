// 화면 틀의 높이 예산(ui 4-3, 6-2, 6-3). 숫자는 부르는 쪽이 DeviceProfile에서 넘긴다(여기에는 크기 숫자가 없다).
// 화면은 목록 자리의 높이를 스스로 재지만(Ledger · Slip), 설정 시험(ui 8절)과 서버의 설정 명령은 화면을 그리지 않고
// 이 계산으로 '이 설정이 모든 대상 크기에 들어가는지'를 본다. 그래서 화면의 틀 높이와 같은 값(DeviceProfile)으로 계산한다.

/** 목록 화면의 머리 · 제목 · 바닥(+ 표 머리, 연결 띠). */
export interface ListChrome {
  headerPx: number;
  titleTabsPx: number;
  footerPx: number;
  /** 표 머리(장부). 없는 틀(기사 목록)은 0. */
  tableHeadPx?: number;
  /** 오프라인일 때의 연결 띠(보일 때만 넘긴다). */
  connectionStripPx?: number;
}

/** 목록에 쓸 수 있는 높이: 잰 화면 높이 − 머리 − 제목 · 탭 − 표 머리 − 바닥 − 연결 띠. */
export function listAreaHeight(viewportHeight: number, chrome: ListChrome): number {
  const used = chrome.headerPx + chrome.titleTabsPx + chrome.footerPx + (chrome.tableHeadPx ?? 0) + (chrome.connectionStripPx ?? 0);
  return Math.max(0, viewportHeight - used);
}

/** 접수증(6-2)의 고정 부분: 머리 · 제목 · 칸 한 줄 · 약속 요약 · 돈 줄 · 표 머리 · 바닥. */
export interface SlipChrome {
  headerPx: number;
  titlePx: number;
  fieldsPx: number;
  promisePx: number;
  moneyPx: number;
  tableHeadPx: number;
  footerPx: number;
}

export function slipFixedHeight(chrome: SlipChrome): number {
  return chrome.headerPx + chrome.titlePx + chrome.fieldsPx + chrome.promisePx + chrome.moneyPx + chrome.tableHeadPx + chrome.footerPx;
}

/** 접수증 품목 표에 한 쪽에 들어가는 품목 줄 수. 넘치면 품목 표만 쪽을 넘긴다('품목 1 / 3쪽'). */
export function slipItemRows(viewportHeight: number, chrome: SlipChrome, rowPx: number): number {
  return Math.max(0, Math.floor((viewportHeight - slipFixedHeight(chrome)) / rowPx));
}

/** 숫자판을 어디에 둘지(ui 5 Keypad): 높이가 기준 이상인 태블릿은 오른쪽 판, 그보다 낮거나 휴대폰이면 아래에서 올라오는 판. */
export function keypadPlacement(viewportHeight: number, sidePanelMinHeightPx: number, allowSide: boolean): 'side' | 'sheet' {
  return allowSide && viewportHeight >= sidePanelMinHeightPx ? 'side' : 'sheet';
}
