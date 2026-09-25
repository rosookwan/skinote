// @skinote/domain — 스키노트의 업무 규칙(work/impl-server/plan.md §3, D1). 가게 상태(ShopState) 위의 순수 함수: 도장 · 돈 · 일정 ·
// 재고 규칙, 명령 처리기(applyCommand), 읽기 모델 만들기(ledgerView · runQuery). SQL · React · Node 내장 모듈 없이 @skinote/contract만
// 가져온다. 메모리 어댑터(apps/pos의 FixtureClient)와 서버 저장소(packages/store)가 같은 코드를 쓴다. 견본 매장은 './sample'.
// 지금은 옮긴 그대로(B1)라 안쪽 셈도 내보낸다(메모리 어댑터의 이야기 · 시험이 쓴다). B2에서 execute · diffShop · 투영이 더해지고 줄어든다.
export * from './model.ts';
export * from './change.ts';
export * from './lines.ts';
export * from './spec.ts';
export * from './time.ts';
export * from './result.ts';
export * from './catalog.ts';
export * from './assets.ts';
export * from './rules.ts';
export {
  attributeReturn, bucketLeft, bucketOnVan, bucketOut, collectTaskIdOf, currentReturn, findTask, lineBuckets, openReturns, orderTasks, returnPromises,
  samePromise, splitRow, taskBucket, taskOrder, type FxBucket, type FxReturnPromise, type FxTask,
} from './promises.ts';
/** 줄이 아직 돌려받을 수(모든 일정 몫). rules.ts의 lineLeft(줄의 받지 않은 돈)와 이름이 겹쳐 따로 이름 붙인다. */
export { lineLeft as lineReturnLeft } from './promises.ts';
export * from './stamps.ts';
export * from './deposits.ts';
export * from './views.ts';
export * from './order-draft.ts';
export * from './promise-sheet.ts';
export * from './return-sheet.ts';
export * from './checkout.ts';
export * from './group-pay.ts';
export * from './closing.ts';
export * from './driver.ts';
export * from './shop-rules.ts';
export * from './commands.ts';
export * from './execute.ts';
export * from './query.ts';
export { SAMPLE_STAFF, prepareImport, sampleDay, sampleRegistry, sampleRules, sampleSpec, type ImportOptions, type SampleDayOptions } from './sample/index.ts';
