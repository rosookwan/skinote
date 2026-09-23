# 스키노트 기반 설계

작성 2026-09-23. 스키노트(한국 스키 렌탈샵 POS, 첫 매장 · 무주)가 여러 해 동안 **데이터베이스를 다시 만들지 않고** 새 품목 · 새 칸 · 새 장소 · 새 매장 · 새 기능을 더할 수 있게 정한 기반이다. 세 가지 설계안(A 관계형 우선, B 이벤트 소싱, C 묶음 + JSON)을 세 심사가 평가했고, 이 설계는 **A를 바탕으로 B와 C의 좋은 점을 더하고 심사가 찾은 치명적 약점을 모두 고친** 최종안이다. 같은 날 네 관점(다시 만들기 사냥 · 돈과 재고 · 동시 수정과 오프라인 · 화면 확장)의 공격적 검토 93건을 받아 반영했다(맨 끝 '검토 반영 기록').

## 문서

| 문서 | 내용 |
|---|---|
| [data-model.md](data-model.md) | 원칙, 두 데이터베이스와 매장 경계, 지점과 마감 범위, ID · 돈 · 세금 · 시간 · 보관 규칙, 모든 표의 목적 · 필드 · 불변식 · 관계, 불변식을 누가 지키나, 투영과 검증기, 확장 방법과 마이그레이션 규칙, S1–S15, PostgreSQL 옮기기, 측정 |
| [`packages/schema/schema.sql`](../../packages/schema/schema.sql) | 참조 DDL(마이그레이션 0001): control 28표, shop 260표(코드 어휘 62), 인덱스, 생성한 장부 트리거(0001 열 목록), 코드 어휘 시드. 표시 줄 `@database` · `@seed`로 파일별로 나뉨 |
| [catalog-and-pricing.md](catalog-and-pricing.md) | 품목 종류와 능력 값, 첫 매장의 시작 값, 상품 · 규격 · 속성(입력 · 보이는 모양), 세트, 요금표 · 조건(상품 · 종류 · 가격 묶음 대상), 가격 계산, 할인, 줄의 가격 출처, 리프트권 · 강습, 세금 |
| [sync-and-concurrency.md](sync-and-concurrency.md) | 쓰기 순서, 명령 봉투(서명된 행위자, 읽기 모델의 기준), 명령 등급, 충돌 키(쓰기 · 읽기)와 자동 이어 붙이기, 동기화 범위, 멱등(요청번호) · 보관, 기기 · 세션 · PIN, 기사 오프라인(같은 코드로 그리기), outbox, 백업(몇 초 안의 LAN 복제) · 복구(after-image) |
| [ui-architecture.md](ui-architecture.md) | C 장부 + A 지금 줄 + B2 남은 일 + A3 ▲▼, 세 층의 설정과 기본 설정 반영, 코드 키 어휘, 기기 등급, 크기 규칙과 칸 폭 계산(em), 넘치는 목록의 한 모델, 부품, C 세 화면과 기사 화면의 설정, 화면과 도메인의 연결 |
| [migration-plan.md](migration-plan.md) | legacy 줄기(codec + facade)와 native 줄기, 표현 규칙, 시험 모드 A–E, 의도한 차이, 대안 F1 · F2, 자료 가져오기, 10주 계획, 멈춤 기준 G1 · G2, 시즌 뒤 옮기기 |
| [../roadmap.md](../roadmap.md) | 10주 계획에 겹쳐 적은 지금 상태(한 것 · 주별 상태 · 다음에 할 것). 주마다 고침 |

**확인한 것(검토 반영 뒤 다시):** `schema.sql`을 Node 22.22.2 · SQLite 3.53.3에서 `foreign_keys = ON` · `recursive_triggers = ON`으로 실행해 외래 키 853묶음(control 26 · shop 827)이 모두 기본 키나 부분 조건 없는 유일 인덱스를 가리키고, 표 안 `UNIQUE` 제약과 목록형 `CHECK`가 0개이며, 88개 동작 시험(매장 경계, 같은 접수, 이동 경로, 묶임과 claim 차선, 추가 전용 · `REPLACE` · 가리기만, 품목 줄 고정, 돈 연결 규칙, 마감 범위, 멱등 키, 작업 기록 보관 확인, 여러 값 속성, 요금 대상, 화면 설정 FK, 값이 든 장부 표에 열 추가 → 채우기 → 한 번만 트리거)이 모두 통과함을 보았다. 다섯 시즌 합성 자료(접수 30,000, 작업 기록 · 명령 기록 · 변경 목록 약 130만 줄, 487 MB)에서 `synchronous = FULL`로 접수 한 건 전체 쓰기 0.58–0.64 ms(세 번 측정), 화면 조회는 모두 0.3 ms 아래였다(data-model 10절).

## 결정 기록

### ADR-01 표가 진실이다
- **결정:** 모든 업무 사실은 형식이 정해진 STRICT 표의 행이다. 작업 기록(`events`)은 감사, 5분 복구 구간, 옛 엔진과의 대조에 쓰고, 평소에는 그것으로 상태를 다시 만들지 않는다.
- **이유:** 앞으로 이 코드를 고칠 사람과 AI 에이전트가 평범한 SQL로 이해할 수 있고, 돈 · 재고 규칙을 데이터베이스가 직접 지킬 수 있다. 측정한 성능도 충분하다.
- **버린 것:** B의 이벤트가 진실 · 투영은 버릴 수 있는 구조(모든 옛 이벤트 모양의 변환기를 영원히 유지, 투영 재구축 중 쓰기 멈춤, 저장된 진실에 데이터베이스 제약이 거의 없음). C의 JSON 본문 묶음(관계가 JSON 안에 있어 외래 키가 없고, 장부 행까지 제자리 변환).

### ADR-02 control과 shop, 두 데이터베이스
- **결정:** 계정 · 세션 · 로그인 기록 · 요금제 · 라이선스 · 스키장 템플릿 · 플랫폼 사용 내역 · 백업 목록 · 매장별 epoch · 매장을 알기 전의 길 찾기(링크 토큰, 업체 번호, 콜백 받은편지함)는 `control.sqlite`, 매장이 가진 모든 것은 `shop-<id>.sqlite`. 두 파일 사이 외래 키는 없고, 매장 행은 계정을 행위자 키(`staff:<id>`)와 이름 스냅샷으로만 가리킨다. 라이선스는 공급자가 Ed25519로 서명한 토큰이고 매장 서버가 앱에 든 공개 키로 확인한다. 매장 PC의 control이 나중에 중앙으로 합쳐져도 키를 다시 매기지 않게 계정은 전역 ULID, 로그인은 `(영역, 이름)`, 사용 내역 사슬은 파일마다, 템플릿 · 요금제는 고정 id다. PostgreSQL에서는 control과 매장 표가 다른 스키마다.
- **이유:** 매장 파일을 따로 옮기거나(SaaS 매장별 파일, PostgreSQL) 계정을 지워도 장부가 깨지지 않는다. 매장 PC의 파일을 고쳐도 라이선스가 풀리지 않는다. NAT 뒤의 매장 PC와 행 보안 아래의 공유 표에서도 문자 · 결제 콜백과 손님 링크가 매장을 찾는다.
- **버린 것:** A의 한 파일 안 계정 FK(매장별 분리 때 수백 개 FK가 깨짐, 서명 없는 라이선스 행). 서명 없는 라이선스(B · C).

### ADR-03 매장 경계와 '같은 접수'를 데이터베이스가 보증
- **결정:** 모든 매장 표는 `shop_id`로 시작하는 키와 복합 외래 키를 쓴다. 접수에 딸린 행은 `(shop_id, order_id, x_id)`로 참조해 같은 접수임을 보증하고, 규격 · 선택지 · 속성 대상 · claim의 장비 · 돈통의 마감 범위도 같은 방식으로 맞춘다. 0001 뒤에 생기는 참조는 복합 FK가 있는 새 연결 · 확장 표를 먼저 쓰고(이동 · claim · 업무 · 조정 · 거래처 거래 · 재고 위치의 새 출처는 반드시), 꼭 열로 더해야 하면 `sys_soft_references`에 적어 검증기가 매일 확인한다.
- **이유:** 다른 매장 · 다른 팀의 행에 붙는 실수를 코드가 아니라 데이터베이스가 막는다. SQLite는 열을 더할 때 복합 FK를 달 수 없으므로 그 빈틈을 숨은 트리거가 아니라 눈에 보이는 목록과 검증기로 메운다.
- **버린 것:** A의 테넌시 트리거(열마다 기억해서 만들어야 하는 숨은 SQLite 전용 규칙). C의 `location_kind/location_id` 같은 다형 참조(FK 검사 불가, 잘못된 차량 id가 조용히 남음).

### ADR-04 DDL에 닫힌 목록이 없다
- **결정:** 코드가 뜻을 아는 값은 `sys_*` 표(마이그레이션만 넣음, FK 대상), 매장이 바꾸는 값은 레지스트리. 화면 설정이 가리키는 코드 키(화면 경로, 칸 그리기, 맞춤, 정렬 · 묶음, 색, 조건, 상태 값, 동작 · 확인 창, 입력 방식)도 모두 sys 표 FK다. 동작 값(부호, 배타, 묶임, 기사 허용, 오프라인 허용, 자동 재시도, 환불 대상 필요, 현금 여부)은 형식 있는 열이고, 규칙이 되는 값은 행에 복사해 복합 FK로 원본과 맞춘다. `CHECK`는 바뀌지 않는 규칙(0/1, 부호, 범위, 계산식)에만 쓴다. 유일성은 모두 이름 있는 인덱스로 적는다.
- **이유:** 새 값은 INSERT이고, 규칙을 바꿀 때 표를 다시 만들 필요가 없다. 표 안 `UNIQUE`는 나중에 풀 수 없지만 인덱스는 바꿀 수 있다(예: 강습 여러 회차).
- **버린 것:** `CHECK (x IN (…))` 목록. B의 `code_lists`(FK 대상이 될 수 없음). C의 `meta` JSON 안 동작 값(검사 불가).

### ADR-05 동작은 능력 값에서, 리프트권과 강습은 평범한 품목
- **결정:** 코드는 `fulfillment_mode_key`, `tracking_key`, `return_policy_key`, `ticketed`, `ends_same_day`, `extendable`, `exchangeable`, `requires_time_slot` 같은 값을 보고, `'liftTicket'` · `'ski'` · 한글 이름을 비교하지 않는다. 줄은 만들 때 계열 · 재고 방식 · 반납 정책을 복사한다.
- **이유:** 옛 코드의 리프트권 분기 약 30곳과 스키 · 보드 고정 교환을 없애고, 강습 줄이 접수를 영원히 열어 두는 문제를 없앤다. 새 종류는 행 추가다.
- **버린 것:** 분류 글자로 가르기. 종류마다 다른 표.

### ADR-06 ID · 돈 · 시간
- **결정:** 모든 새 id는 전역 ULID(기기가 미리 만들 수 있음; 서버가 만드는 id는 요청에서 정해짐), 옛 id는 매장 코드 접두어(`shop1.ski`). 돈은 정수 원, 비율은 basis point, 부호는 어휘 표. 시각은 UTC, 매장마다 시간대와 영업일 기준 시각. 온라인 명령의 발생 시각은 서버가 받은 시각, 큐 명령은 서버 시각 − 기기의 단조 시계 나이. 돈 · 재고 · 청구 기록마다 `occurred_at` · `recorded_at` · `business_date`(일어난 날) · `posting_date`(세는 마감일, 마감 범위마다의 기준선)를 저장하고 다시 계산하지 않는다.
- **이유:** 통신이 끊긴 차량도 기록을 만들 수 있고, 매장 파일을 합치거나 다른 매장으로 장비를 보내도 id가 겹치지 않으며, 틀린 기기 시계가 날짜를 옮기지 않고, 야간 기준 시각을 나중에 정해도 지난 기록이 움직이지 않으며, 마감 뒤 들어온 돈 · 청구도 원래 날짜를 잃지 않고 닫힌 날 사이로 새지 않는다.
- **버린 것:** KST 고정. A의 늦은 기록이 `business_date`를 다음 날로 덮어쓰는 방식.

### ADR-07 추가만 하는 장부를 데이터베이스가 지킨다
- **결정:** 장부 49개 표(돈, 배분, 조정, 세금 문서, 현금, 넘기기 · 확인, 이동, 이동 줄, 되돌리기 연결, 품목 바꾸기, 상태 변경, 취소 · 연장, 마감 · 다시 열기 · 합계 · 인계, 거래처 거래 · 정산, 설정 판, 템플릿 판, 기기 로그인, 보관 목록 · 확인 등)에 **0001의 열 목록으로** 수정을 막는 트리거(`BEFORE UPDATE OF …`)와 삭제를 막는 트리거를 둔다(생성 스크립트가 만들고 CI가 확인). 나중에 더한 열은 마이그레이션이 채운 뒤 '한 번만' 트리거를 단다. 자유 글 칸은 `(지움)`으로 가리기만 된다. 연결마다 `recursive_triggers = ON`이라 `INSERT OR REPLACE`도 막힌다. 청구 쪽도 같다: 품목 줄의 가격 · 수량 · 날짜 · 스냅샷은 고정, 접수 · 줄 · 약속 · 장비 · 업무 행은 지워지지 않는다. 장부 행에 있던 바뀌는 칸은 따로 뺐다: 되돌리기는 `stock_movement_reversals`, 마감 잠금은 `business_days`, 현금 확인은 `cash_transfer_confirmations`, 할인 변경은 새 적용 행. 작업 기록은 추가 전용 확인 행이 있는 시즌 보관 범위만 지울 수 있다. 장부 행에는 개인정보가 없다.
- **이유:** 약속이 아니라 규칙이 되어야 코드에 버그가 있어도 돈 기록이 안전하다. 옛 처리기를 새 표 위에서 돌릴 때 번역이 빠진 곳도 바로 드러난다.
- **버린 것:** A의 '관례로만 추가'.

### ADR-08 장비 claim은 차선(lane)으로
- **결정:** claim 종류마다 차선(preparation · transport · disposition · composition · ticket_window)이 있고, 배타 차선마다 살아 있는 claim은 하나다(`exclusive_key = asset_id || '|' || lane_key` + CHECK + 부분 유일 인덱스). 그 위에 **장비마다 살아 있는 묶임(`asset_bindings`: 어느 접수 · 권 공용 창 · 환불 · 대여) 하나**가 있고, 묶임 차선의 claim은 모두 그 장비의 묶임에 걸린다(복합 FK). 종류와 차선, 차선과 배타 · 묶임 값이 맞는지도 FK로 확인한다. 물건이 실제로 옮겨진 사실은 계획(claim)보다 이긴다: 이동은 늘 적고 부딪힌 계획을 `displaced_by_fact`로 푼다.
- **이유:** 준비한 장비에 차량 적재 claim을 걸 수 있으면서, 같은 장비를 두 차량이 잡거나 **차선이 달라도 두 접수에 약속하는** 일(A 접수 준비 + B 접수 적재, 내일 손님 권의 발권처 환불)은 데이터베이스가 막는다. 새 차선은 행이다.
- **버린 것:** A의 배타 칸 하나(준비와 적재가 부딪힘). B의 `claim_group`(차선 값 확인 없음).

### ADR-09 돈: 실제 돈 한 건 + 배분 + 현금 이동 하나
- **결정:** `payments` 한 행 = 카드 한 번 · 현금 한 번, `payment_allocations`가 여러 접수 · 줄로 나눈다(옮길 때는 음수 배분 + 사유, 수량도 같은 부호). `payment_groups`(결제 자리), `payment_intents` + `payment_intent_allocations` + `order_checkout_locks`(카드 · PG, 한 팀에 열린 결제 하나), `payment_promises`(결제할 팀 · 시점 · 선입금; 내는 팀 쪽에도 보임), `cash_movements`(마감이 현금을 읽는 단 한 곳). **돈 종류마다 현금 장부는 하나**(거래처 · 강습팀 · 발권처 환불 돈은 거래처 정산만). 환불 대상 · 보증금 · 돈통 · 조정 부호는 복사본 + FK + CHECK로 데이터베이스가 지킨다. 카드 승인번호는 유일하지 않으므로 거절 대신 확인 필요. 세금은 수납이 아니라 줄의 분류와 세금 문서(ADR-17).
- **이유:** 여섯 가족 한 번 결제에서 승인번호가 한 건으로 맞고 모든 팀 미수가 0이 된다. 차량 지갑 · 발권처 환불금 · 거래처 현금이 모두 한 곳에서 **한 번씩만** 세어진다. 실제로 받은 카드 돈이 유일성 규칙 때문에 기록되지 못하는 일이 없다.
- **버린 것:** C의 접수마다 결제 행(승인번호를 한 행에만 둘 수 있는 문제). 옛 '결제 하나 = 접수 하나'.

### ADR-10 동시 수정: 충돌 키, 사실은 거절하지 않음
- **결정:** 결정을 바꾸는 명령(intent)은 **확인 창이 그린 읽기 모델의 `{epoch, rev}`**를 보내고, 서버가 명령에서 만든 충돌 키(바꾸는 키 + 그 결정이 기대는 돈 · 수량의 읽은 키)가 그 뒤 바뀌지 않았고 `expect`(받을 돈 등)가 맞으면 자동으로 이어 붙인다(달라진 것은 한 줄 띠로). 일어난 사실(fact)은 버전을 보지 않고 불변식만 보며, 사실 안의 결정 부분만 intent처럼 본다. 앞뒤가 안 맞으면 `확인 필요`가 그 일을 일으킨 기기 · 화면에 쉬운 한 문장으로 가고(급한 것은 열린 창 안의 단계), 관리자 목록은 쌓인 것이다. 방문 순서는 업무마다 한 행의 분수 순위(기준 업무로 보내고 나중 결정이 이김), 빨리 확인은 업무마다 하나.
- **이유:** 진짜로 같은 결정을 두 사람이 바꾸거나 결정의 바탕이 바뀌었을 때만 충돌이 난다('그사이 이 팀이 120,000원을 냈습니다'). 고령 직원은 기술 용어 없는 한 문장과 버튼 두 개만 본다.
- **버린 것:** 옛 매장 전체 버전. C의 접수 전체 버전(다른 줄 약속끼리 충돌). A의 순위 행 다시 쓰기.

### ADR-11 멱등과 작업 기록
- **결정:** `command_log`는 받은 모든 명령을 영원히 남기고 결과 본문만 90일 뒤 비운다. **멱등 키는 요청번호 하나**(행위자는 데이터: 큐 명령은 기기가 서명한 그때의 직원). 요청번호는 확인 창이 열릴 때 만들어 모든 재시도에 쓰고, 지문은 종류 · 판 · 본문만. `(device_id, device_seq)`는 유일하기만 하고 빈 번호를 찾는다. `dependsOn`은 돈을 멈추지 않는다. 시스템 명령은 정해진 요청번호. `events`는 서버가 정한 값이 모두 든 정본 명령(개인정보 · 자유 글 없음), 넣은 장부 행의 해시, 개인정보의 약속값과 해시 사슬(보관 파일 경계에 앞뒤 해시)을 가지고, 개인정보와 자유 글은 `event_pii`(30일)에 따로 둔다.
- **이유:** 늦게 온 재시도, PIN을 바꾼 뒤의 재시도, 기사가 바뀐 휴대폰의 큐도 두 번 적용되지 않고 원래 사람의 기록으로 남는다. 한 명령이 사라져도 그 기기가 멈추지 않는다. 돈 다툼에서 **표의 행까지** 고치지 않았음을 보일 수 있고, 개인정보를 지워도 사슬이 깨지지 않는다.
- **버린 것:** A의 30일 멱등 · NULL 행위자. C의 거절 미기록. B의 이벤트 진실 위 해시 사슬(보관 파일을 넘는 검증이 무거움 → 앞뒤 해시로 해결).

### ADR-12 백업과 복구
- **결정:** `synchronous = FULL`, **커밋마다 몇 초 안에 작업 기록 구간(바뀐 행의 after-image 포함)을 LAN의 다른 기기로 흘려 보내고**, 5분마다 두 번째 디스크 · USB, 묶이는 대로 원격, 1시간마다 `VACUUM INTO` 전체 백업 48개(배포 · 마이그레이션 직후에도), control 파일도 같은 복구 기록, 매주 자동 복구 시험. 복구 = 전체 백업 + 구간의 **after-image 적용**(처리기 코드가 바뀌어도 같은 결과) + 새 epoch + **지금까지 쓴 가장 큰 rev** 위로 1,000,000 도약 + 사람이 읽는 번호 건너뛰기 + 기기들이 7일 보낸 기록을 **그때 서버가 정한 값과 함께** 다시 보냄(같은 id · 같은 접수 번호) + 재시도 없는 채널은 사람이 확인.
- **이유:** 카운터 1이 서버 PC에서 도는 기본 배치에서도 잃는 것은 아직 흘러가지 않은 몇 초다. 다시 보낸 명령이 다른 번호 · 다른 id를 받거나 문자 · 카드가 두 번 나가는 일이 없고, 복구를 두 번 해도 잃은 rev 번호로 만든 옛 id가 다시 쓰이지 않는다.
- **버린 것:** C의 밤 한 번 백업 · 큐를 확인 목록으로만. A의 큐만 다시 보내기(받았다고 답한 뒤 잃은 명령을 복구 못 함).

### ADR-13 확장은 추가로만, 매장 칸은 형식 있는 속성 행
- **결정:** 확장 방법 E1–E12(레지스트리 행, `sys_*` 행 + 코드, 속성, 빈 값 허용 열 + 채우기 + 한 번만 트리거, 새 표, 설정 판, 기능, 화면 설정 + 기본 설정 반영, 인덱스, 속성 → 열 올리기, JSON 문서 새 판, 새 모양이 필요하면 `*_v2` 표 + 뷰). 매장이 정하는 칸은 주인별 값 표 10개(주문, 줄, 일행, 고객, 상품, 규격, 장비, 업무, 장소, 거래처)에 형식 있는 값으로, 여러 값은 `value_seq`. 마이그레이션은 앞으로만, CI 검사가 금지 문장을 막고, 허용되는 트리거는 정해진 네 모양뿐이다. **'빈 예약 표는 다시 만든다'는 예외는 없앴다**(매장 파일마다 따로 마이그레이션해 확인할 수 없고, 예약 표가 이미 FK 대상이므로). 대신 강습 · 보증금 · 지점 · 카드 단말 · 알림 표의 키를 0001에서 정했다.
- **이유:** 객실 번호 같은 새 칸은 코드 없이 행으로 생기고, 선택지 · 대상이 FK로 검사된다. 핵심이 되면 열로 올린다.
- **버린 것:** C의 JSON `attrs` · `body`(형식 검사와 FK가 없음, 제자리 변환). 대상 id가 다형인 일반 EAV 표 하나.

### ADR-14 옮기기: 두 줄기와 멈춤 기준
- **결정:** 저장은 첫날부터 새 표. 검증된 옛 처리기는 codec과 facade로 새 표 위에서 **그대로** 돌고(legacy 줄기; 사실 명령은 native 사실 어댑터 뒤에서 — 맞는 부분만 적용하고 거절하지 않음, 옛 명령마다 자기 명령 종류 행과 충돌 키), 12월 우선순위 · 돈 · 마감 · 차량 업무 · 계정 · 동기화는 native로 새로 쓴다. 표현 규칙과 codec 왕복 시험이 두 줄기를 맞춘다. 222개 시험은 그대로(모드 A)와 새 표 위(모드 B)에서 돈다. 11월 연습 기간에 새 서버로 바꾸고 옛 엔진은 그림자 대조. G1(11/6)을 못 넘으면 옛 서버로 시즌(F1), G2(12/1)에 화면만 모자라면 포스 v4를 `/api/v1`로(F2).
- **이유:** 10주 안에 약 400 KB의 옛 규칙을 다시 쓰는 대신, 옛 기능 전부가 2주차부터 새 저장소에서 돌고 12월 일은 새 기능에만 쓴다. 직원은 11월에 실제 새 시스템으로 연습한다.
- **버린 것:** A의 10주차 한 번에 바꾸기(모든 묶음 재작성). B의 7주차 기준 이벤트 저장소 + 옛 id 흉내 다리 + 옛 엔진 주 서버 그림자. 판정 3의 '옛 처리기는 대조용으로만' — facade를 운영에 쓰되 LOAD_PLAN 측정, 성능 기준, 대안으로 범위를 묶었다.

### ADR-15 화면은 설정으로 그린다
- **결정:** C 장부를 바탕으로 A 지금 줄, B2 남은 일 목록, A3 ▲▼를 섞고 왼쪽 레일을 없앤다(화면 지도는 ui 3-6). 코드(DeviceProfile, 부품, 코드 키 어휘, 칸 맞춤 계산) · 매장 데이터(도장 단계, 장부 칸 · 탭 · 바닥줄 · 동작, 메뉴, 상태 문구, 기능) · 기기(잰 크기 + 역할) 세 층. 시스템 기본 설정은 판이 있고 앱이 올라가면 이미 쓰던 매장에도 반영된다(매장이 바꾼 행은 그대로). 칸 폭은 em, 넘치는 목록은 모두 한 모델(우선순위 · 넘칠 때), 같은 계산이 설정 명령에서도 돈다. 화면은 `DomainClient`의 설정으로 그리는 조회 하나(`ledgerView`)로 서버에 붙고, 체험판과 **기사 기기의 오프라인 화면**은 같은 저장소 코드를 브라우저의 SQLite WASM에서 돌린다. 인쇄도 같은 설정.
- **이유:** 새 종류 · 새 도장 · 새 칸 · 새 속성이 행으로 화면과 인쇄에 나오고, 1024×600부터 875×600(설치한 PWA의 1024×529, 125% 확대 포함)까지 말줄임 없이 칸이 빠지고 합쳐지고 모인다. 체험판과 오프라인 기사 화면이 운영과 다르게 움직이지 않는다.
- **버린 것:** 화면마다 코드로 가르기(옛 v4). 체험판 전용 가짜 로직. 처음 한 번 복사하고 끝나는 기본 설정.

### ADR-16 한 사업자의 여러 위치는 한 파일의 지점, 하루는 마감 범위마다 닫는다
- **결정:** 두 번째 가게 · 따로 닫는 건물은 같은 매장 파일의 지점(`branches`)과 마감 범위(`closing_scopes`, 기본 `main`)다. `business_days` · 마감 · 기준선 · 돈 · 재고 장부 행이 모두 범위를 가지고, 돈통의 범위와 같아야 한다(복합 FK). 설정 · 기능 · 달력도 범위마다 덮어쓸 수 있다. 서로 다른 사업자는 늘 다른 테넌트이고, 다른 테넌트로 물건을 보낼 때는 양쪽 이동이 전역 `transfer_ref`를 나눠 가진다.
- **이유:** 18:00에 닫는 지점과 23:00에 닫는 본점이 서로의 마감을 막지 않는다. 두 파일을 한 파일의 지점으로 합쳐도 키를 다시 매기지 않는다. 채워진 뒤에는 바꿀 수 없는 `business_days` · 마감의 키를 지금 정했다.
- **보류한 것:** 사업자 단위의 공유 고객 · 적립(가맹)은 필요해질 때 control의 새 표(E5)로.

### ADR-17 세금은 줄에서, 세금 문서는 따로
- **결정:** 품목 종류 · 상품의 세금 분류(`sys_tax_categories`), 줄의 분류 · 공급가 · 부가세 스냅샷, 수납에 붙는 추가 전용 `tax_documents`(현금영수증 · 세금계산서)와 개인정보인 신원은 따로(`tax_document_identities`).
- **이유:** 한 카드가 과세 대여 · 대행 리프트권 · 면세 강습을 함께 낼 수 있어 수납 한 행의 부가세 칸은 틀린 단위이고, 추가만 하는 장부에 한 번 쓰면 고칠 수도 없다.
- **버린 것:** S14 예시였던 `payments.tax_amount`.

## 심사에서 나온 약점과 해결

| 약점(심사) | 해결 |
|---|---|
| A: 나중 참조 열에 복합 FK를 달 수 없어 테넌시 트리거에 의존(1 · 3) | ADR-03: 연결 · 확장 표 먼저, 열이면 `sys_soft_references` + 검증기. 트리거 없음 |
| A: 배타 claim 차선이 하나(1) | ADR-08 차선 |
| A: 늦은 사실이 `business_date`를 덮어씀(1) | ADR-06 `posting_date` |
| A: 템플릿의 표 안 UNIQUE + version(1) | `print_templates` + `print_template_versions`, `message_templates` + 판, 스키장 템플릿 판(control) |
| A: 추가만이 관례뿐, 장부 행의 수정 칸(1) | ADR-07 트리거(장부 49개, 0001 열 목록), 수정 칸을 따로 뺌 |
| A: 복구 때 받았다고 답한 명령을 잃음, NULL 행위자(1 · 3) | ADR-11 · 12 |
| A: 고객 속성 표 없음(1) | 속성 값 표 10개 |
| A: 한 번에 바꾸기, 거래처 · 화면 줄기 없음, 시험 160개 옮기기, 수동 되돌리기(2) | ADR-14 두 줄기, 거래처는 시즌 1 legacy, 화면 줄기 1주차부터, 시험은 그대로 A · B, 기록한 명령으로 되돌리기 |
| A: 계정 FK가 한 파일에, 서명 없는 라이선스(3) | ADR-02 |
| A: 변경 목록의 `vehicle_id` 하나(업무를 옮기면 옛 기기에 남음)(3) | `change_log.scope_key` + tombstone |
| A: 191표를 1주차에, 대안 없음, PIN 없음(3) | 예약 표의 키를 0001에서 정함(검토 반영, '빈 표 다시 만들기' 예외는 없앰), F1 · F2, PIN 전환 |
| B: 저장된 진실에 제약이 거의 없음, 투영 재구축, 영원한 변환기, 측정 없음, 일정 위험(1 · 2 · 3) | ADR-01로 채택하지 않음. 좋은 점(control 분리, 해시 사슬, 충돌 키, 명령 기록 영구, 보낸 기록 다시 보내기, 5분 구간, 두 날짜, 현금 이동, 판별 템플릿, 명령 한 번 접수 확정, 멈춤 기준)만 가져옴 |
| C: 위치 · 현금 보관자의 다형 참조(1) | `stock_locations`, `cash_drawers` FK |
| C: 관계가 JSON 안에(1) | 조기 반납 · 업무 옮김 · 준비는 FK 있는 표 |
| C: 장부 행 JSON 제자리 변환, 해시 없음(1 · 3) | 장부 JSON 다시 쓰기 금지(E11), 해시 사슬 |
| C: 취소가 줄을 수정(1) | 취소 줄 장부 + 투영 |
| C: 밤 한 번 백업, `synchronous = NORMAL`, 큐를 확인 목록으로(1 · 3) | ADR-12 |
| C: 접수 전체 버전(1 · 3) | ADR-10 충돌 키 |
| C: 동작 값이 meta JSON(1) | 형식 있는 열 |
| C: 거래처 거래 하나로 뭉침(1) | 거래 · 거래 줄 · 정산 · 배분, 방향은 종류 |
| C: 승인번호 함정(1) | ADR-09 |
| C: 표현 규칙 없음, native 명령의 되돌리기(2) | migration 3-4 표현 규칙, 4절 낮추기 대응 |
| C: 화면 줄기 없음, JSON 본문 흔들림(2) | 화면 줄기, JSON 본문 없음(잔여는 `legacy_records`에만) |
| C: 운영 facade의 복잡함(3) | LOAD_PLAN_MISS 측정 · 성능 기준 G1 · F1, 이음매 셋뿐, 시즌 뒤 묶음별 제거 |
| C: 기사에게 JSON 속 개인정보가 샐 수 있음(3) | JSON 본문 없음, 역할별 자르기(작은 접수 카드) |

## 열린 질문

1. **리프트권 반납 정책:** 권은 지급하면 끝(optional, 지금 값)인가, 늘 돌려받아야 하나(required)? 질문지 2번. 종류 값 하나만 바뀐다.
2. **야간 영업일 기준 시각:** 지금 00:00. 자정 넘는 야간 반납을 어느 날로 셀지 사장님이 정하면 설정만 바꾼다(지난 기록은 그대로).
3. **개인정보 보관 기간:** 손님 이름 · 전화를 몇 년 뒤 지울지(기본 3년으로 둠)와 거래 기록 보관 의무를 세무 담당과 확인.
4. **실제 운영 자료:** ski-rent-ops 운영 서버에 실제 손님 자료가 있는지, 몇 건인지(가져오기 크기).
5. **왼쪽 레일 없애기:** docs/35 1절과 docs/42 부록 A를 바꾸는 결정 — 사용자 확인 뒤 1주차에 개정.
6. **시즌 1 관리 화면:** 설정 · 재고 · 거래처 관리 화면을 포스 v4로 두어도 되는지(관리자만 씀). 화면 설정(칸 · 탭 · 메뉴)은 시즌 1 동안 공급자만 설정 명령으로 바꾸기로 했다(ui 문서 2절) — 사장님이 직접 고칠 일이 있는지.
7. **체험판:** SQLite WASM 묶음 크기가 Pages 체험판에 괜찮은지. 안 되면 읽기 전용 체험판. 기사 기기의 오프라인 화면은 같은 WASM이 필수다.
8. **기사 휴대폰 누르는 곳:** docs/42의 52px 대신 56px(장갑)로 올리는 것.
9. **원격 백업 위치와 담당:** 클라우드 저장소인지 다른 PC인지, 누가 확인하는지(docs/34).
10. **라이선스 과금 단위, 사용 내역 보관 기간, 관리자 인증 방식:** docs/45에 남은 결정.
11. **개장일:** 10주차 계획의 끝(12/4)과 멈춤 기준 G2(12/1)가 실제 개장일에 맞는지.
12. **남은 확인 질문지 23개:** 답이 오면 설정 · 레지스트리 값으로 반영(대부분 구조 변경 없음).
13. **세금 분류:** 리프트권을 대행(수수료만 매출)으로 볼지, 강습이 면세인지, 현금영수증 · 세금계산서를 스키노트에서 낼지(세무 담당). 종류 값과 설정만 바뀐다(ADR-17).
14. **서버 PC:** 카운터 1이 도는 PC가 서버이면 서버 PC와 LAN의 받는 기기가 함께 망가질 때 몇 분을 잃을 수 있다. 서버를 카운터가 아닌 PC(작은 PC)에 둘 수 있는지, LAN으로 작업 기록을 받을 기기(카운터 2)를 어떤 것으로 할지.
15. **카운터 PC 화면:** 작업 표시줄 자동 숨김을 해도 되는지(설치한 PWA의 실제 높이 1024×569). 안 되면 1024×529로 설계한 쪽 수가 기준이 된다.

## 용어

| 한국어 | 식별자 |
|---|---|
| 매장 · 사업자 · 지점 | `shops` / `tenants`(control) · `businesses` · `branches` |
| 계정 · 직원 · 역할 · 권한 | `accounts` · `staff_members` · `roles` · `role_permissions` / `sys_permissions` |
| 기기 · 기기 등록 번호 | `devices` · `device_enrollment_codes` |
| 라이선스 · 요금제 | `licences` · `plans` · `plan_features` |
| 사용 기능 · 매장 설정 | `shop_features` · `shop_settings` |
| 영업일 · 마감 기준일 | `business_date` · `posting_date` |
| 영업일 잠금 · 마감 범위 · 기준선 | `business_days` · `closing_scopes` · posting frontier |
| 통합접수(접수) · 접수 번호 | `orders` · `receipt_no` |
| 대표자 · 일행 · 접수 차수 | `orders.customer_name` · `order_people` · `order_batches` |
| 품목 줄 | `order_lines` |
| 품목 종류 · 상품 · 가격 묶음 · 규격 | `item_kinds` · `catalog_items` · `price_groups` · `item_variants` |
| 장비 품목 바꾸기 | `asset_reclassifications` |
| 행동 계열 · 재고 방식 · 반납 정책 | `fulfillment_mode_key` · `tracking_key` · `return_policy_key` |
| 세트 · 구성품 | `is_bundle` · `catalog_item_components` |
| 속성(사이즈 칸 등) · 선택지 · 자리 | `attribute_definitions` · `attribute_options` · `attribute_placements` |
| 수령 약속 · 반납 약속 | `line_promises`(`pickup` · `return`) |
| 매장 수령 · 차량 배달 · 매장 직접 반납 · 차량 수거 | `shop_counter` · `vehicle_delivery` · `shop_direct` · `vehicle_collection` |
| 반납 타임 · 수령 시각 | `return_slots` · `pickup_time_options` |
| 구역 · 장소(숙소) | `areas` · `places` |
| 요금표 · 판 · 규칙 · 기간별 합계 | `price_lists` · `price_list_versions` · `price_rules` · `price_rule_tiers` |
| 평일 · 주말 · 성수기 · 시즌 | `day_types` · `calendar_days` · `seasons` |
| 할인 · 할인 묶음 · 할인 적용 | `discount_rules` · `discount_groups` · `discount_applications` |
| 가격 내역 | `line_price_components` |
| 결제 칸(장비 · 리프트권 · 강습) | `payment_sections` |
| 수납 · 환불 · 보증금 | `payments`(`payment` · `refund` · `deposit_*`) |
| 예약금 · 선입금 | `purpose_key = 'prepayment'`, 설정 `prepayment_mode` |
| 결제 묶음 · 결제할 팀 · 나중에 | `payment_groups` · `payment_promises.payer_order_id` · `timing_key = 'later'` |
| 배분 · 수납 옮기기 | `payment_allocations` · `payment_reallocations` |
| 카드 결제 요청 | `payment_intents` |
| 미수 · 과수납 | `orders.due_amount` · `orders.credit_amount` |
| 금액 조정 | `charge_adjustments` |
| 돈통 · 차량 지갑 · 넘기는 중 · 과부족 · 현금 넘기기 · 넘김 확인 | `cash_drawers`(`counter` · `vehicle` · `transit` · `over_short`) · `cash_transfers` · `cash_transfer_confirmations` |
| 세금 분류 · 현금영수증 · 세금계산서 | `sys_tax_categories` · `tax_documents` |
| 카드 결제 잠금 | `order_checkout_locks` |
| 현금 입출금 · 현금 이동 | `cash_entries` · `cash_movements` |
| 마감 · 다시 열기 · 인계 | `closings` · `closing_reopenings` · `closing_handover_items` |
| 장비(하나) · 리프트권(실물) | `assets` · `ticket_units` |
| 재고 위치 · 수량 재고 · 잡아 두기 · 묶임 | `stock_locations` · `stock_balances` · `stock_holds` · `asset_claims` · `asset_bindings` |
| 지급(매장 → 손님) · 적재(매장 → 차량) · 전달(차량 → 손님) | `stock_movements.kind_key`: `deliver` · `load` · `deliver` (출발 위치 종류로 구분) |
| 받음(손님 → 차량) · 매장 입고(차량 → 매장) · 매장 반납(손님 → 매장) · 되돌리기 | `collect` · `receive` · `direct_return` · `reversal` |
| 정비 상태 | `asset_conditions` · `asset_condition_changes` |
| 준비(규격·준비) | `preparations` · `preparation_items` |
| 교환 · 조기 반납 | `exchanges` · `early_returns` |
| 발권 · 권 배정 · 예비권 · 발권처 환불 | `ticket_issue` · `line_fulfillment` claim(`ticket_window`) · 배정 없는 권 · `vendor_refunds` |
| 강습 · 강습팀 · 강습 위탁 | `service_bookings` · `counterparties`(`lesson_team`) · `lesson_consignment` |
| 거래처 · 거래처 장부 · 정산 | `counterparties` · `counterparty_trades` · `counterparty_settlements` |
| 차량 · 기사 배정 | `vehicles` · `vehicle_assignments` |
| 차량 업무(배달 · 수거) · 방문 결과 | `tasks` · `task_visits` |
| 방문 순서 · 빨리 확인 | `route_positions` · `task_pins` |
| 알림(요청됨 · 도착 · 확인) | `notifications`(`requested` · `delivered` · `acknowledged`) |
| 사이즈 요청 · 입력폼 · 직원 확인 | `intake_requests` · `intake_submissions` · `intake_reviews` |
| 대여 장부 · 접수증 · 수거 목록 · 기사 목록 | `ledger_views`(`day_ledger` · `order_slip` · `collection_list` · `driver_list`) |
| 도장 · 도장 단계 · 남은 일 목록 | `Stamp` · `stamp_steps` · `Checklist` |
| 색인 탭 · 바닥줄 숫자 · 지금 줄 | `ledger_view_tabs` · `ledger_view_metrics` · `NowLine` |
| 기기 등급 | `sys_device_classes` / DeviceProfile |
| 인쇄 틀 · 인쇄 작업 | `print_templates` · `print_jobs` |
| 문자 · 보낼 일 | `message_deliveries` · `outbox` |
| 확인 필요 | `review_items` |
| 요청 기록 · 작업 기록 · 변경 목록 | `command_log` · `events` · `change_log` |
| 충돌 키(쓰기 · 읽기) · 보냄 대기 · 보낸 기록 | `intent_marks` · 기기 `queue` · 기기 `sent`(서버가 정한 값 포함) |
| 기기 로그인 기록 · 서명된 행위자 | `device_sign_ins` · `recordedBy` |
| 작업 기록 구간(after-image 포함) · 백업 · 복구 시험 | `journal_exports` · `backups` · `restore_drills` |
| 사실 어댑터 | fact 명령을 옛 처리기 앞에서 받는 native 층(`engine_key = 'adapter'`) |
| 화면 기본 설정 반영 | `ui-defaults.json` · `ui_defaults.apply` · `ui_default_applications` |
| 도장 상태 · 도장 모음 · 단계 사슬 | `sys_stamp_states` · `collapse_group_key` · `ledger_view_column_steps` |
| 사용 내역(감사) | `events` + `config_changes`(매장), `platform_audit_log`(플랫폼) |
| 옛 자료 · 옛 처리기 · 새 처리기 | `legacy_records` · legacy facade · native |
| 스키장 템플릿 | `resort_templates` · `resort_template_versions` · `template_applications` |

## 검토 반영 기록

2026-09-23, 공격적 검토 93건(높음 26 · 중간 49 · 낮음 18)을 네 관점에서 받았다: 다시 만들기 사냥(R), 돈과 재고(M), 동시 수정 · 오프라인 · 동기화(C), 화면 확장(U). 모두 설계 파일을 고쳐 **반영**했다. 일부만 미룬 것은 R3의 '사업자 단위 공유 고객 · 적립' 하나이고(필요할 때 control의 새 표로 더할 수 있어 다시 만들 일이 없다), 여러 방법 중 하나를 고른 것은 결정 칸에 적었다. 고친 뒤 `schema.sql`을 다시 실행해 FK 853묶음 문제 0, 표 안 UNIQUE · 목록형 CHECK 0, 동작 시험 88개 통과, 다섯 시즌 쓰기 0.58–0.64 ms를 확인했다.

### 다시 만들기 사냥(R)

| # | 무게 | 지적 | 결정 | 바뀐 곳 |
|---|---|---|---|---|
| R1 | 높음 | 두 번째 가게가 자기 하루를 닫지 못함(영업일 · 마감이 매장 단위, `branch_id`가 일부 표에만) | 반영: 한 사업자의 위치는 한 파일의 지점, 마감 범위를 0001 키에 | schema `closing_scopes`, `business_days` 키 · 마감 유일 · FK, 모든 돈 · 재고 장부의 `closing_scope_id`, 돈통 `(id, 범위)` FK 대상, `shop_features` · `shop_settings`의 `scope_key`, `calendars` · `calendar_days`; data-model 2-4 · 3-3 · 4-3 · 4-13; ADR-16 |
| R2 | 높음 | 이동 기록이 있는 장비를 다른 상품으로 못 옮김(이동 줄이 (장비, 상품)을 묶음) | 반영 | schema 이동 줄은 `(shop_id, asset_id)` FK + 상품 스냅샷, `asset_reclassifications`, `assets_item_id` 지움; data-model 4-9 · S2; catalog 4절 |
| R3 | 높음 | 가맹 공유 재고 · 매장 간 이동 · 매장 합치기를 매장별 파일과 매장 안에서만 유일한 옛 id가 막음 | 반영(일부 보류) | schema 머리말(모든 새 id ULID, 옛 id 매장 코드 접두어), `stock_movements.transfer_ref`, 받는 쪽 `shop_transfer` 경로, 지점 사이 `relocate`; data-model 2-4 · 3-1; migration 3-1 · 3-6 · 5-2; ADR-06 · ADR-16. 보류: 사업자 단위 공유 고객 · 적립 |
| R4 | 중간 | 장부 트리거가 새 열 채우기를 막고, 새 열에 필수 · 범위 규칙을 담을 수 없음 | 반영 | schema 2.19(0001 열 목록의 `BEFORE UPDATE OF`, 생성 스크립트); data-model 7-1 E4 · E10, 7-2(허용 트리거 네 모양); 스모크 '채우기 → 한 번만 트리거' |
| R5 | 중간 | 속성 값이 키 때문에 하나뿐(여러 값 · 값의 단위 불가) | 반영 | schema 값 표 10개와 `intake_answers`의 키에 `value_seq`, `value_unit`, `attribute_definitions.multi_valued`, `money` 형식; data-model 4-7; catalog 5절 |
| R6 | 중간 | 연장이 더 늦은 날짜만 되어 같은 날 · 시간 단위 연장을 못 적음 | 반영 | schema 연장 줄 · 장비의 끝 시각, 반납 타임 스냅샷, 가격 기준, `added_units ≥ 0`, `added_minutes`, 새 CHECK; catalog 14절 |
| R7 | 중간 | 세금 모델이 없고 S14가 부가세를 수납에 둠 | 반영 | schema `sys_tax_categories`, 종류 · 상품 `tax_category_key`, 줄의 세금 스냅샷, `tax_documents` · `tax_document_identities`; data-model 3-2 · S14; catalog 18절; ADR-17 |
| R8 | 중간 | 요금 규칙이 상품만 가리키고 종류마다 할인 묶음 하나(종류 단위 가격 · 묶음을 넘는 패키지 불가) | 반영 | schema `price_groups`, `price_rules` 대상 셋 중 하나(CHECK), `discount_rule_targets`, `package` 묶음; catalog 7 · 8 · 9절; data-model S3 |
| R9 | 중간 | '빈 예약 표 다시 만들기' 예외가 매장별 파일에서 확인 불가, 이미 FK 대상 | 반영: 예외를 없애고 예약 표의 키를 지금 정함 | data-model 7-1 E12 · 7-2; ADR-13; 키 확정은 R1 · R10 · R21 · R22 |
| R10 | 중간 | 수량 품목은 교환 · 조기 반납 · 빌림 · 준비가 안 됨(장비 행 필수) | 반영 | schema `preparation_items` · `exchange_units` · `early_return_assets` · `equipment_loan_items`(장비 또는 규격 + 수량, 키 순번); data-model 4-10; catalog 4절 |
| R11 | 중간 | 매장을 알기 전에 오는 콜백 · 링크의 길이 없음(매장별 파일, 행 보안, NAT) | 반영 | control `public_links` · `external_refs` · `inbound_events`; data-model 2-3; sync 9절; `inbound.record` 명령 |
| R12 | 중간 | PostgreSQL 공유 표에서 한 행짜리 메타 표와 매장별 복구가 깨짐 | 반영 | schema `shop_instance`(매장마다 epoch), `db_instance`는 파일 정체만; data-model 2-3 · 9절(스키마 분리, FK는 `ALTER`, 매장 복구 = after-image 논리 재구성); sync 11절 |
| R13 | 중간 | 언어 정렬 규칙과 나중의 시각 형식 바꾸기가 PostgreSQL 이전을 망침 | 반영: `COLLATE "C"`, 시각은 TEXT + 도메인으로 영원히 | schema 머리말 · `route_positions` 주석; data-model 9절 |
| R14 | 중간 | 매장 PC control을 중앙 control로 옮길 때 키를 다시 매김 | 반영 | control `accounts.login_realm` + `(영역, 이름)` 유일, `platform_audit_log (chain_id, seq)`, 템플릿 · 요금제 고정 id, 계정 전역 ULID; data-model 2-1; ADR-02 |
| R15 | 중간 | 문구가 한국어뿐, 상태 문구 키에 언어가 없음, 저장된 문장을 다시 못 그림 | 반영 | schema `status_terms` 키에 `locale`, `label_translations`, `review_items.message_params_json`, `notifications.template_key` · `params_json`; ui 3-3 · 3-9 |
| R16 | 중간 | 외부 참조 유일 인덱스가 실제 돈을 거절 | 반영 | schema `payments_external_reference` 지움, `approval_no` · `approved_business_date` 찾기 인덱스, (카드 요청, 승인번호) 부분 유일, `possible_duplicate_card`; data-model 3-2 · 4-12; sync 6절 |
| R17 | 중간 | 해시 사슬 · 보관 파일에 지울 수 없는 자유 글 개인정보 | 반영 | schema `events.pii_commitment`, `event_pii.salt`, 장부 자유 글 가리기만 트리거; data-model 원칙 16 · 3-6; sync 2절 |
| R18 | 낮음 | 멱등이 세션 행위자에 묶여 공유 휴대폰에서 어긋남 | 반영 | schema `command_log (shop_id, request_id)` 키, `events_request`, `submitted_by_key`, `actor_signature`, `device_sign_ins`; sync 2 · 6 · 7절 |
| R19 | 낮음 | 인계 항목이 접수를 요구 | 반영 | schema `closing_handover_items.order_id` NULL 허용 + `subject_type_key` · `subject_id`; data-model 4-13 |
| R20 | 낮음 | 수량 재고 키에 주인 · 묶음이 없음 | 반영 | schema `stock_balances` 키 `owner_key` · `lot_key`, 이동 줄 `owner_counterparty_id` · `lot_id`; data-model 4-9 · 7-2(투영 표는 `_v2`) |
| R21 | 낮음 | 강습 예약이 강습팀을 요구, 자정을 넘는 시간이 안 됨 | 반영 | schema `service_bookings.counterparty_id` NULL(`unassigned`), `end_day_offset`(예약 · 시간대); catalog 12절 |
| R22 | 낮음 | 단말 · 전화번호만 받는 NOT NULL(온라인 결제 · 다른 알림 불가) | 반영 | schema `payment_intents.terminal_id` NULL + `provider_key`, `message_deliveries` 채널 · 받는 곳 종류 · 값; data-model 4-12 · 4-15 |
| R23 | 낮음 | 고정된 출처 열과 '주인 하나' CHECK가 새 절차를 못 덮음 | 반영: 새 출처는 1:1 확장 표 필수, '주인 하나'는 검증기 | data-model 7-1 E5 · 4-9 · 4-11 · 5절; schema `stock_locations` 주석; ADR-03 |
| R24 | 낮음 | 장소 쓰임이 고정 불리언 열, 스키장 층이 없음 | 반영 | schema `resorts`, `areas.resort_id`, `place_uses` + `sys_place_uses`(쓰임 열 지움); data-model 4-4 · S4 |
| R25 | 낮음 | 시즌 보관 파일이 마이그레이션 뒤 어긋남 | 반영 | schema `archive_manifests.schema_version` · `epoch_id`; data-model 3-6 · 7-3 |

### 돈과 재고(M)

| # | 무게 | 지적 | 결정 | 바뀐 곳 |
|---|---|---|---|---|
| M1 | 높음 | `INSERT OR REPLACE`가 추가 전용 트리거를 비켜 감 | 반영 | schema 머리말(`recursive_triggers = ON`, 읽어 확인하고 아니면 시작 안 함, CI가 장부에 `OR REPLACE` · `REPLACE INTO` · `INSERT OR IGNORE` 금지); data-model 7-2 · 7-3 · 9절; 스모크 '수납 · 마감을 REPLACE로 덮기' 거절 |
| M2 | 높음 | 같은 현금이 여러 장부에서 두세 번 세어짐 | 반영: 돈 종류마다 현금 장부 하나 | schema `sys_cash_sources`(발권처 환불 시도 뺌, 넘김 확인 더함), `cash_entries.counterparty_settlement_id` 지움, 후불 거래처는 비현금만(CHECK), `counterparty_trades.payment_id`, 정산 하나에 시도 하나; data-model 4-12 · 5절 · S1; catalog 11절; migration 5-3 |
| M3 | 높음 | 차선이 다르면 한 장비가 두 접수 · 목적에 잡힘 | 반영 | schema `asset_bindings`(장비마다 살아 있는 하나), `asset_claims.binding_id` · `lane_bound` + 복합 FK, `sys_claim_lanes.bound`; data-model 4-9; catalog 11절; ADR-08 |
| M4 | 높음 | 계획과 부딪힌 물리적 사실이 버려지고 돈 사실이 FK로 실패 | 반영 | sync 3 · 4-4 · 8-3(사실은 늘 이동, 계획 `displaced_by_fact`, 돈은 dependsOn으로 멈추지 않음, 줄이 없으면 접수 전체 배분); schema `asset_claims.end_reason_key`, `plan_displaced` · `allocation_fallback` |
| M5 | 높음 | 승인번호 유일 인덱스가 실제 카드 · 이체 돈을 거절 | 반영 | R16 + `payment.intent_resolve`(사람의 확인을 요청에 묶어 늦은 단말 결과가 두 번째 수납을 만들지 않음), `extra_card_approval`; sync 9절; data-model S11 |
| M6 | 높음 | 청구 쪽이 바뀔 수 있고 옛 청구가 두 곳에 있음 | 반영 | schema `order_lines_frozen` 트리거(투영 열 밖 고정), 업무 행 삭제 금지 트리거 13개, `orders.legacy_charge_amount` 지움(`legacy_charge` 조정 한 곳), `current_end_*` 투영; data-model 4-6 · 5절; migration 5-3; catalog 8 · 17절 |
| M7 | 중간 | 기준일이 닫힌 날 사이 · 다시 연 지난날로 새고 돈통 이어짐이 없음 | 반영 | data-model 3-3(범위마다 기준선), 4-13(가장 늦게 닫힌 날만 다시 열기, 돈통 예상 = 앞 셈 + rev 창); schema `closing_drawer_counts.prev_closing_id` · `prev_as_of_rev`, `cash_movements_drawer_rev`, `closing_policy` |
| M8 | 중간 | 오프라인 청구와 배분에 기준일이 없음 | 반영 | schema `order_batches.posting_date` · `closing_scope_id`, `payment_allocations`의 날짜 · 행위자 · 요청번호 · 범위; data-model 3-3 · 4-6 · 4-12 |
| M9 | 중간 | 복구가 같은 id · 접수 번호 · outbox 상태를 다시 만들지 못함 | 반영(동기 거울 대신 몇 초 안의 비동기 LAN 복제 — 쓰기 지연 때문에) | data-model 3-1(요청에서 정해지는 id); sync 10-1 · 10-2(after-image, 번호 +500, `replay` 값, replayed outbox는 unknown, 카드 도우미 기록 · VAN 대조); schema `outbox.replayed`, `payment_intents.id` · `outbox.idempotency_key` 주석 |
| M10 | 중간 | 환불 · 보증금 · 돈통 · 조정 연결이 강제되지 않아 환불이 수납을 넘을 수 있음 | 반영 | schema `sys_payment_kinds` 규칙 열 + `legacy_refund`, 수납의 복사본 + 복합 FK + CHECK, `payment_methods_cash` 대상, `payment_intent_allocations`(`allocations_json` 지움), `adjustment_types.sign` + `charge_adjustments.type_sign`; data-model 3-2 · 5절(열린 환불 요청은 잡힌 돈); 스모크 여섯 개 |
| M11 | 중간 | 나눠 결제 수량을 되돌릴 수 없고 접수 전체 배분이 모호 | 반영 | schema `payment_allocations` CHECK(수량 × 금액 > 0); data-model 4-12 · 5절 · S7 |
| M12 | 중간 | 일부 취소 금액이 합계 · 날짜별 가격에서 틀리고 줄과 대조되지 않음 | 반영 | catalog 14절(가격 내역 비율, 마지막이 나머지); schema 취소 · 연장 줄 CHECK(금액이면 조정 필수); data-model 5절 검증기 |
| M13 | 중간 | 강습팀 정산이 두 번 나가거나 청구와 어긋남 | 반영 | schema `counterparty_trades.source_key` + 유일 인덱스, 상계는 두 정산(`offset_group_id`); catalog 12절; data-model S1 · 5절; `lesson.correct` |
| M14 | 중간 | 현금 넘김의 차액이 안 남고 세기 전에 카운터 돈통에 들어감 | 반영 | schema 돈통 `transit` · `over_short`, `cash_transfers.transit_drawer_id`, 확인이 다리를 만듦(날짜 · 범위 · 과부족 돈통), `cash_transfer_confirmation` 출처; data-model 4-12; sync 8-4 |
| M15 | 중간 | '다른 팀 결제 예정'이 내는 팀에서 안 보여 돈이 샘 | 반영 | schema `orders.collect_for_others_amount`, 수납 상태 `promised`, 인계 `promise_open`, `order_due_zero` 설명; data-model 6절 · S7; ui 6-1 |
| M16 | 중간 | 오프라인 돈이 동기화 때 로그인한 사람의 것이 됨 | 반영 | R18 · C1과 같음 |
| M17 | 중간 | 검증기가 돈 불변식 대부분을 다시 보지 않음 | 반영 | data-model 5절(돈 · 현금 · 거래처 검사 목록), `closing_policy`(열린 돈 검사면 마감 막음), `integrity_findings` 주석 |
| M18 | 낮음 | 해시 사슬이 장부 표를 덮지 않고 보관 확인이 바뀌는 표에 기댐 | 반영 | schema 작업 기록 결과에 넣은 행의 해시, `archive_verifications`(추가 전용) + 지우기 트리거가 그것을 요구, `archive_manifests` 추가 전용; data-model 5절; sync 2절 |
| M19 | 낮음 | 수량 이동이 떠나는 상태를 안 적어 다시 만들 수 없음 | 반영 | schema 이동 줄 CHECK(수량 줄은 상태 전후 필수), 주인 · 묶음; data-model 4-9 |
| M20 | 낮음 | 되돌리기가 줄에 묶이지 않고 '마지막 이동'이 기기 시계 순 | 반영 | schema `stock_movement_reversals.reversal_line_no` + FK, 이동 줄 `created_rev` + 인덱스; data-model 4-9 · 6절 |
| M21 | 낮음 | 같은 권이 두 발권처 환불에, claim 연결이 장비와 안 묶임 | 반영 | schema `vendor_refund_items_live`, `asset_claims_asset` 대상 + 준비 항목 · 이동 줄 복합 FK; 스모크 |
| M22 | 낮음 | 분실 · 파손 청구가 장비와 안 묶여 찾아도 안 고쳐짐 | 반영 | schema `adjustment_assets`, `found_after_charge`; data-model 4-12 |
| M23 | 낮음 | 오프라인 권 추가의 가격 출처가 없음 | 반영 | catalog 8절; sync 8-2(그때 효력 있던 판의 기기 견적, 아니면 확인 필요) |
| M24 | 낮음 | 두 번째 복구 뒤 rev가 다시 쓰임 | 반영 | control `tenant_epochs`(`max_rev_seen`, `rev_floor`), `shop_instance`; sync 10-2 3단계 |

### 동시 수정 · 오프라인 · 동기화(C)

| # | 무게 | 지적 | 결정 | 바뀐 곳 |
|---|---|---|---|---|
| C1 | 높음 | 멱등 키에 세션 행위자가 있어 PIN 전환 · 기사 교대 뒤 재시도가 두 번 적용되고 큐 사실을 잃음 | 반영 | schema `command_log` 키 `(shop_id, request_id)`, `submitted_by_key`, `actor_signature`, `device_sign_ins`, `devices.revoked_at` 주석; sync 1 · 2 · 6 · 7절 |
| C2 | 높음 | 기기 번호 엄격 순서가 한 건으로 기기를 영원히 막음 | 반영 | sync 2절(유일만, 빈 번호 찾기, 30분 알림, Web Locks), 8-3(예외도 따로 기록), 10-2 9단계; schema `devices.last_device_seq` 주석, `device_gap`, `offline_policy.seq_gap_alert_minutes` |
| C3 | 높음 | 복구 뒤 다시 보내기가 다른 번호 · id · 바깥 부작용을 만듦 | 반영 | sync 2절(`replay` · `canonical`), 10-2(after-image, 다시 받는 창, 원래 rev 순, 번호가 겹치면 확인 필요, replayed outbox는 unknown, 도우미도 기기); schema `journal_exports`, `outbox.replayed`, `receipt_no_clash` |
| C4 | 높음 | 카운터 1이 서버 PC면 복구 지점 약속이 맞지 않고 control에는 구간이 없음 | 반영 | sync 10-1(커밋마다 LAN 복제, 복제 지연 표시, control 복구 기록, 실제 RPO 문장); control `control_changes` · `control_journal_exports`, `journal_exports.target_key lan_peer`; ADR-12; 열린 질문 14 |
| C5 | 높음 | 옛 처리기가 S6의 사실 의미를 못 주고 엔진 배정이 문서끼리 어긋남 | 반영 | migration 3-2 · 3-3(사실 어댑터, 옛 명령마다 행, 엔진 CI); schema `sys_event_types` 시드(native · adapter · legacy, `legacy.command` 없앰, 옛 명령 종류 추가); sync 1 · 3 · 8-2; ADR-14 |
| C6 | 높음 | 충돌 키가 쓰는 것만 덮어 돈 결정이 조용히 이어 붙음, basis가 동기화 커서 | 반영 | sync 2절(basis = 창의 `as_of_rev`, `expect`), 4-2(읽은 키 `order:<id>:money` · `drawer:<id>:cash`, 돈 intent는 이어 붙이지 않음, 문장); ui 7절; schema `command_log.basis_epoch_id` |
| C7 | 높음 | 두 카운터가 같은 팀을 동시에 결제하고, 진짜 두 번째 승인을 못 적음 | 반영 | schema `order_checkout_locks`, `payment.intent_request`를 intent로, `payments_intent_approval`; sync 4-4 · 9절; ui 6-4 |
| C8 | 높음 | 외부 참조 유일 인덱스가 실제 돈을 거절 | 반영 | R16과 같음 |
| C9 | 높음 | 오프라인 사실을 도착한 때의 상태 · 권한으로 판단(업무를 옮기면 기사 기록이 거절됨) | 반영 | sync 7 · 8-3(일어난 시각의 배정, 옮긴 업무 취소, `skipped_hop`, `late_fact`, 카운터 경고); schema `stock_movements.late_fact` · `skipped_hop`, `task_moved_meanwhile` |
| C10 | 중간 | 결정이 든 사실이 충돌 확인을 건너뛰고 dependsOn이 돈을 막음 | 반영 | sync 3절(사실 안의 결정은 intent처럼), 8-3; 순번은 서버가 매김; 오프라인 견적(M23) |
| C11 | 중간 | 오프라인 기사 화면에 읽는 길이 없음 | 반영 | sync 8-1(같은 store · domain을 OPFS WASM에서, 대기 명령은 savepoint로 겹쳐 그리기); ui 7절 LocalClient; migration 4 · 6주차 시험 |
| C12 | 중간 | 동기화 쪽이 한 rev를 쪼개 줄을 건너뛰고, 범위 퍼짐 · 바뀜이 정해지지 않음 | 반영 | sync 5절(커서 rev.seq, 표마다 범위 함수, 옛 · 새 범위, 속성 시험, 범위가 바뀐 기기 reset) |
| C13 | 중간 | 기기 시계 처리가 돈의 영업일을 틀리게 함 | 반영 | data-model 3-3; sync 2절(온라인 = 받은 시각, 큐 = 단조 나이, 벽시계는 표시 + 확인 필요, 7일 창); schema `command_log.time_source_key`, `offline_policy`, `clock_suspect` |
| C14 | 중간 | 차량 기록이 오기 전에 마감이 틀린 차액을 얼림 | 반영 | data-model 4-13(미리 보기의 차량 동기화, 막기 · 넘기기, `deferred`); sync 8-4; schema `closings.basis_json` · `override_reason`, `closing_drawer_counts.count_status_key`, `closing_policy`, `van_unsynced` |
| C15 | 중간 | outbox가 꺼질 때의 동작이 없어 두 번 가거나 멈춤 | 반영 | sync 9절(잡기를 따로 커밋, 임대 만료 → unknown · failed, 인쇄 도우미 중복 거름); schema `outbox` 주석, `outbox_ready` · `outbox_leases`(shop_id 포함) |
| C16 | 중간 | 옛 epoch로 복구하면 rev가 다시 쓰이고 basis에 epoch가 없음 | 반영 | M24 + basis `{epoch, rev}`, 다른 epoch는 새로 보기 충돌; schema `events` · `journal_exports` · `archive_manifests`의 `epoch_id`, `command_log.basis_epoch_id` |
| C17 | 중간 | 1시간 백업이 끝나지 않을 수 있고 다시 적용이 다른 코드를 돌림 | 반영 | sync 10-1(`VACUUM INTO`, 배포 · 마이그레이션 직후 백업), 10-2(after-image 적용, 다시 돌리기는 확인만); schema `events.handler_version`, `journal_exports.format_version`; data-model 7-3 |
| C18 | 중간 | 방문 순서 · 빨리 확인이 동시 · 오프라인 편집에서 어긋남 | 반영 | sync 4-5(기준 업무, 나중 결정이 이김, 첫 이동에 경로 전체 순위, 동률 규칙, 옮기기가 순위를 다시 씀, 고정 멱등, `pin:<id>`); schema `route_positions.decided_at`, `notifications.source_key` 주석, `route_superseded` |
| C19 | 중간 | 기사 큐가 사라지거나 업그레이드 · 기기 취소 뒤 버려짐 | 반영 | sync 7 · 8-5(`persist()`, 나이로 버리지 않음, upcaster 기간, 취소 전 서명은 받음); schema `devices.offline_capable` · `revoked_at` 주석 |
| C20 | 중간 | 요청번호를 언제 만드는지 없고 지문에 basis가 들어감 | 반영 | sync 2 · 6절(창이 열릴 때 만들고 그대로 재시도, 지문은 종류 · 판 · 본문, 불일치는 처음 결과, 돈의 부드러운 중복 확인); schema `command_log.fingerprint` 주석, `possible_duplicate_money`; ui 5절 |
| C21 | 중간 | 충돌 · 확인 필요가 엉뚱한 사람에게 늦게 감 | 반영 | schema `sys_review_kinds.severity_key` · `routing_key`, `review_items.target_device_id` · `target_actor_key` · `message_params_json`, `decision_overridden`; sync 4-3; ui 5절(ReviewBanner · ReviewStep · ChangeBanner) |
| C22 | 낮음 | 긴 쓰기 일이 쓰기 잠금을 오래 쥠 | 반영 | sync 11절(2,000줄씩 영업 시간 밖, BUSY는 다시 해 볼 만함, 검증기 고침은 시스템 명령); `verifier.repair` |
| C23 | 낮음 | 충돌 키 대체 비교와 기기가 보낸 충돌 키가 불분명 | 반영 | sync 2 · 4-2(키는 서버가 명령에서 만듦, 오래된 기준은 새로 보기 충돌) |

### 화면 확장(U)

| # | 무게 | 지적 | 결정 | 바뀐 곳 |
|---|---|---|---|---|
| U1 | 높음 | 나중에 나온 화면 설정이 이미 쓰던 매장에 들어가지 않음(한 번 복사로 끝) | 반영(방법 b: 행마다 출처 · 기본 판 · 바꾼 때 + 앞으로만 반영 단계) | schema 화면 설정 표의 `origin_key` · `default_rev` · `customized_at`, `ui_default_applications`, `ui_defaults.apply` 명령; ui 2절; data-model 7-1 E8 · 7-3 |
| U2 | 높음 | 화면 설정의 코드 키에 FK가 없고 나중에 달 수 없음 | 반영 | schema 화면 어휘 sys 표와 FK(`stamp_steps.action_key`, 장부 화면 · 칸 · 탭 · 숫자 · 동작, 메뉴, 상태 문구, 종류의 색 · 아이콘 · 고르기, 종류별 도장 조건), 합침 자기 참조 FK, `sys_column_renderers.binding_key`; 스모크 다섯 개; ui 2절 |
| U3 | 높음 | 장부 칸만 빠지고 합쳐지고, 다른 목록은 화면 밖으로 넘침 | 반영 | schema 탭 · 숫자 · 메뉴 · 결제 칸 · 속성 자리 · 옆 동작의 `priority` · `overflow_key` · `fit_mode_key`, `payment_methods.quick`, `sys_overflow_modes`; ui 3-7 칸 수, 4-4 · 4-5; 깨진 '5-3' 참조를 고침(catalog 15절) |
| U4 | 높음 | 875에서 칸 폭 모델이 깨짐(끝 4자리 밀림, 넷째 도장 자리 없음, px 폭, 확대) | 반영 | schema `ledger_view_columns`의 em 폭 · `fold_mode_key` · `fold_min_share_em` · `collapse_group_key`; ui 4-2(조각 우선순위, 도장 모음, 도장 최소 폭, 두 줄 줄, 확대, 묶은 글꼴) |
| U5 | 높음 | 맞춤 검사가 개발 때만 돌고 매장 설정은 검사되지 않음 | 반영(시즌 1 화면 설정은 공급자만) | ui 4-2(`packages/layout`을 서버의 설정 명령에서, 한 문장 거절, 짧은 이름, 기기에서의 대체), 2절, 8절; migration 2 · 6주차; 열린 질문 6 |
| U6 | 높음 | 오프라인 기사 기기에 행만 있고 읽기 모델이 없음 | 반영 | C11 + ui 6-3 바닥줄 '받음 · 대기 · 남음', `sys_ledger_metrics.pending_count` |
| U7 | 높음 | 기사 화면(C3)이 야간 수거뿐(배달 · 현장 수납 · 권 추가 · 방문 결과 · 휴대폰 배치 없음) | 반영 | ui 6-3(받음 칸 하나, 동작 칸, 동작 줄, 높이 계산, 숫자판 판) · 6-5(배달 목록 · 업무 판 · 현장 수납 · 권 추가 · 차에 있는 것); schema `action` 그리기, `task_sheet` 자리, `sys_actions`, `sys_screens` |
| U8 | 중간 | ▲▼가 줄을 튀게 하고 묶음과 부딪힘 | 반영 | ui 6-3(보조 묶음은 이름표, 한 반납 타임 안에서); sync 4-5(첫 이동에 경로 전체 순위); schema `ledger_views.subgroup_by_key` |
| U9 | 중간 | 장부 정렬 · 시각 키가 시안과 다르고 도장 · 다른 기기 뒤 줄이 튐 | 반영 | ui 6-1(시각 칸 = 정렬, 자리 지키기, 끝난 줄은 뒤에 흐리게, 지금 줄 쪽으로 열기, 손대는 동안 새로 고침 미룸), 8절 |
| U10 | 중간 | '한 쪽 7줄'이 지금 줄 · 묶음 제목 · 빨리 확인 · 설치한 PWA 높이를 무시 | 반영 | ui 3-7(1024×569 · 529), 4-3(잰 항목을 채우는 쪽 넘김, docs/42 규칙 5), 4-5; 열린 질문 15 |
| U11 | 중간 | 도장 모델이 모자람(빨간 끝 도장, 없는 상태 둘, 팀으로 모으는 법) | 반영 | schema `sys_tones`(seal · late_only), `sys_stamp_states`(7), `sys_stamp_rollups`, `ledger_view_column_steps`, `stamp_rollup_key`; ui 3-2 · 6-1 |
| U12 | 높음 | 속성의 입력 · 보이는 모양이 없고 두 곳이 자리를 정함 | 반영 | schema `attribute_definitions`(`short_label` · `input_widget_key` · `display_format_key` · `step_value`), `attribute_placements`(id 키 · 등급 · 우선순위 · 맞춤 · 넘칠 때), `sys_input_widgets` · `sys_display_formats`, 표 모양 자리를 `sys_attribute_placements`에서 뺌; ui 3-1 · 3-10; catalog 5절; data-model S14 |
| U13 | 중간 | 접수증에 폭 · 높이 · 세트 규칙 · 동작 설정이 없음 | 반영 | schema `ledger_view_actions`; ui 6-2(폭 · 높이 표, 세트 줄, 품목 요약 단위, 끝난 일 접기, 주황 하나) |
| U14 | 중간 | 6절의 설정을 스키마에 담을 수 없음 | 반영 | schema `ledger_view_primary_actions` + `sys_conditions`, `subgroup_by_key`, `feature_on`, `base_view_id`; ui 3-5(등급 폴백) · 6절 |
| U15 | 중간 | 읽기 모델이 화면마다 고정 조회이고 장부 화면에 줄 단위가 없음 | 반영 | schema `ledger_views.row_grain_key`, `sys_row_grains` · `sys_row_grain_entities`; ui 7절(`ledgerView` 하나) |
| U16 | 중간 | 늦음과 '오늘'이 시계에 달렸는데 자료가 바뀔 때만 새로 그림 | 반영 | ui 6-1 · 6-3 · 7절(`due_at` · `late_at`, 서버 시각 차이로 매분, `currentBusinessDate`, 끝나지 않은 어제 업무 남김); sync 5절 |
| U17 | 중간 | 레일을 없앤 뒤 길 찾기가 정해지지 않음 | 반영 | schema `sys_screens` · `sys_workspaces` + 메뉴 FK, `ledger_views.screen_key`; ui 3-6(화면 지도, 장부 · 관리 · 더 보기, 칸 수, 돌아가기) |
| U18 | 중간 | 인쇄 · 돈통 · 단말 · 업데이트의 플랫폼 층과 앱 · 서버 판 차이 계획이 없음 | 반영 | ui 7절(`PlatformBridge`, 아는 키만 설정, 모르는 키는 숨기고 알림, 업데이트는 창 없고 대기 0일 때, 가져오기 경계 lint, 스파이크 고침); migration 1주차 |
| U19 | 중간 | 인쇄가 화면과 따로 설정되어 새 칸이 인쇄에 안 나옴 | 반영 | schema `print_templates.source_view_id`, `print_template_versions.layout_json`(풀어 쓴 스냅샷); ui 3-7 · 7절; data-model S15 |
| U20 | 중간 | 화면 설정 표의 자연 복합 키가 나중 변형을 막음 | 반영 | schema 숫자 · 속성 자리 · 메뉴 · 종류별 도장 · 칸 · 탭 · 동작을 `(shop_id, id)` 키 + 이름 있는 유일 인덱스로, 탭 · 숫자에 `params_json` |
| U21 | 낮음 | 크기 규칙이 등급 · 부품마다 어긋남 | 반영 | ui 3-7(등급별 최소는 DeviceProfile 한 곳, 14px 예외는 플랫폼 관리자 콘솔만, 쪽 넘김 = 등급 최소, 제목 · 탭 60px), 4-1 |
