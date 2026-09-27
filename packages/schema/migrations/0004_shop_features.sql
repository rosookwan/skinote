-- 0004 기능 묶음 1(2026-09-27, work/impl-features-1/plan.md §3-1 · ADR-21). 0001 ~ 0003은 이미 적용되어 있어 더하기만 한다.
-- 표 · 열은 더하지 않는다(설정 · 할인 · 환불 · 취소가 쓰는 칸은 0001에 모두 있다). 동작 이름은 docs/design/wording.md 3-20의 말이고,
-- 한 번 배포하면 뒤 마이그레이션이 이름을 바꿀 수 없다(plan §14 Q1).

-- 1) 접수 취소를 새 처리기로(엔진 행만 바꿈, lint 허용).
UPDATE sys_event_types SET engine_key = 'native' WHERE key = 'order.cancel';

-- 2) 청구 없는 분실(안 돌아온 리프트권을 손님 → 폐기·분실로, README 열린 질문 35 ①).
INSERT INTO sys_event_types (key, category_key, class_key, audit_label, is_money, offline_allowed, engine_key, added_in) VALUES
 ('stock.write_off', 'stock', 'intent', '분실 처리', 0, 0, 'native', 4);

-- 3) 접수증 옆 동작의 조건(cancellable은 접수 전체로 셈: 모든 줄이 손님에게 없음).
INSERT INTO sys_conditions (key, scope_key, label, added_in) VALUES
 ('order_open', 'order', '진행 중 접수', 4), ('cancellable', 'order', '접수 취소 가능', 4), ('tickets_out', 'line', '미반납 리프트권 있음', 4);

-- 4) 접수증 옆 동작(말은 wording.md 3-20 — 배포 전 확인, plan §14 Q1).
INSERT INTO sys_actions (key, label, kind_key, command_key, confirm_template_key, undo_command_key, screen_key, rule_scope_key, added_in) VALUES
 ('add_items', '품목 추가', 'command', 'order.add', NULL, NULL, NULL, 'order', 4),
 ('remove_items', '품목 취소', 'command', 'order.cancel', NULL, NULL, NULL, 'line', 4),
 ('apply_discount', '할인 적용', 'command', 'discount.apply', NULL, NULL, NULL, 'order', 4),
 ('ticket_loss', '분실 처리', 'command', 'stock.write_off', NULL, NULL, NULL, 'line', 4);
