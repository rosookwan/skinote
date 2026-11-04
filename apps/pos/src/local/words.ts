// 기사 기기(local/)가 창에 돌려주는 한 줄들(work/impl-offline/plan.md §9). 문구는 앱 문구 표(app/strings.ts의 say)에 있고 session.tsx가 넣는다(strings.ts
// localWords): 이 묶음이 첫 화면 묶음의 문구 표를 따로 끌어와 묶음이 나뉘지 않게.
export interface LocalWords {
  /** `연결 끊김 · 연결 후 가능`. */
  offlineLater: string;
  /** `입고 불가 · 연결 끊김`. */
  receiveNeedsLink: string;
  /** `인계 불가 · 연결 끊김`. */
  handoverNeedsLink: string;
  /** `후불 처리 불가 · 연결 끊김`. */
  deferNeedsLink: string;
  /** `전송 실패 · 재전송 필요`. */
  sendFailed: string;
  /** `기록 불가 · 연결 끊김 · 종이 기록`(저장할 곳이 없는 끊긴 기기, §17 R3-25). */
  recordNeedsPaper: string;
  /** `연결 끊김 · 결과 확인 중`. */
  resultChecking: string;
  /** `입고 불가 · 전송 대기 {n}`. */
  receiveWaiting(n: number): string;
  /** `인계 불가 · 전송 대기 {n}`. */
  handoverWaiting(n: number): string;
  /** `로그아웃 불가 · 전송 대기 {n}`. */
  logoutWaiting(n: number): string;
}
