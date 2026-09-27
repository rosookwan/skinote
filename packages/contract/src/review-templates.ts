// 확인 필요 종류(sys_review_kinds, 0001 시드)의 이름 · 문장 틀 · 무게 · 보일 곳의 사본(features-1 §9-1, E18). 도메인이 저장하는 확인 필요의
// 문장(review_items.message)과 마감의 막는 단계가 이 틀로 그려진다. 시드 행은 뒤 마이그레이션이 바꾸지 못한다(lint): 틀을 고치려면 새 종류를
// 더한다. vocab 시험이 이 표와 schema.sql 시드를 맞춰 본다.
// 시드 틀의 수는 `{qty}개`로 굳어 있다. 개로 세지 않는 품목(스키 · 보드 `대`, 의류 `벌`, 리프트권 `매`)은 같은 문장을 그 세는 말로 그린다
// (REVIEW_COUNT_TEMPLATES, 문구 표 3-20).

/** 확인 필요의 무게(code-owned severity_key). */
export type ReviewSeverity = 'info' | 'action' | 'blocking';
/** 먼저 보일 곳(sys_review_kinds.routing_key, sync 4-3). */
export type ReviewRouting = 'manager' | 'origin_device' | 'order_banner' | 'dialog_step';

export interface ReviewKindRow {
  /** 종류 이름(`수거 기록 제외`). */
  label: string;
  /** 문장 틀(`{team} 팀 {item} {qty}개 매장 반납 완료 · 기사 수거 기록 제외`). */
  template: string;
  severity: ReviewSeverity;
  routing: ReviewRouting;
}

/** 시드 sys_review_kinds 그대로(key → 이름 · 틀 · 무게 · 보일 곳). */
export const REVIEW_TEMPLATES: Readonly<Record<string, ReviewKindRow>> = /* @__PURE__ */ Object.freeze({
  already_returned: { label: '수거 기록 제외', template: '{team} 팀 {item} {qty}개 매장 반납 완료 · 기사 수거 기록 제외', severity: 'info', routing: 'origin_device' },
  collect_exceeds: { label: '수거 수량 확인', template: '{team} 팀 수거 {qty}개 · 대여 중 {left}개 · {left}개만 반영', severity: 'action', routing: 'origin_device' },
  plan_displaced: { label: '계획 변경', template: '{item} 실제 위치 {where} · {plan} 계획 해제 · 계획 다시 지정', severity: 'action', routing: 'manager' },
  late_money: { label: '마감 후 수납', template: '{team} 팀 {amount}원 · 마감일({day}) 수납 · {posting_day} 마감 반영', severity: 'info', routing: 'manager' },
  overpaid: { label: '초과 수납', template: '{team} 팀 초과 수납 {amount}원 · 환불 또는 다른 팀 이동', severity: 'action', routing: 'order_banner' },
  allocation_fallback: { label: '품목 미지정 수납', template: '{team} 팀 {amount}원 · 품목 미지정 · 팀 전체 반영 · 품목 선택 필요', severity: 'action', routing: 'manager' },
  card_unknown: { label: '카드 결과 미확인', template: '카드 {amount}원 결제 결과 미확인 · 단말기 화면 · 영수증 확인', severity: 'blocking', routing: 'dialog_step' },
  possible_duplicate_card: { label: '승인번호 중복', template: '승인번호 {approval} · 카드 {amount}원 2건 기록 · 단말기 내역 확인', severity: 'action', routing: 'manager' },
  extra_card_approval: { label: '카드 중복 승인', template: '카드 {amount}원 중복 승인 · 단말기에서 1건 취소', severity: 'blocking', routing: 'dialog_step' },
  possible_duplicate_money: { label: '중복 수납 의심', template: '{team} 팀 {amount}원 · {minutes}분 안 2건 · 중복 여부 확인', severity: 'action', routing: 'origin_device' },
  sms_unknown: { label: '문자 결과 미확인', template: '{team} 팀 문자 발송 결과 미확인 · 필요 시 전화', severity: 'info', routing: 'origin_device' },
  task_cancelled: { label: '취소된 업무', template: '{team} 팀 업무 취소 후 기사 기록 수신', severity: 'action', routing: 'manager' },
  task_moved_meanwhile: { label: '업무 차량 변경 확인', template: '{team} 팀 업무 · {from_vehicle} 처리 완료 · {to_vehicle} 업무 취소', severity: 'info', routing: 'manager' },
  ticket_unavailable: { label: '차량 권 재고 없음', template: '차량 리프트권 재고 없음 · {team} 팀 추가 권 미반영 · 수납 기록 완료', severity: 'action', routing: 'manager' },
  found_after_charge: { label: '분실금 확인', template: '{item} 분실 회수 · {team} 팀 분실금 {amount}원 · 환불 여부 결정', severity: 'action', routing: 'order_banner' },
  deposit_kept_returned: { label: '몰수 보증금 확인', template: '{team} 팀 {item} {qty}{unit} 반납 · 몰수 보증금 {amount}원 · 반환 여부 결정', severity: 'action', routing: 'order_banner' },
  blocked_command: { label: '처리 중단', template: '앞 처리 실패 · 다음 처리 {count}건 중단 · 수납 기록 반영', severity: 'action', routing: 'origin_device' },
  device_gap: { label: '미수신 기록', template: '{device} 기록 {count}건 미수신 · 해당 기기 전송 필요', severity: 'action', routing: 'manager' },
  clock_suspect: { label: '기기 시계 확인', template: '{device} 시계 불일치 · {count}건 날짜 확인 필요', severity: 'action', routing: 'manager' },
  van_unsynced: { label: '차량 전송 대기', template: '{vehicle} 기록 {count}건 전송 대기 · 마감 전 전송 필요', severity: 'blocking', routing: 'dialog_step' },
  route_superseded: { label: '순서 변경', template: '방문 순서 변경됨({device}, {time})', severity: 'info', routing: 'origin_device' },
  decision_overridden: { label: '결정 변경', template: '{time} 결정 {summary} · {other}님 변경', severity: 'info', routing: 'origin_device' },
  receipt_no_clash: { label: '접수 번호 중복', template: '복구 후 접수 번호 {no} 중복 · 종이 접수증 확인', severity: 'action', routing: 'manager' },
  restore_replay: { label: '복구 후 재수신', template: '복구 후 {device} 기기 {count}건 재수신', severity: 'info', routing: 'manager' },
  ui_defaults_kept: { label: '화면 설정 확인', template: '새 화면 설정 {count}개 · 매장 변경 항목 유지', severity: 'info', routing: 'manager' },
  asset_elsewhere: { label: '장비 위치 불일치', template: '{item} 기록상 위치 {where} · {team} 팀 {action} 미반영 · 장비 위치 확인', severity: 'action', routing: 'origin_device' },
  deposit_over_returned: { label: '보증금 초과 반환', template: '{team} 팀 보증금 {amount}원 초과 반환 · {drawer} 현금 출금 기록 · 청구 여부 결정', severity: 'action', routing: 'order_banner' },
  revoked_device_record: { label: '사용 중지 기기 기록', template: '사용 중지 기기({device}) 기록 {count}건 보류 · 확인 후 반영', severity: 'action', routing: 'manager' },
  offline_order_unapplied: { label: '연결 끊김 중 접수 확인', template: '연결 끊김 중 접수(임시 {provisional}) · 대표자 · 품목 · 수납만 반영 · 종이 접수증 대조', severity: 'action', routing: 'origin_device' },
  device_unsynced: { label: '기기 전송 대기', template: '{device} 기록 {count}건 전송 대기 · 마감 전 기기 연결', severity: 'blocking', routing: 'dialog_step' },
  licence_lapsed_record: { label: '라이선스 만료 후 기록', template: '라이선스 만료 후 {device} 연결 끊김 중 접수 {count}건 반영 · 공급자 연락', severity: 'info', routing: 'manager' },
  unverified_sign_in: { label: '미확인 로그인', template: '{device} · {staff}님 연결 끊김 중 로그인 · {count}건 기록 · 계정 중지 또는 번호 변경 후 기록 · 확인 필요', severity: 'action', routing: 'manager' },
  command_held: { label: '공급자 확인 중', template: '{device} 기록 {count}건 공급자 확인 중 · 다른 업무 정상', severity: 'info', routing: 'manager' },
  recomputed_after_restore: { label: '복구 후 재계산', template: '복구 후 {team} 팀 {what} 재계산 · 이전 {before} · 현재 {after}', severity: 'action', routing: 'manager' },
});

/**
 * 개로 세지 않는 품목(`대` · `벌` · `매`)의 같은 문장(E18): 시드 틀의 `{qty}개`를 `{qty}{unit}`로. 저장하는 문장(message)은 이것으로 그리고, 세는 말은
 * 인자(unit)에 남긴다. 개로 세는 품목은 시드 틀 그대로다.
 */
export const REVIEW_COUNT_TEMPLATES: Readonly<Record<string, string>> = /* @__PURE__ */ Object.freeze({
  already_returned: '{team} 팀 {item} {qty}{unit} 매장 반납 완료 · 기사 수거 기록 제외',
  collect_exceeds: '{team} 팀 수거 {qty}{unit} · 대여 중 {left}{unit} · {left}{unit}만 반영',
});

/**
 * 시드 틀이 화면의 버튼과 맞지 않는 종류의 화면 틀(지금 상태에서 세는 것만, 저장하지 않는 문장): 초과 수납 줄의 버튼은 `환불 · {금액}` · `접수증`뿐이라
 * 시드의 `환불 또는 다른 팀 이동`(없는 길 · 지시 문장) 대신 줄이 여는 한 가지로 끝낸다(2026-09-27 점검, 문구 표 3-20).
 */
export const REVIEW_DISPLAY_TEMPLATES: Readonly<Record<string, string>> = /* @__PURE__ */ Object.freeze({
  overpaid: '{team} 팀 초과 수납 {amount}원 · 환불 필요',
});

/** 틀의 자리({team} …)를 인자로 채운다. 없는 자리는 그대로 둔다(시험이 빠진 인자를 찾는다). */
export function renderReview(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) => (params[key] !== undefined ? String(params[key]) : whole));
}

/**
 * 종류와 인자로 문장을 그린다: 세는 말(unit)이 `개`가 아니고 그 종류의 세는 말 틀이 있으면 그 틀, 아니면 시드 틀. 모르는 종류는 빈 글.
 */
export function reviewMessage(kindKey: string, params: Readonly<Record<string, string | number>>): string {
  const unit = params.unit;
  const counted = unit !== undefined && unit !== '개' ? REVIEW_COUNT_TEMPLATES[kindKey] : undefined;
  const template = counted ?? REVIEW_DISPLAY_TEMPLATES[kindKey] ?? REVIEW_TEMPLATES[kindKey]?.template;
  return template ? renderReview(template, params) : '';
}
