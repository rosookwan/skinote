// 접수증 옆 동작의 할인 적용 · 접수 취소(품목 취소) · 즉시 교환 창을 한 묶음으로 따로 받는다(OrderSlipScreen의 loadEdit). 셋을 한 파일에서 내보내면
// 빌드가 작은 묶음 셋 대신 하나를 만들어, 첫 화면 묶음(scripts/check-dist.mjs ④)을 줄이면서 전체 크기는 덜 늘어난다.
export { DiscountDialog } from './DiscountDialog.tsx';
export { CancelDialog } from './CancelDialog.tsx';
export { ExchangeDialog } from './ExchangeDialog.tsx';
