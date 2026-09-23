# AGENTS.md — 이 저장소에서 일하는 AI 에이전트의 규칙

스키노트는 한국 스키 렌탈샵의 포스다. 화면을 쓰는 사람은 대부분 나이 많은 카운터 직원과 장갑을 낀 차량 기사다. 아래 규칙은 사람이 코드 리뷰에서 매번 다시 말하지 않아도 되게 적은 것이고, 대부분은 검사 스크립트가 기계로 확인한다. 규칙과 설계 문서가 어긋나 보이면 추측으로 고치지 말고 사람에게 묻는다.

## 먼저 읽을 것

| 할 일 | 읽을 문서 |
|---|---|
| 무엇이든 | [README.md](README.md), [docs/architecture/README.md](docs/architecture/README.md)의 결정 기록(ADR) |
| 화면 | [ui-architecture.md](docs/architecture/ui-architecture.md): 세 층의 설정(2절), 기기 등급 표(3-7), 크기 규칙(4-1)과 칸 맞춤(4-2 ~ 4-5), 부품(5절), C 화면(6절), 도메인 연결(7절), 시험(8절). 시안은 [docs/design/redesign-mockups.html](docs/design/redesign-mockups.html) |
| 자료 · 마이그레이션 | [data-model.md](docs/architecture/data-model.md) 1 · 3 · 7절, [packages/schema/schema.sql](packages/schema/schema.sql) |
| 돈 · 품목 · 가격 | [catalog-and-pricing.md](docs/architecture/catalog-and-pricing.md), data-model 4-12 · 4-13 |
| 동기화 · 오프라인 · 명령 | [sync-and-concurrency.md](docs/architecture/sync-and-concurrency.md) |
| 일정 · 옮기기 | [migration-plan.md](docs/architecture/migration-plan.md), [docs/roadmap.md](docs/roadmap.md) |

## 화면 규칙(반드시, 검사기가 확인)

매장 기기 등급(`pos` · `pos_narrow` · `driver_tablet` · `driver_phone`) 모두에 적용한다. 숫자는 코드에 새로 적지 말고 `packages/ui/src/device-profile.ts`의 `DeviceProfile`에서 읽는다.

1. **글자는 16px 이상.** 알림 점 하나만 예외다. 16px 아래가 허락되는 곳은 공급자의 숨은 관리자 콘솔(`admin` 등급)뿐이다.
2. **누르는 곳은 52px 이상, 기사 기기는 56px 이상.** 쪽 넘김 버튼도 같다. 도장 칸은 동그라미가 아니라 칸 전체가 누르는 곳이다. 길게 누르기에 기대지 않는다.
3. **말줄임표(`…`)와 잘린 글자가 없다.** `text-overflow: ellipsis`, 줄 수 자르기도 안 된다. 덜 중요한 조각을 통째로 빼고(`TextFit`, `packages/layout`), 품목 목록은 `외 N종`으로 끝낸다.
4. **목록에 스크롤 영역이 없다.** 잰 높이로 쪽을 나누고 바닥줄에 `‹ 1 / 3쪽 ›`을 둔다. 한 쪽에는 온전한 줄만 둔다(반쯤 잘린 줄 없음). 페이지도 스크롤되지 않는다.
5. **주 버튼은 한 화면에 하나.** 포스는 주황, 기사 화면은 보라. 확인 창이 열려 있으면 그 창 안에서 하나다.
6. **빨강은 늦은 것에만.** 반납 때 받기로 한 정상 미수는 검정 글자다. 끝난 도장은 도장 주홍(`seal`)이고 빨강이 아니다.
7. **검사 크기:** 포스 1024×600 · 1024×569 · 1024×529(Windows에 설치한 PWA), 1024×768, 1366×768, 좁은 포스 907×648 · 875×600, 기사 태블릿 1024×520 · 1024×600 · 1280×720, 기사 휴대폰 360×640(390×740 · 412×780). 모든 계산은 잰 크기로 한다.
8. **기사 화면은 촘촘한 줄과 쪽 넘김**을 쓴다(카드 목록이 아님). 포스의 관리 화면만 카드 목록이다.
9. 왼쪽 메뉴 레일은 없다. 메뉴는 머리줄, 화면 안의 나눔은 장부의 색인 탭이다.

## 문구 규칙

- 사장님이 쓰는 가게 말을 쓴다: 장부, 접수증, 지급, 반납, 수납, 미수, 도장, 수거 목록, 빨리 확인, 끝 4자리, 매장 입고, 받음, 못 받음, 차에 있는 것, 보냄 대기, 연결 끊김.
- **화면에 영어 글자가 없다**(검사기가 센다). 기술 용어(동기화, 서버, 오류 코드, 캐시, 데이터베이스 …)도 화면에 쓰지 않는다.
- AI가 쓴 것 같은 말투를 쓰지 않는다: 과장, 감탄, "~해 드릴게요!", "스마트한", 이모지. 짧은 한 문장으로 무엇이 되었는지, 무엇을 누르면 되는지만 쓴다.
- 날짜는 `오늘 · 내일 · 모레`로 쓰고 같은 날짜를 두 번 쓰지 않는다. 돈은 `120,000원`.
- 막히는 일은 기술 설명 대신 쉬운 한 문장과 버튼 두 개('그사이 이 팀이 120,000원을 냈습니다').
- 화면 문구는 코드에 흩어 두지 않는다. 상태 · 도장 문구는 설정(`status_terms`, 도장 단계)에서, 동작 이름은 `sys_actions.label`(`ACTION_LABELS`)에서, 부품 문구는 `packages/ui/src/strings.ko-KR.ts`(`t`)에서, 앱 화면 · 체험판 문장은 `apps/pos/src/app/strings.ts`(`say`)에서 온다. 자리(`{name}`)의 값은 형식이 요구한다.
- 이름 뒤에 조사를 붙여 문장을 만들지 않는다(`label + '은 …'`는 받침에 따라 틀린다). 문장을 통째로 문구 표에 두고 이름은 제목이나 조사가 필요 없는 자리에 쓴다.

## 화면은 설정으로 그린다

- 세 층이다: ① 코드(`DeviceProfile`, 부품, 코드 키 어휘, 칸 맞춤 계산), ② 매장 데이터(도장 단계, 장부 칸 · 탭 · 바닥줄 · 동작, 메뉴, 상태 문구, 사용 기능), ③ 기기(잰 크기 + 역할로 고른 등급). 기본 설정은 `packages/contract/ui-defaults.json`(판 번호 `rev`)이고, 바꾸면 `rev`를 올린다.
- 새 품목 종류 · 도장 · 칸 · 탭은 **설정 행을 더해서** 나오게 한다. 화면 코드에 `if (kind === 'liftTicket')`, `'ski'`, 한글 이름 비교, 화면 크기 숫자 분기를 넣지 않는다. 동작은 능력 값(`fulfillment_mode_key`, `tracking_key`, `return_policy_key` …)으로 가른다.
- 코드 키(칸 그리기, 맞춤, 색, 조건, 동작, 확인 창 …)는 `sys_*` 어휘에 있는 것만 쓴다. `packages/contract`의 어휘 목록은 `schema.sql` 시드와 시험으로 맞춰져 있다.
- 크기 · 색은 CSS 변수(`--sn-*`, `packages/ui/src/styles/tokens.css`)로만 쓴다. `components.css`에 px 숫자를 적지 않는다(시험이 확인).
- **부품은 업무 규칙을 계산하지 않는다.** 도장 상태, 다음 할 일, 늦음의 기준 시각, 받을 돈은 읽기 모델에 이미 들어 있고 부품은 그리기만 한다. 화면(`apps/pos/src/screens`)도 규칙을 만들지 않고 `DomainClient`(`ledgerView` · `query` · `command`)에 묻는다.
- 명령은 확인 창을 연 때 만든 요청번호와 그때의 기준(`asOfRev`)으로 보낸다. 다시 보낼 때도 같은 요청번호다.
- 체험 자료의 규칙은 `apps/pos/src/fixture`(`rules.ts` · `stamps.ts`)에만 있고, `LocalClient`가 오면 폴더째 없앤다. 여기에 새 업무 규칙을 키우지 않는다.

## 가져오기 경계

- `apps/pos`는 `@skinote/contract` · `@skinote/ui` · `@skinote/layout`만 가져온다.
- `apps/pos/src`와 `packages/ui/src`는 `@skinote/core`와 Node 내장 모듈(`node:*`)을 가져오지 않는다.
- 화면 · 부품 · 앱 뼈대(`apps/pos/src/{screens,components,app}`)는 체험 자료(`fixture/`)를 가져오지 않는다(읽기 모델만 받는다). 체험 자료는 `main.tsx`만 만든다.
- `packages/layout`은 순수 함수라 React · `@skinote/ui` · Node 내장 모듈을 가져오지 않고 `@skinote/contract`만 쓴다. `packages/contract`는 다른 `@skinote/*` · React를 가져오지 않는다.
- `npm run check:imports`(`scripts/check-import-boundary.mts`)가 모두 막는다.

## 자료와 SQL

- **SQL은 저장소 패키지(`packages/store`, 아직 없음)에만 쓴다.** `packages/domain`은 SQL 없는 순수 함수다. 예외는 `packages/schema`(스키마 · 마이그레이션 · 그 도구)뿐이다. 화면 · 부품 · 계약 패키지에는 SQL이 없다.
- 데이터베이스 연결은 `packages/schema`의 `openDatabase()`로 열거나 `verifyConnection()`으로 확인한다(`foreign_keys`, `recursive_triggers`, WAL, `synchronous = FULL`). `DatabaseSync`를 직접 열지 않는다.
- **마이그레이션은 앞으로만, 더하기만 한다**(data-model 7-2). `packages/schema/migrations/NNNN_<control|shop>[_이름].sql`에 새 파일을 더하고, 이미 있는 파일은 고치지 않는다(checksum이 막는다).
  - 허용: CREATE TABLE · INDEX · VIEW, 빈 값 허용이나 상수 기본값의 `ADD COLUMN`, `sys_*` · `json_schemas` INSERT, 채우기 UPDATE, 정해진 모양의 트리거 네 가지(생성기 `src/guards.js`가 만든 것과 같아야 함).
  - 금지: DROP TABLE · DROP COLUMN · RENAME, `ADD COLUMN`의 `CHECK` · `REFERENCES` · 기본값 없는 `NOT NULL`, 표 안 `UNIQUE`(이름 있는 인덱스로), `CHECK (x IN (…))` 목록(어휘 표 FK로), `sys_*` key 바꾸기 · 지우기(`INSERT … ON CONFLICT DO UPDATE`로 바꾸는 것 · `DO NOTHING` 포함), 0001이 보호하는 장부 열의 UPDATE(조건이 붙은 '한 번만' · '가리기만' 열 포함), DELETE, DROP TRIGGER, 트랜잭션 · PRAGMA 문장.
  - 이미 있는 장부 표에 `ADD COLUMN`을 하면 같은 마이그레이션에 그 열의 '한 번만' 트리거(`<표>_<열>_once`, 자유 글이면 `_redact_only`)를 둔다.
  - 새 매장 표는 `shop_id`로 시작하는 키와 복합 FK, 새 장부 표는 추가 전용 트리거를 같은 마이그레이션에 둔다.
  - `npm run lint:schema`(마이그레이션 검사, 앱 코드 검사 `--code`, 0001 나누기 · 트리거 생성 결과 확인)가 검사한다. 통과하지 않으면 검사를 고치지 말고 마이그레이션을 고친다.
- 장부 표(돈, 이동, 마감 …)는 추가만 한다. 앱 코드에서 장부 표에 `INSERT OR REPLACE` · `REPLACE INTO` · `INSERT OR IGNORE`를 쓰지 않는다(lint `--code`가 찾는다). 고칠 것은 새 행(되돌리기 · 조정)으로 적는다.
- `schema.sql`은 0001의 참조 DDL이고, 0001은 거기서 나눠 만든다(`npm run split -w @skinote/schema`, 장부 트리거는 `npm run gen-triggers -w @skinote/schema`). 0001이 한 번 배포된 뒤에는 `schema.sql`을 고치지 않고 새 마이그레이션 파일을 더한다(배포한 파일의 checksum이 달라지면 실행기가 시작을 거부한다).
- 돈은 정수 원, 시각은 UTC와 매장 시간대, 새 id는 ULID다(data-model 3절).

## 옛 코드 `packages/core`는 얼려 둔다

- ski-rent-ops에서 옮긴 검증된 업무 규칙과 시험 222개다. **고치지 않는다.** `npm run test:core`는 늘 222개 모두 통과해야 한다.
- 새 기능은 새 패키지에 쓴다. migration-plan 3-2의 세 이음매(날짜 · 조회 · 능력 값)만 계획에 있고, 그것도 사람이 정한 뒤 기본 동작을 바꾸지 않는 방식으로만 한다.

## 체험판과 비밀

- 공개 체험판(https://rosookwan.github.io/skinote/)은 화면 견본이고 `FixtureClient`의 예시 자료로만 돈다.
- **관리자 콘솔, 계정 정보(비밀번호 · 토큰 · 키), 실제 손님 자료를 체험판과 저장소에 넣지 않는다.** 예시 전화번호는 `010-0000-xxxx`만 쓴다. `.env`와 `*.sqlite` 파일은 올리지 않는다. `npm run check:dist`가 빌드에서 관리자 경로 · 비밀 키 모양 · 진짜 전화번호를 찾는다.
- 관리자 콘솔은 시즌 뒤의 따로 된 앱(`apps/admin`)이고 운영 서버의 숨은 주소에서만 연다.

## 검사 돌리기

```sh
npm test               # 옛 core 222 + schema + vitest(contract · layout · ui · pos)
npm run lint           # 마이그레이션 검사 + 가져오기 경계
npm run typecheck      # contract · layout · ui · pos(+ 빌드 도구: apps/pos/tsconfig.node.json)
npm run build          # apps/pos/dist
npm run check:dist     # 체험판 빌드 확인(상대 주소 · PWA 범위 · 넣지 않는 것)
npm run test:pwa       # /skinote/ 하위 경로에서 서비스 워커 · 오프라인(브라우저)
npm run rules          # 빌드 + 화면 규칙 검사(브라우저, 맥에서 4분쯤)
npm run check          # 위 모두. CI(.github/workflows/ci.yml)와 같은 순서
```

- 브라우저 검사는 처음 한 번 `npx playwright install chromium`이 필요하다. Node는 22.18 이상(검사 스크립트가 `.ts`를 Node로 바로 읽음).
- 화면을 고치면 `npm run rules`까지 돈다. 일부만 돌릴 때는 `SKINOTE_RULES_ONLY=pos,driver_phone`, `SKINOTE_RULES_SIZES=1024x529,360x640`. 찍은 화면과 `report.json`은 `work/screens/rules/`(저장소에 올리지 않음)에 남는다.
- 규칙 검사가 어긋나면 **검사를 느슨하게 하지 말고 화면을 고친다.** 규칙 자체가 틀렸다고 생각되면 사람에게 묻는다.
- 스키마를 고치면 `npm run test:schema`와 `npm run lint:schema`.

## 글쓰기와 코드

- 주석과 문서는 한국어 문장으로 쓰고 식별자(표 · 열 · 함수 · 파일 이름)는 영어 그대로 둔다. 기존 문서의 말투(한다체, 짧은 문장, `·`로 나열)를 따른다.
- 코드 식별자는 영어다. 화면 문구만 한국어다.
- 설계를 바꾸는 결정은 해당 설계 문서와 ADR을 함께 고친다. 새 문서를 만들기 전에 이미 있는 문서의 절에 넣을 수 있는지 본다.
- 커밋 · 푸시는 사람이 요청할 때만 한다. `main`에 올라가면 체험판이 바로 배포된다.
