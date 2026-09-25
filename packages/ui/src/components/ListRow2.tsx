// 두 줄 목록 줄(ListRow2, 시안의 mk-list-row): 윗줄 굵은 이름(+ 오른쪽 금액), 아랫줄 작은 설명. 설명이 품목 목록이면 좁을 때
// '외 N종'으로 줄인다(말줄임 없음). 누르는 줄이면 줄 전체가 버튼(높이 = 등급의 누르는 곳). 새 접수의 선택 품목 · 접수 내용이 쓰고,
// 일괄 수납 · 마감의 두 줄 줄도 같은 모양이다. 글은 읽기 모델이 쓴다.
import { TextFit } from './TextFit.tsx';

export interface ListRow2Props {
  title: string;
  note?: string;
  /** 설명이 품목 목록이면 그 목록(좁으면 '외 N종'). */
  items?: readonly string[];
  /** 오른쪽 금액 글('160,000원'). */
  amount?: string;
  onPress?: () => void;
}

export function ListRow2({ title, note, items, amount, onPress }: ListRow2Props) {
  const body = (
    <>
      <span className="sn-list-top">
        <TextFit className="sn-list-title" input={{ mode: 'words', text: title }} />
        {amount ? <span className="sn-list-amount">{amount}</span> : null}
      </span>
      {note ? <TextFit className="sn-list-note" input={items && items.length > 1 ? { mode: 'items', items } : { mode: 'words', text: note }} /> : null}
    </>
  );
  return (
    <li className={'sn-list-row' + (onPress ? ' is-pressable' : '')}>
      {onPress ? <button type="button" className="sn-list-main sn-list-press" onClick={onPress}>{body}</button> : <span className="sn-list-main">{body}</span>}
    </li>
  );
}
