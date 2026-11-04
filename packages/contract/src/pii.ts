// 명령 본문에서 개인정보 · 자유 글로 보는 칸(work/impl-offline/plan.md §4-1). 저장소(journal.ts)는 이 칸의 글 값을 작업 기록에서 빼서
// event_pii에 두고, 기사 기기는 보낸 기록(sent)에서 24시간 뒤 이 칸을 지운다(O14 f). 한 곳에 두어 둘이 같은 목록을 쓴다.

/** 명령 본문에서 개인정보 · 자유 글로 보는 칸(값이 글이면 참조로 바꾼다). */
export const PII_KEYS: ReadonlySet<string> = new Set(['name', 'teamName', 'phone', 'note', 'reason', 'reasonNote', 'overrideReason', 'placeNote', 'memo']);

/** 값 안에 개인정보 칸(글 값)이 있는지(시험 · 기기의 24시간 지우기). */
export function hasPii(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPii);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => (PII_KEYS.has(k) && typeof v === 'string') || hasPii(v));
  }
  return false;
}
