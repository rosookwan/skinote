# 품목과 요금

작성 2026-09-23(같은 날 검토 반영). 품목 종류, 능력 값, 상품과 규격, 속성, 세트, 요금표, 할인, 가격 출처, 리프트권과 강습, 세금을 정한다. 표 정의는 [`schema.sql`](../../packages/schema/schema.sql) 2.4 · 2.5절, 전체 원칙은 [data-model.md](data-model.md).

## 0. 한눈에

- 옛 시스템은 품목 종류가 네 개(장비 · 의류 · 헬멧 · 리프트권)로 고정이고, 리프트권은 약 30곳에서 `category === 'liftTicket'`으로 따로 처리했다. 강습처럼 물건이 없는 품목은 들어갈 자리가 없었다(하루 단위로 청구되고, 장비 할인 묶음에 들어가고, 접수가 `지급 대기`에서 끝나지 않음).
- 새 구조에서 **리프트권과 강습은 평범한 품목 종류**다. 코드는 종류 이름이 아니라 **능력 값**을 본다(`fulfillment_mode_key`, `return_policy_key`, `ticketed`, `ends_same_day` …). 새 종류는 행을 더하는 것으로 끝난다.
- 가격은 **판 번호가 붙은 요금표**에서 서버가 계산한다. 게시된 판은 바뀌지 않고, 줄은 자기가 쓴 판 · 규칙 · 계산 방식 · 내역을 가진다. 할인은 어느 규칙을 어떤 값으로 적용했는지와 줄별 몫이 남는다.

## 1. 층

```text
sys_fulfillment_modes   행동 계열(코드): rental · ticket · service · sale · fee · bundle · placeholder
  └ item_kinds          매장의 품목 종류와 능력 값, 결제 칸, 할인 묶음, 세금 분류, 도장 단계, 속성
      └ catalog_items   고르는 상품(SKU). 종류 값을 덮어쓸 수 있음(NULL = 종류 값). 가격 묶음(price_groups)에 들 수 있음
          ├ item_variants            규격(부츠 250mm, 헬멧 M, 스키 140cm)
          ├ catalog_item_components  세트 구성
          ├ ticket_products          리프트권 조건(1:1)
          └ 실물: assets(하나씩, 다른 상품으로 옮기면 asset_reclassifications) + ticket_units(권) · stock_balances(수량: 위치 · 규격 · 상태 · 주인 · 묶음)
order_lines             팔 때의 스냅샷: 종류 · 계열 · 재고 방식 · 반납 정책 · 이름 · 단위 · 가격 · 출처 · 세금(만든 뒤 바뀌지 않음, 트리거)
```

실제로 쓰는 능력 값 = `catalog_items`의 값 ?? `item_kinds`의 값 ?? 계열 기본값(`sys_fulfillment_modes.default_return_policy_key` 등). 줄을 만들 때 계열 · 재고 방식 · 반납 정책을 **줄에 복사**하므로, 나중에 종류 설정을 바꿔도 지난 줄의 뜻은 바뀌지 않는다. 연장 · 교환 · 준비처럼 앞으로 할 일을 허락하는 값(`extendable`, `exchangeable`, `preparable`)은 그때 종류에서 읽는다.

## 2. 품목 종류의 능력 값

| 열 | 값 | 뜻 | 읽는 곳 |
|---|---|---|---|
| `fulfillment_mode_key` | rental · ticket · service · sale · fee · bundle · placeholder | 행동 계열: 보관 책임이 있는지, 지급이 필요한지, 줄이 언제 끝나는지 | 줄 완료, 접수 상태, 재고 이동 허용 |
| `tracking_key` | unit · count · none | 재고를 하나씩(`assets`) 세는지, 수량으로(`stock_balances`) 세는지, 세지 않는지 | 지급 · 반납 창(장비 고르기 또는 수량), 재고 화면, 차량 적재 요약 |
| `return_policy_key` | required · optional · none | **반납이 필요한가.** required: 돌아와야 줄이 끝남. optional: 지급으로 끝, 회수하면 기록하고 반납 도장. none: 반납 칸이 `—` | 줄 완료, 반납 도장, 수거 목록 |
| `default_price_basis_key` | per_day · per_unit · per_session · per_person_session · per_hour · half_day · flat | 가격 기준 | 가격 계산(8절) |
| `payment_section_id` | 결제 칸 | 접수 확정 창에서 어느 줄에 들어가는지, 기본 수단 · 시점 | 확정 창(15절), 마감 칸별 합계 |
| `discount_group_id` | 할인 묶음 | 어느 묶음의 할인을 받는지(한 묶음에 하나) | 할인(9절) |
| `sized` | 0/1 | 사이즈 칸이 있음(규격 축 또는 사람 치수) | 사이즈 요청, 준비, 교환 창의 규격 고르기 |
| `exchangeable` | 0/1 | 교환 가능 | 교환 버튼(N17: 의류 · 헬멧도 켬) |
| `extendable` | 0/1 | 기간 연장 가능 | 연장 창 |
| `preparable` | 0/1 | 규격·준비 단계가 있음 | 준비표, 준비 도장 |
| `delivery_allowed` | 0/1 | 차량 배달 가능 | 수령 약속의 방법 버튼 |
| `ends_same_day` | 0/1 | 이용 시작 = 끝(하루권) | 날짜 고르기, 연장 금지 |
| `ticketed` | 0/1 | 권 조건(유효 기간, 발권처, 시간대 배정)이 있음 | 발권 · 배정 · 회수 · 발권처 환불, 현장 권 추가 |
| `requires_time_slot` | 0/1 | 시간대를 골라야 함(강습) | 접수 창의 시간대 줄, 강습 목록 |
| `requires_headcount` | 0/1 | 인원을 받아야 함(강습, 인원만 예약) | 접수 창의 인원 입력 |
| `partial_cancel_allowed` | 0/1 | 일부 수량 취소 가능 | 취소 창 |
| `settlement_role_key` | resort_vendor · lesson_team · … | 이 줄의 돈을 누구와 정산하나 | 강습 위탁 · 권 구입 거래 |
| `tax_category_key` | taxable · exempt · zero_rated · agency | 부가세 분류(대행 = 수수료만 매출). NULL이면 세금을 기록하지 않음. 상품이 덮을 수 있음 | 줄 스냅샷, 세금 문서, 마감 세금 합계(18절) |
| `feature_key` | 사용 기능 | 기능이 꺼지면 종류가 고르기 · 탭 · 확정 창에서 사라짐 | 모든 화면 |
| `picker_placement_key` | tile · grouped · hidden(`sys_picker_placements`) | 고르기 화면에서 타일로 보일지, 한 타일 뒤에 묶일지(리프트권 권종 창) | 새 접수 2단계 |
| `unit_label` · `stock_metric_label` · `tone_key` · `icon_key` · `sort` | | 단위(대 · 벌 · 개 · 매 · 명), 차량 요약 이름, 색(`sys_tones`), 아이콘(`sys_icons`), 순서 | 화면 |

도장 단계는 `item_kind_stamp_steps`(종류 × 단계 × 순서 × 조건)로 붙는다. 조건 `vehicle_pickup`이면 차량 배달 약속이 있는 줄에만 `적재` 도장이 생긴다(N1). 사이즈 칸은 `item_kind_attributes`(용도: variant_axis · line · person · asset)로 붙는다.

새 능력이 필요하면 `item_kinds`와 `catalog_items`에 빈 값을 허용하는 열을 더한다(NULL = 계열 기본값). JSON 칸에 넣지 않는다 — 형식 있는 열이라야 데이터베이스와 검증기가 볼 수 있다.

## 3. 첫 매장의 시작 값

매장 개설 명령(`shop.provision`)이 판 번호가 붙은 시드 파일과 고른 스키장 템플릿으로 넣는다. 옛 자료를 가져오면 이 값 위에 옛 설정(요금, 장소, 할인, 차량, 직원)을 얹는다.

**결제 칸과 할인 묶음**

| key | 결제 칸 | 기본 수단 · 시점 | 할인 묶음이 고를 수 있는 할인 |
|---|---|---|---|
| gear | 장비 | 카드 · 접수 때 | per_unit_day(개당 하루), percent, amount, manual_amount |
| lift | 리프트권 | 현금 · 접수 때 | percent |
| lesson | 강습(기능 lessons, 꺼짐) | 현금 · 접수 때 | percent, amount |

**품목 종류**

| key | 이름 | 계열 | 재고 | 반납 | 가격 | 칸 · 할인 | 세금 | 능력 값 | 도장 |
|---|---|---|---|---|---|---|---|---|---|
| equipment | 장비 | rental | unit | required | per_day | gear | taxable | sized, exchangeable, extendable, preparable, delivery | (적재 →) 지급, 반납 |
| clothing | 의류 | rental | unit | required | per_day | gear | taxable | sized, exchangeable(N17), extendable, preparable, delivery | (적재 →) 지급, 반납 |
| helmet | 헬멧 | rental | unit | required | per_day | gear | taxable | sized, exchangeable(N17), extendable, preparable, delivery | (적재 →) 지급, 반납 |
| lift_ticket | 리프트권 | ticket | unit | optional(질문지 2번 답을 받으면 확정) | per_unit | lift | agency(세무 확인 전까지 NULL) | ticketed, ends_same_day, delivery, 기능 lift_tickets, 타일 grouped, 정산 resort_vendor | 발권, 지급 |
| lesson | 강습 | service | none | none | per_person_session | lesson | 확인 전까지 NULL | requires_time_slot, requires_headcount, 기능 lessons, 정산 lesson_team | 강습 |
| headcount | 인원만 예약 | placeholder | none | none | flat(0원) | gear | — | requires_headcount, 고르기에서 숨김(`hidden`) | — |

세금 분류 값(특히 리프트권 대행과 강습)은 세무 담당 확인 뒤 종류 값만 채운다(README 열린 질문). 비워 두면 줄에 세금이 기록되지 않을 뿐 다른 것은 그대로 돈다.

**상품**: 옛 id를 매장 코드 접두어와 함께 둔다(`shop1.ski`; 아래에서는 접두어를 줄여 씀). `ski`, `board`(equipment), `clothing`, `helmet`, `ticket-3h` · `ticket-4h` · `ticket-6h`(lift_ticket, `ticket_products.hours`). 옛 교환이 자동으로 만든 구성품(`ski-boots`, `poles`, `board-boots`, `exchange-other`)은 `hidden_in_picker = 1`로 들어오고 `catalog_item_components`로 세트에 연결한다. `legacy-` 상품은 `requires_type_confirmation = 1`.

**속성**: 사람 치수 `height_cm`(int, cm), `foot_mm`(int, mm), `clothing_size`(option), `helmet_size`(option), 장비 선택 `equipment_choice`(option: ski · board) — 옛 사이즈 입력폼의 고정 칸을 옮긴 것이다. 자리: `intake_form`, `prep_sheet`, `team_label`.

**도장 단계**: `issue` 지급 · `return` 반납 · `pay` 수납 · `load` 적재 · `ticket_secure` 발권 · `collect` 받음(시각 표시) · `receive` 매장 입고 · `lesson_done` 강습(기능 lessons). 단계마다 동작(`sys_actions`: 명령 + 확인 창 + 되돌리기)이 하나다.

## 4. 상품 · 규격 · 실물

- `catalog_items`는 고르기 화면의 한 칸이다. 지우지 않고 `archived_at`으로 숨긴다. 순서(`sort`), 즐겨찾기, 사진, 단위를 가진다.
- `item_variants`는 따로 세는 규격이다. 규격 축은 `item_kind_attributes(usage 'variant_axis')`로 정하고, 규격마다 값은 `variant_attribute_values`에 둔다(부츠 `boot_mm = 265`). 규격은 반드시 그 상품의 것이어야 한다(`(shop_id, catalog_item_id, variant_id)` 복합 FK).
- 번호로 관리하는 품목(`tracking unit`)은 한 대마다 `assets` 행이다. 스티커 번호(`tag_code`)는 있어도 되고 없어도 된다(docs/04: "수량 우선, 번호는 나중"). 옛 자유 글자 사이즈는 `size_text`로 남고, 규격에 맞추는 것은 직원에게 제안만 한다.
- 수량으로 세는 품목(`tracking count`)은 `stock_balances(위치, 규격, 상태, 주인, 묶음)`가 수량이고, 이동 줄이 규격 · 수량 · 떠나는 상태 · 들어가는 상태(필수) · 주인 · 묶음을 가진다. 거래처에서 빌린 고글과 우리 고글, 유효기한이 다른 핫팩 묶음을 따로 센다. 단체에 미리 잡아 두는 것은 `stock_holds`. 교환(M → L 2개), 조기 반납(6개 중 2개), 거래처 빌림(20개), 준비도 수량으로 된다.
- 규격이 바뀌는 일(준비하면서 부츠를 바꿔 끼움)은 `asset_condition_changes`의 전후 규격으로 남는다. 옛 코드처럼 사이즈가 조용히 덮어써지지 않는다.
- **장비를 다른 상품으로 옮기는 일**(보드 여섯 대를 '프리미엄 보드'로, 어른 스키로 넣은 어린이 스키를 바로잡기, 같은 상품 둘 합치기, 옛 `legacy-` 권의 종류 확정)은 `asset_reclassifications`(전후 상품 · 규격, 사유) 한 행이고 `assets.catalog_item_id`는 그 투영이다. 이동 줄은 그때 상품을 스냅샷으로 가지고 장비는 `(shop_id, asset_id)`로만 가리키므로 지난 이동 기록을 건드리지 않는다. 지우고 새로 만들지 않는다(가짜 재고 역사가 생기지 않음).

## 5. 속성

- `attribute_definitions`: 매장마다, 대상 종류마다(접수 · 줄 · 일행 · 고객 · 상품 · 규격 · 장비 · 업무 · 장소 · 거래처). 이름과 짧은 이름, 형식(text · int · decimal · bool · date · time · option · measurement · money), 여러 값 여부(`multi_valued`: 무릎 + 손목 보호대, 연락처 둘), 입력 방식(`input_widget_key`: 숫자판 · 선택 격자 · 켜기 · 시각 버튼 · 글자 · 달력), 보이는 모양(`display_format_key`), 단위, 범위와 간격(`step_value`: 부츠 220~300 5mm → 선택 격자 17칸, 쪽 넘김), 최대 길이, 개인정보 여부, 검색 여부. 값은 `value_seq`로 여러 개, 값마다 단위(`value_unit`: US · mm)를 둘 수 있다. 구입가처럼 돈인 값은 `money`(최소 단위 정수).
- `attribute_options`: 선택지(ski · board, S · M · L). 키는 ASCII.
- `attribute_placements`: **입력폼 · 문서** 어디에 묻고 보이는가(사이즈 입력폼, 접수 화면, 준비표, 팀 스티커, 접수증, 영수증, 기사 업무 판). 기기 등급별로 따로 둘 수 있고, 순서 · 우선순위 · 넘칠 때 · 글자 맞춤 · 필수 여부 · 자리별 이름을 가진다. **표 모양 화면**(대여 장부, 기사 목록 줄, 수거 목록)에 보이려면 자리가 아니라 장부 칸(`ledger_view_columns`의 `attribute`)을 더한다(ui 문서 3-10). 한 칸이 두 곳에 있지 않다.
- `item_kind_attributes`: 종류마다 쓰는 속성과 용도(규격 축 · 줄 · 사람 · 장비 — 어느 화면에서 묻는지 정함).
- 사이즈 요청 질문은 판 번호가 붙은 `intake_templates` · `intake_template_questions`이고, 답은 그때 질문 문구와 함께 남는다. 직원이 확인한 값은 `person_attribute_values(source 'review')`로 옮겨지고, 손님이 나중에 고친 값은 새 판으로 들어와 확인한 값을 조용히 덮지 않는다.
- 코드가 거르고 정렬하게 되면 열로 올린다(data-model 7절 E10).

## 6. 세트와 묶음

- 세트 상품은 `catalog_items.is_bundle = 1`과 `catalog_item_components`(구성품, 수량, `tracked` · `implied`, 교환 가능, 보고서용 가격 비율).
- 접수하면 값이 있는 **세트 줄**(계열 `bundle`) 하나와, `tracked` 구성품마다 **0원 자식 줄**(`parent_line_id`)이 생긴다. `implied` 구성품(폴)은 줄이 없다. 지급 · 교환 · 반납 · 분실은 자식 줄 단위로, 세트 줄은 자식이 모두 끝나면 끝난다.
- 가족 묶음은 두 방법이 있다. ① `family-4` 같은 세트 상품(스키 세트 × 4, 값 하나), ② `package` 할인 규칙(`min_quantity`로 "세트 4개 이상", 비율 또는 금액). ②는 기존 줄을 그대로 두고 할인만 붙어서 부분 취소가 쉽다.
- 이 매장은 지금 스키를 세트로 팔지 않는다. `ski` 상품은 옛 방식대로 부츠 · 폴을 품은 채로 두고, 매장이 세트로 바꾸기로 하면 그때 행을 더한다.

## 7. 요금표

- `price_lists`: 기본(standard), 단골(regular), 거래처별(`counterparty_id`), 원가(`purpose_key = 'cost'`, 권 마진 보고서용). 목적별 기본 요금표는 하나.
- `price_list_versions`: draft → published → retired. **게시된 판과 그 규칙 · 합계는 바뀌지 않는다**(트리거). 값을 바꾸려면 새 판을 만들어 `effective_from`을 정하고 게시한다. 판에는 끝전 단위가 있다.
- `price_rules`: 조건이 붙은 단가 한 줄. **대상은 상품 · 품목 종류 · 가격 묶음(`price_groups`) 중 정확히 하나**(CHECK): '어린이 장비 주말 15,000원'은 종류나 묶음 규칙 하나이고, 판마다 SKU 수만큼 복사하지 않는다(새 SKU도 바로 적용). 조건: 규격(상품 대상일 때만), 연령 구분, 요일 종류, 시즌, 반일(`time_band_key = 'after_12'`, 오전타임 후), 최소 · 최대 일수, 최소 수량. NULL 조건은 "상관없음". 여럿이 맞으면 상품 규칙 > 가격 묶음 규칙 > 종류 규칙, 같은 단계에서는 `priority`가 높은 것.
- `price_rule_tiers`: 여러 날 합계(2일 38,000원, 3일 54,000원). 마지막 단계를 넘으면 마지막 합계 + 하루 단가.
- 날짜 분류: `calendar_days`(달력 · 특정일: 성수기, 공휴일; 달력은 기본 `main`, 성수기가 다른 지점은 자기 달력) → 없으면 `weekday_day_types` 설정(토 · 일은 weekend).
- **값이 없는 것과 0원은 다르다.** 규칙이 없거나 `unit_amount`가 NULL이면 `요금 미등록`이다. 접수는 `price.override` 권한이 있는 사람이 사유와 함께 값을 넣어야 진행된다(`price_source_key = 'manual'`). 일부러 받지 않는 품목은 0원 + `price_source_key = 'free'` + 사유.
- 이 매장의 첫 판은 옛 설정의 상품별 단가(`rates`)를 그대로 옮긴 평평한 판이다(요일 · 시즌 · 연령 조건 없음). 조건을 쓰려면 `advanced_pricing` 기능을 켜고 새 판을 만든다.

## 8. 가격 계산

한 곳(`packages/domain/pricing`)에만 있고, 화면(미리 보기)과 서버(확정)가 같은 코드를 쓴다.

```text
quote(order, line):
  list    := order.price_list_id ?? 거래처 요금표 ?? 기본 요금표(purpose sale)
  version := list의 게시된 판 중 line.start_date에 효력이 있는 판        -- 줄에 고정
  rules   := version의 규칙 중 대상(상품 > 가격 묶음 > 종류)과 (규격?, 연령?, 요일 종류?, 시즌?, 반일?, 일수 범위?, 최소 수량?)이 맞는 것
  basis   := catalog_items.price_basis_key ?? item_kinds.default_price_basis_key
  per_day:
    tier가 있고 일수가 맞으면  → 'tier' 내역 하나(합계 × 수량)
    아니면 날짜 d마다           → 그날 분류(calendar_days ?? weekday_day_types)와 시즌으로 규칙을 고름
                                   같은 규칙 · 단가가 이어지는 날짜 묶음마다 'base' 내역 하나
  half_day:                  → time_band 'after_12' 규칙 × 수량
  per_unit, per_session, per_hour, flat → 단가 × 수량 (× 시간)
  per_person_session         → 단가 × 인원 × 회차
  규칙 없음 또는 단가 NULL     → PRICE_NOT_SET (0으로 만들지 않음)
  결과: price_basis_key, billable_units, unit_price(첫날 단가 또는 대표 단가), gross_amount,
        price_list_version_id, price_rule_id, price_engine_key('per_day@1' · 'tiers@1' …),
        내역(line_price_components), quote_hash = sha256(정본 결과)
```

- 서버는 `order.create` · `order.add`마다 다시 계산한다. 화면이 보낸 `quote_hash`와 다르면(그사이 요금표가 게시됨) `QUOTE_CHANGED`와 새 값을 돌려주고 직원이 확인한다. 옛 시스템처럼 화면이 보낸 단가를 그대로 믿지 않는다.
- **오프라인 사실의 가격**(차량의 권 추가): 기기가 가진 판으로 계산해 판 id · 금액 · `quote_hash`를 함께 보낸다. 서버는 그 판이 `occurred_at`에 효력이 있던 게시 판이면 그대로 받고(`price_source_key 'offline_quote'`), 아니면 기기 값으로 적고 `확인 필요`에 올린다. 사실이므로 `QUOTE_CHANGED`로 돌려보낼 수 없고, 조용히 다시 계산하지도 않는다(현장에서 받은 돈과 청구가 어긋나지 않게).
- 줄의 가격 · 수량 · 날짜 · 스냅샷은 만든 뒤 바뀌지 않는다(데이터베이스 트리거). 나중 변화는 `charge_adjustments`(연장, 취소, 수수료, 파손, 분실, 가격 정정, 할인 변경, 끝전)다. 수량을 늘리는 것은 새 차수의 새 줄, 줄이는 것은 취소 줄이다. 다시 견적은 명시적인 명령이고 줄을 취소하고 새로 더한다.

## 9. 할인

지금 규칙(docs/44): 한 묶음에 할인 하나, 겹치지 않음. 장비 묶음은 개당 하루 금액(금액 × 수량 × 일수, 총액까지) · 장비 합계의 % · 장비 합계에서 금액, 리프트권 묶음은 %. 결과는 10원 단위로 내리고, 묶음 안 줄들에 총액 비율로 나누며, 줄마다 몫도 10원 단위로 내리고, 남은 끝전은 큰 줄부터 준다(옛 `applyDiscounts`와 같은 계산, 순수 함수로 옮김).

- 규칙은 `discount_rules`(종류, 묶음, 대상 종류 · 상품, 금액 · 비율, 끝전, 조건, 필요한 권한, 기간). 대상이 여럿이면 `discount_rule_targets`(종류 · 상품 · 가격 묶음, 대상마다 최소 수량).
- **묶음을 넘는 할인**('스키 + 리프트권 패키지 10%', 가족 패키지)은 `package` 할인 묶음(쌓기 정책이 다른 묶음과 함께 쓰일 수 있음)의 규칙이고, 대상 줄이 장비 · 리프트권 묶음에 걸쳐 있어도 한 `discount_applications` 행과 줄별 몫으로 남는다.
- 쓸 때마다 `discount_applications` 한 행(규칙 id, 종류, 이름 · 값 스냅샷, 끝전, 합계, 사유, 행위자, 시각)과 줄마다 `line_price_components(component_key 'discount')` 한 행(나눈 몫). 줄의 `discount_amount`는 그 몫의 합이다.
- 직접 입력 할인은 `discount_rule_id = NULL`, 종류 `manual_amount` · `manual_percent`, `discount.manual` 권한이 필요하고, **같은 묶음의 다른 할인과 겹치지 않는다**. 옛 확정 창이 프리셋 위에 직접 할인을 더하던 모순(docs/44:56)을 없앤다.
- 받은 뒤 할인을 바꾸면 줄은 그대로 두고, 새 `discount_applications`(`supersedes_application_id`)와 차액 `charge_adjustments(discount_change)`를 남긴다.
- 역할별 한도(`role_permissions.limits_json`의 `max_discount_amount` · `max_discount_percent_bp`)를 넘으면 관리자 PIN을 받는다.
- 보고서는 내역을 상품 · 규칙 · 기간별로 묶는다(할인 종류별 합계, 거래처별 절감액).

## 10. 줄에 남는 가격 출처 — 박준호 팀 예시

12월 26일(토) 전화 예약, 스키 2 · 보드 1 · 헬멧 3 · 야간권 성인 3매. 리프트권 105,000원은 12월 24일 계좌이체로 선입금, 장비 120,000원은 미수, 반납 22:00 설천 주차장 · 1호 차량(redesign 시안 C2와 같은 자료).

| 표 | 행 |
|---|---|
| `order_lines` | L1 스키: rental · required · per_day, 수량 2, 1일, 단가 40,000, 총액 80,000, 할인 0, 순액 80,000, 판 `std-v1`, 규칙 `pr-ski`, `per_day@1` · L2 보드: 25,000 × 1 = 25,000 · L3 헬멧: 5,000 × 3 = 15,000 · L4 야간권 성인: ticket · optional · per_unit, 35,000 × 3 = 105,000, 사용 창 18:30~22:00, 발권 예정일 12/26 |
| `line_price_components` | L1 `base` '스키 1일 40,000원 × 2대 × 1일' 80,000 · L2 `base` 25,000 · L3 `base` 15,000 · L4 `base` '야간권 성인 35,000원 × 3매' 105,000 |
| `line_promises` | L1~L3 수령 `shop_counter` 12/26 16:00 · 반납 `vehicle_collection` 12/26 22:00 설천 · 설천 주차장 · van-1 (반납 타임 '야간타임 후' 스냅샷). L4 수령 `shop_counter` 16:00, 반납 약속 없음(optional) |
| `payment_promises` | 리프트권 칸 `prepayment` · `at_intake` · 105,000(`prepayment_mode = full_lift_ticket`에서 자동) · 장비 칸 `charge` · `at_issue` |
| `payment_groups` | 12/24 `intake_confirm` 묶음 |
| `payments` | 12/24 계좌이체 105,000, 목적 `prepayment`, `business_date = posting_date = 2026-12-24` |
| `payment_allocations` | L4에 105,000 |
| `orders` 투영 | 청구 225,000 · 받음 105,000 · 미수 120,000 · 수납 상태 partial. 카드 문구 '예약금 105,000원 수납 · 잔액 120,000원' |

장비에 10% 할인을 주었다면 `discount_applications`(묶음 gear, percent, 1000bp, 끝전 10, 합계 12,000) 한 행과 L1 −8,000 · L2 −2,500 · L3 −1,500의 `discount` 내역이 붙고, 각 줄의 `discount_amount`와 `net_amount`가 그만큼 바뀐 채로 저장된다.

## 11. 리프트권

- 종류 `lift_ticket`: 계열 `ticket`, 번호 관리, 반납 optional, `per_unit`, 결제 칸 · 할인 묶음 lift, `ticketed`, `ends_same_day`, 기능 `lift_tickets`, 고르기에서 한 타일 뒤에 권종 창(`grouped`).
- 무엇을 파는지: `catalog_items` + `ticket_products`(스키장, 시간, 대상, 사용 창, 유효 일수, 발권처, 원가). 후야권은 두 권으로 나누지 않고 한 권종이다.
- 실물: 산 권마다 `assets` + `ticket_units`(유효 기간, 양도 가능, 발권처, 권 번호, 원가, 발권일) + `ticket_unit_accepts`(이 권으로 대신할 수 있는 권종).
- 수요: 접수 줄(사용일, 사용 창, **발권 예정일** ≠ 사용일). 확보: 시간대가 있는 `line_fulfillment` claim(차선 `ticket_window`). 확보 수 · 아직 필요한 수 · 취소 수는 줄 투영과 claim으로 계산.
- 예비권: 어느 claim에도 묶이지 않고 매장이나 차량 위치에 있는 권. 차량 예비권으로 현장에서 권 추가(`field.add_ticket`)는 그 차량 위치에 있는 권만.
- 권 한 장은 '권 공용 창' 묶임(`asset_bindings`, 목적 `ticket_pool`) 하나 아래에서 시간대가 겹치지 않는 여러 배정 claim을 가질 수 있다(명령 계층 · PostgreSQL EXCLUDE). 발권처 환불로 내보내려면 살아 있는 배정이 없어야 하고, 그 권은 환불 묶임으로 옮겨진다 — 내일 손님에게 배정된 권이 발권처로 돌아가는 일이 없다.
- 회수한 권: 다음 손님에게 다시 주면 새 claim(`source_key = 'recovered_ticket'`). 발권처에 돌려주면 `vendor_refunds`(차선 `disposition`, 한 권은 살아 있는 환불 하나에만) → 방문마다 `vendor_refund_attempts` → 받은 돈은 `counterparty_settlements(receipt)`의 돈통 **한 곳만** `cash_movements` → 마감(시도 행은 현금 출처가 아님). 옛 시스템에서 마감 밖에 있던 돈이 이제 한 번만 들어간다.
- 선입금: 이 매장은 `prepayment_mode = full_lift_ticket`이라 전화 예약의 리프트권 칸이 전액 선입금으로 미리 선택된다. 다른 매장은 금액 또는 없음.
- 반납 정책 optional: 권은 지급하면 줄이 끝난다. 손님이 권만 먼저 돌려주면 `collect` · `direct_return` 이동으로 기록되고 반납 도장이 찍힌다. 옛 시스템은 전달한 권을 회수할 때까지 손님 보유로 셌다. 이 차이는 이관 대조의 **의도한 차이 목록**에 올린다(migration 문서 3-6). 사장님이 "권을 늘 돌려받아야 한다"고 답하면(질문지 2번) 종류 값만 `required`로 바꾼다.

## 12. 강습

- 종류 `lesson`: 계열 `service`, 재고 없음, 반납 없음, `per_person_session`, 결제 칸 lesson, `requires_time_slot`, `requires_headcount`, 정산 `lesson_team`, 기능 `lessons`(이 매장은 끔).
- 상품: '스키 강습 2시간', '보드 강습 2시간', '단체 강습'. 요금 규칙은 1인 1회 단가(연령 구분 가능).
- 시간대: `service_slots`(오전 10:00~12:00, 오후 13:30~15:30, 직접 입력은 예약에 시각만).
- 강습팀: 거래처 + 역할 `lesson_team`(+ `is_internal`인 '우리 강사'). 위탁료: `counterparty_rates(lesson_consignment, per person)`.
- 접수: 줄(수량 = 인원) + `service_bookings`(팀, 종목 선택지, 인원, 날짜, 시간대, 만날 장소, 강사 이름). 여러 회차 강습은 회차마다 예약(`session_no`). 강습팀을 아직 정하지 않고 팔 수 있다(팀 없음, 상태 `unassigned`). 자정을 넘는 야간 강습(22:30~00:30)은 `end_day_offset = 1`.
- 끝내기: `lesson.close`(done · no_show · cancelled) → 줄 `qty_service_closed` → 줄 끝 → 접수가 강습 때문에 열려 있지 않음.
- 정산: 예약을 닫을 때(설정) 강습팀에 줄 돈 `counterparty_trades(lesson_consignment, service_booking_id, source_key 'booking:<id>:1')` — 같은 근거로 두 번 생기지 않는다. 닫은 뒤 결과 · 인원을 고치면 `lesson.correct`만: 그 거래를 취소 기록하고 `booking:<id>:2`로 다시 낸다(팀이 두 번 받거나, 줄은 4명인데 5명 값을 받는 일이 없음). 준 돈은 `counterparty_settlements`(현금이면 그 돈통 하나만 현금 이동).
- 화면: 도장 `lesson_done`, 장부 탭 '강습', 메뉴 '리프트권·강습'(1024×600 메뉴에 10번째 칸이 없으므로 합침), 확정 창 강습 줄, 시간대별 강습 목록 인쇄.

## 13. 다른 종류 예시(행만 더함)

| 필요 | 행 |
|---|---|
| 고글(수량) | `item_kinds('goggles', rental, count, required, per_day, gear)`, 상품 1, 규격 성인 · 어린이 |
| 보호대 | 선택 속성 `protector_size`(S · M · L)를 규격 축으로 |
| 어린이 스키 | 장비 종류의 상품 '어린이 스키', 규격 축 `ski_length_cm`, 요금 규칙 `customer_class = child` |
| 프리미엄 보드 | 가격 묶음 `premium_board` + 묶음 요금 규칙 하나, 기존 보드는 `asset_reclassifications`로 옮김 |
| 부츠를 구성품으로 | 상품 '스키 부츠'(숨김) + 세트 구성 |
| 보관함 · 숙소 연계(나중) | `sys_fulfillment_modes`에 행이 필요하면 E2(코드와 함께), 아니면 `service` 계열 종류 |
| 판매 소모품(핫팩) | 계열 `sale`, 재고 count, 반납 none, per_unit |
| 파손 보험(요금만) | 계열 `fee`, 재고 none, flat |

## 14. 연장 · 취소 · 교환의 가격

- 연장: 줄에 고정된 요금표 판과 **늘어난 날짜들의 요일 분류**로 늘어난 만큼만 계산하고, 할인은 고르지 않으면 붙지 않는다. 결과는 `order_extensions` · `order_extension_lines` · `charge_adjustments(extension)`(금액이 있으면 연결 필수). 연장 줄은 **끝 날짜와 시각**, 새 반납 타임, 가격 기준, 더한 단위 수 · 분을 가진다: 더 늦은 날뿐 아니라 **같은 날 더 늦은 시각**(오후 → 야간 반납), 반일(오전타임 후) → 하루, `per_hour` + 2시간, 3시간권 → 6시간권도 값이 매겨진 연장으로 남는다(가격 정정으로 흉내 내지 않음). 옛 시스템은 `per_day` 줄만 연장했지만 이제 종류의 `extendable`이 정한다. 옛 자료에서 `legacy_total_only`로 들어온 줄은 규칙 단가로 연장하고 직원이 확인한다.
- 취소: 일부 수량도 된다(`partial_cancel_allowed`). 취소 금액은 **그 줄이 실제로 매겨진 내역**(`line_price_components`)에서 비율로 계산한다: `순액 × 취소 수량 / 수량`(10원 내림), 그 줄의 마지막 취소는 남은 금액 전부. 여러 날 합계(2대 × 3일 = 108,000)나 평일 · 주말이 섞인 줄에서도 첫날 단가로 계산하는 잘못(20,000만 빼기)이 없다. 음수 `cancellation` 조정으로 남기고, 취소 줄 · 취소 합계 · 조정의 합이 같은지 검증기가 본다. 발권한 권의 당일 취소는 환불 결정(설정 기본값, 직원이 바꿀 수 있음)을 함께 남긴다.
- 교환: 돈이 바뀌지 않는다. 다른 규격 · 다른 상품으로 바꿔서 값이 달라지면 직원이 `price_correction` 조정을 따로 남긴다. 수량 품목(고글 M → L)도 교환된다.

## 15. 결제 칸과 접수 확정 창

- 확정 창은 **결제 칸마다 두 줄 한 덩이**를 그린다(장비, 리프트권, 강습이 켜지면 강습). 옛 창은 두 장의 고정 카드로 552px 중 537px를 썼다. 칸 방식은 셋이 되어도 한 쪽에 들어가고(1024×529에서도), 넷이 넘으면 칸 쪽을 넘긴다(ui 문서 4-5 · 6-4).
- 칸마다: 1줄 = 칸 이름 · 받을 금액(기본 = 칸 합계, 선입금 설정이면 그 값) · 할인 버튼(그 묶음의 할인), 2줄 = 빠른 수단 버튼(`payment_methods`의 `quick = 1`, 등급마다 최대 4) + **`나중에`**(N4) + `다른 수단`(간편결제 · 상품권 · 외상 같은 나머지).
- `나중에`를 고르면 `결제할 팀` 줄이 열린다: 이 팀 · 다른 팀 고르기(끝 4자리) → `payment_promises(by_other_order)`. 그 팀 카드에는 '김OO 팀 결제 예정'(N19).
- 주 버튼 문구는 실제로 받는 금액만 보인다(`수납하고 접수 확정 · 35,000원`).
- 확정은 **명령 하나**(`order.create`에 약속 · 결제 약속 · 칸별 수납이 함께 들어감)라 접수만 되고 수납이 빠지는 옛 문제(docs/46)가 생기지 않는다.

## 16. 옛 리프트권 분기와 새 값

| 옛 코드의 분기 | 새 값 |
|---|---|
| 리프트권은 per_unit, 나머지는 per_day | `default_price_basis_key`, `catalog_items.price_basis_key` |
| 리프트권은 하루짜리 | `ends_same_day` |
| 리프트권은 `order.issue`로 지급 못 하고 권 배정이 먼저 | 계열 `ticket` + `ticketed` |
| per_day 비권 줄만 연장 | `extendable` |
| 준비(규격)는 권이 아닌 것만 | `preparable` |
| 교환은 스키 · 보드만 | `exchangeable` + 구성품 `exchangeable` |
| 모든 장비가 돌아와야 'returned' | 줄마다 계열의 완료 규칙 + `return_policy_key` |
| 장비 · 리프트권 할인과 확정 카드 | `payment_section_id` + `discount_group_id` + `discount_group_kinds` |
| 고르기 화면에서 리프트권을 한 타일로 | `picker_placement_key = grouped` |
| 차량 요약은 equipment만 셈 | `stock_metric_label` |
| 구성품과 `legacy-` 상품을 id 앞글자로 숨김 | `hidden_in_picker`, `archived_at`, `requires_type_confirmation` |
| 사이즈 입력폼의 고정 칸(스키 · 보드, 키, 발, 옷, 헬멧) | 속성 정의 + 질문 틀 |
| 반납 칸 '—'(시안 C2) | `return_policy_key = none` 또는 optional에서 아직 회수 안 함 |

옛 코드는 사라지는 것이 아니라 이관 기간 동안 legacy 처리기 안에 그대로 있다(migration 문서 3절). 위 표는 **새 코드**가 지키는 규칙이고, legacy 묶음을 native로 옮길 때 이 표가 확인 목록이다.

## 17. 옛 가격 자료 가져오기

- 옛 줄의 `price {basis, days, unitWon, discountWon, amountWon}` → `price_basis_key`, `billable_units`, `unit_price`, `discount_amount`, `net_amount`, `price_engine_key = 'legacy@1'`, 내역 `base`와 `discount`.
- 옛 `return-order-v1`의 총액만 있는 줄 → `price_source_key = 'legacy_total_only'`, 내역 `legacy`. 줄이 없고 접수 총액만 있는 옛 청구는 `charge_adjustments(legacy_charge)` 한 행(청구가 있는 곳은 늘 하나).
- 어느 할인을 썼는지 모름 → 차수 · 묶음마다 `discount_applications` 한 행(종류 `manual_amount`, 이름 '이전 할인').
- 옛 설정의 상품별 단가(`rates`) → 요금표 `standard` 판 1(게시), 할인 프리셋 → `discount_rules`(perUnit → per_unit_day, percent · amount → gear 묶음, liftPercent → lift 묶음 percent).

## 18. 세금(부가세 · 현금영수증 · 세금계산서)

- 세금은 **줄의 분류**에서 나온다. 한 카드가 과세 대여, 대행으로 파는 리프트권(수수료만 매출), 면세일 수 있는 강습을 함께 낼 수 있으므로 수납 한 행에 부가세 칸을 두지 않는다(추가만 하는 장부에 한 번 쓰면 고칠 수도 없다).
- `sys_tax_categories`: taxable(과세 10%) · exempt(면세) · zero_rated(영세율) · agency(대행: 수수료만 매출, 세율 10%는 수수료에). 종류 · 상품이 분류를 가지고, 줄은 만들 때 분류 · 공급가 · 부가세를 스냅샷으로 가진다(`공급가 + 부가세 = 순액`, 값이 없으면 기록 안 함). 취소 · 연장 조정도 그 줄의 분류를 따른다.
- 현금영수증 · 세금계산서는 수납에 붙는 `tax_documents`(추가만; 취소는 새 행): 금액 = 공급가 + 부가세, 분류별 내역(배분된 줄의 스냅샷에서), 국세청 승인번호, 상태. 손님 신원(휴대폰 · 사업자번호 · 카드번호)은 개인정보라 `tax_document_identities`에만 두고 보관 기간 뒤 지운다(장부 행에 개인정보가 없다는 원칙 그대로).
- 마감은 세금 분류별 합계를 `closing_totals(dimension 'tax:<key>')`로 얼린다.
- 이 매장의 분류 값은 세무 담당 확인 뒤 채운다(README 열린 질문). 표와 명령은 지금 있으므로 값만 넣으면 된다.
