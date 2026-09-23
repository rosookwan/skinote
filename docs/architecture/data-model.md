# 데이터 모델

작성 2026-09-23. 스키노트가 여러 해 동안 **데이터베이스를 다시 만들지 않고** 자랄 수 있게 정한 자료 구조다. 실제 정의는 [`packages/schema/schema.sql`](../../packages/schema/schema.sql)(migration 0001)이고, 이 문서는 그 정의를 왜 그렇게 했는지, 무엇을 지켜야 하는지를 적는다. 결정 기록은 [README](README.md), 품목·요금은 [catalog-and-pricing.md](catalog-and-pricing.md), 동시 수정·오프라인·백업은 [sync-and-concurrency.md](sync-and-concurrency.md), 화면 설정은 [ui-architecture.md](ui-architecture.md), 옮기는 순서는 [migration-plan.md](migration-plan.md)에 있다.

**검증한 것 (2026-09-23 검토 반영 뒤 다시, Node 22.22.2 · SQLite 3.53.3):** `schema.sql`을 표시 줄(`@database` · `@seed`) 기준으로 나눠 두 파일에 실행했다. 연결마다 `foreign_keys = ON`, `recursive_triggers = ON`.

| 항목 | control | shop |
|---|---|---|
| 표 | 28 | 260 (그중 `sys_*` 62) |
| 외래 키 묶음 | 26 | 827 — 모두 기본 키나 부분 조건 없는 유일 인덱스를 가리킴, 문제 0 |
| 인덱스 · 트리거 | 19 · 4 | 207 · 148 |
| 표 안에 적은 `UNIQUE` 제약 | 0 | 0 (전부 이름 있는 인덱스) |
| 목록형 `CHECK (x IN ('a','b'))` | 0 | 0 (불리언·부호만) |

같은 스크립트로 88개 동작 시험도 돌렸다. 거절된 것: 다른 매장 행을 가리키는 행, 다른 접수의 품목 줄에 들어간 수납, 돈통 없는 현금 · 돈통에 넣은 카드, 대상 없는 환불, 수단의 현금 여부를 틀리게 복사한 수납, 돈이 쓰는 수단의 현금 여부 바꾸기, 부호가 틀린 취소 조정, 조정 없는 취소 금액, 돈통과 다른 마감 범위의 현금 기록, 품목 줄의 가격 · 수량 고치기, 접수 삭제, 끝이 앞당겨지는 연장, 같은 차선의 두 번째 claim, 다른 접수로 두 번째 묶임(binding), 다른 장비의 claim을 채우는 이동 줄, 줄 없는 되돌리기, 상태 없는 수량 이동 줄, 같은 요청번호를 다른 행위자로 다시 보냄, 검증 기록 없는 작업 기록 지우기, 대상이 둘인 요금 규칙, 없는 칸 · 맞춤 방식 · 상태 · 색 · 화면을 가리키는 화면 설정, 장부 행의 수정 · 삭제 · `INSERT OR REPLACE`, 자유 글 칸 고치기, 게시된 요금 변경. 통과한 것: 같은 승인번호의 두 번째 카드(확인 필요로), 부호 있는 수량의 수납 옮기기, 같은 날 오후 → 야간 연장, 이동 기록이 있는 장비의 품목 바꾸기, 두 번째 마감 범위의 같은 날 마감, 주문 없는 인계 항목, 여러 값 속성, 종류 단위 요금 규칙, 자유 글 칸을 `(지움)`으로 가리기, 값이 든 STRICT 표에 `ADD COLUMN` → 장부 새 열 채우기 → 그 열의 '한 번만' 트리거. 다섯 시즌 규모(접수 30,000건, 작업 기록 33만 줄, 명령 기록 33만 줄, 변경 목록 66만 줄, 파일 487 MB) 측정 결과는 10절에 있다.

## 1. 원칙

1. **표가 진실이다.** 모든 업무 사실은 형식이 정해진 행이다. 작업 기록(`events`)은 감사, 복구 구간 내보내기, 옛 엔진과의 대조에 쓰고, 평소에는 그것으로 상태를 다시 만들지 않는다. 복구할 때는 구간에 담긴 바뀐 행의 after-image를 적용한다(sync 문서 10절).
2. **매장 경계는 키의 일부다.** 모든 매장 표의 기본 키는 `shop_id`로 시작하고, 매장 행끼리의 참조는 `(shop_id, x_id) → x(shop_id, id)` 복합 외래 키다. 다른 매장의 행을 가리키면 데이터베이스가 거절한다. 서버는 `shop_id`를 요청 내용이 아니라 로그인 세션에서 가져온다.
3. **같은 접수 안의 것은 같은 접수임을 데이터베이스가 보증한다.** 접수에 딸린 행(품목 줄, 약속, 수납 배분, 취소 줄, 연장 줄, 준비, 강습 예약)은 `order_id`를 함께 들고 `(shop_id, order_id, line_id) → order_lines(shop_id, order_id, id)`로 참조한다. 수납이 다른 팀 품목에 붙는 실수는 저장되지 않는다.
4. **DDL에 닫힌 목록이 없다.** 품목 종류, 결제 수단, 역할, 할인 종류, 사유, 상태 문구, 기능은 모두 행이다. 코드가 뜻을 알아야 하는 값은 `sys_*` 표(마이그레이션만 넣음)에, 매장이 바꾸는 값은 매장 레지스트리에 둔다. `CHECK`는 바뀌지 않는 규칙에만 쓴다(0/1, 부호, 범위, `net = gross − discount`, `end ≥ start`). 코드가 정하는 진행 상태(`status_key`)는 `CHECK` 없이 글자로 두고 명령 계층과 검증기가 확인한다.
5. **동작은 이름이 아니라 능력 값에서 나온다.** 코드는 `'liftTicket'`, `'ski'`, 한글 이름을 다시 비교하지 않는다. `fulfillment_mode_key`, `return_policy_key`, `ticketed`, `ends_same_day` 같은 값을 본다.
6. **돈 · 재고 · 역사는 추가만 하는 장부다.** 정정은 새 행(환불, 되돌리기 이동, 조정, 취소 기록, 마감 새 판)이다. 49개 장부 표에는 0001의 열 목록으로 수정을 막는 트리거(`BEFORE UPDATE OF …`)와 삭제를 막는 트리거가 있고, 연결마다 `recursive_triggers = ON`이라 `INSERT OR REPLACE`도 막힌다. 청구 쪽도 같다: 품목 줄의 가격 · 수량 · 날짜 · 스냅샷은 만든 뒤 바뀌지 않고(트리거), 접수 · 줄 · 약속 · 장비 · 업무 같은 업무 행은 지워지지 않는다. 그래서 코드에 버그가 있어도 지켜진다.
7. **약속은 덮어쓰지 않는다.** 수령·반납 약속은 품목 줄(또는 그 수량 일부)마다 행이고, 바꾸면 새 행이 옛 행을 `superseded`로 만든다. 누가 낼지는 `payment_promises`다.
8. **잔액과 위치는 기록에서 나온다.** 빠르게 보려고 명령 트랜잭션 안에서 투영(접수 잔액, 품목 진행, 장비 위치, 현금 이동)도 쓰지만, 건드린 묶음(aggregate)마다 장부에서 **전부 다시 계산**하고 차이만 더하지 않는다. 검증기가 언제든 다시 계산해 비교한다(6절).
9. **기록에 그때 이름을 남긴다.** 품목 줄은 이름·단위·가격·할인 출처를, 약속은 반납 타임 이름·시각·구역·장소 이름을, 기록은 행위자 이름을 복사해 둔다. 장소 이름을 바꾸거나 요금을 새로 게시해도 지난 기록은 그대로다.
10. **돈과 재고 기록에는 사유 · 행위자 · 기기 · 요청번호와 네 가지 시간이 있다.** `occurred_at`(일어난 시각), `recorded_at`(서버가 받은 시각), `business_date`(일어난 영업일), `posting_date`(그 기록을 세는 마감일).
11. **매장 · 신원 · 시각 · 영업일 · rev는 서버가 정한다.** 기기는 ULID만 미리 만들 수 있어서 통신이 끊긴 차량도 기록을 만들 수 있다. 예외는 하나다: 통신이 끊긴 기기가 쌓은 기록의 행위자는, 그 일을 한 순간 기기에 로그인해 있던 사람을 기기 키로 서명해 보내고 서버가 기기 로그인 기록(`device_sign_ins`)과 맞춰 본다(sync 문서 2절).
12. **모든 명령은 멱등이다.** 요청번호와 지문(fingerprint)으로 같은 명령을 한 번만 적용하고, 그 기록은 지우지 않는다(결과 본문만 90일 뒤 비움).
13. **자라는 방법은 추가뿐이다.** 새 행, 새 표, 빈 값을 허용하는 새 열, 속성 행, 새 설정 판. 마이그레이션은 번호순·앞으로만이고 값이 든 표는 다시 만들지 않는다(7절).
14. **JSON은 문서와 외부 응답에만 쓴다.** 얼린 보고서, 인쇄 문서, 단말·문자 응답, 설정 값, 템플릿 내용, 작업 기록 본문. 모두 `json_schemas`의 판 번호로 검증한다. 업무 규칙이 읽는 필드, 참조, 돈, 수량, 위치는 JSON에 두지 않는다.
15. **PostgreSQL로 옮길 수 있게 쓴다.** SQLite만의 기능은 목록으로 관리하고(9절) 옮길 방법을 적어 둔다. 날짜와 시간대 계산은 SQL이 아니라 앱에서 한다.
16. **개인정보는 몇 곳에만 있다.** 고객, 접수의 대표자 스냅샷, `is_pii` 속성, 문자 기록, 인쇄 문서, 세금 문서의 신원(`tax_document_identities`). 장부 행과 작업 기록에는 이름과 전화번호가 없다. 직원이 쓰는 자유 글(메모 · 사유 · 비고)에는 이름이 섞일 수 있으므로, 장부의 자유 글 칸은 `(지움)`으로 가리기만 허용하고(트리거), 작업 기록에는 자유 글을 넣지 않고 `event_pii` 참조와 해시 약속값(commitment)만 둔다. 지우기는 그 칸을 비우고 행은 남긴다.
17. **잘 되던 것은 그대로 가져간다.** 추가만 하는 장부, 기록에서 계산하는 잔액, 줄에 남기는 스냅샷, 돈·재고 기록의 사유와 행위자, 요청번호와 지문으로 하는 멱등 처리, 엄격한 입력 허용 목록(이제 판 번호가 붙음), 서버가 정하는 신원·매장·시각, 확정 전 미리 보기(dry run).

## 2. 두 개의 데이터베이스와 매장 경계

### 2-1. 무엇이 어디에 있나

| 파일 | 담는 것 | 누가 쓰나 |
|---|---|---|
| `control.sqlite` (SaaS: 중앙 control DB) | `businesses`, `tenants`(매장 목록과 자료 위치), `tenant_epochs`(매장마다 모든 epoch와 지금까지 쓴 가장 큰 rev), `accounts`(로그인 영역 + 로그인 · 비밀번호 · PIN 해시), `account_tenants`, `platform_admins`, `sessions`, `login_attempts`, `plans`, `plan_features`, `licence_signing_keys`, `licences`, `resort_templates`와 판, `template_usage`, `platform_audit_log`(해시 사슬, 파일마다 사슬 id), `usage_daily`, `backups`, `restore_drills`, 매장을 알기 전의 길 찾기(`public_links`, `external_refs`, `inbound_events`), control 자체의 복구 기록(`control_changes`, `control_journal_exports`) | 서버의 인증 · 관리자 콘솔 · 백업 작업 · 바깥 콜백 받기 |
| `shop-<shop_id>.sqlite` (SaaS: 매장별 파일 또는 PostgreSQL 스키마) | 매장, 직원(`staff_members`), 역할과 권한, 기기, 설정, 레지스트리, 접수, 재고, 차량 업무, 돈, 마감, 작업 기록, 동기화, 이관 기록 | 그 매장의 명령 처리기 하나 |

- 두 파일 사이에는 **외래 키가 없다.** 매장 행은 계정을 `actor_key`(`staff:<staff_members.id>` 등)와 이름 스냅샷으로만 가리킨다. 계정이 정지 · 삭제돼도 장부는 그대로 읽히고, 매장 파일을 다른 서버나 PostgreSQL로 옮겨도 깨지는 제약이 없다.
- 매장 PC에서는 두 파일이 한 폴더에 있다. 로그인은 control에서 확인하고, 그 매장에서 무슨 일을 할 수 있는지는 매장 파일의 `staff_members → roles → role_permissions`로 정한다. 그래서 인터넷이 끊겨도 매장 PC는 로그인과 권한 확인을 할 수 있다.
- `account_tenants`는 로그인 화면에서 "어느 매장으로 들어갈지"를 보여 주려는 목록 복사본이다. 권한의 원본은 매장 파일의 `staff_members`다.
- 코드 어휘 중 `sys_features`는 두 파일에 같은 행으로 있다(요금제 기능 표와 매장 사용 기능 표가 각각 참조). 같은 마이그레이션이 두 파일에 넣는다.
- **매장 PC의 control 파일이 나중에 중앙 control로 합쳐져도 키를 다시 매기지 않는다.** 계정 id는 한 번 만든 전역 ULID이고 매장 PC는 그것을 복사할 뿐 새로 만들지 않는다. 로그인 이름은 `(login_realm, login_id)`로 유일하다(`counter1`은 매장마다 있을 수 있다; 영역은 매장 코드, 관리자는 `platform`). 플랫폼 사용 내역의 해시 사슬은 `(chain_id = 그 파일의 instance_id, seq)`라 여러 PC의 사슬을 번호를 바꾸지 않고 모은다. 스키장 템플릿과 요금제는 공급자가 정한 고정 id로 배포한다(sys 행처럼).

### 2-2. 라이선스

`licences.token`은 공급자가 Ed25519 개인 키로 서명한 문자열이다(매장, 기간, 기기 수, 기능). 매장 서버는 앱에 들어 있는 공개 키로 서명을 확인하고, 확인되지 않거나 기간이 지나면 새 기록을 막고 읽기만 허용한다. 영업 중에 갑자기 멈추지 않도록 유예 기간(기본 7일)을 서명 내용에 함께 넣는다. 매장 PC의 control 파일을 고쳐도 서명이 맞지 않으므로 기능이 열리지 않는다. `licence_signing_keys`에는 공개 키만 있다.

### 2-3. 매장 경계 규칙

- 모든 매장 표: `shop_id TEXT NOT NULL REFERENCES shops(id)`, 기본 키 `(shop_id, id)` 또는 `(shop_id, 부모 id, 순번)`.
- 매장 행끼리 참조: 항상 `shop_id`를 포함한 복합 외래 키.
- 접수에 딸린 행: `(shop_id, order_id, x_id)` 참조로 같은 접수까지 보증(원칙 3). 같은 방식으로 품목의 규격(`(shop_id, catalog_item_id, variant_id) → item_variants`), 장비의 품목(`(shop_id, asset_id, catalog_item_id) → assets`), 속성의 선택지(`(shop_id, attribute_id, option_id) → attribute_options`), 속성의 대상 종류(`(shop_id, attribute_id, entity_type_key) → attribute_definitions`)도 데이터베이스가 맞춘다.
- 서버는 세션 → 직원 → 매장 순서로 `shop_id`를 정하고 요청 본문의 매장 값은 받지 않는다. 실시간 알림(SSE), 인쇄 도우미, 내보내기, 검색도 같은 경계를 쓴다.
- **매장을 알기 전에 오는 것**(문자 결과 콜백, 카드 · 온라인 결제 콜백, 손님 사이즈 입력 링크, 온라인 예약)은 control이 길을 찾는다. 링크 토큰은 `public_links(token_hash → tenant)`, 업체 번호는 `external_refs(provider, external_id → tenant)`로 매장을 정하고, 콜백 본문은 `inbound_events`에 받아 둔다. 매장 PC는 NAT 뒤에 있어 콜백을 직접 받을 수 없으므로 매장 서버가 이 받은편지함을 가져가서(pull) 정해진 요청번호(`inbound:<id>`)의 시스템 명령으로 기록한다. PostgreSQL 행 보안에서도 이 표들은 `skinote.shop_id`를 정하기 전에 읽는 control 표다.
- PostgreSQL에서 여러 매장이 한 스키마를 쓰면 `shop_id = current_setting('skinote.shop_id')` 행 보안 정책을 모든 매장 표에 건다. 앱의 검사와 겹쳐 두 번 막는다. control 표와 매장 표는 서로 다른 PostgreSQL 스키마에 둔다(같은 이름의 `schema_migrations` · `db_instance` · `json_schemas` · `sys_features`가 부딪히지 않게).

### 2-4. 지점, 마감 범위, 여러 매장

- **한 사업자의 여러 위치는 한 매장 파일의 지점(`branches`)이다.** 서로 다른 사업자는 늘 서로 다른 테넌트다(docs/04). 두 번째 가게를 열면 새 파일이 아니라 지점 행, 재고 위치(`stock_locations.branch_id`), 돈통, 기기, 차량을 더한다.
- **하루를 닫는 단위는 마감 범위(`closing_scopes`)다.** 한 카운터 가게는 `main` 하나(매장 개설 때 만듦). 18:00에 닫는 지점이나 따로 닫는 건물은 자기 범위를 가진다. `business_days`의 키는 `(shop_id, closing_scope_id, business_date)`이고, 마감 · 마감 판 번호 · 기준일(posting_date)도 범위마다다. 돈 · 재고 장부 행은 모두 `closing_scope_id`를 가지며, 돈통을 쓰는 행은 `(돈통, 범위)` 복합 FK로 돈통의 범위와 같아야 한다. 범위는 돈통 → 기기(`devices.closing_scope_id`) → `main` 순으로 정한다.
- 설정과 사용 기능은 `scope_key`(`''` = 매장 전체, `branch:<id>`, `closing_scope:<id>`)가 키에 있어 지점마다 덮어쓸 수 있고, 요일 · 성수기 분류는 달력(`calendars`, 기본 `main`)마다다.
- **다른 테넌트로 물건을 보낼 때**는 보내는 쪽 `shop_transfer`(매장 → 다른 매장)와 받는 쪽 `shop_transfer`(다른 매장 → 매장) 이동이 같은 전역 `transfer_ref`를 가진다. id는 모두 전역으로 유일하므로(3-1) 장비 id를 그대로 쓸 수 있다.
- **두 매장 파일을 한 파일의 지점으로 합치는 일**은 id가 겹치지 않으므로(새 id는 ULID, 옛 id는 매장 코드 접두어) 행을 그대로 옮기고 지점 · 범위 열만 채우는 가져오기로 한다. 키를 다시 매기지 않는다.
- **사업자 단위로 나누는 고객 · 포인트(가맹 적립 등)**는 아직 만들지 않는다(보류). 필요해지면 control에 사업자 범위의 새 표(E5)로 더하고 매장 행은 그 id를 약한 참조로 가리킨다. 지금 매장의 `customers`는 매장마다다.

## 3. 공통 규칙

### 3-1. ID

- 모든 id는 TEXT다. 새 id는 **ULID**(26자, 시간순 정렬, 전역으로 유일)이고, 서버나 통신이 끊긴 기기가 만든다. 매장 개설(`shop.provision`)이 만드는 레지스트리 행도 ULID다. 고정 id는 매장마다 기본값 두 개(`closing_scopes.main`, `calendars.main`)뿐이다. 서버는 형식과 중복을 확인하고, 같은 id에 다른 내용이 오면 `ID_CONFLICT`로 거절한다.
- 서버가 명령을 처리하며 만드는 id(카드 요청, outbox 멱등 키, 줄 · 이동 id 등)는 **요청에서 정해진다**: ULID 시각 = `occurred_at`, 나머지 = `HMAC(request_id, 순번)`. 복구 뒤 기기가 같은 명령을 다시 보내도 같은 id가 나온다(sync 문서 10절).
- ski-rent-ops에서 가져온 id(`ski`, `van-1`, `R-…`, `movement-12-1`, `asset-7-2`)는 **매장 코드 접두어를 붙여** 쓴다(`shop1.ski`, `shop1.van-1`). 구분 문자는 `.`이다(행위자 키 · 충돌 키가 `:`로 나뉘므로). codec이 붙이고 떼므로 옛 처리기는 옛 id를 그대로 보고, `legacy_records.source_id`에 원래 id가 남는다. 그래서 두 매장 파일을 합치거나 다른 매장으로 장비를 보내도 id가 겹치지 않는다.
- 사람이 읽는 번호는 id와 따로 둔다: `orders.receipt_no`(`YYMMDD-NNN`, `shop_counters`), `payment_groups.group_no`, `intake_requests.group_code`, 레지스트리의 `key`.
- `key` 열은 ASCII만 쓴다. 한글 이름은 `label`이고, 코드는 `key`만 비교한다.

### 3-2. 돈

- 모든 금액은 `INTEGER`이고 `shops.currency`의 최소 단위다(KRW = 원, `currency_exponent = 0`). 비율은 basis point(10% = 1000).
- 부호는 어휘 표가 정한다: `sys_payment_kinds.balance_sign / deposit_sign / cash_sign`, `sys_trade_kinds.direction_sign`, `adjustment_types.sign`. 금액 열은 양수이고 조정(`charge_adjustments.amount`)과 수납 옮기기의 음수 배분만 부호를 가진다.
- **규칙을 정하는 값은 행에 복사하고 FK로 묶는다**(claim 차선과 같은 방식). 수납은 종류의 `requires_refund_of` · `requires_deposit` · `cash_sign`과 수단의 `affects_cash_drawer`를 복사하고, 두 복사본은 `(key, 값…)` 유일 인덱스를 가리키는 복합 FK로 원본과 같아야 한다. 그래서 '환불이면 환불 대상 필수', '보증금 종류면 보증금 필수', '현금이 움직이면 돈통 필수, 아니면 돈통 없음'을 CHECK가 지키고, 돈이 쓰는 수단의 현금 여부는 나중에 바꿀 수 없다(부모 키가 바뀌면 FK가 거절). 조정은 종류의 `sign`을 복사해 `sign × amount > 0`(부호 0 = 양쪽 가능)을 지킨다.
- 카드 승인번호는 **유일하지 않다**(카드사마다 8자리, 부분취소가 같은 번호). 그래서 승인번호로 거절하지 않고 `approval_no`는 찾기용 인덱스만 두며, 같은 단말 · 번호 · 금액 · 날짜가 두 번이면 `확인 필요`(`possible_duplicate_card`)로 보인다. 계좌이체 메모(`external_reference`)는 유일성 키가 아니다.
- **세금:** 품목 종류 · 상품에 `tax_category_key`(과세 · 면세 · 영세 · 대행)가 있고, 줄은 만들 때 분류와 공급가 · 부가세를 복사한다(값이 없으면 기록 안 함). 현금영수증 · 세금계산서는 수납에 붙는 추가 전용 `tax_documents`(취소는 새 행)이고, 손님 신원(전화 · 사업자번호)은 보관 기간이 지나면 지우는 `tax_document_identities`에만 있다. 세금은 수납 한 행이 아니라 줄의 분류에서 나온다(한 카드가 과세 대여 + 대행 리프트권을 함께 낼 수 있다).
- 끝전 처리(10원 내림)는 `rounding_policy` 설정이고, 판 번호가 있어 옛 기록은 그때 규칙 그대로다.
- 청구액은 음수가 될 수 없다(`orders.charged_amount ≥ 0`, 옛 시스템과 같은 규칙). 더 받은 돈은 `credit_amount`로 따로 보이고 다른 팀 미수와 상계하지 않는다.

### 3-3. 시간과 영업일

- 시각(`*_at`)은 밀리초와 `Z`가 붙은 ISO-8601 UTC 글자다. 날짜(`*_date`)는 `YYYY-MM-DD`, 시각(`*_time`)은 `HH:MM`이고 모두 매장 시간대 기준이다.
- 매장마다 `shops.timezone`(IANA, 기본 `Asia/Seoul`)과 `shops.business_day_cutoff`(기본 `00:00`)가 있다. 영업일은 `occurred_at`을 매장 시간대로 바꾼 뒤 그 시각이 기준 시각보다 이르면 전날로 친다. 예: 기준 `02:00`이면 12월 27일 01:30에 받은 야간 반납은 12월 26일 영업일이다.
- 네 가지 시간:
  - `occurred_at`: 일이 일어난 시각. **바로 보낸 명령은 서버가 받은 시각**(`recorded_at`)을 쓴다 — 카운터 PC의 시계가 틀려도 날짜가 틀어지지 않는다. **큐에 쌓였던 명령**은 기기가 '만든 뒤 지난 시간'(단조 시계 ms, 부팅 · 세션 id와 함께)을 보내고 서버가 `recorded_at − 지난 시간`으로 정한다. 그 기준을 잃었을 때만 기기 벽시계 + 시계 차이를 쓰고 기록에 표시한다(`command_log.time_source_key = 'wall_clock'`). 허용 창은 큐 보관 창과 같은 7일(`offline_policy`)이고, 창을 벗어나거나 벽시계를 쓴 돈 · 재고 사실은 조용히 날짜를 옮기지 않고 `확인 필요`(`clock_suspect`)로 올린다. 시계가 2분 넘게 틀린 기기에는 경고를 보인다.
  - `recorded_at`: 서버가 받은 시각.
  - `business_date`: `occurred_at`으로 계산한 영업일. 한 번 계산해 저장하고 다시 계산하지 않는다. 야간 기준 시각을 나중에 바꿔도 지난 기록은 움직이지 않는다.
  - `posting_date`: 그 기록을 세는 마감일. **마감 범위마다의 기준선(posting frontier)**으로 정한다: `business_date`가 열려 있고 그 뒤 날짜 중 닫힌 날이 없으면 `business_date`, 아니면 그 범위의 **가장 늦게 닫힌 날 다음의 첫 열린 날**. 그래서 닫힌 날 사이의 빈 날(기록이 없어 `business_days` 행이 없던 날)이나 다시 연 지난날로 늦은 돈이 들어가지 않는다. 다시 열기는 그 범위의 가장 늦게 닫힌 날만 된다(더 앞 날을 열려면 뒤의 닫힌 날부터 차례로). 통신이 끊겼다가 마감 뒤에 들어온 기록만 `business_date`와 다르고, 이미 얼린 마감은 바뀌지 않는다. `CHECK (posting_date >= business_date)`. 돈뿐 아니라 **청구도** 같다: 접수 차수(`order_batches`)가 `posting_date`를 가지고 그 줄들의 청구는 그 날 마감이 센다. 수납 배분(`payment_allocations`)도 자기 `business_date` · `posting_date`를 가져 수납 옮기기가 결제 칸 · 품목 종류 합계를 옮긴 날이 분명하다.
- 날짜 계산은 한 곳(`packages/domain`의 날짜 서비스)에서만 한다. 옛 코드의 `C.day(at)`(KST 자정 고정)는 같은 결과를 내도록 이 서비스에 연결한다(migration 문서 3절).

### 3-4. 버전과 rev

| 이름 | 어디 | 쓰임 |
|---|---|---|
| `version` | 바뀌는 모든 행 | 레지스트리 · 설정 편집의 낙관적 잠금. 다르면 그 행만 `VERSION_CONFLICT` |
| `rev` | `shop_counters('rev')`, `events.rev`, `*_rev` 열, `change_log` | 매장 안에서 쓰기 트랜잭션마다 1씩 오르는 번호. 동기화 커서이고 잠금 조건이 아니다. 복구 뒤에는 `shop_instance.rev_floor`(= 모든 epoch를 통틀어 쓴 가장 큰 rev + 1,000,000, control의 `tenant_epochs`에 보관) 위로 뛴다. 기기가 보내는 기준은 늘 `{epoch, rev}`다 |
| `created_rev` / `updated_rev` | 행 | 이 행을 만든 · 마지막으로 바꾼 rev. 마감은 `as_of_rev`까지를 센다 |
| `config_rev` | `shops`, `orders`, `line_promises` | 설정 판. 접수는 만들 때의 판을 기억한다 |
| 충돌 키 | `intent_marks` | 약속 · 가격 같은 결정을 바꾼 rev. 서로 다른 칸을 바꾼 두 명령은 자동으로 이어 붙인다(sync 문서 4절) |

### 3-5. 행위자

- 장부 행: `actor_key`(필수), `actor_name`(그때 이름), `device_id`, `request_id`(필수).
- 바뀌는 행: `created_by` · `updated_by` · `*_by` 열에 행위자 키.
- 행위자 키 모양: `staff:<staff_members.id>`, `system:<작업 이름>`(outbox, 검증기, 가져오기), `form:<intake_requests.id>`(손님 입력폼), `legacy:<role>:<id>`(옛 자료). NULL은 없다. 시스템 명령도 멱등 검사를 받는다.

### 3-6. 삭제와 보관

- 업무 행은 지우지 않는다. 레지스트리는 `active = 0` 또는 `archived_at`, 진행 행은 `ended_at` · `status_key`, 장부는 트리거로 수정 · 삭제 자체가 막혀 있다.
- 계정을 지워도 직원 행과 기록은 남는다(`accounts.deleted_at`, 화면에는 `삭제된 계정`).
- 보관 기간(`retention` 설정):

| 대상 | 기본 | 끝나면 |
|---|---|---|
| `command_log.result_json` | 90일 | 본문만 NULL. 행과 요청번호는 남아 중복을 계속 잡는다 |
| `event_pii`(이름 · 전화 · 자유 글) | 30일 | `pii_json` NULL. 복구 창보다 훨씬 길다. 작업 기록 해시는 약속값(`pii_commitment`)만 덮으므로 지워도 사슬이 깨지지 않는다 |
| 장부의 자유 글 칸(`reason` · `memo` · `note` 등) | 고객 개인정보와 같이 | 요청이 있거나 이름 · 번호가 들어간 것을 찾으면 `(지움)`으로 가림(트리거가 이것만 허용) |
| `tax_document_identities` | 세무 보관 기간(열린 질문) | 값 NULL, `purged_at` |
| `change_log` | 60일 | 지움. 더 오래된 커서는 `reset`을 받는다 |
| `intent_marks` | 30일 | 지움. 더 오래된 기준의 intent는 '새로 보고 다시' 충돌을 받음 |
| `events`, `command_log`, `outbox_attempts` | 이번 시즌 + 지난 시즌 | 시즌 보관 파일로 옮기고 확인한 뒤 지움. 목록(`archive_manifests`)과 확인(`archive_verifications`)은 모두 추가 전용이고, 트리거는 확인 행이 있는 범위만 지우게 한다. 보관 파일은 자기 `schema_migrations`를 가지고, 붙일 때(ATTACH) 빠진 앞으로만 마이그레이션을 먼저 적용하며, 보관 파일은 열 이름을 적어서만 읽는다 |
| 고객 개인정보(`customers`, `orders.customer_*`, `order_people.name`, `is_pii` 속성, 문자 수신번호, 인쇄 문서) | 1,095일(열린 질문) | 칸을 비우고 `anonymized_at` 기록. 행과 금액은 남음 |
| `legacy_events` 원본 | 대조 통과 뒤 한 시즌 | 이름·전화 칸 가림(`redacted_at`) |

- 업무 표(접수, 품목, 약속, 돈, 재고, 마감)는 보관 파일로 옮기지 않는다. 다섯 시즌에 200~250 MB로 매장 PC에 충분히 들어간다.

### 3-7. JSON을 쓰는 곳

`shop_settings.value_json`, `shop_features.config_json`, `role_permissions.limits_json`, `print_template_versions.layout_json`, `message_template_versions.variables_json`, `print_jobs.document_json` · `params_json`, `closings.report_json` · `basis_json`, `payment_intents.vendor_response_json`, `tax_documents.breakdown_json`, `outbox.payload_json` · `result_json`, `events.command_json` · `result_json`, `event_pii.pii_json`, `review_items.detail_json` · `message_params_json`, `notifications.params_json`, `ledger_view_tabs.params_json` · `ledger_view_metrics.params_json`, `legacy_records.residue_json`, `template_applications.added_json`, `ui_default_applications.*_json`, `resort_template_versions.content_json`, `licences.feature_overrides_json`, `inbound_events.payload_json`, `sys_*`의 작은 목록(`depends_on_json`, `scopes_json`). 카드 요청의 배분은 JSON이 아니라 복합 FK가 있는 `payment_intent_allocations`다. 모두 `json_schemas(key, version)`에 스키마가 있고 쓰기 전에 검사한다. 업무 규칙이 조건으로 쓰는 값이 JSON에 들어가면 열로 올린다(7절 E10).

### 3-8. 유일성은 인덱스로

유일성 규칙은 모두 `CREATE UNIQUE INDEX`로 적었다. 표 안의 `UNIQUE` 제약은 나중에 풀 수 없지만(표를 다시 만들어야 함) 인덱스는 지우거나 바꿀 수 있다. 예: 강습 예약은 `(shop_id, line_id, session_no)` 인덱스라 여러 회차 강습이 필요해지면 인덱스만 바꾸면 된다. 외래 키가 가리키는 유일 인덱스(`*_order_id`, `*_item_id` 등)는 지우지 않는다.

## 4. 엔터티

전체 열은 `schema.sql`에 설명과 함께 있다. 여기서는 표마다 목적, 핵심 필드, 불변식, 관계를 적는다. "장부"는 추가만 되고 트리거로 수정·삭제가 막힌 표다.

### 4-1. control 데이터베이스

| 표 | 목적 | 핵심 필드 | 불변식 · 관계 |
|---|---|---|---|
| `schema_migrations` | 이 파일에 적용한 마이그레이션 | `id`, `name`, `database_key`, `checksum` | 이름 유일. 적용한 파일의 checksum이 바뀌면 서버가 시작하지 않음 |
| `db_instance` | 이 파일의 정체 | `instance_id`, `epoch_id`, `epoch_no` | 한 행. 복구하면 새 epoch |
| `json_schemas` | JSON 열의 스키마 | `(key, version)`, `json_schema`, `upcaster_key` | 판은 추가만 |
| `sys_features` | 기능 어휘(요금제용) | `key`, `depends_on_json` | 마이그레이션만 넣음 |
| `businesses` | 매장을 가진 사업자 | `name`, `business_no` | 다른 사업자의 매장은 절대 한 지점으로 묶지 않음 |
| `tenants` | 매장 목록과 자료 위치 | `code`, `data_location`, `status_key`, `is_test` | `code` 유일. `is_test`면 문자 · 카드가 실제로 나가지 않음 |
| `accounts` | 로그인하는 사람 | 전역 ULID `id`, `login_realm`, `login_id`, `password_hash`, `pin_hash`, 잠금 칸, `status_key`, `deleted_at` | `(login_realm, login_id)` 유일(NULL 제외). 5번 틀리면 10분 잠금(설정). 지워도 행은 남음. 계정은 한 곳에서 만들고 매장 PC는 복사만 |
| `account_tenants` | 로그인 때 고를 매장 목록 | `(account_id, tenant_id)` | 권한 원본은 매장 파일 |
| `platform_admins` | 숨은 관리자 콘솔 사용자 | `role_key`, `revoked_at` | 체험판(Pages)에는 없음 |
| `sessions` | 로그인 세션 | `token_hash`, `kind_key`, `tenant_id`, `device_id`, `staff_member_id`, `idle_timeout_s`, `expires_at`, `revoked_at` | 토큰 원문은 저장하지 않음. 기사 기기는 긴 유휴 시간(14일), 기기 취소로 즉시 끊김 |
| `login_attempts` | 로그인 시도 | `login_id`, `method_key`(password · pin · token), `succeeded` | 잠금 판단 근거 |
| `plans` · `plan_features` | 요금제와 허용 기능 | `device_limit`, `account_limit` | 기능은 요금제가 허용하고 매장이 켜야 보임 |
| `licence_signing_keys` | 라이선스 서명 확인용 공개 키 | `key_id`, `algorithm`, `public_key` | 개인 키는 어떤 DB에도 없음 |
| `licences` | 매장 라이선스 | `licence_no`, `plan_key`, 기간, 한도, `token`, `signing_key_id`, `status_key` | 매장당 살아 있는 라이선스 하나(부분 유일 인덱스). `expires_on ≥ starts_on` |
| `resort_templates` · `resort_template_versions` | 스키장 템플릿(구역 · 장소 · 반납 타임 · 수령 시각 · 권종 · 발권처) | 공급자가 정한 고정 `id`, `key`, `published_version_no`, 판별 `content_json` | 판은 바뀌지 않음(트리거). 적용하면 매장에 없는 행만 더하고 요금 · 할인은 건드리지 않음 |
| `template_usage` | 템플릿을 쓰는 매장 수 | `(tenant_id, template_id, version_no)` | 원본은 매장의 `template_applications` |
| `platform_audit_log` | 플랫폼 사용 내역 | `(chain_id, seq)`, `category_key`, `action_key`, 전후 JSON, `prev_hash`, `hash` | 장부(트리거). 파일마다 사슬 하나(`chain_id` = 그 파일의 `instance_id`), 합쳐도 번호를 바꾸지 않음 |
| `usage_daily` | 관리자 대시보드 숫자 | `(tenant_id, date, metric_key)`, `value` | 매장 서버가 하루 한 번 올림 |
| `backups` | 모든 백업 파일 목록 | `kind_key`, `sha256`, `epoch_id`, `max_rev`, `last_hash`, `status_key` | 복구할 때 이어 붙일 작업 기록 위치를 알려 줌 |
| `restore_drills` | 매주 자동 복구 시험 결과 | `backup_id`, `outcome_key`, `report_json` | 실패하면 관리자 알림 |
| `tenant_epochs` | 매장의 모든 epoch | `epoch_no`, `epoch_id`, `rev_floor`, `max_rev_seen` | 매장 파일을 잃어도 남음. 새 `rev_floor` = 모든 epoch · 백업 · 구간 · 기기 보고에서 본 가장 큰 rev + 1,000,000 |
| `public_links` · `external_refs` · `inbound_events` | 매장을 알기 전의 길 찾기와 콜백 받은편지함 | 토큰 해시 → 매장, (업체, 업체 번호) → 매장, 받은 본문 | 매장 서버가 받은편지함을 가져가 `inbound:<id>` 시스템 명령으로 기록(한 번만) |
| `control_changes` · `control_journal_exports` | control 파일 자체의 복구 기록과 구간 | 바뀐 행의 이후 모습(after-image) | 계정 · PIN · 세션 · 기기 등록이 1시간 백업 사이에 잃어버리지 않게 매장 작업 기록처럼 내보냄(sync 문서 10절) |

### 4-2. 매장 파일: 메타와 코드 어휘

| 표 | 목적 | 불변식 · 관계 |
|---|---|---|
| `schema_migrations`, `db_instance`, `json_schemas` | 위와 같음. `db_instance`는 파일의 정체(`instance_id`)만. epoch · `rev_floor`는 매장마다 한 행인 `shop_instance`(4-3) | 여러 매장이 한 PostgreSQL 스키마를 써도 매장마다 복구할 수 있음 |
| `sys_soft_references` | 나중에 `ADD COLUMN`으로 더한 참조 열 목록 | 검증기가 이 목록의 열마다 대상 행이 있는지, 같은 매장인지 매일 확인(7절 E4) |

`sys_*` 표 62개는 코드가 뜻을 아는 어휘다. 모두 `key` 기본 키, 한글 `label`, `added_in`(들어온 마이그레이션 번호)이 있고, 동작을 정하는 값은 형식이 있는 열이라 데이터베이스가 쓸 수 있다.

| 어휘 표 | 정하는 것 | 시작 값(ASCII key) |
|---|---|---|
| `sys_features` | 매장 사용 기능, 의존 관계 | vehicles, night_collection, lift_tickets, lessons, size_preinput, partner_ledger, deposits, prepayment, exchange, driver_field_payment, multi_order_payment, split_payment, card_terminal, sms, bundles, advanced_pricing, branches, label_printer, customer_profiles |
| `sys_permissions` | 권한과 허용 범위(`scopes_json`: shop · own_vehicle · own_orders), 민감 여부 | order.*, price.override, discount.*, payment.*, deposit.*, adjustment.create, cash.*, closing.*, stock.*, asset.condition, task.*, route.reorder, ticket.*, vendor_refund.manage, exchange.manage, intake.manage, print.request, catalog.manage, price_list.publish, settings.manage, features.manage, staff.manage, device.manage, counterparty.*, customer.*, review.resolve, export.data, audit.view |
| `sys_setting_definitions` | 매장 설정 이름, 값 스키마, 기본값, 판을 기록에 남기는지 | prepayment_mode, same_day_cancel_refund_default, payment_timing_default, rounding_policy, discount_stacking, receipt_number_format, weekday_day_types, walk_in_phone_required, extension_default_return_time, night_collection_notice_minutes, driver_sees_due_amount, lesson_settlement_timing, max_line_quantity, session_idle_minutes, login_lockout, retention, backup_policy, offline_policy, closing_policy |
| `sys_device_kinds` · `sys_device_classes` | 기기 종류 · 화면 크기 등급(값은 코드의 DeviceProfile) | pos, driver_tablet, driver_phone, admin_console, print_agent, card_agent · pos, pos_narrow, driver_tablet, driver_phone, print, admin |
| `sys_fulfillment_modes` | 품목의 행동 계열: 보관 책임 여부, 지급 필요, 기본 반납 정책, 완료 규칙 | rental, ticket, service, sale, fee, bundle, placeholder |
| `sys_return_policies` | 줄이 반납을 기다리는지 | required(완료를 막음), optional(지급으로 끝, 회수하면 기록), none |
| `sys_tracking_modes` | 재고를 세는 법 | unit, count, none |
| `sys_price_bases` | 가격 기준과 곱하는 값 | per_day, per_unit, per_session, per_person_session, per_hour, half_day, flat |
| `sys_discount_kinds` | 할인 종류와 적용 범위(line · group) | per_unit_day, percent, amount, package, manual_amount, manual_percent |
| `sys_location_kinds` · `sys_movement_kinds` · `sys_movement_routes` | 재고 위치 종류, 이동 종류, **허용된 (이동, 출발, 도착)** 과 기사 · 오프라인 허용 | 기초 재고, 들이기, 발권, 적재, 지급·전달, 받음, 매장 입고, 매장 반납, 발권처 환불, 찾음, 거래처 대여 · 반환, 차량 간 넘김, 창고 · 지점 사이 이동(매장 → 매장 포함), 다른 매장으로 보냄 · 다른 매장에서 받음, 폐기, 되돌리기(모든 되돌릴 수 있는 경로의 반대 방향) |
| `sys_claim_lanes` · `sys_claim_types` | 장비를 잡아 두는 차선과 종류, 차선이 장비의 묶임(binding)에 걸려야 하는지(`bound`) | preparation, transport, disposition, composition(모두 배타; composition만 묶임 없음) · ticket_window(시간대, 비배타) |
| `sys_task_kinds` · `sys_promise_types` · `sys_fulfillment_methods` | 차량 업무 종류, 약속 종류, 수령·반납 방법(차량 필요, 장소 필요, 만드는 업무) | delivery, collection, vendor_refund, shop_transfer · pickup, return · shop_counter, vehicle_delivery, shop_direct, vehicle_collection |
| `sys_payment_timings` · `sys_payment_kinds` · `sys_payment_purposes` | 결제 시점, 돈의 종류와 부호 · 필요한 연결(환불 대상, 보증금), 돈의 목적 | at_intake, at_issue, at_return, later, by_other_order, partner_postpaid · payment, refund, legacy_refund(가져오기 전용: 대상 모르는 옛 환불), deposit_in, deposit_out, deposit_apply · charge, prepayment, deposit |
| `sys_counterparty_roles` · `sys_trade_kinds` | 거래처 역할, 거래 종류와 방향 | resort_vendor, partner_shop, lesson_team, lodging_affiliate, billing_company · receivable, payable, ticket_purchase, ticket_sale, ticket_refund, equipment_borrow_fee, equipment_lend_fee, lesson_consignment, commission_payable, commission_receivable |
| `sys_entity_types` · `sys_attribute_data_types` · `sys_attribute_placements` | 속성을 가질 수 있는 대상, 값 형식, 속성이 나오는 입력폼 · 문서 자리(표 모양 화면은 장부 칸이 맡음) | order, order_line, order_person, customer, catalog_item, item_variant, asset, task, place, counterparty · text, int, decimal, bool, date, time, option, measurement, money(최소 단위 정수) · intake_form, order_form, prep_sheet, team_label, slip, receipt, task_sheet |
| `sys_reason_domains` | 사유 묶음 | visit_result, early_return, exchange, handover, asset_condition, found, cash_entry, refund, cancellation, adjustment, closing_difference, reallocation, price_override |
| `sys_stamp_rules` · `sys_stamp_states` · `sys_stamp_rollups` | 도장 칸의 상태를 계산하는 규칙, 도장 상태 일곱 가지와 색, 팀 한 줄로 모으는 법 | qty_prepared, qty_loaded, qty_issued, qty_collected, qty_returned, ticket_secured, service_closed, order_due_zero, task_done, task_received · todo, partial, done(도장 주홍), na, blocked, scheduled(예정), delegated(차량이 함) · worst_of, first_open |
| `sys_outbox_channels` · `sys_print_renderers` | 바깥으로 나가는 일과 자동 재시도 여부, 인쇄 모양 | sms(재시도 안 함), print, card_terminal(재시도 안 함), webhook, backup_upload · receipt_slip, collection_list_a4, prep_sheet_a4, team_label, closing_sheet, stock_list, unreturned_list, ledger_a4, qr_guide |
| `sys_screen_templates` · `sys_column_renderers` · `sys_ledger_filters` · `sys_ledger_metrics` | 화면 틀, 장부 칸 그리기(와 칸이 채워야 할 연결 `binding_key`), 색인 탭 필터, 바닥줄 숫자 | ledger, slip, checklist, collection_list, driver_list, tiles, form, split · time, team, items, promise, place, money, stamp, attribute, text, vehicle, action(전화 · 못 받음) · all, pickup, return, unpaid, vehicle, lessons, open_tasks, collected, remaining, pinned · team_count, issued_count, returned_count, due_total, collected_count, pending_count, remaining_count, vehicle_load |
| 화면 어휘: `sys_workspaces` · `sys_screens` · `sys_group_keys` · `sys_sort_keys` · `sys_fit_modes` · `sys_fold_modes` · `sys_align_keys` · `sys_overflow_modes` · `sys_tones` · `sys_icons` · `sys_picker_placements` · `sys_conditions` · `sys_status_keys` · `sys_confirm_templates` · `sys_actions` · `sys_input_widgets` · `sys_display_formats` · `sys_row_grains` · `sys_row_grain_entities` | 화면 설정 행이 가리킬 수 있는 코드 키 전부(외래 키 대상) | 작업 공간 · 경로가 있는 화면 · 묶음 · 정렬(시각 여부) · 글자 맞춤 · 합치는 모양 · 정렬 · 넘칠 때 · 색(빨강은 늦음만, 도장 주홍 따로) · 아이콘 · 고르기 자리 · 조건 · 도메인별 상태 값과 기본 문구 · 확인 창 · 동작(명령 + 확인 창 + 되돌리기 묶음) · 입력 방식 · 보이는 모양 · 장부 한 줄의 단위와 붙일 수 있는 속성 주인 |
| `sys_tax_categories` · `sys_place_uses` | 세금 분류와 세율 · 매출 기준, 장소 쓰임 | taxable, exempt, zero_rated, agency(대행: 수수료만 매출) · pickup, return, lodging, meeting, parking, locker, bus_stop |
| `sys_cash_sources` · `sys_booking_channels` | 현금 이동을 만든 장부(돈 종류마다 현금 장부는 하나), 접수 경로 | payment, cash_entry, cash_transfer, cash_transfer_confirmation, counterparty_settlement(발권처 환불금 포함) · walk_in, phone, intake_form, ticket_reservation, driver_field, legacy |
| `sys_review_kinds` | `확인 필요`의 종류, **쉬운 한 문장 틀**, 무게(info · action · blocking), 누구에게 보이나(`routing_key`: 관리자 목록 · 일으킨 기기 · 접수 띠 · 열린 창의 단계) | already_returned, collect_exceeds, plan_displaced, late_money, overpaid, allocation_fallback, card_unknown, possible_duplicate_card, extra_card_approval, possible_duplicate_money, sms_unknown, task_cancelled, task_moved_meanwhile, ticket_unavailable, found_after_charge, blocked_command, device_gap, clock_suspect, van_unsynced, route_superseded, decision_overridden, receipt_no_clash, restore_replay, ui_defaults_kept |
| `sys_event_types` | 명령 종류 목록: 분류, 충돌 등급(fact · intent · commutative · system), 사용 내역 이름, 돈 여부, 오프라인 허용, 시즌 1 처리 엔진(native · adapter = 사실 어댑터 뒤의 옛 처리기 · legacy = facade 뒤의 옛 처리기, intent만) | order.create … verifier.repair, legacy.imported (88종으로 시작: native 49 · adapter 18 · legacy 20 · import 1; 옛 명령마다 자기 행이 있고 '옛 명령 하나로 뭉친' 행은 없음). `engine_key`는 묶음을 native로 옮길 때 마이그레이션이 바꿀 수 있는 유일한 sys 열이고, CI가 코드에 등록된 엔진과 같은지 확인 |

### 4-3. 매장 · 직원 · 기기 · 설정

| 표 | 목적 | 핵심 필드 | 불변식 · 관계 |
|---|---|---|---|
| `shops` | 매장 한 곳(파일마다 한 행) | `code`, `timezone`, `business_day_cutoff`, `currency`, `is_test`, `config_rev` | 모든 매장 표의 부모 |
| `shop_instance` | 매장의 지금 epoch | `epoch_id`, `epoch_no`, `restored_up_to_rev`, `rev_floor` | 매장마다 한 행(한 PostgreSQL 스키마에 여러 매장이 있어도). 모든 epoch는 control `tenant_epochs` |
| `branches` | 한 사업자의 다른 위치(같은 파일) | `name` | 다른 사업자와 합치지 않음(2-4) |
| `closing_scopes` | 하루를 따로 닫는 단위 | `key`, `branch_id` | 매장 개설 때 `main`. 돈통 · 기기 · 모든 돈 · 재고 장부 행이 범위를 가짐 |
| `roles` · `role_permissions` | 역할과 권한, 범위, 한도 | `key`, `permission_key`, `scope_key`, `limits_json` | 역할은 데이터. 기사 역할은 `own_vehicle` 범위 |
| `staff_members` | 이 매장에서 일하는 사람 | `account_id`(control, FK 없음), `display_name`, `role_id`, `default_vehicle_id`, `legacy_actor_key`, `status_key` | 계정당 한 명(부분 유일). 옛 접근 파일의 행위자는 `legacy` 상태 직원으로 들어옴 |
| `staff_permission_overrides` | 사람별 권한 더하기 · 빼기 | `effect_key`, `scope_key`, `limits_json` | 역할 위에 적용 |
| `devices` | 등록한 기기 | `kind_key`, `vehicle_id`, `closing_scope_id`, `public_key`(큐 명령 서명), `last_device_seq`(높은 물 표시), `offline_capable`, `status_key`, `revoked_at` | 기사 기기는 차량에 묶임. 취소하면 새 세션이 끊기지만 `revoked_at` 전에 서명한 사실은 받음. 저장소를 오래 지킬 수 없는 기기(`navigator.storage.persist()` 거절)는 오프라인 기록을 끔. 라이선스 기기 수를 셈 |
| `device_sign_ins` | 기기마다 누가 언제 로그인했나(장부) | `staff_member_id`, `signed_in_at`, `method_key` | 큐 명령의 서명된 행위자를 이것으로 확인(같은 차량 휴대폰을 기사가 바꿔 써도) |
| `device_enrollment_codes` | 기기 등록 일회용 번호 | `code_hash`, `expires_at`, `used_at` | 번호 원문 저장 안 함 |
| `shop_features` | 사용 기능 켜기 · 끄기 | `(feature_key, scope_key)`, `enabled`, `config_json` | 끈 기능은 화면에서 사라지고 자료는 남음. 켜려면 의존 기능도 켜져 있어야 함. `scope_key`(지점 · 마감 범위)가 매장 전체 값을 덮음 |
| `shop_settings` | 판 번호가 붙은 설정 | `(setting_key, scope_key, version_no)`, `value_json`, `effective_from` | 장부(수정 안 함). 지금 값은 그 범위에서 이미 효력이 난 가장 높은 판, 없으면 매장 전체 값 |
| `shop_counters` | rev, 접수 번호, 묶음 번호 | `(counter_key, scope_key)`, `value` | 쓰기 트랜잭션 안에서만 올림 |
| `business_days` | 마감 범위 · 영업일마다 한 행, 마감 잠금 | `(closing_scope_id, business_date)`, `active_closing_id`, `last_version_no` | `active_closing_id`는 **그 범위 · 그 날짜의** 마감만 가리킴(복합 FK). NULL이면 열린 날 |
| `config_changes` | 레지스트리 · 설정 편집 전후 | `(config_rev, seq)`, `entity_type`, 전후 JSON | 장부 |
| `template_applications` | 스키장 템플릿 적용 기록(장부) | `template_id`, `template_version`, 더한 행 · 건너뛴 행 | 요금 · 할인은 절대 안 바꿈 |

### 4-4. 레지스트리: 돈 · 품목 · 속성 · 장소 · 차량 · 거래처

| 표 | 목적 | 핵심 필드 | 불변식 · 관계 |
|---|---|---|---|
| `payment_methods` | 결제 수단 | `key`, `affects_cash_drawer`, `requires_terminal`, `requires_reference`, `refundable`, `driver_allowed`, `quick`(수단 줄의 버튼), `short_label` | `key` 유일. 새 수단(간편결제, 상품권, 외상 `on_account`)은 행 추가. `(id, affects_cash_drawer)`가 수납의 FK 대상이라 돈이 쓰는 수단의 현금 여부는 못 바꿈 |
| `payment_sections` | 접수 확정 창의 결제 칸(장비 · 리프트권 · 강습) | `default_method_id`, `default_timing_key`, `feature_key`, `priority`, `overflow_key` | 기능이 꺼지면 칸이 사라짐. 칸이 창에 다 안 들어가면 쪽을 나눔(ui 문서 6-4) |
| `discount_groups` · `discount_group_kinds` | 할인 묶음(한 묶음에 하나만)과 그 묶음이 고를 수 있는 할인 종류 | `stacking_policy_key` | 장비: 개당 하루 · 비율 · 금액, 리프트권: 비율 |
| `item_kinds` | 품목 종류와 능력 값 | 행동 계열, 재고 세는 법, 반납 정책, 가격 기준, 결제 칸, 할인 묶음, `sized`, `exchangeable`, `extendable`, `preparable`, `delivery_allowed`, `ends_same_day`, `ticketed`, `requires_time_slot`, `requires_headcount`, `partial_cancel_allowed`, `settlement_role_key`, `tax_category_key`, `feature_key`, `picker_placement_key` · `tone_key` · `icon_key`(모두 sys 어휘 FK) | `key` 유일. 능력 값의 뜻은 catalog 문서 2절 |
| `price_groups` | 함께 값을 매기는 상품 묶음(프리미엄 보드, 어린이 장비) | `key`, `label` | 요금 규칙 · 할인 대상이 될 수 있음 |
| `catalog_items` | 고르는 상품(SKU) | `item_kind_id`, `price_group_id`, `tax_category_key`, `label`, 종류 값을 덮는 칸(NULL = 종류 값), `is_bundle`, `hidden_in_picker`, `requires_type_confirmation` | 지우지 않고 `archived_at` |
| `ticket_products` | 리프트권 상품의 조건(1:1) | 발권처, 스키장, 시간, 대상(성인 · 어린이), 사용 창, 유효 일수, 원가 | 원가 NULL = 미산정 |
| `catalog_item_components` | 세트 구성 | `component_mode_key`(tracked · implied), `exchangeable`, `price_share_bp` | 자기 자신을 구성품으로 못 가짐 |
| `item_variants` | 규격(부츠 250mm, 헬멧 M, 스키 140cm) | `catalog_item_id`, `label` | `(shop_id, catalog_item_id, id)` 유일 → 다른 상품의 규격을 못 씀 |
| `attribute_definitions` | 매장이 정하는 칸(키, 발, 옷 사이즈, 객실, 수준) | `entity_type_key`, `key`, `label` · `short_label`, `data_type_key`, `multi_valued`, `input_widget_key`, `display_format_key`, 범위 · `step_value`, `is_pii`, `searchable`, `promoted_to` | `(entity_type_key, key)` 유일. 입력 · 보이는 모양은 sys 어휘(catalog 문서 5절). 열로 올리면 `promoted_to` 기록 |
| `attribute_options` · `attribute_placements` · `item_kind_attributes` | 선택지, 입력폼 · 문서 자리(기기 등급별, 우선순위 · 넘칠 때 · 맞춤), 종류별 쓰임(규격 축 · 줄 · 사람 · 장비) | `key`, `placement_key`, `device_class_key`, `usage_key` | 선택지는 그 속성의 것만(복합 FK). 표 모양 화면(장부 · 기사 줄 · 수거 목록)은 자리가 아니라 장부 칸이 맡음 |
| `customer_classes` | 성인 · 어린이 · 경로 | `key` | 요금 조건과 권 대상 |
| `resorts` · `areas` · `places` · `place_uses` | 스키장, 구역, 장소(솔마을 → 한솔동), 장소 쓰임 | `resort_id`, `name`, 위치, 안내 사진, `template_ref`, 쓰임은 `sys_place_uses` 행(수령 · 반납 · 숙소 · 만남 · 주차장 · 보관함 · 정류장) | 구역 안 같은 이름 금지(인덱스). 템플릿 출처 유일. 새 쓰임은 sys 행이지 열이 아님 |
| `return_slots` | 반납 타임 | `label`, `local_time`, `day_offset ≥ 0`(상한 없음), `is_night`, 효력 기간 | 야간 수거 알림은 `is_night` |
| `pickup_time_options` | 수령 시각 버튼(옛 09:00 · 12:00 · 17:00) | `local_time` | |
| `service_slots` | 강습 시간(오전 · 오후 · 야간) | `start_time`, `end_time`, `end_day_offset` | 같은 날이면 `end > start`, 자정을 넘으면 `end_day_offset = 1` |
| `vehicles` · `vehicle_assignments` | 차량과 날짜별 담당 기사 | `name`, `staff_member_id`, `valid_from/to` | 은퇴해도 행 유지 |
| `cash_drawers` | 카운터 돈통, 차량 지갑, 넘기는 중(`transit`), 과부족(`over_short`) | `kind_key`, `vehicle_id`, `closing_scope_id` | 차량마다 지갑 하나(부분 유일). `(id, closing_scope_id)`가 돈 장부의 FK 대상 |
| `card_terminals` · `printers` | 카드 단말, 인쇄 대상 | `vendor_key`, `device_id`, `paper_key` | 비밀값은 DB 밖. 온라인 결제(PG)는 단말 행 없이 카드 요청의 `provider_key`로 |
| `counterparties` · `counterparty_roles` · `counterparty_rates` | 발권처, 거래처 샵, 강습팀, 제휴 숙소, 후불 거래처와 단가 | `is_internal`('우리 강사'), `trade_kind_key`, 금액 · 비율, 기간 | 한 거래처가 여러 역할 가능. 테넌트 매장과는 다른 개념(자동 공유 없음) |

### 4-5. 레지스트리: 요금 · 기타 · 템플릿 · 화면 설정

| 표 | 목적 | 핵심 필드 | 불변식 · 관계 |
|---|---|---|---|
| `price_lists` · `price_list_versions` | 요금표(기본 · 단골 · 거래처 · 원가)와 판 | `purpose_key`(sale · cost), `priority`, `is_default`, 판별 `status_key`, `effective_from/to`, `rounding_unit` | 목적별 기본 요금표 하나. **게시된 판과 그 규칙은 바뀌지 않음**(트리거). 은퇴(`retired`)와 끝나는 날만 바꿀 수 있음 |
| `seasons` · `day_types` · `calendars` · `calendar_days` | 시즌(운영 · 요금), 평일 · 주말 · 성수기, 달력(기본 `main`, 지점마다 더할 수 있음), 달력 · 날짜별 분류 | `start_date`, `end_date`, `(calendar_id, date)`, `day_type_id` | 없는 날짜는 `weekday_day_types` 설정으로 분류 |
| `price_rules` · `price_rule_tiers` | 조건별 단가(대상, 규격, 연령, 요일 종류, 시즌, 반일, 최소 일수 · 수량)와 여러 날 합계 | 대상은 상품 · 품목 종류 · 가격 묶음 중 **정확히 하나**(CHECK), `unit_amount`(NULL = 요금 미등록, 0이 아님), `priority` | 규격은 상품 대상에만, 그 상품의 것만(복합 FK). 겹치면 상품 > 가격 묶음 > 종류 > 우선순위. 새 조건은 NULL 허용 열 추가 |
| `discount_rules` · `discount_rule_targets` | 빠른 할인과 묶음 조건, 여러 대상(묶음 할인: 스키 세트 + 리프트권) | 종류, 할인 묶음(여러 묶음에 걸친 할인은 `package` 묶음), 대상, 금액 · 비율, 끝전, `min_quantity`, 연령 · 요일 조건, 필요한 권한, 기간 | 한 묶음에서 하나만(설정). 대상 줄은 종류 · 상품 · 가격 묶음 중 하나 |
| `adjustment_types` · `reason_codes` · `asset_conditions` · `customer_tags` | 조정 종류(부호 포함), 사유, 정비 상태(행동 값 포함), 고객 표시 | `key`, `report_group_key`, `sign`, `issuable`, `is_lost` | `(id, sign)`가 조정의 FK 대상. 옛 시스템에서 설정할 수 없던 `damaged`도 정식 행 |
| `print_templates` · `print_template_versions` | 인쇄 틀과 판(A4 20명 준비표, 80×50 스티커, 수거 목록) | `renderer_key`, `paper_key`, `source_view_id`(인쇄 등급의 장부 설정), `current_version_no`, 판별 `layout_json`(용지 값 + 그때 풀어 쓴 칸 · 자리) | 판은 바뀌지 않음(트리거). 인쇄 작업을 만들 때 풀어 쓴 설정이 지금 판과 다르면 새 판부터 씀. 화면과 같은 설정이라 새 칸 · 속성이 인쇄에도 나옴 |
| `message_templates` · `message_template_versions` | 문자 틀과 판 | `time_sensitive`, `expires_after_minutes`, 판별 `body` | 시간이 지난 문자는 보내지 않음(`not_after`) |
| `stamp_steps` · `item_kind_stamp_steps` | 도장 단계(지급 · 반납 · 수납 · 적재 · 발권 · 받음 · 입고 · 강습)와 종류별 순서 · 조건 | `rule_key`, `action_key`(명령 + 확인 창 + 되돌리기 묶음, `sys_actions`), `checklist_label`, `short_label`, 긴급 순위, `shows_time`, `condition_key`(`sys_conditions`) | 새 단계는 행 추가. 새 계산 규칙 · 동작만 코드와 sys 행 필요. 한 종류에 같은 단계가 조건만 다르게 두 번 올 수 있음 |
| `ledger_views` · `ledger_view_columns` · `ledger_view_column_steps` · `ledger_view_tabs` · `ledger_view_metrics` · `ledger_view_primary_actions` · `ledger_view_actions` | 장부 · 접수증 · 수거 목록 · 기사 목록 화면 설정 | 화면 경로, 틀, 기기 등급, 바탕 화면(`base_view_id`), 한 줄의 단위(`row_grain_key`), 묶음 · 보조 묶음, 정렬, 지금 줄, ▲▼, 빨리 확인 · 칸 최소 · 선호 폭(em), 비율, 빠지는 순서, 합쳐 들어갈 칸과 모양, 도장 모음(`collapse_group_key`), 맞춤 방식, 도장 · 속성 · 동작 연결 · 단계 사슬 · 탭 필터와 값 · 바닥줄 숫자와 값 · 조건별 주 버튼 · 옆 동작 | 모든 코드 키가 sys 어휘 FK. 합쳐 들어갈 칸은 같은 화면의 칸(자기 참조 FK). 목록마다 우선순위 · 넘칠 때(ui 문서 4-4). 기능이 켜졌을 때 또는 꺼졌을 때만 보이기(`feature_on`) |
| `menu_entries` · `status_terms` · `label_translations` | 메뉴, 상태 문구 · 색 · 순위(언어별), 매장 이름 행의 다른 언어 | `screen_key`(`sys_screens`), `workspace_key`, 우선순위 · 넘칠 때, `feature_key` · `feature_on`, `permission_key`, `device_class_key` · `(domain_key, key, locale)` → `sys_status_keys`, `tone_key` → `sys_tones` · `(table_name, row_id, field_key, locale)` | 화면은 키만 비교, 문구는 여기서. 매장 문구가 없으면 `sys_status_keys.default_label`(키 그대로 보이지 않음). 빨강(`late_only`)은 늦은 상태에만 |
| `ui_default_applications` | 앱과 함께 온 화면 기본 설정(`ui-defaults.json`) 몇 판을 적용했나(장부) | `default_rev`, 더한 행 · 고친 행 · 그대로 둔 행 | 화면 설정 행마다 `origin_key` · `default_rev` · `customized_at`(ui 문서 2절) |

### 4-6. 고객과 접수

| 표 | 목적 | 핵심 필드 | 불변식 · 관계 |
|---|---|---|---|
| `customers` · `customer_tag_assignments` | 매장별 고객과 표시 | 이름, 전화(표시 · 숫자만), `phone_last4`(생성 열), 연령 구분, 제휴처, `anonymized_at` | 이름 · 전화가 같아도 자동으로 합치지 않음. 다른 매장과 공유 안 함 |
| `orders` | 통합접수: 한 팀, 대표자 이름으로 | `receipt_no`, `customer_name` · `customer_phone` 스냅샷, `booking_channel_key`, `price_list_id`, `business_date`, `config_rev` + 투영(`status_key`, `is_open`, 이용 기간, `next_due_at`, 청구 · 수납 · 미수 · 과수납 · 보증금 · 다른 팀 결제 예정 금액 · **이 팀이 대신 낼 금액**(`collect_for_others_amount`), `pay_state_key`) | 접수 번호 유일(부분). 청구 ≥ 0, 미수 · 과수납 · 보증금 · 대신 낼 금액 ≥ 0. 지우지 않음(트리거). 옛 총액만 있는 청구는 열이 아니라 `legacy_charge` 조정 한 행 |
| `order_links` | 예약 합치기, 같은 일행, 가족 묶음 | `link_kind_key` | 자기 자신과 연결 안 됨 |
| `order_batches` | 접수 차수(첫 접수, 늦게 온 일행, 배달 중 추가) | `seq`, `source_key`, `closing_scope_id`, `business_date`, `posting_date` | 접수 안에서 순번 유일. 그 차수 줄들의 청구는 `posting_date`의 마감이 셈(오프라인에서 더한 권이 마감 뒤에 들어와도 닫힌 날이 바뀌지 않음) |
| `order_people` | 일행(사이즈 미리 받기에만 씀) | `seq`, `name`, 연령 구분 | 현장 대여는 대표자만 기록. 나눠서 결제는 사람을 고르지 않음 |
| `order_lines` | 품목 줄 | 상품 · 규격 · 종류, 행동 계열 · 재고 방식 · 반납 정책 스냅샷, 결제 칸, 할인 묶음, 이름 · 단위 스냅샷, 수량, 이용 시작 · 끝, 권 사용 창, 발권 예정일, 인원, 가격 기준 · 단위 수 · 단가 · 총액 · 할인 · 순액, 요금표 판 · 규칙, `price_source_key`, `price_engine_key`, `quote_hash`, 세금 분류 · 공급가 · 부가세 스냅샷 + 투영(연장 뒤 끝 `current_end_date` · `_time`, 취소 · 준비 · 적재 · 지급 · 손님 보유 · 차량 · 반납 · 미반납 · 모름 · 강습 끝 수량, `progress_key`) | `net = gross − discount`, `discount ≤ gross`, `공급가 + 부가세 = net`, `end ≥ start`, `0 ≤ 취소 ≤ 수량`. 차수 · 부모 줄 · 일행은 같은 접수(복합 FK). **투영 열 밖은 만든 뒤 바뀌지 않고 줄은 지워지지 않음**(트리거). 수량을 늘리면 새 차수의 새 줄, 줄이면 취소 줄 |
| `discount_applications` | 적용한 할인과 그때 값 | 규칙, 종류, 이름 · 값 스냅샷, 끝전, 합계, `supersedes_application_id` | 장부. 바꾸면 새 행 + 조정 |
| `line_price_components` | 줄 가격의 내역 | `component_key`(base · tier · day_type · season · class · discount · manual · rounding · legacy), 날짜별 행 | 장부. 합 = `order_lines.net_amount`(검증기). 할인 행은 같은 접수의 적용만 가리킴 |
| `line_promises` | 줄(또는 일부 수량)의 수령 · 반납 약속 | 종류, 방법, 수량, 날짜 · 시각, 반납 타임 · 수령 시각 옵션과 스냅샷, 장소 id + 구역 · 장소 이름 스냅샷 + 메모(객실), 차량, 업무, 상태, 앞 약속 | 방법은 그 약속 종류의 것만(복합 FK). 줄마다 · 종류마다 살아 있는 약속 수량의 합 = 살아 있는 수량(명령 계층 + 검증기) |
| `line_promise_assets` | 약속을 특정 장비에 묶음(4대 중 2대 연장) | `asset_id` | |
| `payment_promises` | 누가 · 언제 · 얼마를 낼지 | 목적(수납 · 선입금 · 보증금), 시점, `payer_order_id`('김OO 팀 결제 예정'), 후불 거래처, 예상 금액, 상태 | 자기 접수를 결제 팀으로 못 고름 |
| `service_bookings` | 강습 예약(팀, 종목, 인원, 날짜, 시간, 강사, 만날 장소, 상태) | `session_no`, 강습팀(비어 있으면 `unassigned`: 팀을 정하기 전에 팔 수 있음), `end_day_offset`(자정 넘는 야간 강습), `status_key`(unassigned · reserved · done · cancelled · no_show) | `(line_id, session_no)` 유일 인덱스. 강습팀 정산은 `counterparty_trades(source_key 'booking:<id>:<n>')` 한 번. 정산 뒤 바꾸기는 `lesson.correct`(거래 취소 + 다시 냄)만 |
| `order_cancellations` · `order_cancellation_lines` | 취소(일부 수량 포함)와 환불 결정 | `refund_decision_key`, 수량, 금액(줄 가격 내역에서 비율로, 마지막 취소가 남은 금액), 조정 | 장부. 취소 줄은 같은 접수의 취소와 줄만. 금액이 있으면 조정 연결 필수(CHECK). 취소 합계 = 줄 합 = −조정 합(검증기) |
| `order_extensions` · `order_extension_lines` · `order_extension_assets` | 연장과 장비별 끝 | 전후 끝 날짜 · 시각, 새 반납 타임과 스냅샷, 가격 기준, 더한 단위 수 · 분, 금액, 새 약속 | 장부. 더 늦은 날, 또는 같은 날 더 늦은 시각(오후 → 야간, 반일 → 하루, 3시간권 → 6시간권). 금액이 있으면 조정 연결 필수 |

### 4-7. 속성 값

`order_attribute_values`, `line_attribute_values`, `person_attribute_values`(출처별: 손님 입력 · 직원 확인 · 측정 · 지급), `customer_attribute_values`, `catalog_item_attribute_values`, `variant_attribute_values`, `asset_attribute_values`, `task_attribute_values`, `place_attribute_values`, `counterparty_attribute_values`. 모두 같은 모양이다.

- 키: `(shop_id, 주인 id, attribute_id, value_seq)`, 주인 표로 복합 FK. 값이 하나인 칸은 `value_seq = 0`, 여러 값 칸(`multi_valued`: 무릎 + 손목 보호대, 연락처 둘)은 1..n. `value_unit`은 여러 단위로 받는 칸의 그 값의 단위(부츠 US · mm).
- `entity_type_key`는 `CHECK`로 고정하고 속성 정의와 함께 외래 키로 묶어, **주문 속성을 품목 줄에 저장하는 실수**를 데이터베이스가 막는다.
- 값 칸(`value_text` · `value_int` · `value_real` · `option_id`) 중 하나만 채운다(`CHECK`). 선택지는 그 속성의 것만. 나중에 값 칸을 더하면(예: `value_json`) 그 마이그레이션이 '하나만' 규칙을 BEFORE INSERT 트리거로 이어 받는다(7-2). 돈 같은 값(구입가)은 REAL이 아니라 최소 단위 정수(`money` 형식 → `value_int`).
- 동기화는 이 행들을 **주인 묶음의 일부**로 보낸다. 기기는 `order_attribute_values`라는 별도 종류를 몰라도 접수와 함께 받는다.

### 4-8. 사이즈 미리 받기

| 표 | 목적 | 불변식 · 관계 |
|---|---|---|
| `intake_templates` · `intake_template_questions` | 질문 틀의 판(행 하나가 판 하나)과 질문(속성, 필수, 보임, `현장에서 확인` 허용, 대상 종류) | `(key, version_no)` 유일 |
| `intake_requests` | 요청 링크 하나(모든 요청은 접수에 딸림, 인원만 예약도 접수) | `token_hash` 유일. 매장은 control `public_links`가 먼저 찾아 줌(2-3). 토큰 원문은 URL 조각에만 |
| `intake_submissions` · `intake_submission_people` · `intake_answers` | 손님 입력의 판, 사람, 답(그때 질문 문구, 여러 값은 `value_seq`) | 장부. 손님이 고쳐도 새 판. 이름 · 글 답은 보관 기간 뒤 `(지움)`으로 가림(트리거가 이것만 허용) |
| `intake_reviews` | 직원이 확인한 판 | 장부. 확인한 값은 `person_attribute_values(source 'review')`로 |

### 4-9. 재고

| 표 | 목적 | 핵심 필드 | 불변식 · 관계 |
|---|---|---|---|
| `stock_locations` | 재고가 있을 수 있는 모든 곳(매장 · 지점, 창고, 차량, 손님, 거래처, 다른 테넌트, 외부, 없어짐) | `kind_key`, 차량 · 거래처 · 접수 연결, `branch_id` | 매장마다 `external`과 `void` 행도 있음. 차량 · 거래처 · 접수마다 하나(부분 유일). `(id, kind_key)` 유일 → 이동의 경로 확인에 씀. 나중의 새 주인 종류(숙소 보관함 등)는 1:1 확장 표(E5)이고 '주인 하나' 규칙은 검증기가 봄 |
| `lots` | 들여온 묶음(구입, 기초, 거래처에서 빌림) | 주인 거래처, `source_reference` | 중복 들이기 방지(부분 유일) |
| `assets` | 번호로 관리하는 장비 하나와 리프트권 한 장 | 상품 · 규격(품목 바꾸기의 투영), 옛 사이즈 글자, 주인, 스티커 번호 + 투영(`location_id`, `condition_id`, `last_movement_id`) | 규격은 그 상품의 것만. 스티커 번호 유일(부분). 위치 · 상태 · 품목은 이동 · 상태 변경 · 품목 바꾸기 기록으로만 바뀜. 지우지 않음 |
| `asset_reclassifications` | 장비를 다른 상품 · 규격으로(등급 조정, 잘못 넣은 어린이 스키, 같은 상품 합치기, 옛 `legacy-` 권 종류 확정)(장부) | 전후 상품 · 규격, 사유, 네 시간 | 이동 줄은 그때 상품을 **스냅샷**으로 가지므로 품목을 바꿔도 지난 이동은 그대로다 |
| `ticket_units` · `ticket_unit_accepts` | 권의 유효 기간, 양도 가능, 발권처, 번호, 원가 · 이 권으로 대신할 수 있는 권종 | `valid_to > valid_from` | |
| `stock_balances` | 수량으로 세는 품목(고글, 보호대)의 위치 · 규격 · 상태 · **주인 · 묶음(lot)**별 수량 | `quantity ≥ 0` | 투영: 수량 이동 줄의 합. 거래처에서 빌린 고글과 우리 고글, 유효기한 있는 핫팩 묶음을 따로 셈 |
| `stock_holds` | 수량 품목 잡아 두기(단체 고글 M 6개) | `quantity`, 접수 줄, 업무, `ended_at` | 가능 수량 = 잔량 − 살아 있는 잡기(명령 계층) |
| `stock_movements` | 이동 머리(장부) | 종류, 출발 · 도착 위치와 그 종류, 접수 · 업무 · 거래처 · 교환 · 조기 반납 · 발권처 환불 · 거래처 대여 · 사이즈 요청, `reverses_movement_id`, 매장 간 `transfer_ref`, `late_fact`(늦게 온 오프라인 사실: 역사로만), `skipped_hop`(손에 든 것을 본 기록이라 출발지가 달라도 받음), `source_reference`, 마감 범위, 사유 | **(종류, 출발 종류, 도착 종류)가 `sys_movement_routes`에 있어야 함**(복합 FK). 위치의 종류가 실제 위치 행과 같아야 함. 출발 ≠ 도착. 여러 팀을 한 번에 입고하면 `order_id`는 비움. 장비의 '마지막 이동'은 `created_rev`(적용 순서)로 정하고 id나 기기 시각으로 정하지 않음 |
| `stock_movement_lines` | 장비 하나 또는 수량 한 묶음(장부) | 상품(그때 스냅샷), 장비 또는 규격, 수량, 주인 · 묶음(수량 줄), 접수 · 줄, claim, 상태 전후, `created_rev` | 장비 줄은 수량 1. 장비는 `(shop_id, asset_id)`로만 가리킴(품목 바꾸기가 되게). 수량 줄은 떠나는 상태 · 들어가는 상태 필수(CHECK). claim은 **그 장비의** claim만(복합 FK). 줄은 그 접수의 것 |
| `stock_movement_reversals` | 어떤 되돌리기 줄이 어떤 줄을 되돌렸나(장부) | `(reversed_movement_id, reversed_line_no)` 기본 키, `(reversal_movement_id, reversal_line_no)` → 되돌리기 자신의 줄(복합 FK) | **한 줄은 한 번만 되돌림.** 되돌리는 줄이 같은 장비 · 규격 · 수량의 반대 경로인지와 머리가 맞는지는 검증기. 옛 `reversed_by_movement_id` 수정 열을 대신함 |
| `asset_bindings` | 장비가 지금 누구 · 무엇에 약속돼 있나: **장비마다 살아 있는 묶임 하나**(부분 유일) | 목적(접수 · 권 공용 창 · 발권처 환불 · 거래처 대여 · 교환), 접수 · 환불 · 대여 | 묶임이 걸린 차선(`bound = 1`)의 claim은 모두 그 장비의 묶임에 걸림(복합 FK) → 준비는 A 접수, 적재는 B 접수처럼 **차선이 달라도 두 약속이 동시에 설 수 없음** |
| `asset_claims` | 장비를 잡아 두는 모든 경우(준비, 배달 적재, 수거 예정, 발권처 환불, 거래처 대여, 교환용, 구성품, 권 배정) | 묶임, 종류, 차선, 차선 배타 · 묶임 여부, `exclusive_key`, 접수 · 줄 · 업무 · 준비 · 교환 · 환불 · 대여, 기준 장비, 권 사용 창, 끝남(`displaced_by_fact` 포함) | 종류의 차선과 일치(복합 FK), 차선의 배타 · 묶임 값과 일치(복합 FK), 배타면 `exclusive_key = asset_id || '|' || lane_key`(CHECK), 묶임 차선이면 묶임 필수(CHECK). **배타 차선마다 살아 있는 claim 하나**(부분 유일 인덱스). `(id, asset_id)`가 준비 항목 · 이동 줄의 FK 대상. 권은 '권 공용 창' 묶임 하나 아래 시간대 claim들이고, 겹치지 않는지는 명령 계층(PostgreSQL은 EXCLUDE), 발권처 환불로 내보내려면 살아 있는 시간대 claim이 없어야 함. 지우지 않음 |
| `asset_condition_changes` | 상태 · 분실 · 찾음 · 규격 바뀜 기록(장부) | 전후 상태, 전후 규격, 마지막 위치, 마감 범위 | 규격이 몰래 바뀌지 않음 |

### 4-10. 재고 절차

| 표 | 목적 | 불변식 · 관계 |
|---|---|---|
| `preparations` · `preparation_items` | 준비(지급 전 장비를 골라 규격을 맞춰 둠)와 항목별 규격 전후 | 항목은 **장비 하나 + 그 장비의 준비 claim** 또는 **수량 규격 + 수량 잡기(stock_hold)**(CHECK). 같은 접수의 준비 · 줄 · 일행만 |
| `exchanges` · `exchange_units` · `exchange_recoveries` | 교환(교환 가능한 모든 종류와 구성품), 장비 또는 수량 규격(고글 M → L 2개)별 배달 · 수거 업무, 회수(장부) | 교환은 그 접수의 줄에 대해서만. 장비 교환과 수량 교환 중 하나(CHECK) |
| `early_returns` · `early_return_assets` | 조기 반납(돈은 바뀌지 않음)과 장비 또는 수량(고글 6개 중 2개)별 이전 업무 · 약속 | 이전 계획은 JSON이 아니라 외래 키. 장비 줄은 조기 반납마다 한 번(부분 유일) |
| `equipment_loans` · `equipment_loan_items` | 거래처에서 빌림 · 빌려줌과 장비 또는 수량(고글 20개)별 나감 · 돌아옴 | 돈은 거래처 장부. 수량은 여러 번에 나눠 돌아올 수 있음(`back_quantity ≤ quantity`) |
| `vendor_refunds` · `vendor_refund_items` · `vendor_refund_attempts` | 회수한 리프트권을 발권처에 돌려주고 돈 받기, 권별 결과, 방문마다 시도(장부) | 한 권은 살아 있는 발권처 환불 하나에만(부분 유일). 받은 돈은 **거래처 정산 한 곳**으로만 현금 이동 → 마감(시도는 현금 출처가 아님, 정산 하나에 시도 하나) |

### 4-11. 차량 업무와 알림

| 표 | 목적 | 핵심 필드 | 불변식 · 관계 |
|---|---|---|---|
| `tasks` | 차량 한 대의 배달 · 수거 · 발권처 방문 | 종류, 차량, 약속한 날 · 시각, 장소 id + 이름 스냅샷, 접수, `customer_label`, 출처, 상태 | 방문 순서를 바꿔도 약속 시각은 안 바뀜. 새 출처(수리, 보관, 강습 픽업)는 1:1 확장 표(E5). 지우지 않음 |
| `task_items` | 업무의 품목 · 계획 수량과 투영(한 수량, 매장에서 따로 받은 수량) | 계획 ≥ 0 | 줄 · 약속은 같은 접수의 것 |
| `task_visits` | 방문 결과(고객 부재 · 장소 변경 · 물품을 받지 못함, 다시 가기)(장부) | `result_reason_id`, `retry_key`, 전후 날짜 · 시각 · 장소 | 업무 안 순번 유일. 순번은 서버가 적용할 때 매김(기기가 매기지 않음) |
| `task_reassignments` | 차량 · 날짜 · 시각 옮김(장부) | 전후 값 | 옮기면 옛 차량 범위에 지움 표시, 새 차량 범위에 새 행(sync 문서 5절) |
| `route_positions` | 방문 순서: 업무마다 한 행, 분수 순위 | `rank_key`(BINARY 비교, NULL = 시간순), 차량, 날짜, `decided_at`(고친 발생 시각) | 한 경로의 첫 손 순서 바꾸기가 그 경로 모든 업무에 순위를 한 명령으로 씀. ▲▼는 '이 업무 앞 · 뒤'(기준 업무)로 보내고 서버가 지금 순서에 맞춰 풂. 더 오래된 이동이 늦게 오면 짐(`route_superseded`). 같으면 (순위, 약속 시각, 업무 id). 업무 옮기기가 같은 트랜잭션에서 차량 · 순위를 다시 씀 |
| `task_pins` | 빨리 확인: 맨 위 고정과 알림 | 메시지, 고정 · 해제, 해제 이유, 알림 | 업무마다 살아 있는 고정 하나(부분 유일). 이미 고정이면 같은 명령은 '이미 됨'(오류 아님). 업무가 끝나거나 취소되면 자동 해제 |
| `notifications` · `notification_receipts` · `notification_preferences` | 직원 · 기사 알림(요청됨 → 기기에 도착 → 사람이 확인 → 닫힘 · 만료), 기기별 도착 · 확인, 소리 설정 | 받는 범위(매장 · 차량 · 직원), 종류, `source_key`, 단계와 시각, 문구 틀 키 · 값 | 출처 키 유일(중복 알림 방지; 빨리 확인은 `pin:<고정 id>`라 다시 고정할 수 있음). 제목에 전화번호 없음. 문구 틀 키와 값(`template_key`, `params_json`)을 함께 두어 다른 언어로 다시 그림 |

### 4-12. 돈

| 표 | 목적 | 핵심 필드 | 불변식 · 관계 |
|---|---|---|---|
| `payment_groups` | 한 번의 결제 자리(접수 확정, 여섯 팀 한 번에, 나눠서 한 회차, 현장 수납)(장부) | `group_no`, `purpose_key` | 묶음 번호 유일 |
| `payment_intents` · `payment_intent_allocations` | 카드 단말 · 온라인 결제 왕복(요청 → 승인 · 거절 · 모름)과 의도한 배분 | 금액, 단말(없으면 PG) · `provider_key`, 상태, 승인번호, 카드 표시, 단말 응답, 사람이 확인한 명령(`resolved_by_request_id`) · 배분 줄(접수 · 줄 복합 FK) | id는 요청에서 정해짐(복구 뒤 다시 보내도 같은 id → 단말 도우미가 '이미 승인'). `unknown`은 결제 창 안의 단계로. 배분이 JSON이 아니라 FK라 승인 뒤 복사가 실패하지 않음 |
| `order_checkout_locks` | 접수마다 열린 카드 결제 하나 | 접수, 카드 요청, 기기 | 부분 유일 인덱스. 다른 카운터는 '카운터 1에서 카드 결제 중'을 보고 그사이 그 팀의 카드 · 현금을 받지 못함 |
| `payments` | **실제 돈 한 건**(카드 한 번, 현금 한 번)(장부) | 종류(와 그 규칙 값 복사), 목적(수납 · 선입금 · 보증금), 수단(과 현금 여부 복사), 금액 > 0, 돈통 · 차량 지갑, 단말, 카드 요청, 승인번호 · 승인일, 메모, 환불 대상, 보증금, 낸 팀 · 고객 · 거래처, 받은 차량, 사유(가리기만), 마감 범위, 네 시간 | 환불은 대상 필수 · 보증금 종류는 보증금 필수 · 현금이 움직이면 돈통 필수, 아니면 없음(모두 CHECK + 복사본 FK). 돈통의 범위와 같음(복합 FK). 후불 거래처(`payer_counterparty_id`)는 현금이 아닌 수단만. **승인번호로 거절하지 않음**(같은 번호 두 번 → 확인 필요). 같은 카드 요청에 같은 승인번호 두 번은 한 건(부분 유일), 다른 승인번호면 기록 + '한 번 더 승인됨'. 환불은 자기 자신 불가. 이름 칸 없음 |
| `tax_documents` · `tax_document_identities` | 현금영수증 · 세금계산서(장부, 취소는 새 행)와 그 손님 신원(개인정보, 보관 기간 뒤 지움) | 수납, 금액 = 공급가 + 부가세, 세금 분류별 내역, 국세청 승인번호, 상태 | 취소 기록은 한 번만 |
| `payment_allocations` | 한 건을 여러 접수 · 줄에 나눔(장부) | 접수, 줄(NULL = 접수 전체), 금액(수납 옮기기 안에서만 음수), 수량(나눠서 결제; 금액과 같은 부호), 마감 범위 · `business_date` · `posting_date`, 행위자, 요청번호 | 줄은 그 접수의 것(복합 FK). `수량 × 금액 > 0`(CHECK)이라 되돌린 수량이 '더 낸 수량'으로 세어지지 않음. 품목별로 나눠 내는 접수는 줄 단위 배분만(명령 계층). 배분 합 = 수납 금액(명령 계층 + 검증기) |
| `payment_reallocations` | 수납을 다른 팀 · 줄로 옮김(장부) | 사유 | 옮김 = 원래 쪽 음수 배분 + 새 쪽 양수 배분 |
| `deposits` | 보증금 보관 머리 | 필요 금액 + 투영(보관 금액, 상태) | 돈은 보증금 종류의 수납 행. 청구에 자동으로 쓰지 않음 |
| `charge_adjustments` · `adjustment_assets` | 청구를 바꾸는 부호 있는 기록(연장, 취소, 취소 수수료, 늦은 반납, 파손, 분실, 가격 정정, 할인 변경, 끝전, **옛 청구 — 옛 총액만 있는 청구가 있는 유일한 곳**)(장부)와 분실 · 파손 청구가 가리키는 장비 | 종류 · 부호 복사, 금액 ≠ 0, 사유 필수, 연장 · 취소 · 강습 · 할인 연결, 마감 범위 | `부호 × 금액 > 0`(부호 0 종류는 양쪽). 연결 대상은 같은 접수의 것. 분실 청구한 장비를 찾으면 `found_after_charge` |
| `cash_entries` | 접수 · 거래처와 상관없는 현금 입출금(시재, 지출, 은행 입금)(장부) | 돈통, 방향, 금액, 사유 | 거래처 돈은 여기 적지 않음(거래처 정산이 유일한 현금 장부) |
| `cash_transfers` · `cash_transfer_confirmations` | 차량 지갑 → 카운터 돈통 넘김과 카운터 확인(장부) | 넘김: 금액, 넘기는 중 돈통 · 확인: 센 금액, 차액, 과부족 돈통, 사유, 두 날짜 | 넘기면 지갑 → **넘기는 중** 돈통, 세고 확인해야 넘기는 중 → 카운터 돈통(센 금액)과 차액 → 과부족 돈통(사유). 확인 안 된 넘김은 마감 인계 |
| `cash_movements` | 마감이 현금을 읽는 **단 한 곳**(투영) | 돈통 · 마감 범위, 부호 있는 금액, 출처 종류 · id · 다리 번호, 두 날짜, `created_rev` | `(출처 종류, 출처 id, 다리)` 유일. **돈 종류마다 현금을 만드는 장부는 하나**(수납 · 현금 입출금 · 넘김 · 넘김 확인 · 거래처 정산)라 같은 현금을 두 길로 셀 수 없음. 장부에서 다시 만들 수 있고, 검증기가 현금 장부 행마다 정확히 한 행(다리마다)인지 확인 |

### 4-13. 마감

| 표 | 목적 | 불변식 · 관계 |
|---|---|---|
| `business_days` | 마감 범위 · 날짜별 잠금(4-3) | 열린 날인지, 지금 유효한 마감 판 |
| `closings` | 마감 한 판: 범위, 시재, 예상 · 센 현금, 차액, `as_of_rev`, 확인한 미리 보기(`basis_json`), 넘어가기 사유(`override_reason`), 얼린 보고서(장부) | `차액 = 센 금액 − 예상`. `(범위, 날짜, 판)` 유일. 보고서에 이름 없음(id와 숫자만) |
| `closing_reopenings` | 마감 다시 열기(관리자, 사유)(장부) | 한 판은 한 번만 다시 엶. 그 범위의 가장 늦게 닫힌 날만(3-3) |
| `closing_totals` · `closing_drawer_counts` · `closing_handover_items` | 마감 숫자(수단 · 결제 칸 · 품목 종류 · 거래처 · 세금 분류별), 돈통 · 차량 지갑별 센 금액(앞 셈 · 앞 `as_of_rev`, 셈 상태 counted · deferred), 다음 날로 넘기는 일(미수, 과수납, 보증금, 미반납, 늦게 들어온 돈, 확인 필요, **열린 대신 내기 약속**, 확인 안 된 현금 넘김, 결과 모르는 카드, 발권처 환불 대기)(장부) | 돈통별 `차액 = 센 − 예상`. 인계 항목은 접수가 없어도 됨(대상 종류 + id) |

마감 절차: 범위 · 날짜의 `business_days` 행을 잠그고 → 청구(차수)와 돈 장부를 `closing_scope_id = 그 범위`, `posting_date = 그날`, `created_rev ≤ as_of_rev`로 합산 → **돈통마다** 예상 현금 = 그 돈통의 앞 셈(`prev_closing_id`의 센 금액) + `cash_movements.created_rev`가 `(앞 as_of_rev, as_of_rev]`인 합(날짜가 아니라 rev 창이라 늦게 들어온 차량 현금이 두 번 세어지거나 빠지지 않음) → `closings` 판 추가 → `business_days.active_closing_id` 설정. 마감 미리 보기는 차량 기기마다 마지막 동기화 시각과 보낼 줄 수를 보이고, 보낼 것이 남은 차량이 있거나 돈 검증 결과가 열려 있으면 막는다(관리자 PIN + 사유로 넘길 수 있음; 그 차량 지갑은 `deferred`로 두고 다음 셈에 넘김). 다시 열기: `closing_reopenings` 추가 → `active_closing_id = NULL`. 새로 마감하면 판 번호가 하나 오른다. 마감된 날 뒤에 들어온 돈 · 청구는 3-3의 기준선으로 `posting_date`를 받는다.

### 4-14. 거래처 장부

| 표 | 목적 | 불변식 · 관계 |
|---|---|---|
| `counterparty_trades` · `counterparty_trade_lines` | 받을 돈 · 줄 돈(권 구입 · 판매 · 환불, 장비 빌린 값 · 빌려준 값, 강습 위탁, 수수료, 후불 거래처 청구)과 내역(장부) | 방향은 종류가 정함. 정정은 취소 기록(`cancels_trade_id`, 한 번만). 만든 근거는 `source_key`로 한 번만(강습 예약을 두 번 닫아도 두 번 빚지지 않음). 후불은 접수를 비운 비현금 수납(`payment_id`)과 연결 |
| `counterparty_settlements` · `counterparty_settlement_allocations` | 준 돈 · 받은 돈과 거래별 배분(장부). **거래처 돈의 유일한 현금 장부** | 현금이면 돈통(범위 복합 FK). 상계는 같은 금액의 받음 + 줌 두 행이 `offset_group_id`를 나눠 가짐(수단 · 돈통 없음). 정정은 취소 기록. 옛 자료의 수단 미확인은 `method_confirmed = 0`. 정산 금액 = 배분 합, 거래별 배분 합 ≤ 거래 금액, 취소된 거래에는 배분 없음(검증기) |

### 4-15. 문서와 바깥으로 나가는 일

| 표 | 목적 | 불변식 · 관계 |
|---|---|---|
| `print_jobs` · `print_job_sources` · `print_job_attempts` | 인쇄 한 건(틀의 판, 대상, 조건, 기준 rev, 얼린 문서와 해시, 상태), 만든 근거, 시도 | 틀의 판을 복합 FK로. 인쇄 창을 여는 것만으로 무엇도 끝냄 처리하지 않음 |
| `message_deliveries` | 알림 한 건(틀의 판, 채널, 받는 곳 종류 · 값, 본문, 상태, 업체 번호, `not_after`) | 업체 번호 유일(부분). 받는 곳(전화 · 이메일 · 푸시 · 메신저)은 개인정보. 업체 콜백은 control `external_refs`로 매장을 찾음 |
| `outbox` · `outbox_attempts` | 커밋 뒤 실행할 일(문자, 인쇄, 카드 단말, 외부 알림, 백업 올리기)과 시도 | `(채널, 멱등 키)` 유일, 멱등 키는 만든 요청에서 정해짐. 자동 재시도는 채널 값을 복사(문자 · 카드는 0). 잡기(`in_flight`)는 바깥 호출 전 따로 커밋. 복구 뒤 다시 만든 행(`replayed`)의 재시도 없는 채널은 `unknown`에서 시작. 결과는 정해진 요청번호의 시스템 명령으로 기록 |

### 4-16. 작업 기록 · 멱등 · 동기화

| 표 | 목적 | 불변식 · 관계 |
|---|---|---|
| `command_log` | 받은 모든 명령(적용, 일부 적용, 이미 됨, 확인 필요, 거절, 멈춤, 충돌) | 기본 키 `(shop_id, request_id)`: **요청번호 하나가 멱등 키**(행위자는 데이터). 큐 명령은 기기가 서명한 행위자 + 전달한 세션(`submitted_by_key`). `(device_id, device_seq)` 유일(순서는 강제하지 않고 빈 번호를 찾음). 기준 `{epoch, rev}`, 시각 출처. 결과 본문은 90일 뒤 비우고 행은 남김 |
| `events` | 받아들인 명령마다 한 행: 서버가 정한 id · 시각 · 영업일이 들어간 정본 명령(개인정보 · 자유 글 없음), 결과(넣은 장부 행의 해시 포함), 처리기 판, epoch, 해시 사슬 | 장부. 확인 기록이 있는 시즌 보관 범위만 지울 수 있음(트리거). 요청번호 유일 |
| `event_pii` | 작업 기록이 참조하는 개인정보와 자유 글(명령 본문 밖), 소금값 | 30일 뒤 비움. 사슬에는 `pii_commitment = sha256(소금 ‖ pii_json)`만 들어가 지워도 사슬이 맞음 |
| `intent_marks` | rev마다 바뀐 충돌 키(결정 키와, 돈 사실이 남기는 `order:<id>:money` · `drawer:<id>:cash`) | 30일 보관. 그보다 오래된 기준은 새로 보기 충돌(sync 문서 4-2) |
| `change_log` | rev마다 바뀐 행과 보이는 범위(store · vehicle:<id> · money · public), upsert · tombstone | 60일 보관 |
| `device_sync_cursors` | 기기별 마지막 rev, 기기 번호, 시계 차이, 대기 수 | |
| `review_items` | `확인 필요`(쉬운 한 문장과 그 값, 두 기록, 적용한 부분, 보일 기기 · 사람) | 종류는 `sys_review_kinds`(무게 · 보일 곳). 관리자 목록은 쌓인 것, 급한 것은 일으킨 기기의 그 화면 안에 |
| `integrity_findings` | 검증기 결과(투영 차이, 약한 참조, 현금 출처, 모르는 상태, 해시 사슬, FK) | 관리자 · 개발자용 |
| `journal_exports` | 작업 기록 구간(암호화): 작업 기록 + `event_pii` + 명령 기록 + **바뀐 행의 이후 모습(after-image)** | 사슬의 앞뒤 해시, epoch. 같은 LAN의 다른 기기로 몇 초 안에 흘려 보내고(`lan_peer`), 두 번째 디스크 · 원격에도 |

### 4-17. 이관 · 전환 · 보관

| 표 | 목적 | 불변식 · 관계 |
|---|---|---|
| `legacy_import_runs` | 가져오기 한 번(원본 지문, 대조 전후 결과) | 같은 원본으로 확인된 가져오기는 하나 |
| `legacy_records` | 옛 요소 → 새 행, 열이 없는 필드(잔여) | 가져오기로 만든 것과 옛 규칙 처리기(facade)가 운영 중에 만든 것 모두. 잔여는 개인정보 가릴 수 있음 |
| `legacy_events` | 옛 작업 기록 원본 | 가릴 수 있음(`redacted_at`) |
| `legacy_value_map` | 옛 값(장소 글자, 발권처 id, 직원, 행위자) → 새 행 | |
| `native_only_aggregates` | 옛 처리기가 표현하지 못하는 상태가 된 묶음(수량을 나눈 약속, 선입금, 여러 팀 결제, 강습, 방문 순위) | 옛 처리기가 이 묶음에 쓰려 하면 분명한 오류로 거절(migration 문서 3절) |
| `archive_manifests` · `archive_verifications` | 시즌 보관 파일로 옮긴 작업 기록 범위, 사슬 앞뒤 해시, epoch, 스키마 판(장부)과 그 확인(장부) | 확인 행이 있는 범위만 `events`에서 지울 수 있음(바뀔 수 있는 상태 열에 기대지 않음) |

## 5. 불변식은 누가 지키나

**데이터베이스**(앱 코드에 버그가 있어도 지켜짐):
- 매장 경계(복합 FK), 같은 접수 안의 연결, 같은 상품의 규격, 그 속성의 선택지, 그 대상 종류의 속성.
- 이동 경로(`sys_movement_routes`)와 위치 종류 일치, 출발 ≠ 도착, 수량 이동 줄의 상태 전후, 되돌리기 줄이 자기 이동의 줄을 가리킴.
- 장비마다 살아 있는 묶임 하나, 묶임 차선의 claim은 그 장비의 묶임에 걸림, 배타 차선마다 살아 있는 claim 하나, claim 종류와 차선의 일치, 준비 항목 · 이동 줄의 claim은 그 장비의 claim, 한 권은 살아 있는 발권처 환불 하나에만.
- 한 이동 줄은 한 번만 되돌림. 거래처 거래 · 정산 · 세금 문서의 취소 기록은 한 번만. 거래처 거래는 근거(`source_key`)마다 한 번.
- 업무마다 살아 있는 빨리 확인 하나. 알림 출처 키 유일. 접수마다 열린 카드 결제 하나.
- 범위 · 날짜마다 유효한 마감 하나(그 범위 · 그 날짜의 마감만), 마감 판 번호 유일, 판마다 다시 열기 한 번.
- 돈의 연결: 환불은 대상, 보증금 종류는 보증금, 현금이 움직이면 돈통(아니면 없음), 돈통과 같은 마감 범위, 후불 거래처는 비현금 수단, 조정의 부호(모두 복사본 + 복합 FK + CHECK). 금액이 있는 취소 · 연장 줄은 조정과 연결. 배분 수량은 금액과 같은 부호.
- 접수 번호, 카드 요청당 같은 승인번호 한 건, 멱등 키(요청번호), 기기 번호, 작업 기록 요청번호, outbox 멱등 키, 재고 들이기 출처, 스티커 번호, 토큰 해시 유일. (카드 승인번호 자체는 유일하지 않다.)
- 부호 · 범위(금액 > 0, 수량 ≥ 1, 0 ≤ 취소 ≤ 수량, 비율 0~10000), `net = gross − discount`, `공급가 + 부가세 = net`, `차액 = 센 − 예상`, `posting_date ≥ business_date`, `valid_to > valid_from`, 요금 규칙 대상 하나.
- 장부 49개 표와 작업 기록의 추가만(0001 열 목록의 수정 금지, 삭제 금지, 자유 글은 가리기만, `REPLACE`도 막힘), 품목 줄의 가격 · 수량 · 날짜 · 스냅샷 고정, 업무 행 삭제 금지, 게시된 요금표의 고정.
- 화면 설정의 모든 코드 키(화면, 칸 그리기, 맞춤, 정렬, 묶음, 색, 조건, 상태, 동작, 확인 창)가 sys 어휘에 있음, 합쳐 들어갈 칸이 같은 화면에 있음.

**명령 계층**(한 번에 하나씩 처리하는 쓰기 트랜잭션 안):
- 배분 합 = 수납 금액, 환불 ≤ 받은 돈(접수 · 줄 · 배분 안 된 금액; **열린 · 모르는 환불 카드 요청도 잡힌 돈으로 셈**), 보증금 반환 ≤ 보관 금액. 품목별로 나눠 내는 접수는 줄 단위 배분만.
- 권 배정 시간대가 겹치지 않음, 권의 유효 기간 · 양도 가능 · 대신할 수 있는 권종. 묶임의 목적과 claim의 접수 · 목적이 같음.
- 이동의 출발 위치 = 장비의 지금 위치(손에 든 것을 본 사실은 `skipped_hop`, 더 늦은 사실보다 먼저 일어난 사실은 `late_fact`로 역사만), 되돌리기는 장비의 마지막 이동만(`created_rev` 순), 장비는 그때 그 상품의 것.
- 줄 · 종류마다 살아 있는 약속 수량의 합 = 살아 있는 수량.
- 마감한 날에는 새 청구 · 취소를 받지 않음(늦은 사실은 기준선으로).
- 권한 · 범위 · 한도, 기능 켜짐, 기사의 차량 범위(**일이 일어난 시각의** 업무 배정으로), 가격 = 서버 견적(오프라인 사실은 그때 효력 있던 판의 기기 견적) 또는 권한 있는 직접 입력, 할인 겹치기 규칙.
- 코드가 정하는 상태 값이 알려진 값인지(계약 패키지가 목록을 내보냄).

**검증기**(명령마다 테스트에서, 매일 밤 매장 PC에서, 마감 전에). 결과는 `integrity_findings(check_key)`. 돈 검사(`money_*`)가 열려 있으면 그날 마감은 관리자 PIN + 사유 없이는 되지 않는다(`closing_policy`).
- 모든 투영을 장부에서 다시 계산해 비교(6절). 차이는 적고 투영을 다시 만든다(고치는 것도 정해진 요청번호의 시스템 명령 `verifier.repair`로, rev와 변경 목록을 남겨 기기에도 간다).
- 가격 · 청구: `line_price_components` 합 = 줄 순액, 할인 적용 합계 = 할인 내역 합, 접수 청구는 장부(줄 순액 + 조정)로만 다시 계산, 취소 줄 합 = 취소 합계 = −연결된 조정 합, 연장도 같게, 줄마다 취소 합 ≤ 순액 + 연장.
- 돈: 배분 합 = 수납 금액, 수납마다 환불 합 ≤ 수납, (수납, 접수)마다 옮긴 뒤 배분 합 ≥ 0, 줄마다 받은 돈 ≤ 줄 청구(+ 조정) · 받은 수량 ≤ 살아 있는 수량, 보증금 장부 잔액 ≥ 0이고 `deposits.held_amount`와 같음, 거래처 거래 금액 = 내역 합, 정산 금액 = 배분 합, 거래별 배분 합 ≤ 거래 금액 · 취소된 거래에는 배분 없음, 발권처 환불 시도 금액 = 정산 금액, 강습 예약마다 살아 있는 위탁 거래 ≤ 1.
- 현금: 현금 장부 행마다(다리마다) `cash_movements` 정확히 한 행, 한 정산 · 시도 · 수납이 두 현금 이동을 만들지 않음, 마감의 예상 현금 = 돈통 셈 예상의 합, 돈통의 시작 = 앞 셈의 센 금액, 거래처 장부 합과 현금 이동을 밤마다 맞춤.
- 재고: 되돌리기 줄이 같은 장비 · 규격 · 수량의 반대 경로이고 머리가 맞음, 장비의 살아 있는 claim이 모두 같은 묶임.
- `sys_soft_references`에 적힌 열의 대상이 있고 같은 매장인지, 나중 주인 열까지 '주인 하나'인지.
- 작업 기록 해시 사슬과 **장부 행 해시**(명령이 넣은 행의 해시가 `events.result_json`에 있어 rev 순으로 다시 계산해 맞춤), `PRAGMA foreign_key_check`, `PRAGMA quick_check`, 알 수 없는 상태 값.

## 6. 투영과 검증기

| 투영 | 무엇에서 다시 계산하나 | 언제 |
|---|---|---|
| `orders`의 청구 · 수납 · 미수 · 과수납 · 보증금 · 다른 팀 결제 예정 · 이 팀이 대신 낼 금액 · `pay_state_key` | 줄 순액 + 조정(옛 청구 포함) / 배분 × 부호 / 보증금 행 / 열린 결제 약속(내가 받을 쪽 · 내가 낼 쪽) | 그 접수의 줄 · 조정 · 배분 · 결제 약속을 건드린 모든 명령(대신 내는 팀 접수도) |
| `orders.status_key` · `is_open` · 이용 기간 · `next_due_at` | 줄 진행, 살아 있는 약속, 열린 교환 | 같음 |
| `order_lines.qty_*` · `progress_key` · `current_end_*` | 이동 줄(되돌린 줄 제외), 살아 있는 claim, 강습 예약, 취소 줄, 연장 줄 | 그 줄의 이동 · claim · 강습 · 취소 · 연장 |
| `assets.location_id` · `condition_id` · `last_movement_id` · `catalog_item_id` · `variant_id` | 되돌리지 않고 `late_fact`가 아닌 마지막 이동 줄(`created_rev` 순), 상태 변경, 품목 바꾸기 | 그 장비의 이동 · 상태 변경 · 품목 바꾸기 |
| `stock_balances.quantity` | 수량 이동 줄의 합(위치 · 규격 · 상태 · 주인 · 묶음별) | 수량 이동 |
| `tasks.status_key`, `task_items.done_quantity` · `elsewhere_quantity` | 업무에 연결된 이동, claim, 방문 | 그 업무의 이동 · 방문 |
| `deposits`, `vendor_refunds`, `equipment_loans`(수량 돌아옴 포함), `early_returns`, `intake_requests`의 상태 | 자식 행 | 그 자식 행을 쓸 때 |
| `cash_movements` | 수납(현금 수단), 현금 입출금, 넘김(지갑 → 넘기는 중), 넘김 확인(넘기는 중 → 돈통, 차액 → 과부족), 거래처 정산 | 그 장부 행을 쓸 때 |

투영은 건드린 묶음마다 장부 전체에서 다시 계산한다(다섯 시즌 규모에서 접수 잔액 하나 0.005 ms). 차이만 더하지 않으므로 틀린 값이 쌓이지 않는다.

**줄이 끝나는 조건**(행동 계열과 반납 정책):
- 보관 책임이 있는 계열(rental · ticket · sale): 반납 정책이 `required`면 지급 + 반납 + 미반납 + 취소 = 수량일 때, `optional` · `none`이면 지급 + 취소 = 수량일 때. `optional` 권을 나중에 회수하면 그 기록은 남고 반납 도장이 찍힌다.
- `service`: 예약이 모두 끝 · 취소 · 불참일 때. `fee`: 만들 때. `bundle`: 자식 줄이 모두 끝날 때. `placeholder`(인원만 예약): 끝나지 않음 — 당일 품목으로 바꾸거나 취소해야 한다.

**수납 상태(`pay_state_key`)**: `paid`는 미수 0이고 **이 팀이 대신 내기로 한 금액도 0**일 때만이다. 다른 팀이 내기로 한 금액만 남았으면 `promised`(도장은 '예정', 끝이 아님), 이 팀이 대신 낼 금액이 남았으면 수납 창과 접수증에 '김OO 팀 몫 120,000원도 받을 것'이 보이고 끝이 아니다. 어느 쪽 접수든 닫히거나 그날이 끝날 때 열린 약속은 마감 인계(`promise_open`)에 오른다.

**접수 상태**는 옛 순서를 지키고 두 가지를 더했다: `cancelled`(살아 있는 줄 없음) → `awaiting_exchange` → `needs_review`(위치 모름) → `partial_return` → `in_use` → `awaiting_shop`(차량에 있음) → **`awaiting_load`**(차량 배달 약속이 있는데 아직 적재 전, N1) → `awaiting_issue` → **`booked`**(강습 · 인원만 남음) → `returned` 또는 **`completed`**(보관 책임 줄이 없는 접수). 강습 줄은 예약이 닫히면 끝나므로 접수를 영원히 열어 두지 않는다. 미수는 접수를 열어 두지 않는다(수납 상태와 마감 인계에서 보인다).

## 7. 레지스트리와 확장 규칙

### 7-1. 확장 방법

| # | 방법 | 쓰는 곳 | 바뀌는 것 |
|---|---|---|---|
| E1 | 매장 레지스트리 행 | 새 품목 종류, 상품, 가격 묶음, 규격, 스키장, 구역, 장소와 쓰임, 반납 타임, 수령 시각, 차량, 거래처, 결제 수단, 돈통, 지점 · 마감 범위 · 달력, 역할, 할인과 대상, 요금표, 사유, 정비 상태, 도장 단계, 장부 칸 · 탭 · 동작, 메뉴, 상태 문구 · 번역, 인쇄 · 문자 틀 | INSERT만 |
| E2 | `sys_*` 행 + 코드(번호 붙은 마이그레이션) | 새 행동 계열: 이동 종류와 경로, 행동 계열, 반납 정책, claim 차선 · 종류, 돈 종류 · 목적, 거래 종류, 세금 분류, 장소 쓰임, 권한, 기능, 설정, 도장 규칙 · 상태 · 모음, 바깥 채널, 인쇄 모양, 화면 · 틀 · 칸 그리기 · 탭 필터 · 동작 · 확인 창 · 조건 · 색 · 입력 방식, 명령 종류, 확인 필요 종류 | INSERT + 앱 배포 |
| E3 | 속성(정의 + 값 + 자리) | 매장이 정하는 칸: 객실, 부츠 mm, 수준, 스탠스, 브랜드, 길이, 대문 비밀번호, 보호대 여러 개 | INSERT만, 코드 변경 없음. 여러 값은 `value_seq`, 새 값 형식(`multi_option` 등)은 E2 |
| E4 | 빈 값을 허용하는 열(`ALTER TABLE … ADD COLUMN`) | 코드가 판단하거나 자주 거르는 칸(숙소 장소, 새 능력 값, 차량 정산 묶음 번호) | 추가 마이그레이션. 참조 열이면 `sys_soft_references` 행을 같은 마이그레이션에 넣음(검증기가 확인). 참조는 E5가 먼저. **장부 표에 더한 열**은 같은 마이그레이션이 지난 행을 나눠 채우고(0001의 수정 금지 트리거는 0001 열만 막으므로 된다) 그 열의 '한 번만' 트리거(`WHEN OLD.x IS NOT NULL`)를 단다. 새 행부터 꼭 있어야 하면 '이 판부터 필수' BEFORE INSERT 트리거(7-2). 세금은 이 방법이 아니라 줄 · 세금 문서(3-2) |
| E5 | 새 자식 · 연결 · 확장 표(복합 FK) | 기존 행에 새 관계(강사 일정, 고객 ↔ 후불 거래처, 1:1 확장 표로 새 참조) | CREATE TABLE. **이동 · claim · 업무 · 조정 · 거래처 거래 · 재고 위치에 새 출처(수리, 보관, 강습 픽업, 보관함)를 더할 때는 반드시 이 방법**(1:1 확장 표 + 복합 FK)이다. 이 표들에 참조 열을 더하지 않는다. 옛 열과 새 표를 합친 '주인 하나' 규칙은 검증기가 본다 |
| E6 | 판 번호가 붙은 설정(`shop_settings`, 값 스키마로 검증) | 매장 · 지점 정책(선입금 방식, 끝전, 할인 겹치기, 결제 시점, 마감 확인) | 새 판 INSERT |
| E7 | 기능 켜기(`shop_features` + `plan_features`) | 기능 전체를 매장 · 지점마다 켜고 끔 | 한 행 UPDATE |
| E8 | 화면 설정 행 | 도장 단계, 종류별 도장, 장부 칸 · 탭 · 바닥줄 · 동작, 메뉴, 상태 문구, 인쇄 틀 | INSERT · UPDATE. 앱이 새 기본 설정을 가져오면 실행기의 `ui_defaults.apply(rev)`가 없는 시스템 행을 넣고 매장이 안 바꾼 행만 고친다(ui 문서 2절). 설정 명령은 모든 대상 크기에서 칸 맞춤을 다시 계산해 넘치면 거절 |
| E9 | 새 인덱스 | 새 검색, 유일성 규칙 바꾸기(옛 인덱스 지우고 새로) | CREATE INDEX · DROP INDEX |
| E10 | 속성을 열로 올리기 | 매장 칸이 핵심이 될 때 | 열 추가 → 채우기(나눠서; 장부 표도 E4처럼 됨) → 둘 다 읽기 → 속성 쓰기 중단 → 필요하면 '이 판부터 필수' 트리거. 정의는 `promoted_to`와 함께 남음 |
| E11 | JSON 문서의 새 판 | 인쇄 틀, 설정 값, 보고서 모양, 명령 본문 | `json_schemas` 새 판 + 읽는 코드(upcaster). **장부 행의 JSON은 다시 쓰지 않는다** |
| E12 | 새 모양이 필요한 표: `*_v2` 새 표 + 뷰 | 키 · 제약을 바꿔야 할 때(예상 횟수 0) | 새 이름의 표를 만들고 옛 표를 읽기 전용 뷰로 합쳐 보여 준다. 이미 있는 이름을 DROP · CREATE하지 않는다 |

### 7-2. 마이그레이션 규칙(CI가 검사)

- **허용:** CREATE TABLE · INDEX · VIEW, `ADD COLUMN`(빈 값 허용 또는 상수 기본값), `sys_*`와 시드 표 INSERT, `sys_event_types.engine_key` UPDATE(묶음을 native로 옮길 때), 나눠서 하는 UPDATE 채우기(장부 표의 새 열 포함), DROP INDEX · VIEW, 그리고 **정해진 모양의 트리거 네 가지**: ① 새 장부 표의 추가 전용 트리거(0001처럼 `BEFORE UPDATE OF <그 표의 열>` + 삭제 금지), ② 장부 표에 더한 열의 '한 번만' 트리거(`BEFORE UPDATE OF 새 열 WHEN OLD.새 열 IS NOT NULL`), ③ '이 판부터 필수' 트리거(`BEFORE INSERT WHEN NEW.새 열 IS NULL`)와 새 값 칸을 '하나만' 규칙에 잇는 BEFORE INSERT 트리거, ④ 자유 글 새 열의 가리기만 트리거. 모두 생성 스크립트가 만들고 CI가 모양을 확인한다.
- **금지:** 값이 들어갈 수 있는 표의 DROP TABLE · DROP COLUMN · RENAME, 이미 있는 이름의 표를 DROP 후 CREATE, `ADD COLUMN`에 `CHECK` · `REFERENCES` · 기본값 없는 `NOT NULL`(대신 위 트리거와 검증기), 새 표의 표 안 `UNIQUE`(인덱스로), `CHECK (x IN ('…'))` 목록, `sys_*` 행의 key 변경 · 삭제(`INSERT … ON CONFLICT DO UPDATE`로 바꾸는 것 포함, `DO NOTHING`도 금지), `json_schemas`의 있는 판 고쳐 쓰기, 0001이 보호하는 장부 열의 UPDATE(조건이 붙은 '한 번만' · '가리기만' 열 포함: 빈 시험 DB에서는 통과해도 값이 든 매장 파일에서 멈춤), 표를 새로 만들어 옮기는 12단계 재구성, 장부 트리거의 DROP. 이미 있는 장부 표에 더한 열은 같은 마이그레이션에 ②(자유 글이면 ④) 트리거가 없으면 lint가 막는다(E4). 앱 코드에서 장부 표에 `INSERT OR REPLACE` · `REPLACE INTO` · `INSERT OR IGNORE`(CI 검사; `ON CONFLICT DO NOTHING` 뒤에는 지문을 꼭 비교).
- **새 표 규칙:** 매장 표는 `shop_id`로 시작하는 키와 복합 FK, 장부 표는 네 시간 · 행위자 · 요청번호 · 마감 범위 열과 추가 전용 트리거를 같은 마이그레이션에 둔다. 코드가 뜻을 아는 키 열은 sys 어휘 FK.
- **예약 표 예외는 없다.** 매장 PC마다 자기 파일만 마이그레이션하므로 '모든 파일이 비어 있으면 다시 만든다'는 확인할 수 없고, 강습 · 보증금 · 지점 · 카드 단말 표는 이미 값이 드는 표의 FK 대상이다. 그래서 이번 검토에서 그 표들의 키를 정했다(강습팀 없는 예약, 자정 넘는 시간, 지점과 마감 범위, 단말 없는 결제, 전화 아닌 알림, 수량 품목의 교환 · 조기 반납 · 빌림). 나중에 모양이 바뀌면 E12(`*_v2` + 뷰)다.
- **투영 표**(`stock_balances`, `cash_movements`)는 장부에서 언제든 다시 만들 수 있지만 이름을 지우지 않는다. 새 키가 필요하면 `*_v2` 투영을 만들어 장부에서 채우고 읽는 코드를 옮긴 뒤 옛 표는 채우지 않는다(E12).

### 7-3. 실행기

- 시작할 때 데이터베이스에 이 앱이 모르는 마이그레이션이 있으면(앱을 옛 판으로 되돌림) **읽기 전용으로 시작**하고 "앱을 업데이트해 주세요"를 보인다. 모든 요청이 500이 되는 옛 동작을 없앤다.
- 연결마다 `busy_timeout = 5000`을 맨 먼저 켜고(다른 프로세스가 같은 파일을 쓰는 중이면 곧바로 실패하지 않고 기다림), `foreign_keys = ON`, `recursive_triggers = ON`을 켜고 다시 읽어 확인한다. 하나라도 꺼져 있으면 서버 · 가져오기 · 검증기 · 복구 시험 모두 시작하지 않는다. 연결은 `openDatabase()`로만 연다(lint `--code`가 `node:sqlite`를 가져오는 곳을 모두 찾는다).
- 남은 마이그레이션을 **적용하기 전에 모두 훑는다**: 문장을 읽을 수 없거나 트랜잭션 · PRAGMA 문장이 하나라도 있으면 아무것도 적용하지 않고 거절한다(중간 판까지 올라간 파일이 생기지 않게).
- 적용 전 `pre_migration` 백업(`VACUUM INTO`, 이름은 빈 파일을 원자적으로 잡아 두 실행기가 겹치지 않음) → 마이그레이션마다 `BEGIN IMMEDIATE` → 그사이 다른 실행기가 그 판을 적용했으면 건너뜀 → 적용 → `PRAGMA foreign_key_check` · `quick_check` → `schema_migrations`에 checksum과 함께 기록 → 커밋 → **적용 직후 전체 백업 한 번 더**(뒤의 작업 기록 구간이 늘 같은 스키마 · 앱 판의 백업에 이어지게). 적용 뒤 백업이 실패해도 적용은 커밋된 채로 두고 알린다(`backupError`). 다음 시작에서 그 판의 `post_migration` 백업이 없으면 먼저 받는다.
- 실패하면 그 마이그레이션을 되돌리고 멈춘다. 앞에서 커밋한 판은 남고, 파일은 **읽기 전용으로** 연다(앱 N은 스키마 N을 기대하므로 옛 스키마에 쓰지 않는다; 고친 앱으로 다시 시작하면 남은 판부터 이어 적용). 2026-09-23 검토: 전에는 '옛 스키마로 계속'이라 적었으나 실행기는 처음부터 읽기 전용이었고, 옛 스키마에 새 앱이 쓰는 위험이 더 커서 문서를 실행기에 맞췄다(사람이 다시 정할 수 있는 결정).
- 스키마 마이그레이션 뒤 `ui_defaults.apply(rev)`: 앱과 함께 온 화면 기본 설정 판을 적용한다(ui 문서 2절). 결과는 `ui_default_applications`.
- 시즌 보관 파일도 자기 `schema_migrations`를 가진다. 보관 파일을 붙일 때 빠진 마이그레이션을 먼저 적용하고, 보관 파일은 열 이름을 적은 쿼리 · 뷰로만 읽는다.
- 한 번 배포한 마이그레이션 파일은 고치지 않는다(checksum이 다르면 시작 거부).
- 변경이 추가뿐이라 서버 N−1 판이 스키마 N에서 돈다. 앱을 되돌려도 자료 복구가 필요 없다.
- 새 파일에는 첫 표를 만들기 전에 `auto_vacuum = INCREMENTAL`을 켠다.
- 정말 급한 경우(STRICT 형식이 틀렸는데 값이 이미 있음)에도 재구성하지 않고 E12(`*_v2` + 뷰)로 간다. 기대하는 횟수는 0이다.

## 8. 시나리오 S1–S15

**S1 강습팀 강습.** 행만 추가: `shop_features('lessons')` 켜기, `item_kinds('lesson')`(계열 `service`, 재고 `none`, 반납 `none`, 기준 `per_person_session`, 결제 칸 `lesson`, `requires_time_slot = 1`, `requires_headcount = 1`, 정산 역할 `lesson_team`), 상품(스키 강습 2시간), `service_slots`(오전 · 오후), 강습팀 거래처(역할 `lesson_team`, 필요하면 `is_internal`인 '우리 강사'), `counterparty_rates`(`lesson_consignment`, 1인당), 속성 `discipline`(ski · board). 접수하면 줄(수량 = 인원)과 `service_bookings`(팀, 종목, 인원, 날짜, 시간, 상태 reserved; 강습팀을 아직 못 정했으면 팀 없이 `unassigned`, 자정을 넘는 야간 강습은 `end_day_offset = 1`). `lesson.close`가 done · no_show · cancelled로 닫으면 `qty_service_closed`가 수량에 닿고 완료 규칙 `service_closed`로 줄이 끝나 접수가 닫힌다. 정산: 예약이 닫힐 때(설정 `lesson_settlement_timing`) `counterparty_trades(lesson_consignment, service_booking_id, source_key 'booking:<id>:1')` — 같은 근거로는 한 번만 생긴다. 닫은 뒤 결과 · 인원을 고치면 `lesson.correct`가 그 거래를 취소 기록하고 `booking:<id>:2`로 다시 낸다. 강습팀에 준 돈은 `counterparty_settlements`이고, 돈통 현금이면 **그 정산의 `cash_drawer_id`만** `cash_movements`를 만든다(현금 입출금을 따로 적지 않음). 화면은 `lesson_done` 도장, 강습 탭, 메뉴 이름 '리프트권·강습', 확인 창 강습 줄. 우리 강사 일정 겹침 검사는 나중에 연결 표(E5). DDL 변경 없음.

**S2 새 물리 품목과 규격.** 고글(수량): `item_kinds('goggles', tracking count)`, 상품 하나, 규격 성인 · 어린이, 재고는 `stock_balances`, 이동 줄은 규격과 수량 3. 보호대: 선택 속성 `protector_size`(S · M · L)를 규격 축으로. 어린이 스키: 장비 종류의 상품, 규격 축 `ski_length_cm`, 장비마다 `assets` 행, 요금은 `customer_class = child`. 프리미엄 보드: 상품 + 자기 요금 규칙. 구성품 부츠: 상품 '스키 부츠'(세트로만 팔면 `hidden_in_picker`)와 `catalog_item_components`(스키 세트 = 스키 1 tracked + 부츠 1 tracked + 폴 1 implied). 접수에는 값이 있는 세트 줄(`bundle`)과 0원 자식 줄이 생겨 부츠만 따로 교환 · 반납된다. 종류별 사이즈 칸은 `item_kind_attributes`, 질문 틀, 인쇄 칸. 수량 품목도 교환(`exchange_units`의 규격 · 수량: 고글 M → L 2개), 조기 반납(6개 중 2개), 거래처에서 빌림(20개, 여러 번에 나눠 돌려줌), 준비(수량 잡기)가 된다. 여섯 대의 보드를 새 '프리미엄 보드' 상품으로 올리거나, 어른 스키로 잘못 넣은 어린이 스키를 고치거나, 같은 상품 둘을 합칠 때는 `asset_reclassifications` 한 행씩과 `assets.catalog_item_id` 투영 — 지난 이동 줄은 그때 상품을 스냅샷으로 가지고 있어 건드리지 않는다. 보호대(무릎 + 손목)처럼 값이 여러 개인 칸은 `multi_valued` 속성. DDL 변경 없음.

**S3 요금 확장.** 세트 · 가족 묶음은 세트 상품의 자기 요금 규칙 또는 `package` 할인. 주말 · 성수기 · 시즌은 `day_type_id` · `season_id`가 있는 `price_rules`(날짜마다 `calendar_days`로 분류). 어린이 · 성인은 `customer_class_id`. '어린이 스키는 주말 15,000원'은 **품목 종류나 가격 묶음을 대상으로 한 규칙 하나**(SKU마다 복사하지 않음; 새 SKU도 바로 적용). 여러 날 합계는 `price_rule_tiers`. 요금표는 판(게시하면 고정). 할인: 개당 하루 · 비율 · 금액 · 리프트권 비율은 `discount_rules`, '스키 + 리프트권 10%'처럼 묶음을 넘는 할인은 `package` 할인 묶음과 `discount_rule_targets`. 쓸 때마다 `discount_applications` + 줄별 `line_price_components`(출처 규칙, 이름 · 값 스냅샷, 끝전, 나눈 금액). catalog 문서 6~9절. DDL 변경 없음.

**S4 장소.** `resorts` → `areas` → `places`(솔마을 → 한솔동 · 두솔동 · 세솔동 · 네솔동, 꽃마을 → 들국화 · 백합 · 민들레 · 개나리 · 해바라기 · 코스모스), 쓰임은 `place_uses`(수령 · 반납 · 숙소 · 만남, 나중에 주차장 · 보관함 · 정류장은 sys 행 하나), 순서, 켜기. 두 스키장을 도는 가게는 두 번째 스키장 템플릿을 적용하면 구역이 스키장별로 묶인다. 직접 입력한 장소는 `place_id = NULL` + `place_name`. 약속 · 업무 · 방문 · 강습은 `place_id`와 구역 · 장소 이름 스냅샷을 함께 가지므로 이름을 바꾸면 한 행만 바뀌고 역사는 그대로다(`config_changes`에 기록). 스키장 템플릿 적용은 없는 구역 · 장소 · 반납 타임 · 권종만 넣고 `template_applications`에 기록. 새 스키장은 control의 `resort_templates` 행과 판. DDL 변경 없음.

**S5 카운터 2대, 차량 3대, 휴대폰 기사가 동시에.** 매장 전체 버전이 없다. 부딪힘은 같은 결정을 두 사람이 바꿀 때, 또는 **결정의 바탕이 된 돈 · 수량이 그사이 바뀌었을 때**만 생긴다. 카운터 1의 수납과 카운터 2의 반납 약속 변경은 서로 다른 행이라 둘 다 된다. 같은 줄의 반납 약속을 둘이 바꾸면 두 번째만 충돌하고 누가 무엇으로 바꿨는지 보인다. 카운터 2가 '받은 돈 0 · 환불 없음'을 보고 취소를 누르는 사이 카운터 1이 그 팀 돈을 받았으면 취소는 이어 붙지 않고 '그사이 이 팀이 120,000원을 냈습니다'가 뜬다(읽은 키 `order:<id>:money`). 두 카운터가 한 팀을 동시에 카드로 받으려 하면 두 번째는 '카운터 1에서 카드 결제 중'을 본다(`order_checkout_locks`). 빨리 확인과 기사의 ▼는 서로 다른 행(`task_pins`, `route_positions`)이라 둘 다 된다. 같은 장비를 두 기사가 잡는 계획은 부분 유일 인덱스가 두 번째를 거절하지만, 실제로 옮긴 사실은 늘 기록되고 그 계획이 풀린다. 쓰기는 파일마다 하나씩 처리되고 한 건에 약 0.6 ms다. 두 번째 가게(지점)는 자기 마감 범위로 따로 닫는다. sync 문서 4 · 8절.

**S6 밤 두 시간 오프라인 차량.** 기사 기기는 허용된 명령만 큐에 쌓고(받음, 차량에서 전달, 방문 결과, 현장 수납, 권 추가, 순서 바꾸기, 알림 확인), 각 명령에 그때 로그인한 기사를 기기 키로 서명해 둔다. 기기는 같은 도메인 코드를 자기 범위 자료 위에서 돌려 목록 · 도장 · '받음 4 · 대기 8 · 남음 3'을 그린다(앱을 껐다 켜도). 다시 연결되면 기기 번호 순서로 보낸다(순서는 강제가 아니라 빈 번호만 찾음). 명령마다 따로 적용되고 요청번호로 한 번만 들어간다. 이미 매장에서 받은 장비는 `superseded`, 남은 수보다 많이 받은 경우는 맞는 만큼만 적용하고 나머지는 `확인 필요`, 그사이 카운터가 다른 차량으로 옮긴 업무라도 **일이 일어난 시각에 이 차량 업무였으면** 적용하고 옮겨 간 업무를 취소한다. 돈은 절대 멈추지 않고 기록하며 마감된 날이면 기준선의 `posting_date`를 받는다. 차량 기록이 아직 오지 않았으면 마감이 먼저 알려 준다. sync 문서 8절에 21:40~23:40 예시가 있다.

**S7 여섯 가족 한 번에, 한 팀 나눠서.** 카드 한 번 480,000원: `payment_groups(multi_order)`, `payments` 한 행(승인번호 하나), 접수 · 줄마다 `payment_allocations`. 여섯 팀 미수가 모두 정확히 0이 되고 카드 전표와 기록이 한 건으로 맞는다. 내기 전에는 각 팀에 `payment_promises(by_other_order, payer_order_id)`가 있어 빨간 미수 대신 '김OO 팀 결제 예정'(파란 '예정' 도장)이 보이고, **내기로 한 김OO 팀 쪽에는 '다른 팀 몫 400,000원도 받을 것'**(`collect_for_others_amount`)이 보여 그 팀이 자기 몫만 내고 가지 않는다. 한 팀 나눠서(S08R): `payment_groups(split_by_items)`, 회차마다 수납 하나와 고른 줄의 배분(`allocated_quantity`, 금액과 같은 부호). 그 전에 접수 전체로 받은 선입금은 먼저 줄로 옮겨 나눈다(명확한 '어느 품목이 낸 것인가'). 똑같이 나누기는 비율 배분. 한 가족 몫 환불: `refund` 수납(`refund_of_payment_id`)을 그 접수에만 배분.

**S8 선입금 방식과 당일 취소.** `shop_settings.prepayment_mode`: 이 매장 `{"mode":"full_lift_ticket"}`, 다른 매장 `{"mode":"fixed_amount","amount":50000}` 또는 `{"mode":"none"}`. 전화 예약은 결제 약속을 만든다(리프트권 칸 `prepayment` · `at_intake` · 권 합계, 장비 칸 `at_issue`). 받은 돈은 `payments.purpose_key = 'prepayment'`로 권 줄에 배분 → 카드에 '예약금 N 수납 · 잔액 M'. 당일 취소: `order_cancellations`(환불 결정 기본값은 `same_day_cancel_refund_default`), 취소 줄, 음수 `cancellation` 조정. 환불하면 선입금에 연결된 `refund` 수납으로 미수 · 과수납이 0. 환불하지 않으면 양수 `cancellation_fee` 조정이 받은 돈을 청구로 남긴다. 사 둔 권은 장비로 남고 claim은 `cancelled`로 끝나며, 다음 손님 재사용이나 발권처 환불은 따로 한다.

**S9 기사 현장 수납과 차량 예비권 추가.** 기사 역할에 `payment.collect_field`(범위 own_vehicle), 수단은 `driver_allowed`인 것만. 현장 수납은 `collected_by_vehicle_id`, `cash_drawer_id` = 그 차량 지갑, 업무의 접수에 배분, 행위자는 기기가 서명한 그 기사. '미수로 두기'는 `payment_promises(later)`. 권 추가는 명령 하나 `field.add_ticket`(자기 업무만, `ticketed` 종류, 그 차량 위치의 장비): 차수(`source_key driver_field`, '배달 중 추가', 자기 `posting_date`), 권 줄(가격은 그때 효력 있던 요금표 판의 기기 견적, `price_source_key 'offline_quote'`), 시간대 claim, 차량 → 손님 `deliver` 이동, 선택한 수납을 한 트랜잭션에. 권을 줄 수 없으면 줄 · 이동은 확인 필요, 수납은 접수 전체 배분으로 그대로 기록. 저녁에 `cash_transfers`(차량 지갑 → 넘기는 중)와 카운터가 세어 확인(넘기는 중 → 카운터 돈통, 차액 → 과부족), 마감은 돈통 · 지갑마다 rev 창으로 센다.

**S10 여러 매장 SaaS.** control에 계정(로그인 영역), 사업자, 매장 목록과 epoch, 요금제 · 기능, 서명된 라이선스, 스키장 템플릿(고정 id), 플랫폼 사용 내역(파일마다 사슬), 사용량, 백업, 매장을 알기 전의 길 찾기와 콜백 받은편지함. 매장 파일에 직원 · 역할 · 권한(범위와 한도), 기기, 사용 기능, 매장 사용 내역(`events` + `config_changes`). 매장은 명시적인 개설 명령으로만 생긴다(옛 `W.fresh`처럼 첫 기록에 저절로 생기지 않음). 기능은 요금제가 허용하고 매장이 켜야 보인다. 배치: (a) 매장 PC마다 SQLite 두 파일(지금), (b) 매장별 SQLite 파일 + 중앙 control, (c) PostgreSQL(매장별 스키마 또는 공유 표 + 행 보안; control과 매장 표는 다른 스키마). (a) → (b)로 옮길 때 로그인 이름 · 사슬 번호 · 템플릿 id · 계정 id를 다시 매기지 않는다(2-1). 관리자 콘솔은 체험판에 넣지 않는다.

**S11 카드 단말과 문자.** 카드: 명령 트랜잭션에서 `payment_intents`(요청에서 정해진 id) + `payment_intent_allocations` + `order_checkout_locks` + `outbox(card_terminal)`. 카드 요청은 intent(충돌 키 `order:<id>:checkout`)이고, 열린 요청이 있는 팀은 다른 카운터가 카드 · 현금을 받지 못한다. 승인은 `payment.intent_outcome` 시스템 명령(요청번호 `outbox:<id>:<attempt>:approved`)으로 `payments` 한 행. 같은 요청에 같은 승인번호가 두 번 오면 한 건, 다른 승인번호가 또 오면 기록하고 '카드가 한 번 더 승인됐습니다 — 단말기에서 하나를 취소해 주세요'. 거절은 요청 상태만. 시간 초과는 `unknown` → **결제 창 안에서 막는 단계**('단말기 화면에 승인됐나요? [승인번호 넣기] [안 됨]'), 사람이 넣으면 `payment.intent_resolve`가 그 요청에 묶어 기록하므로 늦게 온 단말 결과가 두 번째 수납을 만들지 않는다. 자동 재시도 없음. 카드 단말 도우미는 자기 승인 기록을 가지고 epoch가 바뀌면 다시 알리며, 날마다 VAN 정산 파일과 맞춘다. 온라인 결제(PG)는 단말 없이 `provider_key`. 카드 환불은 `refund` 종류의 요청. 문자: `message_deliveries`(업무 기록, 받는 곳 종류 · 값) + `outbox(sms)`(전달), 자동 재시도 없음, 시간이 중요한 문자는 `not_after`가 지나면 `expired`. 업체 콜백은 control `external_refs` · `inbound_events`로 매장을 찾아 매장 서버가 가져간다. `shops.is_test`면 모두 모의 대상으로.

**S12 ski-rent-ops 자료 이관.** 모든 옛 모음이 표로 옮겨지는 표는 migration 문서 5절. 옛 id는 매장 코드 접두어를 붙여 들어온다. 옛 총액만 있는 청구는 `legacy_charge` 조정 한 행, 대상이 없는 옛 환불은 `legacy_refund` 종류, 종류가 확실하지 않은 `legacy-` 권은 나중에 `asset_reclassifications`로 확정한다. 모든 원본 요소는 `legacy_records` 행을 가지고 열이 없는 필드는 `residue_json`에 남아 아무것도 버리지 않는다. 옛 작업 기록 원본은 `legacy_events`, 작업 기록에는 가린 요약(`legacy.imported`). 대조(접수별 금액 · 줄별 수량 · 차량 재고 · 날짜별 마감)가 0 차이여야 성공.

**S13 다섯 시즌.** 10절 측정: 접수 30,000건, 작업 기록 약 130만 줄에서 화면 조회는 모두 0.3 ms 아래, 전체 접수 쓰기 0.58–0.64 ms. 이번 시즌과 지난 시즌만 작업 기록을 두고, 시즌 끝에 `archive/<shop>/<season>.sqlite`로 `events` · `change_log` · `command_log` · `outbox_attempts`를 옮긴다(복사 → 개수 · checksum · 사슬 앞뒤 해시 확인 → `archive_manifests` + `archive_verifications` → 한 번에 2,000줄씩 영업 시간 밖에 지움 → `incremental_vacuum`). 보관 파일은 그때 스키마 판과 자기 `schema_migrations`를 가지고, 나중에 붙일 때 빠진 마이그레이션을 먼저 적용한다. 업무 표는 옮기지 않는다. 백업: 1시간마다 `VACUUM INTO`(48개 순환), 커밋마다 몇 초 안에 LAN의 다른 기기로 흘려 보내는 작업 기록 구간(+ 5분마다 두 번째 디스크 · USB), 밤마다 암호화 원격 복사, 매주 자동 복구 시험. sync 문서 10절.

**S14 접수에 새 칸, 장부에 새 열, 새 도장 단계.** 객실 번호: `attribute_definitions(entity 'order', key 'room_no', type text, input_widget text, short_label '객실')` + 자리 `slip`(접수증) · `task_sheet`(기사 업무 판), 값은 `order_attribute_values`. 표 모양 화면(대여 장부, 수거 목록, 기사 목록 줄)에는 `ledger_view_columns` 행(그리기 `attribute`, em 폭, 빠지는 순서) — 설정 명령이 모든 대상 크기에서 맞춤을 다시 계산해 넘치면 거절하고, 인쇄 수거 목록은 같은 화면 설정(인쇄 등급)을 쓰므로 따라온다. 코드 변경이 없다. 나중에 모든 화면에서 거르게 되면 E10으로 `ALTER TABLE orders ADD COLUMN lodging_room_no TEXT` → 채우기 → 읽기 전환(스모크 시험에서 값이 든 표에 성공). 돈 장부에 새 열이 필요하면(예: 차량 정산 묶음 번호) `ALTER TABLE payments ADD COLUMN van_batch_no TEXT` → 지난 행 채우기(0001 트리거가 막지 않음) → '한 번만' 트리거(스모크 시험에서 성공). 부가세는 이 방법이 아니다: 줄의 세금 스냅샷과 `tax_documents`(3-2). 새 도장 단계(배달 줄의 적재)는 기존 규칙(`qty_loaded`)과 동작(`stamp.load`)을 쓰는 `stamp_steps` 행 + `item_kind_stamp_steps`(조건 `vehicle_pickup`) + 지급 칸의 단계 사슬(`ledger_view_column_steps`: 적재 → 지급). 새 계산 규칙이 필요할 때만 코드와 `sys_stamp_rules` 행.

**S15 인쇄.** `print_templates`와 판(A4 한 장 20명 준비표, 80×50 팀 스티커, A4 수거 목록, 대여 접수증). 틀은 화면과 **같은 설정**(`source_view_id`의 인쇄 등급 장부 칸, 입력폼 · 문서 자리)을 인쇄 크기(A4 약 794px, 80 mm 영수증, 80×50 스티커)로 풀어 쓰고, 작업을 만들 때 풀어 쓴 설정이 지금 판과 다르면 새 판을 먼저 쓴다. 문서는 매장 서버가 한 번 그리고 도우미나 브라우저는 내보내기만 한다. `print_jobs`에 얼린 문서, 기준 rev, 근거 행과 판(`print_job_sources`), 시도. `print` 채널의 outbox로 인쇄 도우미나 브라우저에 보내고, 도우미는 인쇄 작업 id로 중복을 걸러 응답을 잃어도 두 번 찍지 않는다. 다시 인쇄는 문서를 복사한다. 문서 해시로 '출력 뒤 바뀜'을 알 수 있다. 인쇄 창을 여는 것만으로 무엇도 처리됨으로 바뀌지 않는다.

## 9. PostgreSQL로 옮기기

| 이 DDL(SQLite) | PostgreSQL |
|---|---|
| `STRICT` | 지움 |
| 두 파일(control · 매장) | 서로 다른 스키마(`control`, `shop` 또는 매장마다 스키마). 같은 이름의 메타 표가 부딪히지 않음 |
| 열 순서대로의 FK(앞 · 순환 참조: 직원 → 차량, 영업일 ↔ 마감, 수납 ↔ 카드 요청) | 모든 `CREATE TABLE` 뒤에 `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`로 따로 만든다 |
| TEXT id · key · `rank_key` | TEXT `COLLATE "C"`(SQLite의 BINARY 비교와 같은 순서. 언어 정렬이면 `a0v`와 `a0V`의 순서가 바뀌어 방문 순서가 조용히 바뀜) |
| TEXT 시각 · 날짜 · 시간 | **이전에서도 TEXT 그대로**, 모양을 검사하는 도메인(`utc_instant`, `local_date`, `local_time`, `COLLATE "C"`)으로. 나중에 `ALTER COLUMN TYPE`(장부 표 전체를 다시 씀)을 하지 않는다. 날짜 계산은 원래 앱에서 한다 |
| `INTEGER` | `bigint`, 0/1은 `boolean` 또는 `smallint` |
| `REAL` | `double precision` |
| `GENERATED ALWAYS AS (…) VIRTUAL` | `GENERATED ALWAYS AS (…) STORED`(PG 18은 VIRTUAL), `substr(x, -4)` → `right(x, 4)` |
| `(a IS NOT NULL) + (b IS NOT NULL) <= 1` | `num_nonnulls(a, b, …) <= 1` |
| `a || '|' || b` | 같음 |
| 부분 인덱스, 복합 FK, `ON CONFLICT DO NOTHING` | 같음. 나중 참조 열은 `ALTER TABLE … ADD CONSTRAINT`로 진짜 FK를 더할 수 있다 |
| 추가 전용 트리거(`RAISE(ABORT)`, `BEFORE UPDATE OF <열>`) | plpgsql 함수 하나를 같은 열 목록의 `BEFORE UPDATE OF … OR DELETE`에 걸고, 앱 역할에서 장부 표의 `UPDATE, DELETE`를 거둠(`REVOKE`). 가리기만 · 한 번만 · 이 판부터 필수 트리거도 같은 함수 모양 |
| `recursive_triggers = ON`(REPLACE 삭제도 막음) | PostgreSQL에는 REPLACE가 없고 `ON CONFLICT DO UPDATE`는 UPDATE 트리거를 거침 |
| 매장마다 epoch(`shop_instance`) | 같음. 한 매장만 복구할 때는 공유 표에서 그 매장 행을 지우지 않고(장부가 막음) **새 스키마에 작업 기록 구간의 after-image를 다시 적용**해 만든 뒤 바꿔 끼움(논리 재구성) |
| `events` 보관 확인 트리거, 요금 고정 트리거 | plpgsql 트리거 함수 |
| 매장 파일마다 `BEGIN IMMEDIATE` | 쓰기 트랜잭션 처음에 `SELECT value FROM shop_counters WHERE shop_id = $1 AND counter_key = 'rev' FOR UPDATE`(매장별로만 줄 세움) |
| 권 배정 시간대 겹침(명령 계층) | `EXCLUDE USING gist (shop_id WITH =, asset_id WITH =, tstzrange(window_start, window_end) WITH &&) WHERE (ended_at IS NULL AND lane_key = 'ticket_window')`(`btree_gist`) |
| JSON 글자 열 | `jsonb` |
| `PRAGMA`, `backup()`, `VACUUM INTO` | 서버 설정, `pg_dump` · 기본 백업 + WAL 보관 |
| `INTEGER PRIMARY KEY` 행 번호(`schema_migrations`, `login_attempts`, `control_changes`) | `bigint generated always as identity` |
| `platform_audit_log`의 `(chain_id, seq)` | 같음. 사슬마다 추가를 한 줄로 세움(`pg_advisory_xact_lock(hash(chain_id))`) |
| outbox 잡기 | `FOR UPDATE SKIP LOCKED`, 인덱스에 `shop_id` 포함 |

## 10. 측정

Node 22.22.2, SQLite 3.53.3, 파일 DB, WAL, `synchronous = FULL`, `recursive_triggers = ON`, Apple silicon 노트북. 검토 반영 뒤 스키마(트리거 148개, 복합 FK 827묶음)로 다시 쟀다. 합성 자료: 다섯 시즌 × 100일 × 60팀 = 접수 30,000건, 품목 줄 150,000, 약속 300,000, 수납 30,000, 배분 150,000, 이동 줄 120,000, 작업 기록 330,000, 명령 기록 330,000, 변경 목록 660,000. 파일 487 MB(열이 늘어 461 → 487). 불러오기 7초.

| 작업 | 시간 |
|---|---|
| 오늘 대여 장부(60팀, 품목 요약, 다음 반납) | 0.25 ms |
| 날짜별 수거 목록 | 0.13 ms |
| 접수 잔액을 장부에서 다시 계산 | 0.005 ms |
| 동기화 한 쪽(차량 범위, 변경 500개) | 0.23 ms |
| 끝 4자리 찾기 | 0.009 ms |
| 하루 마감의 수단별 합계 | 0.02 ms |
| 장비 한 대의 이동 기록(최근 20건, `created_rev` 순) | 0.024 ms(0.54 ms에서: 이동 줄의 `(asset_id, created_rev)` 인덱스) |
| 충돌 키 확인 | 0.001 ms |
| **전체 접수 쓰기**: 접수, 차수, 줄 5, 약속 10, 수납 1(복사본 FK 포함), 배분 5, 충돌 키 5, 작업 기록(해시 포함), 명령 기록, 변경 목록 8, rev | **0.58–0.64 ms**(세 번 측정) |

측정 중에 데이터베이스가 측정 스크립트의 실수(다른 상품의 장비를 품목 줄에 연결)를 복합 FK로 거절했다. 설계가 막으려던 종류의 실수다.
