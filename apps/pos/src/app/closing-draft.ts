// 하루 마감(V6, spec 3-7)의 화면 초안: 센 돈통 금액(돈통 점검 · 재점검)과 점검 이월한 차량 봉투. 명령이 아니라 화면 상태이고(plan §8 D3:
// 마감 전의 돈통 셈을 적는 명령 · 장부 표는 없다), 마감 명령(closing.close)이 싣는다. 탭(sessionStorage)에 남아 장부 · 접수증에 다녀와도
// 그대로이고, 체험 자료를 초기화하면(epoch가 바뀜) 버린다. 화면은 계산하지 않는다: 고른 것(친 금액 · 사유 · 이월)을 인자로 closingSheet를
// 다시 묻고, 차액 · 주 버튼 · 보낼 것은 서버가 쓴다.
import type { ClosingCount, ClosingSheetParams } from '@skinote/contract';

export interface ClosingDraft {
  epoch: string;
  date: string;
  counts: ClosingCount[];
  deferredTransferIds: string[];
}

/** 점검 판에서 고른 차액 사유(직접 입력이면 글). */
export interface ClosingReason {
  reasonKey?: string;
  reasonNote?: string;
}

const STORAGE_KEY = 'sn-closing';

/** 돈통 셈을 초안에 넣는다(같은 돈통의 앞 셈은 바꾼다). */
export function withCount(params: ClosingSheetParams, count: ClosingCount): ClosingSheetParams {
  return { ...params, counts: [...(params.counts ?? []).filter((c) => c.drawerId !== count.drawerId), count] };
}

/** `점검 이월`: 그 차량 봉투를 따로 둔다(이월 항목 `미확인 현금 인계`). */
export function withDefer(params: ClosingSheetParams, key: string): ClosingSheetParams {
  const list = params.deferredTransferIds ?? [];
  return list.includes(key) ? params : { ...params, deferredTransferIds: [...list, key] };
}

/** 이월한 봉투를 오늘 셌다(점검 판의 확인이 끝남): 이월에서 뺀다. */
export function withoutDefer(params: ClosingSheetParams, key: string): ClosingSheetParams {
  const list = params.deferredTransferIds ?? [];
  return list.includes(key) ? { ...params, deferredTransferIds: list.filter((k) => k !== key) } : params;
}

/** 친 숫자(숫자만) → 금액. 비었으면 아직 치지 않음. */
export function amountOf(digits: string): number | undefined {
  const only = digits.replace(/\D/g, '');
  return only ? Number(only) : undefined;
}

/** 점검 판이 다시 물을 인자: 화면 초안 + 그 줄 · 친 금액 · 고른 사유. */
export function checkParams(params: ClosingSheetParams, key: string, digits: string, reason: ClosingReason = {}): ClosingSheetParams {
  const countedAmount = amountOf(digits);
  return {
    ...params,
    check: {
      key,
      ...(countedAmount !== undefined ? { countedAmount } : {}),
      ...(reason.reasonKey ? { reasonKey: reason.reasonKey } : {}),
      ...(reason.reasonNote ? { reasonNote: reason.reasonNote } : {}),
    },
  };
}

/** 초안의 인자(날짜 · 셈 · 이월). 초안이 없으면 날짜만. */
export function draftParams(date: string | null, draft: ClosingDraft | null): ClosingSheetParams {
  const base: ClosingSheetParams = date ? { date } : {};
  if (!draft || !date || draft.date !== date) return base;
  return {
    ...base,
    ...(draft.counts.length ? { counts: draft.counts } : {}),
    ...(draft.deferredTransferIds.length ? { deferredTransferIds: draft.deferredTransferIds } : {}),
  };
}

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}

export function readClosingDraft(): ClosingDraft | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as ClosingDraft;
    return typeof draft.epoch === 'string' && typeof draft.date === 'string' && Array.isArray(draft.counts) && Array.isArray(draft.deferredTransferIds) ? draft : null;
  } catch {
    return null;
  }
}

export function writeClosingDraft(draft: ClosingDraft): void {
  try {
    if (!draft.counts.length && !draft.deferredTransferIds.length) storage()?.removeItem(STORAGE_KEY);
    else storage()?.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // 저장이 막혀도 마감 화면은 돈다(다른 화면에 다녀오면 셈을 다시 친다).
  }
}

export function clearClosingDraft(): void {
  try { storage()?.removeItem(STORAGE_KEY); } catch { /* 저장이 막힌 브라우저 */ }
}
