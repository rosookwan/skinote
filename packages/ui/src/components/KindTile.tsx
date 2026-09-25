// 새 접수 ① 품목의 종류 타일(KindTile, 시안 V2의 v2-kind · spec 3-4): 첫 줄 굵은 이름, 둘째 줄 회색 값('1일 40,000원' · 고른 권종
// '야간권 35,000원'), 고른 수는 오른쪽 끝의 남색 둥근 수 표시(지름 32, 흰 20px 숫자). 지금 연 종류는 옅은 바탕 + 굵은 남색 테두리 +
// 아래 띠 + 아래 갈매기 그림(`down`)이다(남색 바탕은 '고름'의 모양이라 쓰지 않는다). 칸이 좁으면(좁은 포스 3열) 갈매기를 먼저 빼고,
// 둘째 줄은 짧은 글('40,000원' · '야간권')로 줄인다(말줄임 없음). 타일에 무엇이 나오는지는 읽기 모델이 정했다(ADR-05).
import type { KindTile as KindTileView } from '@skinote/contract';
import { useRef, useState } from 'react';
import { Icon } from '../icons.tsx';
import { useElementSize, useFontsVersion, useIsoLayoutEffect } from '../measure.ts';
import { t } from '../strings.ko-KR.ts';
import { TextFit } from './TextFit.tsx';

export interface KindTileProps {
  tile: KindTileView;
  onPress: (key: string) => void;
}

export function KindTile({ tile, onPress }: KindTileProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const size = useElementSize(ref);
  const fonts = useFontsVersion();
  const signature = [size?.width ?? 0, fonts, tile.open ? 1 : 0, tile.count ?? 0, tile.label].join('|');
  const [chevron, setChevron] = useState({ signature, shown: true });
  const shown = chevron.signature === signature ? chevron.shown : true;
  // 연 종류의 갈매기가 들어가지 않으면(이름 · 둘째 줄이 제 칸을 넘치거나 둘째 줄의 짧은 글도 들어가지 않으면) 뺀다. 크기 · 글꼴 · 수가
  // 바뀌면 다시 넣어 본다. 둘째 줄의 맞춤(TextFit)은 이 확인보다 먼저 돌아 data-fits로 알린다.
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tile.open) return;
    const text = el.querySelector('.sn-kind-text');
    const tight = el.scrollWidth > el.clientWidth + 1 || (text !== null && text.scrollWidth > text.clientWidth + 1) || el.querySelector('[data-fits="false"]') !== null;
    if (shown && tight) setChevron({ signature, shown: false });
    else if (chevron.signature !== signature) setChevron({ signature, shown });
  });
  const alts = [tile.secondLine, ...(tile.secondShort ? [tile.secondShort] : [])];
  return (
    <button ref={ref} type="button" className="sn-button sn-kind" aria-expanded={tile.open} onClick={() => onPress(tile.key)}>
      <span className="sn-kind-text">
        <b className="sn-kind-name">{tile.label}</b>
        <TextFit className="sn-kind-second" input={{ mode: 'alts', alts }} />
      </span>
      {(tile.open && shown) || tile.count ? (
        <span className="sn-kind-end">
          {tile.open && shown ? <Icon name="down" /> : null}
          {tile.count ? <span className="sn-kind-count" role="img" aria-label={t('pickedCount', { n: tile.count })}>{tile.count}</span> : null}
        </span>
      ) : null}
    </button>
  );
}
