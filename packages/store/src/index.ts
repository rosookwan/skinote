// @skinote/store — 서버 저장소(work/impl-server/plan.md §4, D1 · D4 · D10). 도메인 상태(ShopState) ↔ 매장 파일 · control 파일의 표.
// SQL은 이 패키지에만 있다(AGENTS.md). node:sqlite는 가져오지 않고 @skinote/schema의 openDatabase()가 연 연결을 구조 형식(Db)으로
// 받는다. 지금 표로 옮기는 것: 매장 만들기(목록 값 · 운영 규칙 · 돈통 · 직원 · 역할 · 재고), 운영 규칙 저장, 접수 번호 셈, 명령 트랜잭션과
// 작업 기록(command_log 멱등 · events 해시 사슬 · event_pii · change_log · intent_marks · rev), 기기 · 세션 행, 쓰는 사람 잠금.
// 접수 · 재고 이동 · 돈 · 보증금 · 차량 업무 · 마감의 표 옮기기는 도메인 B2 다음 단계(C3a ~ C3e)다.
export * from './db.ts';
export * from './errors.ts';
export * from './ids.ts';
export * from './dates.ts';
export * from './lock.ts';
export * from './registry-keys.ts';
export * from './registry-write.ts';
export * from './registry-read.ts';
export * from './provision.ts';
export * from './load.ts';
export * from './devices.ts';
export * from './journal.ts';
export * from './write.ts';
export * from './shop-store.ts';
export * from './control/index.ts';
