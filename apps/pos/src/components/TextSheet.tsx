// 글자 입력 판(새 접수의 대표자 이름, spec 3-4): 기기 자판으로 치는 칸 하나와 `닫기` · `입력`. 카운터 PC는 자판으로 치고, 태블릿은
// 기기 자판이 아래에서 올라온다. 끝 4자리 숫자판처럼 아래에서 올라오는 판이다. 들어가기(Enter)는 입력(한글 조합 중에는 아님), Esc는 닫기.
import { Icon, t } from '@skinote/ui';
import { useEffect, useId, useRef, useState } from 'react';

export interface TextSheetProps {
  title: string;
  value: string;
  /** 빈 칸의 회색 글('이름'). */
  placeholder: string;
  maxLength: number;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

export function TextSheet({ title, value, placeholder, maxLength, onSubmit, onClose }: TextSheetProps) {
  const titleId = useId();
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const submit = () => onSubmit(text.trim());
  return (
    <div className="sn-sheet-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <section className="pos-text-sheet">
        <h2 id={titleId} className="pos-text-sheet-title">{title}</h2>
        <input
          ref={input}
          className="pos-text-input"
          value={text}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-labelledby={titleId}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit();
            else if (event.key === 'Escape') onClose();
          }}
        />
        <div className="pos-text-actions">
          <button type="button" className="sn-button" onClick={onClose}>
            <Icon name="left" />
            <span>{t('close')}</span>
          </button>
          <button type="button" className="sn-button pos-text-go" onClick={submit}>{t('enter')}</button>
        </div>
      </section>
    </div>
  );
}
