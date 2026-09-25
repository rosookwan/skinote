// 포스 화면들의 머리줄(ui 3-6): 장부(홈) · 끝 4자리 찾기 · 메뉴(menu_entries, 등급 칸 수) · 더 보기 · 알림 · 관리 · 나가기.
// 끝 4자리는 어느 화면에서든 숫자판(아래에서 올라오는 판)을 열고, 한 팀이면 그 접수증을 바로 연다(N10).
// 메뉴는 화면 키(screen_key)의 경로로 간다(router의 screenRoute: 수거 목록 #/collections/:date, 관리 #/manage).
// 아직 없는 화면(리프트권 · 확인 필요 · 사이즈 요청)은 한 문장 알림으로 알린다.
// 서버에 붙은 카운터가 끊기면 매장 이름 자리에 회색 이름표 `연결 끊김 · 마지막 연결 16:48`(AppHeader connection, 계획 6-4).
import { menuFor, type MenuEntryRow, type ReviewItem } from '@skinote/contract';
import { AppHeader, Keypad, t, useDeviceProfile, type AppHeaderMore } from '@skinote/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { useClient, useConfig, useConnection, useLive } from '../app/client.tsx';
import { go, screenRoute } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { ChoiceSheet, NoticeDialog, type Choice } from './NoticeDialog.tsx';

export interface PosHeader {
  element: ReactNode;
  /** 머리줄의 판 · 창이 열려 있다(그동안 새로 고침을 미룬다). */
  active: boolean;
  overlays: ReactNode;
}

type Sheet = { title: string; choices: Choice[]; onPick: (key: string) => void };
type Message = { title: string; lines: string[] };

/**
 * 머리줄로 다른 화면에 가기 전에 묻는 곳(저장하지 않은 바꿈이 있는 매장 설정 V8: `미저장 변경 3건`). proceed를 부르면 간다.
 * 끝 4자리 숫자판 · 알림 · 더 보기 판처럼 화면을 떠나지 않는 것은 묻지 않는다.
 */
export type LeaveGuard = (proceed: () => void) => void;

/**
 * from: 지금 화면. 장부에서 연 접수증은 '‹ 장부'가 뒤로 가기로 그 자리에 돌아간다. currentKey: 켜진 메뉴(관리 화면이면 'management').
 * guard: 떠나기 전에 묻는 곳(없으면 바로 간다).
 */
export function usePosHeader(from: 'ledger' | 'slip' | 'collection' | 'other', currentKey?: string, guard?: LeaveGuard): PosHeader {
  const client = useClient();
  const config = useConfig();
  const profile = useDeviceProfile();
  const connection = useConnection();
  const [finding, setFinding] = useState(false);
  const [digits, setDigits] = useState('');
  const [note, setNote] = useState<string | undefined>(undefined);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const reviews = useLive<ReviewItem[]>('reviews', (c) => c.query('reviewList', {}), finding || sheet !== null || message !== null);
  const menu = useMemo(() => (config ? menuFor(config.menuEntries, 'pos', profile.key, config.features, null) : []), [config, profile.key]);

  const leave = (proceed: () => void) => (guard ? guard(proceed) : proceed());
  const openSlip = (orderId: string) => {
    setFinding(false);
    setSheet(null);
    setDigits('');
    setNote(undefined);
    leave(() => go({ name: 'slip', orderId }, { state: { fromLedger: from === 'ledger' } }));
  };

  const find = (last4: string) => {
    client.query('findLast4', { last4 }).then((found) => {
      if (found.matches.length === 1) openSlip(found.matches[0]!.orderId);
      else if (found.matches.length === 0) setNote(say('notFound', { last4 }));
      else {
        setFinding(false);
        setSheet({
          title: say('last4', { last4 }),
          choices: found.matches.map((m) => ({ key: m.orderId, label: say('teamName', { name: m.teamName }) + ' · ' + m.last4, note: m.parts.map((p) => p.text).join(' · ') })),
          onPick: openSlip,
        });
      }
    }, () => setNote(say('findFailed')));
  };

  const soon = (label: string) => setMessage({ title: label, lines: [say('screenSoon')] });
  const openMenu = (entry: MenuEntryRow) => {
    const route = screenRoute(entry.screen_key);
    if (route) leave(() => go(route));
    else soon(entry.label);
  };

  const onMore = (more: AppHeaderMore) => {
    const choices: Choice[] = more.entries.map((entry: MenuEntryRow) => ({ key: entry.key, label: entry.label }));
    if (more.includesExit) choices.push({ key: '__exit', label: t('exit'), icon: 'exit' });
    setSheet({
      title: t('more'),
      choices,
      onPick: (key) => {
        setSheet(null);
        const entry = more.entries.find((e) => e.key === key);
        if (key === '__exit') leave(() => go({ name: 'exit' }));
        else if (entry) openMenu(entry);
      },
    });
  };

  const alerts = reviews.data ?? [];
  const element = (
    <AppHeader
      shopName={config?.shopName ?? ''}
      menu={menu}
      alertCount={alerts.length}
      {...(currentKey ? { currentKey } : {})}
      onHome={() => leave(() => go({ name: 'ledger', date: null }))}
      onFind={() => { setDigits(''); setNote(undefined); setFinding(true); }}
      onMenu={openMenu}
      onMore={onMore}
      onAlerts={() => setMessage({ title: t('alerts'), lines: alerts.length ? alerts.map((a) => a.message) : [say('noAlerts')] })}
      onExit={() => leave(() => go({ name: 'exit' }))}
      connection={connection}
    />
  );

  const overlays = (
    <>
      {finding ? (
        <Keypad
          value={digits}
          onChange={(value) => { setDigits(value); setNote(undefined); }}
          onSubmit={find}
          open
          placement="sheet"
          onClose={() => setFinding(false)}
          {...(note ? { note } : {})}
        />
      ) : null}
      {sheet ? <ChoiceSheet title={sheet.title} choices={sheet.choices} onPick={sheet.onPick} onClose={() => setSheet(null)} /> : null}
      {message ? <NoticeDialog title={message.title} lines={message.lines} onClose={() => setMessage(null)} /> : null}
    </>
  );

  return { element, overlays, active: finding || sheet !== null || message !== null };
}
