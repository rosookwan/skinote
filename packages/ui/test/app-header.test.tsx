// 머리줄의 연결 끊김 이름표(계획 work/impl-server/plan.md A3 · 6-4): 서버에 붙은 카운터가 끊기면 매장 이름 자리에 회색 이름표
// `연결 끊김`(남는 폭이 있으면 `· 마지막 연결 16:48`). 연결되어 있거나 연결 상태를 넘기지 않으면(체험판 · 기사 기기) 그리지 않는다.
// 빨강 · 영어 글자가 없다. 서버 그리기로 본다(잰 폭은 브라우저의 규칙 검사기가 본다).
import { DEFAULT_FEATURES, menuFor, uiDefaults } from '@skinote/contract';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { AppHeader, DeviceProfileProvider, headerOfflineAlts } from '../src/index.ts';

const noop = () => {};
const render = (node: ReactElement) => renderToStaticMarkup(<DeviceProfileProvider role="counter" timezone="Asia/Seoul" size={{ width: 1024, height: 600 }}>{node}</DeviceProfileProvider>);
const menu = menuFor(uiDefaults.menu_entries, 'pos', 'pos', DEFAULT_FEATURES, null);
const header = (connection?: { online: boolean; lastSyncAt?: string }) => render(
  <AppHeader shopName="우리 스키샵" menu={menu} alertCount={0} onHome={noop} onFind={noop} onMenu={noop} onMore={noop} onAlerts={noop} onExit={noop} {...(connection ? { connection } : {})} />,
);

describe('머리줄의 연결 끊김 이름표', () => {
  it('글: 마지막 연결 시각(매장 시간대)이 있으면 긴 것부터, 없으면 `연결 끊김`만', () => {
    expect(headerOfflineAlts('2026-12-26T07:48:00.000Z', 'Asia/Seoul')).toEqual(['연결 끊김 · 마지막 연결 16:48', '연결 끊김']);
    expect(headerOfflineAlts(undefined, 'Asia/Seoul')).toEqual(['연결 끊김']);
  });

  it('끊기면 매장 이름 자리에 이름표(읽는 이름은 긴 글), 연결되어 있으면 매장 이름', () => {
    const off = header({ online: false, lastSyncAt: '2026-12-26T07:48:00.000Z' });
    expect(off).toContain('class="sn-tag-slot sn-header-offline" role="status" aria-label="연결 끊김 · 마지막 연결 16:48"');
    expect(off).not.toContain('우리 스키샵');
    expect(off).not.toMatch(/[A-Za-z]{2,}<\//);
    const on = header({ online: true, lastSyncAt: '2026-12-26T07:48:00.000Z' });
    expect(on).not.toContain('sn-header-offline');
    expect(on).toContain('우리 스키샵');
    expect(header()).not.toContain('sn-header-offline');
  });
});
