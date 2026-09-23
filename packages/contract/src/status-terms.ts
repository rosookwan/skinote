// 상태 문구(ui 3-3). 화면은 상태 키만 비교하고, 문구 · 색 · 순위는 매장의 status_terms에서 가져온다.
// 매장 문구가 없으면 sys_status_keys.default_label(아래 표)을 쓴다. 키 글자 그대로나 빈칸이 보이는 일은 없다.
import type { StatusDomainKey, ToneKey } from './vocab.ts';

/** sys_status_keys의 기본 문구(ko-KR). schema 시드와 같아야 한다(test/vocab.test.ts). */
export const STATUS_DEFAULT_LABELS = {
  order: {
    booked: '예약', cancelled: '취소', awaiting_exchange: '교환 대기', needs_review: '확인 필요', partial_return: '일부 반납',
    in_use: '이용 중', awaiting_shop: '차량에 있음', awaiting_load: '차량 적재 대기', awaiting_issue: '지급 대기',
    returned: '반납 끝', completed: '끝',
  },
  line: { todo: '할 일', partial: '일부', done: '끝', na: '해당 없음' },
  task: { waiting: '대기', in_progress: '가는 중', completed: '끝', cancelled: '취소' },
  pay_state: { paid: '수납 끝', partial: '일부 수납', unpaid: '미수', promised: '다른 팀 결제 예정', none: '받을 돈 없음' },
  promise: { active: '살아 있음', superseded: '바뀜', fulfilled: '지킴', cancelled: '취소' },
  booking: { unassigned: '강습팀 미정', reserved: '예약', done: '끝', cancelled: '취소', no_show: '불참' },
  stamp: { todo: '할 일', partial: '일부', done: '끝', na: '—', blocked: '먼저 할 일', scheduled: '예정', delegated: '차량이 함' },
} as const satisfies Record<StatusDomainKey, Record<string, string>>;

export type StatusKeyOf<D extends StatusDomainKey> = keyof (typeof STATUS_DEFAULT_LABELS)[D] & string;

export interface StatusTermRow {
  domain_key: StatusDomainKey;
  key: string;
  locale: string;
  label: string;
  tone_key: ToneKey;
  rank: number;
}

export interface StatusTerm {
  label: string;
  tone: ToneKey;
  rank: number;
}

/**
 * 상태 키의 문구 · 색 · 순위. 매장 행(locale 일치) → 같은 언어가 없으면 ko-KR 행 → 기본 문구 순으로 찾는다.
 * 기본 문구로 떨어지면 색은 ink, 순위는 0이다.
 */
export function statusTerm(rows: readonly StatusTermRow[], domain: StatusDomainKey, key: string, locale = 'ko-KR'): StatusTerm {
  const hit = rows.find((r) => r.domain_key === domain && r.key === key && r.locale === locale)
    ?? rows.find((r) => r.domain_key === domain && r.key === key && r.locale === 'ko-KR');
  if (hit) return { label: hit.label, tone: hit.tone_key, rank: hit.rank };
  const defaults: Readonly<Record<string, string>> = STATUS_DEFAULT_LABELS[domain];
  // 모르는 키(앱보다 새 서버)는 키 글자 대신 '—'로 보이고, 부르는 쪽이 서버에 알린다(ui 7절).
  return { label: defaults[key] ?? '—', tone: 'ink', rank: 0 };
}
