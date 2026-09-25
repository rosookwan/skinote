// @skinote/contract — 화면과 서버가 함께 쓰는 형식: 코드 키 어휘, 화면 설정 행, 읽기 모델, DomainClient,
// 명령 봉투와 초안, 상태 문구, 화면 기본 설정(ui-defaults.json), 둘째 판 화면의 읽기 모델(sheets.ts).
export * from './vocab.ts';
export * from './status-terms.ts';
export * from './config.ts';
export * from './read-models.ts';
export * from './sheets.ts';
export * from './client.ts';
export * from './request-id.ts';
export * from './ui-defaults.ts';
export * from './validate.ts';
export * from './shape.ts';
export * from './auth.ts';
// 들어오는 본문의 검사(plan §5-2). 작은 검사 말(str · obj …)은 wire.ts 안에만 두고 검사 함수와 한도만 내보낸다.
export {
  parseAuthBody, parseEnvelope, parseQuery, ID_PATTERN, KEY_PATTERN, LEDGER_VIEW_KEYS, QUEUE_FIELDS, WIRE_LIMITS, WIRE_QUERY_NAMES,
  type AuthBodies, type EnvelopeOptions, type LedgerViewKey, type WireFailure, type WireQuery,
} from './wire.ts';
