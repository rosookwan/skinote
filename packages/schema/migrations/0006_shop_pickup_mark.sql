-- 기존 접수의 손님 픽업 체크 변경. 장비 일정·돈과 별개이며 기존 접수 권한을 사용한다.
INSERT INTO sys_event_types (key, category_key, class_key, audit_label, is_money, offline_allowed, engine_key, added_in)
VALUES ('order.customer_pickup', 'order', 'intent', '손님 픽업 변경', 0, 0, 'native', 6);
