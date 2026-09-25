// @skinote/layout — 칸 맞춤(ui 4-2), 글자 맞추기 · 쪽 나누기(4-3), 넘치는 목록(4-4), 확인 창 크기(4-5), 남는 높이를 줄에 나누기(fillRows), 카드 목록의 칸 · 쪽(packCards),
// 화면 키보드의 모양 고르기(fitKeyboard).
// 모두 순수 함수이고 크기 숫자는 부르는 쪽(DeviceProfile)이 넘긴다. 화면 · 설정 명령(서버) · 시험이 같은 코드를 쓴다.
export * from './columns.ts';
export * from './paging.ts';
export * from './areas.ts';
export * from './confirm.ts';
export * from './capacity.ts';
export * from './text.ts';
export * from './rows.ts';
export * from './cards.ts';
export * from './keyboard.ts';
