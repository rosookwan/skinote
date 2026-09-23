# 일정과 지금 상태

작성 2026-09-23. [migration-plan.md 6절](architecture/migration-plan.md#6-10주-계획2026-09-28--12-04)의 10주 계획(2026-09-28 ~ 12-04)에 지금까지 한 것을 겹쳐 적는다. 무엇을 왜 하는지는 migration-plan이 기준이고, 이 문서는 어디까지 왔는지와 주마다 다음에 할 것만 적는다. 한 주가 끝날 때마다 고친다.

줄기는 넷이다: **기반**(schema · store · domain), **legacy**(codec · facade · 옛 시험), **기능**(N 목록), **화면**(React). 화면 줄기는 예시 자료(`FixtureClient`)로 먼저 달려 1주차 전에 2 ~ 4주차 화면의 모양을 거의 갖췄다. 기반 · legacy 줄기는 스키마와 실행기까지 왔다.

## 1. 지금까지 한 것(1주차 전, 2026-09-23)

| 줄기 | 한 것 | 확인 |
|---|---|---|
| 설계 | 기반 설계 6개 문서(`docs/architecture`, 결정 기록 17개, 공격적 검토 93건 반영), 고른 코드 시안(`docs/design/redesign-mockups.html`: C 종이 장부와 도장 + A 지금 줄 · B2 남은 일 목록 · A3 ▲▼와 빨리 확인). 왼쪽 레일을 없애기로 함 | — |
| 스키마(`packages/schema`) | `schema.sql`을 옮기고 마이그레이션 0001(control · shop)로 나눔. 실행기(연결 설정을 읽어 확인, 적용 전 백업과 적용 뒤 한 번 더, checksum, 모르는 판 · 다른 종류의 파일은 읽기 전용으로 거절, 실패하면 그 마이그레이션만 되돌림)와 명령줄 도구. 장부 트리거 생성기, 마이그레이션 검사(`--code`로 앱 코드도), 구조 확인(FK 대상 · 표 안 UNIQUE · 목록형 CHECK), 스모크 88개, 다섯 시즌 벤치 | 시험 161개 |
| 화면 기반 | `packages/contract`(코드 키 어휘와 시드 대조, `ui-defaults.json`, 읽기 모델, `DomainClient`, 명령 봉투, 확인 창에서 만드는 요청번호), `packages/layout`(4-2 칸 맞춤, 높이로 쪽 나누기, 확인 창 크기, 말줄임표 없는 글자 맞춤), `packages/ui`(DeviceProfile 3-7, 토큰, 부품 18개와 주 버튼, 묶은 Pretendard). 가져오기 경계 검사(`@skinote/core` 스파이크 없앰) | 단위 시험 contract 40 · layout 40 · ui 64 |
| C 화면(예시 자료) | `FixtureClient`(12월 26일 15:40, 18팀). C1 오늘 대여 장부(색인 탭, 지금 줄, 늦은 줄만 빨강, 자리 지키기), C2 대여 접수증 + 남은 일 목록 + 도장 확인 창(수량 −/+, 수납 수단), C3 기사 수거 목록(태블릿 · 휴대폰: 받음 도장, ▲▼ · 맨 위로 · 시간순, 빨리 확인 고정 줄, 못 받음 방문 결과, 끝 4자리 숫자판, 차에 있는 것, 매장 입고, 연결 끊김과 보냄 대기), 카운터 수거 목록과 빨리 확인 보내기 | 단위 시험 pos 31. 화면 규칙 검사 13개 크기 · 3,851장면 어긋남 0 |
| PWA | `manifest.webmanifest`와 서비스 워커(앱 뼈대 · 스크립트 · 스타일 · 글꼴을 미리 받음, 범위는 상대 주소), 운영 빌드에서만 등록 | `test:pwa` 23개 |
| CI · 배포 | 루트 스크립트(`test` · `lint` · `typecheck` · `build` · `check:dist` · `test:pwa` · `rules` · `check`), `.github/workflows/ci.yml`(모든 push · pull request, 화면이 어긋나면 찍은 화면을 올림), `.github/workflows/pages.yml`(`main` → https://rosookwan.github.io/skinote/), 체험판 빌드 확인(`scripts/check-dist.mjs`) | 내 컴퓨터에서 `npm run check` 통과. GitHub에서의 첫 실행은 저장소를 올린 뒤 |

## 2. 주별 계획과 상태

상태 표시: **끝** · **일부** · **먼저 함**(그 주보다 앞서 예시 자료로 만든 것, 실제 API로 잇는 일은 남음) · **남음**.

| 주 | 기반 · legacy | 기능 | 화면 | 끝났다는 기준 |
|---|---|---|---|---|
| 1 (9/28–10/2) | 패키지 나누기 **일부**(schema · contract · layout · ui는 있음, domain · store · importer · server는 남음), 0001 **끝**, 실행기 **일부**(`ui_defaults.apply` 남음), 트리거 생성기 · lint **끝**, 스키마 확인 CI **끝**, 날짜 서비스 **남음**, 요청에서 정해지는 id(ULID + HMAC) **일부**(기기 쪽 ULID만), 계약 패키지 뼈대 **일부**(충돌 키 함수 남음), 레지스트리 · 품목 · 주문 codec **남음** | 매장 개설 명령 · 첫 매장 시드 **남음** | docs/35 · docs/42 부록 A 개정 **남음**(ski-rent-ops 문서), DeviceProfile · layout **끝**(글자 폭 표 남음), TextFit · Pager **끝**, 규칙 검사기 **끝**, 부품 뼈대 **끝**, 가져오기 경계 **끝** | 빈 파일에 마이그레이션 **끝**, 스모크 88개 **끝**, codec 왕복 **남음** |
| 2 (10/5–10/8) | 쓰기 순서, 검증기, 나머지 codec, facade + 사실 어댑터 + 이음매 1 · 2, 상태 대조 **남음** | — | C1 장부를 가짜 읽기 모델로 **먼저 함** | 모드 A · B 초록(222 × 2) **남음** |
| 3 (10/12–10/16) | 모드 C, LOAD_PLAN, 모드 E 기록기 **남음** | N2 · N4 · N19 · 약속 바꾸기 · N1 **남음** | C2 접수증 + 남은 일 목록 **먼저 함**, C1 · C2를 실제 API로 **남음**, 접수 확정 창(N개 결제 칸) **남음** | N1 재현 시험 **남음** |
| 4 (10/19–10/23) | `/api/v2/sync` + SSE, 범위 함수, 기사 기기 LocalClient **남음** | N12 순서 · 빨리 확인 **먼저 함**(화면과 예시 명령), N3 수거 목록 읽기 모델 **먼저 함**(예시), A4 인쇄 **남음** | C3 기사 수거 목록 · 숫자판 · RowActionBar · PinBar · 연결 띠 · 포스 수거 목록 **먼저 함**, 인쇄 **남음** | 두 기기 동시 순서 바꾸기, 인쇄, 온라인 · 오프라인 목록 같음 **남음** |
| 5 (10/26–10/30) | `finance.*` 번역기, 의도한 차이 목록, 모드 D(돈 · 마감) **남음** | 돈 native · N19 한 번에 수납 · 마감 **남음** | 수납 창(도장 확인 창의 수단 고르기만 **먼저 함**), 한 번에 수납 창, 마감 화면 **남음** | **남음** |
| 6 (11/2–11/6) | 오프라인 큐 · 기기 서명 · S5 · S6 시험 **남음** | 계정 · 기기 · PIN, N20, N11 방문 결과(화면 **먼저 함**), 카드 결제 잠금 **남음** | 확인 필요, 오프라인 표시(체험에서 **먼저 함**), 로그인 · PIN, 기사 업무 판 · 현장 수납 판 · 권 추가 판 **남음** | **G1**(11/6) |
| 7 (11/9–11/13) | 실제 자료 가져오기 · 대조, 백업 · 복구, 이음매 3 **남음** | N17, `사용 기능` 설정 **남음** | 리프트권 · 매장 반납 · 새 접수 다듬기, 관리 → v4 연결 **남음** | 가져오기 `verified`, 복구 시험 |
| 8 (11/16–11/20) | 새 서버로 바꾸기, 옛 엔진 그림자 | 관찰 결과 고치기 | 연습 로그인, 관찰 시험 | 매일 대조 보고서 |
| 9 (11/23–11/27) | 대조 차이 0, 성능(p95 < 20 ms) | N6 ~ N10, 금요일에 기능 동결 | 관찰 고치기 | — |
| 10 (11/30–12/4) | **G2**(12/1), 산에서 오프라인 · 인쇄 · 복구 연습 | 동결 | 동결 | 개장 준비 |

멈춤 기준 G1 · G2와 대안 F1 · F2, '반드시 할 것'과 밀리는 순서는 [migration-plan 6-1절 · 4절](architecture/migration-plan.md#6-1-멈춤-기준)을 따른다.

## 3. 다음에 할 것

### 1주차(9/28–10/2)

1. **기반:** 날짜 서비스(매장 시간대 + 영업일 기준 시각), 서버가 요청에서 정하는 id(ULID + HMAC), 계약 패키지의 충돌 키 함수.
2. **실행기 마무리:** `ui_defaults.apply(rev)`와 `json_schemas` 적재(`packages/contract`의 `ui-defaults.json`을 읽음, 실행기에는 `afterSchema` 자리가 있음), 백업 결과를 control `backups`에 적는 곳(실행기는 값만 돌려줌).
3. **매장 개설:** `shop.provision`(시드 + 스키장 템플릿 + `closing_scopes.main` · `calendars.main` + 기본 설정 반영)과 첫 매장 시드.
4. **legacy:** `packages/domain` · `packages/store` 뼈대, 레지스트리 · 품목 · 주문 codec(`shop1.` 같은 매장 코드 id 접두어)과 222개 시험이 만드는 모든 상태의 왕복 시험.
5. **화면:** 묶은 글꼴의 글자 폭 표(서버의 설정 검사용)와 줄인 Pretendard(지금 2 MB 전체), docs/35 1절 · docs/42 부록 A의 레일 없앰 개정(ski-rent-ops 쪽 문서라 사람이 정함).
6. **CI:** 저장소를 GitHub에 올리고 Settings → Pages의 Source를 'GitHub Actions'로 정한 뒤 `ci.yml` · `pages.yml` 첫 실행을 확인한다. 화면 규칙 검사를 리눅스에서 처음 도는 것이라 글꼴 · 속도 차이로 어긋나면 찍은 화면(작업의 올린 파일)을 보고 화면을 고친다.

### 2주차(10/5–10/8)

쓰기 순서(command_log · events · change_log · intent_marks · 투영), 검증기(돈 검사 포함), 나머지 모음 codec, facade + 사실 어댑터 + 이음매 1 · 2, 상태 대조. 끝 기준은 **모드 A · B 초록(222 × 2)**. 화면 쪽은 C1이 이미 있으므로 `DomainClient`를 store 위의 LocalClient로 바꿀 준비(읽기 모델 모양 맞추기)를 한다.

### 3주차 이후

migration-plan 6절 표대로 간다. 화면 줄기는 예시 자료로 만든 C1 · C2 · C3를 실제 API(HttpClient)와 LocalClient로 옮기고, 그 주의 새 화면(접수 확정 창, 수납 · 마감, 기사 업무 판 · 현장 수납 · 권 추가, 확인 필요, 로그인 · PIN)을 더한다. `FixtureClient`는 LocalClient가 체험판을 맡으면 폴더째 없앤다.

## 4. 앞 단계에서 남긴 작은 일

- `ui-defaults.json`은 판 2다(2026-09-23 검토: 시각 칸 합침 폭 4em · 약속 최소 10.5em, 수거 목록 팀 칸 비율, 수납 `has_due` · 조기 반납 `has_items_out` 조건). `ui_defaults.apply`가 옛 매장 파일을 이 판으로 올린다.
- 앱에 '새 버전 · 지금 바꾸기' 표시가 없다. 서비스 워커는 `skinote:apply-update`를 받을 준비가 되어 있다(열린 창이 없고 보냄 대기가 0일 때만 보내기로).
- 휴대폰에서 `시간순 되돌리기` 버튼이 폭 때문에 동작 줄에서 빠진다(맨 위로도 빠짐). 목록 머리나 더 보기 판에 둘지 정한다.
- 같은 끝 4자리가 여러 팀일 때 고르는 창은 예시 자료에 그런 팀이 없어 규칙 검사기가 열어 보지 못한다.
- 110% · 125% 확대 크기가 DeviceProfile `checkSizes`에 없어 규칙 검사기가 돌지 않는다(ui 8절에는 있음).
- 앞 단계의 `scripts/check-screens.mjs`(`test:ui`)는 이제 DeviceProfile · 토큰을 읽지만 규칙 검사기와 겹친다. 규칙 검사기로 옮겨 없앨지 정한다.
- 수거 목록 인쇄는 알림만 뜨고, `전화`는 번호만 보인다.
- 화면 훅(`useConfirmFlow` · `useLive` · `useCommandDraft`)을 DOM에서 도는 시험이 없다(시험에 DOM 흉내 패키지를 들이지 않았다). 봉투 · 초안의 순수 함수(`confirmEnvelope` · `draftOptions` · `reusableDraft`)와 규칙 검사기의 흐름으로 본다.
- 운영 연결(HttpClient)이 오면 `DomainError`의 NETWORK를 연결 띠와 잇고, `pending()`을 보냄 대기 목록 화면에 쓴다.
- 아직 없는 부품: `MethodRow`, `PlaceChooser`, `SlotChooser`, `ReviewList` · `ReviewBanner` · `ReviewStep`, `ChangeBanner`. 아직 없는 기사 화면(6-5): 배달 목록, 업무 판, 현장 수납 판, 권 추가 판.
- 루트 `engines`는 Node 22.13 이상이지만 `.ts`를 Node로 바로 읽는 검사 스크립트(`check:imports`, 규칙 검사기)는 22.18 이상이 필요하다. CI는 Node 22 최신판을 쓴다.

## 5. 정해야 할 것

- 개장일이 12/4(10주차 끝)와 G2(12/1)에 맞는지(README 열린 질문 11).
- 체험판을 LocalClient(SQLite WASM)로 바꿀 때 묶음 크기가 Pages에 괜찮은지(열린 질문 7). 안 되면 체험판은 읽기 전용.
- 라이선스(저장소 주인이 정함). 정할 때까지 `LICENSE` 파일을 두지 않는다.
