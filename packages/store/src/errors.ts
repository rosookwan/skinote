// 저장소의 오류: 코드(개발자용, 화면 글이 아니다)와 짧은 설명. 서버는 코드로 응답을 가르고 설명은 기록에만 남긴다.

export type StoreErrorCode =
  | 'SHOP_MISMATCH' // 이 매장 파일의 shops 행이 부른 매장이 아니다(deployment 2-5)
  | 'SHOP_NOT_PROVISIONED' // 매장 파일에 shops 행이 없다(아직 만들지 않음)
  | 'ALREADY_PROVISIONED' // 빈 파일에만 매장을 만든다
  | 'TIMEZONE_UNSUPPORTED' // Asia/Seoul이 아닌 매장(D13)
  | 'BAD_SPEC' // 매장 명세가 표로 옮겨지지 않는다
  | 'UNMAPPED_CHANGE' // 아직 표로 옮기지 못하는 바뀜 종류(C3a ~ C3e에서 채운다)
  | 'REENTRANT' // 한 매장의 트랜잭션 안에서 또 트랜잭션(명령은 await 없이 한 번에 돈다, D4)
  | 'NOT_FOUND'
  | 'NOT_TEST_SHOP' // 견본 자료(load-sample)는 시험 매장(shops.is_test)에만 넣는다
  | 'FAULT'; // 시험의 고장 고리(opts.fault)

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export const isStoreError = (error: unknown, code?: StoreErrorCode): error is StoreError =>
  error instanceof StoreError && (code === undefined || error.code === code);
