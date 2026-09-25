// 글자 입력 판(새 접수의 대표자 이름 spec 3-4, 현금 점검의 직접 입력 사유 spec 3-7): 화면 키보드(HangulKeyboard)가 아래에서 올라온다.
// 매장 포스에 실제 자판이 없어(2026-09-26 사용자 요청) 숫자판처럼 이 판의 키로 친다. 편집 칸이 없어 운영체제 자판이 뜨지 않고, 자판이
// 있는 카운터 PC는 그 자판으로도 친다(글쇠 자리를 두벌식으로 읽음). 낱자모가 남은 글('김민ㅅ')에 `입력`을 누르면 넘기지 않고 제목 아래
// 회색 한 줄 `글자 미완성 · 정정 필요`가 뜬다(치는 동안에는 뜨지 않는다: 새 글자마다 자음이 먼저 온다). 들어가기(Enter) = 입력,
// Esc · 제목 줄의 `닫기` = 닫기.
import { HangulKeyboard, hasLoneJamo, t } from '@skinote/ui';

export interface TextSheetProps {
  title: string;
  value: string;
  /** 빈 칸의 회색 글('이름'). */
  placeholder: string;
  maxLength: number;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

/** 이름 · 사유로 받는 글: 낱자모(조합이 끝나지 않은 자모)가 없다. */
const complete = (text: string) => !hasLoneJamo(text);

export function TextSheet({ title, value, placeholder, maxLength, onSubmit, onClose }: TextSheetProps) {
  return (
    <HangulKeyboard
      title={title}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      onSubmit={onSubmit}
      onClose={onClose}
      accept={complete}
      note={t('textIncomplete')}
    />
  );
}
