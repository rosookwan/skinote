# 옮기는 계획

작성 2026-09-23(같은 날 검토 반영). 지금의 `packages/core`(매장 전체 JSON 한 덩어리, JS UMD, 시험 222개)에서 새 스키마로, 시험을 깨지 않고 옮기는 순서다. ski-rent-ops 자료 이관과 12월 시즌까지 10주 계획, 멈춤 기준(gate)과 대안을 함께 적는다. 자료 구조는 [data-model.md](data-model.md), 동기화 · 백업은 [sync-and-concurrency.md](sync-and-concurrency.md), 화면은 [ui-architecture.md](ui-architecture.md).

## 0. 한눈에

- **저장은 첫날부터 새 표다.** 옛 JSON 덩어리 위에서 시즌을 보내지 않는다(주문 600건에서 명령 하나 82 ms, 시즌 중 수백 ms로 늘어남, 매장 전체 충돌).
- **업무 규칙은 두 줄기로 돈다.**
  - **legacy 줄기:** 검증된 옛 처리기(`packages/core`의 `execute()`)를 **바꾸지 않고**, 새 표에서 필요한 부분만 옛 모양으로 채워(codec) 실행하고, 바뀐 요소를 다시 표로 쓴다(facade). 시즌 1 동안 지급 · 반납 · 재고 이동 · 리프트권 · 교환 · 조기 반납 · 사이즈 요청 · 거래처 · 관리가 이 줄기로 돈다. **사실(fact) 명령은 옛 처리기 앞에 native 사실 어댑터를 둔다**(3-2): 거절하지 않고 맞는 부분만 적용한다.
  - **native 줄기:** 12월 우선순위(N1 적재 연결, N2 반납 장소, N12 순서 바꾸기 · 빨리 확인, N3 수거 목록, N4 칸별 수납 · 선입금, N19 여러 팀 한 번에 수납, N20 현장 수납)와 돈 · 마감 · 차량 업무 · 계정 · 동기화는 새 TypeScript 코드로 새 표에 직접 쓴다.
- 두 줄기가 같은 표를 쓰므로 **표현 규칙**(3-4절)을 시험으로 지킨다. native가 만든 상태는 옛 모양으로 오갈 수 있어야 하고, 그럴 수 없는 묶음은 표시해서 옛 처리기가 손대지 못하게 한다.
- 222개 시험은 처음부터 끝까지 그대로 돈다(모드 A). 2주차부터는 같은 시험이 새 표 위에서도 돈다(모드 B).
- 새 React 화면(C 장부 · 접수증 · 수거 목록)은 3주차부터 따로 가는 줄기다.
- **11월 연습 기간에 새 서버로 바꾼다**(옛 엔진은 밤마다 대조하는 그림자). 멈춤 기준 G1(11/6) · G2(12/1)와 대안 두 가지(엔진 대안 · 화면 대안)가 있다.

## 1. 출발점

| 항목 | 지금 |
|---|---|
| 업무 규칙 | `packages/core/src/workflows` 약 400 KB의 JS UMD 모듈. `execute(previous, command, context) → {state, event, result}`는 순수 함수다(상태를 복사하고 바꿔서 돌려줌) |
| 저장 | `workflow_state`(매장마다 JSON 한 덩어리), `workflow_events`(읽는 코드 없음), `notification_state`(JSON 한 덩어리), 옛 `return_orders` · `return_events` · `return_shops` |
| 시험 | `packages/core/tests` 25개 파일, 222개. 주요: 주문 21 · 주문 작업 38 · 돈 11 · 관리 10 · 교환 8+4 · 리프트권 8 · 할당 안전 8 · 조기 반납 7 · 주문 문서 13 · 체험 자료 13 · 알림 12 · 옛 반납 17+4+1+2 · 서비스 · API 12 |
| 서버 | `server/returns-api.cjs`(정적 폴더 경로가 새 구조에 없는 `dist`를 가리킴), 접근 파일 로그인(토큰 해시) |
| 화면 | 운영 후보는 ski-rent-ops의 포스 v4(vanilla, Pages 체험판). `apps/pos`는 React 19 시작 틀뿐(`core.fresh()`를 매장 id 없이 불러 오류) |
| 실제 자료 | docs/52 4-5절에 `실제 자료 이관 대조`가 아직 남아 있음. 운영 자료가 적거나 없을 수 있다(사장님께 확인) |

## 2. 도착점: 패키지

| 패키지 | 내용 | 비고 |
|---|---|---|
| `packages/core` | 옛 업무 규칙과 222개 시험. **고치지 않는다**(아래 세 개의 이음매만) | legacy 줄기이자 대조 기준. 마지막 묶음을 옮긴 뒤 보관 가지로 |
| `packages/schema` | `migrations/0001_control.sql` · `0001_shop.sql`(=`schema.sql`을 표시 줄로 나눔), 실행기, 검사(lint), 스키마 확인 스크립트, 장부 트리거 생성 스크립트, 자료 사전 생성, `ui_defaults.apply` | 확인 스크립트(FK 대상 · 표 안 UNIQUE · 목록형 CHECK · 스모크 88개)와 트리거 생성기를 옮겨 CI에. lint: 금지 문장, 장부 표에 `OR REPLACE` · `REPLACE INTO` · `INSERT OR IGNORE`, 트리거 모양, `recursive_triggers` 확인 |
| `packages/contract` | 명령 · 조회 형식(판 번호), 허용 키 목록, 오류 코드, JSON Schema, `ui-defaults.json`, 문구 표, 시스템 어휘 키 | 화면과 서버가 함께 씀 |
| `packages/domain` | native 처리기(순수 함수), 가격 · 할인, 도장 계산, 접수 상태 계산, 날짜 서비스, ULID | SQL 없음 |
| `packages/store` | 저장소(묶음별), 쓰기 순서(sync 문서 1절), 투영 계산, 검증기, **codec**, **legacy facade**, 명령 번역기(v1 → v2) | SQL은 여기에만 |
| `packages/importer` | ski-rent-ops 자료 가져오기, 잔여 기록, 대조 | |
| `packages/server` | HTTP · SSE, 세션 · PIN, outbox 작업자, 백업 · 작업 기록 구간 내보내기, 복구 도구, `/api/v1` 호환 창구 | |
| `packages/layout` | 칸 맞춤 · 목록 넘침 계산, 묶은 글꼴의 글자 폭 표 | 화면 · 서버(설정 명령) · 시험이 같은 코드 |
| `packages/ui` | 부품, DeviceProfile, 글자 맞추기, 쪽 넘김, 규칙 검사기, PlatformBridge 형식 | |
| `apps/pos` | React 앱(포스 + 기사), HttpClient · LocalClient | |
| `apps/admin` | 관리자 콘솔(시즌 뒤) | 체험판에 넣지 않음 |

## 3. 두 줄기

### 3-1. codec

옛 모음(orders, lines, catalog, assets, movements, allocations, reservations, tasks, sequences, forms, payments, adjustments, closings, cashEntries, partners…, settingVersions, events, requests)마다 순수 함수 두 개:

- `toRows(element) → rows`: data-model 문서의 이관 표(5절)를 그대로 코드로 옮긴 것. 열이 없는 필드는 `legacy_records.residue_json`. 옛 id에는 매장 코드 접두어를 붙인다(`shop1.` + 옛 id; 옛 처리기가 새로 만든 `movement-<rev>-<n>` 같은 id도).
- `fromRows(rows) → element`: 반대 방향. 접두어를 떼고 잔여를 다시 붙여 **정확히 같은 요소**를 만든다.
- 옛 코드가 배열에서 요소를 **빼면**(지움) facade는 행을 지우지 않는다(업무 행 삭제 금지 트리거). 행은 끝남 · 취소 상태로 두고 `legacy_records.residue_json`에 `removed: true`를 적으며, `fromRows`는 그 요소를 빼고 만든다.

시험: 222개 시험이 만드는 모든 상태에서 `fromRows(toRows(x)) == x`(정본 비교). 2주차부터 CI.

옛 요소의 **수정**은 장부 행의 수정이 아니라 새 행으로 번역한다. 예: 옛 `movement.reversedAssetIds`에 id가 더해지면 `stock_movement_reversals` 행 추가, 옛 `closing.reopenings`에 항목이 더해지면 `closing_reopenings` 행 추가, 옛 결제의 수정은 없다(옛 코드도 추가만). 장부 표의 추가 전용 트리거가 번역이 빠진 곳을 바로 드러낸다.

### 3-2. facade

```text
legacy 명령 처리(쓰기 순서 7단계 안):
  plan  := LOAD_PLANS[command.type](payload)       -- 이 명령이 읽는 묶음: 접수, 그 접수의 이동 · claim · 업무, 관련 장비, 설정 …
  state := hydrate(plan)                            -- 표 → codec.fromRows → 옛 모양의 '부분' 상태
           state.revision = 이번 rev − 1            -- 옛 id(movement-<rev>-<n>)가 새 rev로 유일
  out   := legacy.execute(state, {…command, expectedVersion: state.revision}, context)
  diff  := 바뀐 요소(추가 · 수정)만
  rows  := codec.toRows(diff) (+ 수정을 새 행으로 번역)
  native_only_aggregates에 걸린 묶음이면 → NATIVE_ONLY 거절
  행 쓰기 → 투영 다시 계산 → events(engine 'legacy', 정본 명령) → 나머지 쓰기 순서
```

- 옛 코드의 전체 버전 비교(`expectedVersion === state.revision`)는 facade가 맞춰 주고, 실제 충돌은 새 쓰기 순서(충돌 키 · 불변식)가 판단한다. 그래서 **옛 명령마다 자기 `sys_event_types` 행**(`ops.extend` → `order.extend`, `ops.cancel` → `order.cancel` …)과 등급 · 충돌 키 함수가 있다. 하나로 뭉친 '옛 명령' 행은 없다(연장과 취소, 교환과 조기 반납이 같은 줄에서 부딪히면 충돌로 잡힘).
- **사실 어댑터(adapter):** fact 명령(적재 · 지급 · 전달 · 받음 · 매장 입고 · 매장 반납 · 발권 · 들이기 · 정비 상태 · 발권처 환불 시도 · 교환 완료 · 사이즈 입력 · 거래처 거래와 정산)은 옛 처리기에 바로 가지 않는다. native 어댑터가 먼저 장비마다 지금 위치 · 업무 상태를 보고, 맞는 장비만 옛 `move()`에 넘기고, 나머지는 `superseded` · `needs_review`로 적으며, 옛 오류(`QUANTITY_EXCEEDED`, `NO_CHANGE`, `FORBIDDEN`)를 결과 상태로 바꾼다. 옛 처리기의 '전부 아니면 거절'이 사실을 버리지 않는다. 늦게 온 사실(`late_fact`), 손에 든 것을 본 사실(`skipped_hop`), 사실에 밀린 계획(`displaced_by_fact`)도 어댑터가 정한다(sync 문서 8-3).
- 오프라인 허용 명령은 모두 native이거나 어댑터다. G1 전에 이것이 CI로 확인된다(`sys_event_types.engine_key`와 코드에 등록된 엔진이 같아야 함).
- **LOAD_PLAN_MISS:** 부분 상태에 없는 모음을 옛 코드가 훑으면(예: 모든 업무를 뒤져 claim 찾기) 시험 모드 C에서 오류로 잡는다. 운영에서는 그 명령만 **열린 자료 전체**(열린 접수 + 그 장비 · 이동 · 업무, 수 MB)로 다시 채워 실행하고 횟수를 잰다. 11월 기준 p95가 20 ms를 넘으면 그 모음에 조회 이음매를 더한다.
- 옛 코드의 이음매는 세 개뿐이고, 기본 동작은 그대로라 222개 시험은 바뀌지 않는다.
  1. **날짜:** `C.day(at)` → `C.day(at, context)`. `context.timezone` · `cutoff`가 있으면 그것으로, 없으면 지금처럼 KST 자정.
  2. **조회:** 모음 전체를 훑는 몇 곳(업무로 claim 찾기 `inventory.js:33-67`, 접수 번호 `orders.js:174-176`, 폼 · 예약 id 충돌 `ticket-operations.js:29`)을 `Q.activeTaskClaims(state, assetId)`, `Q.nextReceiptNo(state, day)` 같은 함수로. 기본 구현은 지금의 배열 훑기, facade는 SQL로.
  3. **능력 값:** 교환 가능 품목 확인(`exchanges.js:53`, `orders.js:230`의 스키 · 보드)과 리프트권 분기 중 N17에 필요한 것을 `Cap.exchangeable(state, sku)` 같은 함수로. 기본 구현은 지금의 목록, facade는 `item_kinds` 값으로(N17 의류 · 헬멧 교환).

### 3-3. native 줄기(시즌 1)

| 묶음 | 시즌 1 | 이유 |
|---|---|---|
| 설정 · 레지스트리 · 품목 · 요금 · 사용 기능 | native(표). facade는 codec으로 옛 `settingVersions` · `catalog` 모양을 읽기 전용으로 만든다 | 새 레지스트리 |
| 계정 · 직원 · 기기 · 세션 · PIN | native | 새 기능 |
| 접수 만들기 · 더하기(확정 창: 약속, 결제 칸, 나중에, 선입금, 결제할 팀) | native | N2 · N4 · N19, 접수와 수납을 한 명령으로 |
| 약속 바꾸기(줄 전체 수량, 매장 직접 전환 포함) | native | N2, P24 |
| 차량 업무: 약속에서 업무 만들기, 적재 대기 상태, 방문 순서, 빨리 확인, 방문 결과, 업무 옮기기 | native | N1 · N12 · N11 |
| 수거 목록 읽기 모델과 A4 인쇄 | native | N3 |
| 돈: 수납 · 환불 · 여러 팀 · 결제 약속 · 보증금 · 조정 · 현금 입출금 · 차량 지갑 · 넘기기 · **마감**(돈통별, `posting_date`) | native. 옛 `finance.*` 명령은 번역기가 native 명령으로 바꾼다(한 접수 = 배분 하나) | N19, 차량 지갑, 늦은 돈 |
| 현장 수납 · 차량 예비권 추가 | native | N20 |
| 동기화 · outbox · 인쇄 작업 · 확인 필요 | native | 새 구조 |
| 지급 · 매장 반납 · 적재 · 전달 · 받음 · 매장 입고 · 발권 · 권 회수 · 발권처 환불 시도 · 교환 완료 · 재고 들이기 · 정비 상태 · 찾음 · 사이즈 입력 · 거래처 거래와 정산 | **adapter**(native 사실 어댑터 + 옛 처리기) | 검증된 옛 이동 규칙을 쓰되 사실은 거절하지 않음. 옛 이동 종류에 적재 · 전달 · 받음 · 입고가 이미 있다 |
| 되돌리기 · 준비 · 연장 · 취소 · 권 배정 · 교환 요청 · 조기 반납 · 사이즈 요청 · 인쇄 문서 · 재고 관리 · 거래처 약정 | **legacy**(facade, intent) | 옛 명령마다 자기 행과 충돌 키 |
| 장비 품목 바꾸기(`asset.reclassify`) | native | 새 표 |

### 3-4. 표현 규칙

native가 쓰는 상태를 legacy 처리기가 읽을 수 있어야 한다.

1. native 처리기가 쓰는 행 중 legacy 모음에 속하는 것은 `fromRows → toRows`로 되돌려도 같아야 한다. **native 시험이 만드는 모든 상태**에도 codec 왕복 시험을 돈다(모드 B-native).
2. 시즌 1 동안 native는 옛 모양으로 표현되는 상태만 만든다.
   - 약속: 줄마다 살아 있는 수령 약속 하나 · 반납 약속 하나(옛 `pickupPlan` · `returnPlan`). 수량을 나눈 약속은 시즌 뒤(주문 묶음을 옮긴 다음).
   - 여러 팀 수납: 표에는 수납 한 행 + 접수별 배분이지만, 옛 모양으로는 **배분 하나 = 옛 결제 하나**(같은 수단, 배분 금액, 줄 배분)로 보인다. 옛 코드는 결제를 추가만 하므로 왕복이 된다.
   - 선입금: `payments.purpose_key = 'prepayment'`는 옛 결제의 잔여(`residue_json`)로 오간다.
   - 방문 순위 · 빨리 확인: 옛 `sequences`는 `route_positions`에서 **읽기 전용으로 만든 모양**이다. 옛 `dispatch.reorder`는 번역기가 native `route.move`로 바꾼다. 빨리 확인은 옛 상태에 없다(옛 코드도 알림에만 있었음).
3. 옛 모양으로 표현할 수 없는 상태를 만들어야 하는 명령(강습 줄, 인원만 예약 줄의 변환, 결제 약속의 다른 팀 지정이 옛 코드의 결제 검사와 부딪히는 경우)은 그 묶음을 `native_only_aggregates`에 넣고, 이후 legacy 명령이 그 묶음에 오면 `NATIVE_ONLY`('이 접수는 새 화면에서 처리해 주세요')로 거절한다. 이 매장은 강습을 쓰지 않아 시즌 1에 거의 생기지 않는다.

### 3-5. 시험 모드

| 모드 | 무엇 | 목적 | 언제 |
|---|---|---|---|
| A | `node --test packages/core/tests` 그대로 | 옛 동작 기준 | 늘(legacy 엔진을 지울 때까지) |
| B | 같은 시험 파일을 `--import tests/support/facade-engine.mjs`로. `W.execute`를 감싸: 들어온 상태를 `toRows`로 메모리 SQLite에 넣고 facade로 실행한 결과와, 옛 `execute`를 바로 실행한 결과(상태 · 결과 · 이벤트)가 같아야 함 | codec과 facade가 아무것도 잃지 않음 | 2주차부터 CI |
| C | 모드 B에 실제 LOAD_PLAN을 적용. 불러오지 않은 모음을 옛 코드가 건드리면 `LOAD_PLAN_MISS` | 숨은 전체 훑기를 찾음 | 3주차부터 |
| D | 옛 시험을 엔진과 상관없는 계약 시험으로(`engine.command()`, `engine.view.order(id)`, `view.finance`, `view.vehicle`, `view.day`) — 두 엔진에서 읽기 모델을 비교 | native로 옮긴 묶음이 옛 동작과 같음 | native로 옮기는 묶음마다(시즌 1: 돈 · 마감 · 차량 업무 · 접수 만들기) |
| E | 모드 A · B와 11월 연습 기간의 모든 `(상태, 명령, 문맥, 결과)`를 기록(`SKINOTE_RECORD=1`)해 native 엔진에 다시 넣고 읽기 모델 비교 | 단위 시험 밖의 회귀 그물 | 3주차부터, 11월에는 밤마다 |
| 검증기 | 모든 시험의 모든 명령 뒤 투영 전체 재계산 · 비교(옛 '청구 음수' 검사처럼) | 투영이 틀리면 바로 잡음 | 2주차부터 |
| 상태 대조 | 옛 시험이 끝날 때의 상태를 모두 가져오기로 넣고, 옛 읽기 모델과 새 SQL 읽기 모델이 같아야 함 | 시험 222개가 만든 수백 개의 실제 같은 자료로 가져오기를 검사 | 2주차부터 |

옛 시험 파일의 운명:

| 파일 | 수 | 시즌 1 | 시즌 뒤 |
|---|---|---|---|
| workflows-orders · order-operations · finance · exchanges · order-exchange · early-returns · ticket-operations · allocation-safety · driver-receiving · order-documents · management · domain · migration · demo | 약 160 | A + B + C. 돈 · 마감 · 차량 업무 · 접수 만들기는 D도 | 묶음을 옮길 때마다 D로 바꾸고 계약 시험으로 남김 |
| workflows-service · api · unified-api · pos-integration | 약 12 | A. 새 서버에는 `/api/v2` 계약 시험을 새로 씀. `/api/v1` 호환 창구는 이 시험들을 새 서버에 대고도 돌림 | 호환 창구를 없앨 때 보관 |
| returns-storage · workflows-pending-recovery · workflows-backup | 약 5 | A. 새 실행기 · 백업 · 복구 epoch · 오프라인 큐 시험으로 대체 | 보관 |
| returns-domain · returns-api · returns-client | 약 22 | A(가져오기가 `legacy.migrate`를 쓰는 동안) | 이관 끝나면 보관 |
| notifications | 약 12 | A. 새 알림 표 시험을 새로 씀 | 보관 |

### 3-6. 의도한 차이

대조는 0 차이가 기준이다. 아래 차이만 목록 파일(`packages/importer/divergences.json`)에 적고 허용한다.

| 영역 | 옛 동작 | 새 동작 | 이유 |
|---|---|---|---|
| 영업일 | KST 자정 고정 | 매장 시간대 + 기준 시각 | 여러 매장, 야간 영업. 이 매장은 기준 시각을 정하기 전까지 같은 결과 |
| 동시 수정 | 매장 전체 버전 | 충돌 키 · 행 버전 · 등급 | S5 |
| 리프트권 완료 | 전달한 권은 회수할 때까지 손님 보유 | 반납 정책 optional: 지급으로 줄 끝, 회수는 기록 | 질문지 2번 답으로 확정. required로 바꾸면 차이 없음 |
| 발권처 환불 돈 | 시도와 이동에만 있고 마감 밖 | 거래처 정산(현금 장부는 정산 하나) → 현금 이동 → 마감(새 기록만) | 마감에 보여야 함, 두 번 세지 않음 |
| 환불 연결 | 없음 | `refund_of_payment_id` 필수. 대상이 없는 옛 환불은 `legacy_refund` 종류로 | 카드 취소 맞추기, 환불 ≤ 수납 |
| 차량 사실 | 옛 `move()`: 한 장비라도 안 맞으면 전부 거절 | 사실 어댑터: 맞는 장비만 적용, 나머지 확인 필요 | 사실은 거절하지 않음(S6) |
| 계획과 사실이 부딪힘 | claim이 있으면 이동 거절 | 이동은 적고 계획을 풂(`displaced_by_fact`) | 물건의 실제 위치가 맞아야 함 |
| 차량 현금 넘기기 | 넘기면 바로 카운터 돈통 | 넘기는 중 → 세고 확인해야 돈통, 차액은 과부족 | 차액의 책임이 보임 |
| 옛 id | 그대로 | 매장 코드 접두어(`shop1.`), codec이 붙이고 뗌 | 파일을 합쳐도 겹치지 않음. 옛 모양으로는 같음 |
| 장소 | 글자 | id + 이름 스냅샷(옛 글자는 스냅샷) | S4 |
| 빨리 확인 | 알림에만 | `task_pins` + 세 단계 알림 | 알림을 지워도 고정이 남음 |
| 순서 바꾸기 | 매장만 | 기사도 자기 차량 | 사장님 답 2 |
| 교환 | 스키 · 보드만 | 교환 가능한 모든 종류 | 사장님 답 7(N17) |
| `damaged` 상태 | 교환이 만들지만 설정 불가 | 정식 행 | 일관성 |
| 접수 번호 | 주문 훑기 | `shop_counters`(같은 모양) | 훑기 없음 |
| 가격 | 화면이 보낸 단가를 받음 | 서버 견적 + `quote_hash` | 출처와 감사 |
| 할인 겹치기 | 프리셋 위에 직접 할인 | 묶음마다 하나(직접 포함) | docs/44:56 |
| 여러 팀 수납 | 불가 | 수납 하나 + 배분 여러 개(옛 모양으로는 결제 여러 개) | N19 |

## 4. 대안(fallback)

| 이름 | 언제 | 무엇 |
|---|---|---|
| **F1 엔진 대안** | G1(11/6)을 넘지 못하면 | 2026-27 시즌을 ski-rent-ops 서버 + 포스 v4로 운영하고, N1(적재 버튼) · N2(반납 장소 줄) · N12(순서 바꾸기 · 빨리 확인) · N19(여러 팀 결제를 '같은 메모의 한 팀씩 결제'로)를 옛 코드에 덧붙인다. 새 시스템은 시즌 내내 그림자로 돌리며 대조하고, 시즌이 끝난 뒤 한 시즌 자료와 함께 옮긴다. 설계는 바뀌지 않고 날짜만 옮긴다 |
| **F2 화면 대안** | G2(12/1)에 엔진은 넘었는데 React 화면이 모자라면 | 모자란 화면만 포스 v4를 `/api/v1` 호환 창구로 새 저장소에 붙여 쓴다. 기사 화면과 오늘 장부처럼 준비된 React 화면은 그대로. 관리 화면은 처음부터 v4로 두어도 된다(관리자만 씀) |

되돌리기(개장 전까지): 11월 바꾸기 때 옛 파일은 읽기 전용으로 옆에 둔다. 되돌려야 하면 서버를 옛 파일로 돌리고, 연습 기간에 기록한 명령(모드 E 기록)을 옛 엔진에 다시 넣는다. native만의 명령은 옛 모양으로 낮춘다: 여러 팀 수납 → 접수별 결제 여러 개(같은 메모), 빨리 확인 → 우선 요청 알림, 방문 순위 → `sequences`, 선입금 → 메모 '선입금'인 결제, 결제 약속 → 메모. 시즌이 열린 뒤에는 옛 파일로 되돌리지 않는다. 고칠 것은 앞으로 고친다.

## 5. ski-rent-ops 자료 가져오기(S12)

### 5-1. 원본

| 원본 | 새 곳 |
|---|---|
| `workflow_state.state_json`(매장마다) | 모음별로 data-model 4절의 표로(아래 5-3). 원본 전체를 `legacy_records` · `legacy_events`에 |
| `workflow_events` | `legacy_events`(원본), `events(imported = 1, command_type 'legacy.imported')`에는 이름 · 전화를 뺀 요약 |
| `notification_state` | `notifications`, `notification_receipts`, `notification_preferences`, 요청 → `command_log`(행위자 `legacy:…`) |
| `return_shops` · `return_orders` · `return_events` | 옮기지 않은 옛 반납 주문은 **옛 엔진의 `legacy.migrate`로 먼저 덩어리에 넣은 뒤** 덩어리와 같이 가져옴. 원본 행은 `legacy_events` · `legacy_records` |
| `SKI_RETURNS_ACCESS_FILE` 로그인 | control의 `accounts`(legacy), 매장의 `staff_members(legacy_actor_key)`, `devices`, 토큰 해시 → 만료 있는 `legacy_token` 세션 |
| 브라우저의 보류 중 저장 칸 | 가져오지 않음. 바꾸기 전에 모든 기기에 보류 명령이 없는지 확인 |

### 5-2. 순서

1. **멈추고 복사:** 옛 서버를 멈추고 `VACUUM INTO`로 복사, 확인. 원본은 건드리지 않는다.
2. **옛 쪽 마무리:** 옮기지 않은 `return_orders`를 옛 엔진의 `legacy.migrate`로.
3. **대조 전:** 옛 엔진으로 계산해 `legacy_import_runs.oracle_before_json`에 저장
   - 접수마다: 상태, 줄별 수량(지급 · 손님 · 차량 · 매장 · 모름), 청구 · 받음 · 미수 · 과수납 · 보증금, 줄별 받은 돈
   - 차량마다: 재고 요약
   - 마감한 날마다: 옛 보고서를 다시 계산해 얼린 스냅샷과 비교(다시 연 적 없는 날)
   - 종류 · 수단별 합계, 위치 · 상태별 장비, 모음별 개수
4. **새 파일:** 마이그레이션 0001, 매장 개설(`shop.provision`: 시드 + 스키장 템플릿 + `closing_scopes.main` · `calendars.main` + `ui_defaults.apply`), 시간대 Asia/Seoul, 기준 시각 = 옛 `nightCutoff`(없으면 00:00), `shop_counters('rev')` = 옛 revision. 옛 id는 매장 코드 접두어를 붙여 넣는다.
5. **레지스트리:** 가장 최근 `settingVersions`에서(옛 판들은 `config_changes`에 전후로), 장소 글자 · 발권처 id · 직원 · 행위자 · 거래처는 `legacy_value_map`. 장소 글자는 정확히 같은 이름의 장소가 있을 때만 id를 연결하고, 나머지는 이름 스냅샷으로 남기고 직원에게 맞추기를 제안만 한다.
6. **묶음:** codec `toRows`로, id를 그대로. 가져오기 트랜잭션 안에서 외래 키 검사를 커밋 때로 미룬다(`PRAGMA defer_foreign_keys = ON`).
7. **작업 기록 · 멱등:** `events(imported)`, `command_log`(옛 `requests`: 행위자 `legacy:<role>:<id>`, 지문은 옛 정본 문자열의 sha256, 결과는 90일), 알림.
8. **투영 계산**, 검증기.
9. **대조 후:** 같은 읽기 모델을 두 번 계산 — facade(옛 코드를 채운 상태 위에서)와 native SQL 읽기 모델. 둘 다 `oracle_before_json`과 **정확히 같아야** 하고(의도한 차이 목록 제외), 하나라도 다르면 `failed`, 새 파일은 버린다.
10. `legacy_import_runs(status 'verified', 개수, 지문)`. 같은 원본으로 다시 돌리면 아무 일도 없고, 원본이 바뀌면 새 파일에 새 가져오기.

### 5-3. 모음별 대응(요약)

| 옛 모음 | 새 표 |
|---|---|
| `orders[]` | `orders`(스냅샷), 총액만 있는 옛 청구 → `charge_adjustments(legacy_charge)` 한 행(청구가 있는 곳은 하나), `customers`(고객 기록이 있으면), `order_batches`(`posting_date` = 영업일), `order_people`(+ 사전 입력 → `person_attribute_values(source preinput)`) |
| `orders[].lines[]` | `order_lines`(분류 → 종류, 가격 → 가격 열 + 내역, 총액만 → `legacy_total_only`), `line_promises`(pickupPlan · returnPlan → 살아 있는 약속, 장소 글자 → 이름 스냅샷), 취소 수량 → 취소 줄, `assetTerms` → 연장 장비 · 약속 장비 |
| `orders[].cancellations/extensions/schedules/links/preparations/ticketCancellations/preinputApplications` | 취소 + 조정, 연장 + 조정, 지난 약속 사슬, `order_links` · 사이즈 요청 연결, `preparations` + 준비 claim, 취소(해당 없음) + 끝난 claim, 확인 값 |
| `catalog[]` | `item_kinds`(kind로), `catalog_items`(id 그대로), `ticket_products`(hours), 구성품 · 숨김, `requires_type_confirmation` |
| `assets[]` | `assets`, `ticket_units` · `ticket_unit_accepts`, `lots`, 위치 → `stock_locations`, 목적 · 환불 · 교환 · 준비 · 대여 · 구성품 표시 → `asset_claims`, 분실 → 상태 변경, 주인 · 대여 |
| `reservations[]` · `allocations[]` | 권만 있는 접수(또는 연결된 접수에 합침), 권 줄(사용일, 창, 발권 예정일) · 시간대 claim |
| `movements[]` · `corrections[]` | `stock_movements` · `stock_movement_lines`(장비마다 한 줄), 종류 이름 맞춤(`stock.receive` → `stock_receive`, `directReturn` → `direct_return`), `before` 스냅샷 → 잔여, 정정 → 되돌리기 이동 + `stock_movement_reversals` |
| `exchanges[]` · `earlyReturns[]` · `refunds[]` | 교환 · 교환 장비 · 회수, 조기 반납 · 장비(이전 계획 → 외래 키), 발권처 환불 · 권 · 시도(옛 금액은 수단 미확인 거래처 정산, 서랍 없음 — 지난 마감이 움직이지 않게) |
| `tasks[]` · `sequences[]` | `tasks` · `task_items` · `task_visits` · `task_reassignments` · 운반 claim, `route_positions`(순위) |
| `forms[]` | 사이즈 요청 · 제출 · 사람 · 답 · 확인(토큰 → 해시) |
| `printJobs[]` · `deliveries[]` | `print_jobs` · 근거 · 시도, `message_deliveries` · `outbox` |
| `payments[]` | `payments`(종류 · 수단 규칙 값 복사) + 배분(배분이 없으면 접수 전체 하나, 배분의 날짜 = 수납의 날짜), 수단 → 수단 행, 결제자 글자 → 잔여(이름 칸 없음), 보증금 종류 → 접수마다 보증금 하나, 현금 → 돈통 `counter-1`, 대상 없는 환불 → `legacy_refund`, 옛 `externalReference`(중복 · 빈 값 있어도 됨) → 승인번호 또는 메모 |
| `adjustments[]` · `cashEntries[]` · `closings[]` | `charge_adjustments`(연장이 가리키면 extension, 아니면 price_correction), `cash_entries`, `closings`(범위 `main`, 판 번호, 스냅샷 → `report_json` 그대로) · `closing_reopenings` · 합계 · 돈통 하나(앞 셈 연결) · 인계, `business_days`(범위 `main`) |
| `customerProfiles[]` | `customers`, `orders.customer_id` |
| `partners[]` · `partnerLoans/Returns/Lendings/Receipts` · `partnerAgreements/Offsets/Money` | 거래처(`partner_shop`), 장비 대여 · 항목(장비 또는 수량), 거래, 상계(받음 + 줌 두 정산, `offset_group_id`), 정산 + 배분(현금이면 **정산의 돈통**만 현금 이동 — 현금 입출금으로 따로 적지 않음) |
| 권의 `vendorId` | 거래처(`resort_vendor`). `legacy-unconfirmed`는 표시한 발권처 |

### 5-4. 크기

실제 자료가 적으면(연습 · 체험 자료뿐) 가져오기는 하루 일이다. 크기보다 **옛 동작과 같은지**가 더 큰 위험이라 노력은 모드 B · C · E와 대조에 쓴다. 사장님께 확인할 것: ski-rent-ops 운영 서버에 실제 손님 자료가 있는지, 있다면 몇 건인지.

## 6. 10주 계획(2026-09-28 ~ 12-04)

한글날(10/9, 금)과 개천절(10/3, 토)이 있다. 줄기는 네 개가 함께 간다: **기반**(schema · store · domain), **legacy**(codec · facade · 시험), **기능**(N 목록), **화면**(React). 매주 금요일에 체험판(LocalClient)과 매장 PC 시험 서버에 올린다.

| 주 | 기반 · legacy | 기능 | 화면 | 끝났다는 기준 |
|---|---|---|---|---|
| 1 (9/28–10/2) | 패키지 나누기, `schema.sql` → 마이그레이션 0001(control · shop), 실행기(`recursive_triggers` 확인, 백업 먼저 · 적용 뒤 한 번 더, 모르는 판이면 읽기 전용, checksum, `ui_defaults.apply`), 장부 트리거 생성기와 lint, 스키마 확인 CI, 날짜 서비스, 요청에서 정해지는 id(ULID + HMAC), 계약 패키지 뼈대(충돌 키 함수 포함). 레지스트리 · 품목 · 주문 codec(id 접두어) | 매장 개설 명령과 첫 매장 시드 | docs/35 · docs/42 부록 A 개정안(레일 없앰, 화면 지도). DeviceProfile(칸 수 포함), `packages/layout`(칸 맞춤 · 넘침 · 글자 폭 표), TextFit · Pager 옮기기, 규칙 검사기 옮기기, 부품 뼈대, 가져오기 경계 lint(스파이크의 `@skinote/core` 가져오기 없앰) | 빈 파일에 마이그레이션 적용, 스모크 88개 통과, 모든 시험 상태에서 레지스트리 · 주문 codec 왕복 |
| 2 (10/5–10/8) | 쓰기 순서(command_log(요청번호 키), events + 해시 · 행 해시 · pii 약속값, event_pii, change_log(옛 · 새 범위), intent_marks(쓰기 · 읽기 키), 투영 계산), 검증기(돈 검사 포함), 나머지 모음 codec, facade + **사실 어댑터** + 이음매 1 · 2, 상태 대조 | — | Ledger · Stamp · IndexTabs · NowLine을 가짜 읽기 모델로(C1) | **모드 A · B 초록(222 × 2)**, 모든 명령 뒤 검증기 깨끗 |
| 3 (10/12–10/16) | 모드 C, LOAD_PLAN 조정, 모드 E 기록기 | **N2** 접수 만들기(약속: 반납 장소 줄), **N4** 확정 창(결제 칸, 나중에, 선입금 설정), **N19** 결제할 팀(결제 약속), 약속 바꾸기(P24 매장 직접), **N1** 배달 약속 → 적재 업무 · `awaiting_load` · 적재 도장(legacy 적재 · 전달 이동) | C1 오늘 장부를 실제 API로, C2 접수증 + 남은 일 목록, 확정 창(N개 칸 줄) | UI로 만든 배달 접수가 적재 업무를 만들고 기사 기기에 전달(N1 재현 시험 통과) |
| 4 (10/19–10/23) | `/api/v2/sync`(커서 rev.seq) + SSE, 표마다 범위 함수 + 범위 속성 시험, 범위가 바뀐 기기 reset, 기사 기기 LocalClient(OPFS 범위 자료 + 보냄 대기 겹치기) | **N12** 방문 순서 ▲▼ · 맨 위로 · 시간순(기사 · 카운터, 기준 업무 + 나중 결정이 이김), 빨리 확인(고정 + 세 단계 알림), **N3** 수거 목록 읽기 모델 + A4 인쇄(같은 화면 설정의 인쇄 판 · outbox · 인쇄 도우미) | C3 기사 수거 목록(태블릿 · 휴대폰), 숫자판(옆 판 · 아래 판), RowActionBar, PinBar, 연결 띠, 포스 수거 목록 + 인쇄 | 두 기기가 동시에 순서를 바꿔도 충돌 없음, 수거 목록이 인쇄됨, 온라인 · 오프라인 `driverList`가 같음 |
| 5 (10/26–10/30) | 옛 `finance.*` 번역기, 의도한 차이 목록, 모드 D(돈 · 마감) | 돈 native: 수납 · 환불 · **N19 한 번에 수납**(수납 하나 + 배분) · 보증금 · 조정 · 현금 · 차량 지갑 · 넘기기, **마감**(돈통별, `business_days`, `posting_date`) | 수납 창, 한 번에 수납 창, 마감 화면 | 여섯 팀 한 번 수납에 모든 접수 미수 0, 마감이 옛 엔진 대조와 같음 |
| 6 (11/2–11/6) | 오프라인 큐 · batch · dependsOn(돈은 멈추지 않음) · 빈 기기 번호 찾기 · 확인 필요 보일 곳, 기기 서명 행위자 + `device_sign_ins`, S5 · S6 시나리오 시험 자동화(오프라인 중 앱 다시 시작 포함) | 계정 · 직원 · 기기 등록(`persist()`) · 세션 · PIN, **N20** 현장 수납 · 차량 예비권 추가(오프라인 견적), **N11** 방문 결과 버튼, 카드 결제 잠금 | 확인 필요(목록 · 띠 · 창 안 단계), 오프라인 표시(보냄 대기), 로그인 · PIN 전환, 기사 업무 판 · 현장 수납 판 · 권 추가 판 | **G1**(아래) |
| 7 (11/9–11/13) | 실제 DB 복사본으로 가져오기 · 대조, 백업(커밋마다 LAN 흘려 보내기 · 5분 묶음 · 1시간 `VACUUM INTO` · 밤 원격, control 복구 기록) · 복구 도구(after-image 적용, epoch, 전체 rev 최댓값 위 도약, 번호 건너뛰기, `replay` 값으로 다시 보내기, replayed outbox는 unknown) · 복구 시험, 이음매 3 | **N17** 의류 · 헬멧 교환, `사용 기능` 설정 화면 | 매일 쓰는 나머지 화면(리프트권 발권 · 배정 · 회수, 매장 반납, 새 접수 다듬기), 관리 → v4 연결 | 가져오기 `verified`, 복구 시험 통과(같은 id · 번호로 다시 들어감) |
| 8 (11/16–11/20) | **바꾸기**: 새 서버를 매장에서 주 서버로(연습 매장 `is_test` + 실제 매장), 옛 엔진은 그림자(명령을 밤마다 다시 넣어 대조) | 관찰 결과 고치기 | 연습 로그인, 관찰 시험(다섯 과업 × 세 명 이상, docs/52 2-7) | 매일 대조 보고서 |
| 9 (11/23–11/27) | 대조 차이 0 유지, 성능 확인(명령 p95 < 20 ms) | N6 · N7 · N8 · N9 · N10, 금요일에 기능 동결 | 관찰 고치기 | — |
| 10 (11/30–12/4) | **G2**(12/1). 산에서 오프라인 · 인쇄 · 복구 실전 연습, 지원 순번, 문서 | 동결(버그만) | 동결(버그만) | 개장 준비 완료. 개장하면 되돌리기 창을 닫음 |

**반드시 할 것(주가 밀려도):** 스키마와 실행기, 쓰기 순서와 검증기, codec과 facade(옛 기능 전부가 새 저장소에서 돎), 가져오기와 대조, 동기화, 백업 · 복구, N1 · N2 · N12 · N3 · N4 · N19. 밀리면 N20 → N17 → N11 → 화면 다듬기 순으로 뒤로 간다.

**만들었지만 꺼 둠 · 나중:** 강습 명령 · 화면(기능 꺼짐), 나눠서 결제 화면(표는 있음, 카드 단말과 함께), 카드 단말 도우미와 실제 문자(outbox는 있음, 모의 대상), 요금 조건 편집 화면(첫 판은 옛 단가 그대로), 관리자 콘솔 · 라이선스 화면(명령줄 도구로 매장 · 계정 · 라이선스를 만듦), 시즌 보관 작업(시즌 끝 전까지), PostgreSQL.

### 6-1. 멈춤 기준

**G1 (11/6, 6주차 금요일)** — 모두 만족해야 계속:
- 모드 A · B · C 초록, 모드 D(돈 · 마감 · 차량 업무 · 접수 만들기) 초록, 모든 시험 명령 뒤 검증기 깨끗(돈 검사 포함).
- 오프라인 허용 명령 · fact가 모두 native 또는 어댑터(CI), 어댑터 시험: 12개 중 1개가 이미 매장에 온 받음이 11개 적용 + 1개 superseded, 모든 dependsOn이 실패해도 돈 명령은 수납 행을 남김.
- 상태 대조(옛 시험 최종 상태 전부) 0 차이.
- N1 · N2 · N3 · N4 · N12 · N19 시나리오 시험 초록.
- S6(두 시간 오프라인) 시험: 두 번 세는 것 0.
- facade 포함 명령 p95 < 20 ms(열린 접수 600건 합성 자료).
- C1 · C2 · C3 화면을 실제 API로 쓸 수 있음.
- 못 넘으면 **F1**.

**G2 (12/1, 10주차 화요일)** — 모두 만족해야 개장:
- 그림자 대조 **7일 연속 설명 안 되는 차이 0**.
- 세 명 이상이 다섯 과업을 도움 없이 끝냄.
- 복구 시험 통과(다시 보낸 명령이 같은 id · 번호로), 원격 백업 동작, 작업 기록 구간이 LAN의 받는 기기로 몇 초 안에 가고 5분 묶음이 두 번째 디스크(USB)에 쌓임.
- 산에서 기사 기기 오프라인 연습 통과.
- 엔진은 넘었는데 화면이 모자라면 **F2**. 엔진이 모자라면 개장 전까지 되돌리기(4절).

## 7. 시즌 뒤: legacy 묶음 옮기기

순서(값과 위험 순): ① 지급 · 반납 · 재고 이동 · 되돌리기(모드 D) → ② 리프트권(발권 · 배정 · 회수 · 발권처 환불) → ③ 교환 · 조기 반납 → ④ 주문 작업(연장, 취소 일부 수량 v2, 준비, 약속 나누기) → ⑤ 사이즈 요청 · 인쇄 문서 → ⑥ 거래처 · 재고 관리.

한 묶음이 끝나는 기준: 모드 D가 native에서 초록, 모드 E(기록한 시즌 명령)를 native에 다시 넣어 **일주일 동안** 읽기 모델 차이 0, 그다음 그 묶음의 legacy 처리기를 지우고 시험은 계약 시험으로 남긴다. 표현 규칙의 제한(약속 하나씩 등)은 그 묶음을 옮긴 뒤 풀린다. 마지막 묶음 뒤에 `packages/core`는 보관 가지로 가고, `native_only_aggregates`는 쓰이지 않으며, `legacy_records`의 잔여는 가져온 자료의 기록으로만 남는다.

## 8. 위험과 대응

| 위험 | 대응 |
|---|---|
| codec이 무언가를 잃음 | 모드 B(222개 시험 × 모든 명령), 상태 대조, 추가 전용 트리거가 번역 빠진 곳을 드러냄 |
| facade가 느림(숨은 전체 훑기) | 모드 C, 운영 LOAD_PLAN_MISS 횟수 측정, G1 성능 기준, 조회 이음매 추가 |
| native와 legacy가 같은 표를 다르게 이해 | 표현 규칙과 native 상태의 codec 왕복 시험, `native_only_aggregates` |
| 화면 줄기가 늦음 | 3주차부터 가짜 읽기 모델로 먼저, F2(v4 + `/api/v1`), 관리 화면은 v4 유지 가능 |
| 10주가 모자람 | 반드시 할 것 목록, 밀리는 순서, G1 · F1 |
| 고령 직원이 새 화면에 적응 못 함 | 11월 연습 로그인과 관찰, 종이 장부 · 수거 목록 인쇄를 전환기에 함께 |
| 새 돈 습관(차량 지갑, 현금 넘기기) | 연습 과업에 포함, 마감 화면이 돈통 · 지갑을 따로 보여 줌 |
| 매장 PC 고장 | 커밋마다 LAN 복제 + 1시간 백업 + 5분 묶음 + 기기 보낸 기록(서버가 정한 값과 함께), 복구 시험, 종이 |
| 자료가 생각보다 큼 | 가져오기는 대조가 통과할 때까지 새 파일을 버리고 다시 함. 대조는 원본 복사본에서 |
| 옛 코드 이음매가 동작을 바꿈 | 이음매는 기본 동작 그대로, 모드 A가 바로 잡음 |
| 옛 처리기의 '전부 아니면 거절'이 차량 사실을 버림 | 사실 어댑터(3-2), G1의 어댑터 시험 |
| 옛 코드가 요소를 지움 | 행은 지우지 않고 끝남 + `removed` 잔여, codec 왕복 시험 |
| 장부 트리거 · 설정이 새 스키마와 어긋남 | 트리거는 생성기가 만들고 CI가 모양 · 열 목록을 확인 |
