-- 0002 첫 서버 연결(2026-09-26, work/impl-server/plan.md §4-3 · ADR-20). 0001은 이미 운영 파일에 적용되어 있어 더하기만 한다.
-- 네 가지: 나눈 일정의 묶음(line_promises.schedule_id), 결제 칸 단위 배분(payment_allocation_sections),
-- 이동 줄이 채운 일정 몫(line_promise_fulfillments), 집이 없던 설정 둘(opening_cash · default_return_slot).

-- 1) 일정 변경으로 나눈 반납 · 수령 일정 하나의 id(FxPromiseSplit.id). 같은 일정으로 옮긴 줄들이 같은 값을 갖는다.
--    line_promises는 장부 표가 아니다(바꾸면 새 행 + 옛 행 superseded).
ALTER TABLE line_promises ADD COLUMN schedule_id TEXT;
CREATE INDEX line_promises_schedule ON line_promises (shop_id, order_id, schedule_id) WHERE schedule_id IS NOT NULL;

-- 2) 줄을 고르지 않고 결제 칸(리프트권 선입금 …)을 채운 배분. 장부 표(payment_allocations)에 열을 더하면 '한 번만' 트리거가
--    빈 칸 → 값 한 번을 허락해 이미 적은(마감한 날의) 배분이 나중에 칸을 얻을 수 있다. 그래서 새 연결 장부 표(E5)로 둔다: 배분 한 줄에
--    칸 하나, 추가만(고치기 · 지우기 금지), 배분 · 결제 칸에 복합 FK.
CREATE TABLE payment_allocation_sections (
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  payment_id          TEXT    NOT NULL,
  seq                 INTEGER NOT NULL,
  payment_section_id  TEXT    NOT NULL,
  created_rev         INTEGER NOT NULL,
  PRIMARY KEY (shop_id, payment_id, seq),
  FOREIGN KEY (shop_id, payment_id, seq) REFERENCES payment_allocations(shop_id, payment_id, seq),
  FOREIGN KEY (shop_id, payment_section_id) REFERENCES payment_sections(shop_id, id)
) STRICT;
CREATE TRIGGER payment_allocation_sections_no_update BEFORE UPDATE OF
  shop_id, payment_id, seq, payment_section_id, created_rev
  ON payment_allocation_sections BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payment_allocation_sections'); END;
CREATE TRIGGER payment_allocation_sections_no_delete BEFORE DELETE ON payment_allocation_sections BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payment_allocation_sections'); END;

-- 3) 이동 줄 하나가 어느 일정 몫을 채웠나(매장 반납이 나눈 일정으로 들어감, 나눈 일정 업무의 수거 · 입고). 새 연결 표(E5, ADR-03).
CREATE TABLE line_promise_fulfillments (
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  movement_id  TEXT    NOT NULL,
  line_no      INTEGER NOT NULL,
  order_id     TEXT    NOT NULL,
  promise_id   TEXT    NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity >= 1),
  created_rev  INTEGER NOT NULL,
  PRIMARY KEY (shop_id, movement_id, line_no, promise_id),
  FOREIGN KEY (shop_id, movement_id, line_no) REFERENCES stock_movement_lines(shop_id, movement_id, line_no),
  FOREIGN KEY (shop_id, order_id, promise_id) REFERENCES line_promises(shop_id, order_id, id)
) STRICT;
CREATE INDEX line_promise_fulfillments_promise ON line_promise_fulfillments (shop_id, promise_id);
CREATE TRIGGER line_promise_fulfillments_no_update BEFORE UPDATE OF
  shop_id, movement_id, line_no, order_id, promise_id, quantity, created_rev
  ON line_promise_fulfillments BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY line_promise_fulfillments'); END;
CREATE TRIGGER line_promise_fulfillments_no_delete BEFORE DELETE ON line_promise_fulfillments BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY line_promise_fulfillments'); END;

-- 4) 집이 없던 설정 둘. opening_cash는 매장의 첫 마감의 시재만(뒤의 마감은 앞 마감의 센 금액을 잇는다), default_return_slot은
--    권이 없는 새 접수의 반납 시각 처음 값(return_slots.sort는 고르는 차례라 기본값을 싣지 못한다). added_in은 들어온 마이그레이션 번호.
INSERT INTO sys_setting_definitions (key, label, value_schema_key, default_value, effective_dated, added_in) VALUES
 ('opening_cash',        '시재',            'setting.money_amount', '{"amount":0}',           0, 2),
 ('default_return_slot', '기본 반납 타임',  'setting.return_slot',  '{"return_slot_id":null}', 0, 2);
