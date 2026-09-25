// 관리(머리줄 `관리`, ui 3-6 · 6-9): 포스의 관리 화면은 카드 목록이다(AGENTS 화면 규칙 8). 장부형 틀(종이 한 장, 제목 `관리`) 안에 카드
// `매장 설정`(→ 운영 규칙 탭, V8) · `마감`(→ 오늘 영업일의 하루 마감, V6). 카드 전체가 누르는 곳이다(두 칸, 줄 높이는 두 줄 줄).
// 설정 · 재고 · 정비 · 거래처 · 직원 · 기기 · 백업 카드는 그 화면을 만들 때 더한다(ui 3-6). 바닥줄은 돌아갈 곳 `‹ 장부` 하나(주 버튼 없음).
// 화면은 규칙을 계산하지 않는다: 마감의 날짜는 서버가 준 영업일(currentBusinessDate)이다.
import type { LedgerViewResult } from '@skinote/contract';
import { FooterBar, Icon, TextFit, t } from '@skinote/ui';
import { useLive } from '../app/client.tsx';
import { go } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { usePosHeader } from '../components/PosHeader.tsx';

/** 서버의 오늘 영업일(기준 시각 06:00을 넣은 날). 읽기 전에는 null(마감 화면이 영업일 주소로 바꾼다). */
function useBusinessDate(): string | null {
  const live = useLive<LedgerViewResult>('today', (c) => c.ledgerView('day_ledger', {}));
  return live.data?.currentBusinessDate ?? null;
}

interface ManageCard {
  key: string;
  label: string;
  onPress: () => void;
}

export function ManageScreen() {
  const header = usePosHeader('other', 'management');
  const date = useBusinessDate();
  const cards: ManageCard[] = [
    { key: 'settings', label: say('shopSettings'), onPress: () => go({ name: 'shopSettings', tab: 'rules' }) },
    { key: 'closing', label: say('closing'), onPress: () => go({ name: 'closing', date }) },
  ];
  return (
    <div className="sn-screen">
      {header.element}
      <div className="sn-desk">
        <main className="sn-sheet pos-manage" aria-label={t('manage')}>
          <div className="sn-titlebar">
            <h1 className="sn-title"><TextFit input={{ mode: 'words', text: t('manage') }} /></h1>
          </div>
          <div className="pos-manage-body">
            {cards.map((card) => (
              <button key={card.key} type="button" className="pos-manage-card" onClick={card.onPress}>
                <span className="pos-manage-title">{card.label}</span>
                <Icon name="right" />
              </button>
            ))}
          </div>
        </main>
      </div>
      <FooterBar metrics={[]} primary={null}>
        <div className="pos-footer-back">
          <button type="button" className="sn-button" aria-label={t('home')} onClick={() => go({ name: 'ledger', date: null })}>
            <Icon name="left" />
            <span>{t('home')}</span>
          </button>
        </div>
      </FooterBar>
      {header.overlays}
    </div>
  );
}
