// 반납 · 수령 장소 고르기(PlaceChooser, ui 5 · 4-4): `매장 직접`과 구역 버튼(`설천 ›` …)이 한 줄. 구역을 누르면 같은 줄이 그 구역의
// 장소(`‹ 구역` · `한솔동` · `두솔동` …)로 바뀌고, 장소를 고르면 구역 줄로 돌아와 고른 구역 버튼이 두 줄(`솔마을` / `두솔동`)이 된다
// (줄 수는 늘지 않는다, spec 3-2). 넘치면 끝 칸이 `더 보기`(꽃마을 여섯 곳). 구역 · 장소의 차례는 매장 설정(읽기 모델) 그대로다.
// 새 접수 ② 일정(V3)은 줄을 바꾸지 않고 구역의 장소를 작은 창으로 연다(onArea, spec 3-5 ④). 차량 배달 창은 `매장 직접` 없이(store false).
import type { PlaceArea, PlacePick } from '@skinote/contract';
import { useState } from 'react';
import { Icon } from '../icons.tsx';
import { t } from '../strings.ko-KR.ts';
import { ChoiceRow } from './Choice.tsx';

export interface PlaceChooserProps {
  areas: PlaceArea[];
  place: PlacePick;
  onPick: (place: PlacePick) => void;
  /** 묶음의 읽는 이름('반납 장소'). */
  label: string;
  /** 고른 구역 버튼의 읽는 이름('솔마을 두솔동 · 장소 다시 선택'). */
  againName?: (place: string) => string;
  /** 주면 구역을 눌렀을 때 같은 줄 대신 부르는 쪽이 그 구역의 장소를 연다(작은 창). */
  onArea?: (area: PlaceArea) => void;
  /** `매장 직접` 버튼(기본 있음). 차량 배달 장소처럼 매장이 답이 아닌 줄은 false. */
  store?: boolean;
}

/** 매장 직접 버튼의 key(구역 key와 겹치지 않게). */
const STORE = 'store:direct';

/** 장소의 온전한 이름: 숙소 구역은 구역 이름을 앞에 붙인다('솔마을 두솔동', PlaceArea.lodging). */
const fullName = (area: PlaceArea, place: { label: string }) => (area.lodging ? area.label + ' ' + place.label : place.label);

export function PlaceChooser({ areas, place, onPick, label, againName, onArea, store = true }: PlaceChooserProps) {
  const [open, setOpen] = useState<string | null>(null);
  const picked = place.mode === 'vehicle' ? areas.find((a) => a.places.some((p) => p.key === place.placeKey)) : undefined;
  const pickedPlace = picked?.places.find((p) => place.mode === 'vehicle' && p.key === place.placeKey);
  const area = open ? areas.find((a) => a.key === open) : undefined;

  if (area) {
    return (
      <ChoiceRow
        label={label}
        lead={(
          <button type="button" className="sn-button sn-choice" onClick={() => setOpen(null)}>
            <Icon name="left" />
            <span>{t('areas')}</span>
          </button>
        )}
        options={area.places.map((p) => ({ key: p.key, label: p.label, selected: pickedPlace?.key === p.key, enabled: true }))}
        onPress={(key) => { setOpen(null); onPick({ mode: 'vehicle', placeKey: key }); }}
      />
    );
  }
  const names: Record<string, string> = picked && pickedPlace && againName ? { [picked.key]: againName(fullName(picked, pickedPlace)) } : {};
  return (
    <ChoiceRow
      label={label}
      names={names}
      options={[
        ...(store ? [{ key: STORE, label: t('storeDirect'), selected: place.mode === 'store', enabled: true }] : []),
        ...areas.map((a) => (a === picked && pickedPlace
          ? { key: a.key, label: a.label, secondLine: pickedPlace.label, selected: true, enabled: true }
          : { key: a.key, label: a.label, opens: true, selected: false, enabled: true })),
      ]}
      onPress={(key) => {
        if (key === STORE) onPick({ mode: 'store' });
        else if (onArea) { const area = areas.find((a) => a.key === key); if (area) onArea(area); }
        else setOpen(key);
      }}
    />
  );
}
