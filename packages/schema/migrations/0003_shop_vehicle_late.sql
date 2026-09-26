-- 0003 차량 늦음의 여유(2026-09-26 첫 매장 답 15, README D7). 0001 · 0002는 이미 운영 파일에 적용되어 있어 더하기만 한다.
-- 차량 수거 · 배달 약속이 늦음(빨강)이 되기까지의 여유 분. minutes = 그 밖의 차량 약속, night_minutes = 야간 반납 타임(return_slots.is_night)
-- 이후의 차량 약속. 스키장이 22:00에 끝나 손님 연락이 22:30 ~ 23:00에 오는 매장은 밤 수거가 늘 하는 일이라 22:00 + 60분에 빨개지면 안 된다
-- (첫 매장 night_minutes 90). 기본값은 지금까지의 규칙(60 · 60)이라 이 행이 없는 매장의 화면은 그대로다. added_in은 이 마이그레이션 번호.
INSERT INTO sys_setting_definitions (key, label, value_schema_key, default_value, effective_dated, added_in) VALUES
 ('vehicle_late_after_minutes', '차량 지연 기준', 'setting.vehicle_late', '{"minutes":60,"night_minutes":60}', 0, 3);
