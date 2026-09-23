# 스키노트

스키노트는 한국 스키 렌탈샵의 포스(POS)입니다. 카운터의 대여 접수 · 지급 · 반납 · 수납부터 배달 · 야간 수거 차량, 하루 마감까지 한 장부로 잇습니다. 첫 매장은 무주의 한 렌탈샵이고, 나중에 다른 렌탈샵도 자기 품목 · 요금 · 장소 · 직원 설정으로 쓸 수 있게 만듭니다.

## 누가 쓰나

- **카운터 직원:** 대부분 나이가 많은 분들입니다. 매장 PC(1024×600 화면, 설치한 앱으로 쓰면 1024×529까지)와 태블릿에서 씁니다. 종이 장부처럼 한 줄에 한 팀, 할 일은 도장을 찍듯 누릅니다.
- **차량 기사:** 장갑을 끼고 차량 태블릿(1024×520 ~ 1280×720)이나 휴대폰(360×640)으로 배달 · 수거 목록을 봅니다. 산에서는 연결이 끊겨도 받음 도장을 찍을 수 있어야 합니다.

그래서 화면은 글자 16px 이상, 누르는 곳 52px 이상(기사 기기 56px), 말줄임표와 스크롤 없이 쪽 넘김으로 만들고, 가게에서 쓰는 쉬운 우리말(장부, 접수증, 지급, 반납, 수납, 미수, 도장, 수거 목록, 빨리 확인, 끝 4자리)만 씁니다. 자세한 규칙은 [AGENTS.md](AGENTS.md)에 있습니다.

## 체험판

**[체험판 열기](https://rosookwan.github.io/skinote/)** — `main`에 올라오면 GitHub Actions(`.github/workflows/pages.yml`)가 빌드해 올립니다.

- 체험판은 **화면 견본**입니다. 서버에 붙지 않고, 브라우저 안의 예시 자료(`FixtureClient`, `apps/pos/src/fixture`)로만 돌아갑니다.
- 예시 자료는 12월 26일(토) 15:40의 하루, 18팀입니다. 이름은 시안의 예시이고 전화번호는 모두 가짜(`010-0000-xxxx`)입니다. 실제 손님 자료, 계정, 관리자 콘솔은 들어 있지 않습니다.
- 찍은 도장과 수납은 그 브라우저에만 남습니다(다른 기기와 나누지 않음). `나가기` 화면에서 체험 시계를 앞으로 돌리거나 처음 자료로 되돌립니다.
- 처음 화면에서 `카운터(포스)` · `기사 태블릿` · `기사 휴대폰`을 고릅니다. 지금 볼 수 있는 화면은 오늘 대여 장부, 대여 접수증과 남은 일 목록, 야간 수거 목록(기사 · 카운터)입니다. 새 접수 · 마감 · 관리처럼 아직 만들지 않은 화면은 '아직 만드는 중' 알림이 뜹니다.
- 설치할 수 있는 앱(PWA)입니다. 한 번 연 뒤에는 연결 없이도 열립니다.
- `FixtureClient`는 임시입니다. 운영과 같은 저장소 코드를 브라우저에서 돌리는 `LocalClient`가 오면 없앱니다([ui-architecture.md 7절](docs/architecture/ui-architecture.md#7-화면과-도메인의-연결)).

## 내 컴퓨터에서 돌리기

Node.js 22가 필요합니다. `engines`는 22.13 이상이지만, 검사 스크립트 일부가 `.ts` 파일을 Node로 바로 읽으므로 **22.18 이상**을 쓰세요.

```sh
npm ci                                  # 의존성 설치(package-lock.json 그대로)
npm run dev                             # 개발 서버. 터미널에 나온 주소를 엽니다(#/ 처음 화면)
npx playwright install chromium         # 처음 한 번: 화면 검사용 브라우저
npm run check                           # 모든 시험 · 검사 · 빌드 · 화면 검사(맥에서 5분쯤)
```

| 명령 | 하는 일 |
|---|---|
| `npm test` | 옛 업무 규칙 시험 222개(`test:core`) + 스키마 시험(`test:schema`) + 화면 쪽 단위 시험(`test:unit`, vitest) |
| `npm run lint` | 마이그레이션 검사(추가만 허용, 트리거 모양, 장부 표의 `OR REPLACE` 금지)와 가져오기 경계 검사 |
| `npm run typecheck` | TypeScript 패키지 넷(contract · layout · ui · pos) 형식 검사 |
| `npm run build` | 체험판 빌드(`apps/pos/dist`, 상대 주소라 어느 하위 경로에 올려도 됨) |
| `npm run check:dist` | 빌드 확인: 상대 주소, PWA 범위, 관리자 콘솔 · 비밀 키 · 진짜 전화번호가 없는지 |
| `npm run test:pwa` | 빌드를 `/skinote/` 하위 경로로 띄워 서비스 워커 범위와 오프라인 열기 확인 |
| `npm run rules` | 빌드한 뒤 화면 규칙 검사(모든 기기 크기 · 화면 · 창). 찍은 화면은 `work/screens/rules/` |
| `npm run check` | 위 모두(CI와 같은 순서) |
| `npm run migrate -w @skinote/schema -- shop ./shop-test.sqlite` | 빈 매장 파일에 마이그레이션 적용(백업 먼저, 모르는 판이면 읽기 전용으로 거절) |

CI(`.github/workflows/ci.yml`)는 모든 push와 pull request에서 같은 검사를 돌고, 화면 검사가 어긋나면 찍은 화면을 내려받을 수 있게 올립니다.

## 저장소 지도

| 경로 | 무엇 |
|---|---|
| `packages/core` | 옛 업무 규칙 · 서버 · 시험 222개(ski-rent-ops에서 그대로 옮김). **고치지 않습니다.** 새 표 위에서 옛 규칙을 그대로 돌리는 기준입니다 |
| `packages/schema` | 두 데이터베이스(control · shop)의 참조 스키마 `schema.sql`, 마이그레이션 0001, 실행기(`bin/migrate.js`), 장부 트리거 생성기, 마이그레이션 검사, 스키마 시험 |
| `packages/contract` | 화면과 서버가 함께 쓰는 형식: 코드 키 어휘, 화면 기본 설정 `ui-defaults.json`, 읽기 모델, `DomainClient`, 명령 봉투 |
| `packages/layout` | 칸 폭 맞추기 · 쪽 나누기 · 확인 창 크기 · 글자 맞추기(말줄임표 대신 덜 중요한 부분을 뺌)의 순수 함수 |
| `packages/ui` | 화면 부품(장부 · 도장 · 접수증 · 남은 일 목록 · 숫자판 · 쪽 넘김 …), 기기 등급 `DeviceProfile`, 디자인 토큰, 묶은 글꼴(Pretendard) |
| `apps/pos` | React 앱(카운터 포스 + 기사 태블릿 · 휴대폰), 체험 자료 `FixtureClient`, PWA, 화면 규칙 검사기(`scripts/check-ui-rules.mjs`) |
| `scripts` | 가져오기 경계 검사, 체험판 빌드 확인, PWA 검사, 앞 단계의 화면 검사(`test:ui`) |
| `docs/architecture` | 기반 설계(아래) |
| `docs/design/redesign-mockups.html` | 고른 코드 시안: C 종이 장부와 도장에 A 지금 줄, B2 남은 일 목록, A3 ▲▼ 순서와 빨리 확인을 섞음 |

앞으로 생길 패키지(`packages/domain` · `store` · `importer` · `server`, 시즌 뒤의 `apps/admin`)는 [migration-plan.md 2절](docs/architecture/migration-plan.md#2-도착점-패키지)에 있습니다. 관리자 콘솔은 체험판에 넣지 않습니다.

## 문서

- [기반 설계와 결정 기록(ADR)](docs/architecture/README.md)
- [자료 구조](docs/architecture/data-model.md) · [품목과 가격](docs/architecture/catalog-and-pricing.md) · [동기화와 동시 수정](docs/architecture/sync-and-concurrency.md)
- [화면 구조](docs/architecture/ui-architecture.md): 설정으로 그리는 화면, 기기 등급, 크기 규칙, 부품, C 화면
- [옮기는 계획](docs/architecture/migration-plan.md)과 [일정 · 지금 상태](docs/roadmap.md)
- [AI 에이전트 규칙](AGENTS.md)

## 라이선스

라이선스는 아직 정하지 않았습니다(저장소 주인이 정합니다). 정할 때까지 `LICENSE` 파일을 두지 않습니다.
