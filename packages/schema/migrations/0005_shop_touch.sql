-- 손님 픽업은 접수의 선택 표시다. 장비 일정·이동·정산은 기존 기록을 쓴다.
ALTER TABLE orders ADD COLUMN customer_pickup INTEGER NOT NULL DEFAULT 0;
