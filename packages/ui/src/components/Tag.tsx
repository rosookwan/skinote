// 작은 이름표(Tag, 시안의 mk-tag): 제목 옆 `전화 예약`, 줄 안의 `결제 팀` · `결제 예정` 같은 16px 글 한 칸. 누르는 곳이 아니다.
// 색은 뜻으로 고른다: 다른 팀이 낼 몫은 파랑(blue), 차량이 할 일은 보라(purple), 그 밖은 옅은 종이(plain).

export interface TagProps {
  text: string;
  tone?: 'plain' | 'blue' | 'purple';
}

export function Tag({ text, tone = 'plain' }: TagProps) {
  return <span className={'sn-chip' + (tone === 'plain' ? '' : ' is-' + tone)}>{text}</span>;
}
