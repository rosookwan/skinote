// 부품 문구 표: 시험 · 규칙 검사기 · 촬영이 버튼 이름으로 찾는 고정 문구는 값을 여기에 그대로 적어 둔다(바꾸면 이 시험이 알린다).
import { describe, expect, it } from 'vitest';
import { FIXED_STRING_KEYS, STRINGS_KO, createStrings, t } from '../src/strings.ko-KR.ts';

describe('문구 표', () => {
  it('고정 문구(검사기 · 문서 docs/42 부록 A가 기대는 이름)', () => {
    expect(Object.fromEntries(FIXED_STRING_KEYS.map((key) => [key, STRINGS_KO[key]]))).toEqual({
      home: '장부', find: '끝 4자리', more: '더 보기', manage: '관리', exit: '나가기', offline: '연결 끊김', page: '{page} / {total}쪽',
      pinTitle: '긴급', tooNarrow: '화면 폭 부족', zoomReset: '확대 초기화', close: '닫기', prevPage: '이전 쪽', nextPage: '다음 쪽',
      qtyMinus: '수량 감소', qtyPlus: '수량 증가', moveUpLabel: '위로', moveDownLabel: '아래로', moveTop: '맨 위로', notCollected: '수거 실패',
      search: '찾기', erase: '정정', confirm: '확인', pinAck: '확인',
    });
  });

  it('영어 글자 · 말줄임표가 없고, 자리의 값이 빠지면 던진다', () => {
    for (const text of Object.values(STRINGS_KO)) {
      expect(text.replace(/\{\w+\}/g, '')).not.toMatch(/[A-Za-z]/);
      expect(text).not.toContain('…');
    }
    expect(t('page', { page: 1, total: 3 })).toBe('1 / 3쪽');
    // @ts-expect-error 자리 값이 빠짐
    expect(() => t('page', { page: 1 })).toThrow('{total}');
    const say = createStrings({ hello: '{name} 팀' } as const);
    expect(say('hello', { name: '박준호' })).toBe('박준호 팀');
  });
});
