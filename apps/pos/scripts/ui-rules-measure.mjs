// 화면 규칙 재기(ui 4-1 · 8절, 옛 ski-rent-ops/scripts/pos-ui-rules.cjs의 measure를 옮겨 넓힘).
// measureRules는 브라우저 페이지 안에서 돈다(page.evaluate): 바깥 변수 · import를 쓰지 않고 받은 값(options)만 쓴다.
// 크기 숫자(최소 글자 · 누르는 곳)는 부르는 쪽이 DeviceProfile에서 읽어 넘기고, 색(늦음 빨강 · 강조색)은 페이지의 토큰(--sn-*)을 읽는다.
// 사람이 화면에서 알아챌 것만 잰다. 창(role=dialog)이 열려 있으면 그 창 안만 잰다(뒤 화면은 창을 열기 전에 쟀다).
//   smallText   등급 최소보다 작은 글자
//   shortTargets 등급 최소보다 작은 누르는 곳(버튼 · 탭 · 링크, 손가락 모양 커서의 바깥 요소)
//   overflow    페이지 · 요소의 가로 넘침, 화면 밖으로 나간 것, 내용이 상자 밖으로 흘러넘친 요소
//   clipped     잘리거나 상자 밖으로 넘친 글자(맞추지 못한 TextFit 포함)
//   ellipsis    말줄임표 글자, text-overflow: ellipsis, 줄 수 자르기(line-clamp)
//   scroll      페이지 스크롤, 스크롤 영역, 스크롤 상자 안의 목록, 반쯤 잘린 줄
//   primaries   한 화면(창)에 주 버튼 둘 이상, 등급 강조색이 아닌 주 버튼
//   red         늦은 것(.tone-late · .is-late)이 아닌 곳의 빨강
//   latin       영어 글자(보이는 글 · 읽어 주는 이름)
//   device      화면이 고른 기기 등급이 검사 크기의 등급과 다름

export const RULE_LABELS = {
  smallText: '작은 글자',
  shortTargets: '작은 누르는 곳',
  overflow: '넘침 · 화면 밖',
  clipped: '잘린 글자',
  ellipsis: '말줄임표',
  scroll: '스크롤 · 반쯤 잘린 줄',
  primaries: '주 버튼',
  red: '늦음이 아닌 빨강',
  latin: '영어 글자',
  device: '기기 등급',
};

export const RULES = Object.keys(RULE_LABELS);

/**
 * profiles: 등급 키 → { minFont, minTarget, accent }(DeviceProfile의 minFontPx · minTargetPx · accent).
 * sizeClass: 검사 크기의 등급. 화면이 고른 등급(.sn-root[data-device])과 둘 중 더 엄한 값으로 잰다.
 * allowedDevices: 이 경로 · 크기에서 화면이 골라야 할 등급들.
 * lateTokens: 늦음 빨강 토큰 이름(--sn-late …), lateSelector: 늦은 것의 모양(빨강을 허락하는 곳).
 * @param {{ profiles: Record<string, { minFont: number, minTarget: number, accent: string }>, sizeClass: string, allowedDevices: string[], lateTokens: string[], lateSelector: string }} options
 */
export function measureRules(options) {
  const { profiles, sizeClass, allowedDevices, lateTokens, lateSelector } = options;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const doc = document.documentElement;
  const styleCache = new Map();
  const cs = (el) => {
    let s = styleCache.get(el);
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
    return s;
  };
  const visibleCache = new Map();
  const visible = (el) => {
    if (visibleCache.has(el)) return visibleCache.get(el);
    let ok = el.getClientRects().length > 0;
    if (ok) {
      const s = cs(el);
      ok = s.visibility !== 'hidden' && s.visibility !== 'collapse' && s.display !== 'none';
    }
    for (let p = el; ok && p && p !== doc; p = p.parentElement) if (Number(cs(p).opacity) === 0) ok = false;
    if (ok) {
      const r = el.getBoundingClientRect();
      ok = r.width > 0.5 && r.height > 0.5;
    }
    visibleCache.set(el, ok);
    return ok;
  };
  const isSvgPart = (el) => el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg';
  const name = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };
  const path = (el) => {
    const parts = [];
    for (let p = el; p && p !== document.body && parts.length < 3; p = p.parentElement) parts.unshift(name(p));
    return parts.join(' > ');
  };
  const sample = (el) => (el.getAttribute?.('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
  const round = (n) => Math.round(n * 10) / 10;
  const out = { smallText: [], shortTargets: [], overflow: [], clipped: [], ellipsis: [], scroll: [], primaries: [], red: [], latin: [], device: [] };
  const seen = new Map();
  const add = (rule, el, extra = {}) => {
    const key = rule + '|' + (el ? path(el) + '|' + sample(el) : '') + '|' + (extra.why ?? '');
    const hit = seen.get(key);
    if (hit) { hit.count += 1; return; }
    const row = { el: el ? path(el) : '', text: el ? sample(el) : '', ...extra, count: 1 };
    seen.set(key, row);
    out[rule].push(row);
  };

  // ── 색: 토큰(#hex · rgb())을 rgb 값으로 ───────────────────────────
  const parseColor = (value) => {
    const v = String(value ?? '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(v);
    if (m) return m[1].split('').map((c) => parseInt(c + c, 16)).concat(1);
    m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
    m = /^rgba?\(([^)]+)\)$/i.exec(v);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    }
    return null;
  };
  const sameColor = (a, b) => a && b && a[3] > 0.05 && Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[2] - b[2]) <= 2;
  const roots = [...document.querySelectorAll('.sn-root')];
  const snRoot = roots.at(-1) ?? doc;
  const token = (key) => parseColor(getComputedStyle(snRoot).getPropertyValue(key));
  const lateColors = lateTokens.map(token).filter(Boolean);
  const accentColors = ['--sn-orange', '--sn-purple'].map(token).filter(Boolean);
  /** 빨강: 늦음 토큰 그대로이거나 빨강 쪽 색상(도장 주홍 14° · 주황 20°는 빨강이 아니다). */
  const isRed = (rgba) => {
    if (!rgba || rgba[3] <= 0.05) return false;
    if (lateColors.some((c) => sameColor(c, rgba))) return true;
    const [r, g, b] = rgba.map((x, i) => (i < 3 ? x / 255 : x));
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (max + min) / 2;
    const d = max - min;
    if (d < 0.001 || max !== r) return false;
    const sat = d / (1 - Math.abs(2 * light - 1));
    let hue = 60 * (((g - b) / d) % 6);
    if (hue < 0) hue += 360;
    return (hue >= 340 || hue <= 10) && sat >= 0.4 && light >= 0.2 && light <= 0.7;
  };

  // ── 잴 범위: 열린 창이 있으면 맨 위 창 ─────────────────────────────
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const root = dialogs.at(-1) ?? document.body;
  const all = [...root.querySelectorAll('*')].filter((el) => !isSvgPart(el) && visible(el));

  // ── 기기 등급과 그 등급의 값 ───────────────────────────────────────
  const device = snRoot.getAttribute?.('data-device') ?? '';
  if (!allowedDevices.includes(device)) add('device', null, { why: '화면 등급 ' + (device || '없음') + ', 기대 ' + allowedDevices.join(' · ') });
  const sizeProfile = profiles[sizeClass];
  const pageProfile = profiles[device] ?? sizeProfile;
  const minFont = Math.max(sizeProfile.minFont, pageProfile.minFont);
  const minTarget = Math.max(sizeProfile.minTarget, pageProfile.minTarget);
  const accent = pageProfile.accent;
  const accentColor = token('--sn-' + accent);

  // ── 보이는 글 조각(글 노드마다 잰 상자) ───────────────────────────
  const texts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || !n.textContent.trim() || parent.closest('script,style,noscript,title') || isSvgPart(parent) || !visible(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    const box = {
      left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)),
    };
    texts.push({ parent, text: n.textContent.trim(), box });
  }

  // ① 작은 글자
  for (const t of texts) {
    const px = parseFloat(cs(t.parent).fontSize);
    if (px < minFont - 0.01) add('smallText', t.parent, { px: round(px), min: minFont });
  }

  // ② 말줄임표 · 영어 글자
  for (const t of texts) {
    if (/…|\.\.\.|⋯/.test(t.text)) add('ellipsis', t.parent, { why: '말줄임표 글자' });
    if (/[A-Za-z]/.test(t.text)) add('latin', t.parent);
  }
  for (const el of all) {
    const s = cs(el);
    if (s.textOverflow === 'ellipsis') add('ellipsis', el, { why: 'text-overflow' });
    const clamp = s.webkitLineClamp ?? s.getPropertyValue('-webkit-line-clamp');
    if (clamp && clamp !== 'none') add('ellipsis', el, { why: 'line-clamp' });
    const aria = el.getAttribute('aria-label');
    if (aria && /[A-Za-z]/.test(aria)) add('latin', el, { why: 'aria-label' });
  }

  // ③ 잘린 · 넘친 글자: 글 상자가 그 글을 담은 상자(인라인이 아닌 가장 가까운 조상) 밖, 또는 넘침을 자르는 조상 밖.
  const blockOf = (el) => {
    let p = el;
    while (p && p !== root && ['inline', 'contents'].includes(cs(p).display)) p = p.parentElement;
    return p ?? el;
  };
  const clipsX = (el) => cs(el).overflowX !== 'visible';
  const clipsY = (el) => cs(el).overflowY !== 'visible';
  for (const t of texts) {
    const s = cs(t.parent);
    const font = parseFloat(s.fontSize);
    const lineHeight = parseFloat(s.lineHeight) || font * 1.2;
    // 글 상자의 높이는 글꼴의 위아래 여백(약 1.3em)이라 줄 높이가 작으면 조금 삐져나온다: 그만큼은 봐준다.
    const tolY = Math.max(1.5, (font * 1.3 - lineHeight) / 2 + 1);
    const box = blockOf(t.parent);
    const r = box.getBoundingClientRect();
    if (t.box.right > r.right + 1 || t.box.left < r.left - 1) add('clipped', box, { why: '글이 상자보다 넓음', need: round(t.box.right - t.box.left), has: round(r.width) });
    else if (t.box.bottom > r.bottom + tolY || t.box.top < r.top - tolY) add('clipped', box, { why: '글이 상자보다 높음', need: round(t.box.bottom - t.box.top), has: round(r.height) });
    for (let p = box; p && p !== doc && p !== document.body; p = p.parentElement) {
      const x = clipsX(p);
      const y = clipsY(p);
      if (!x && !y) continue;
      const c = p.getBoundingClientRect();
      if ((x && (t.box.right > c.right + 1 || t.box.left < c.left - 1)) || (y && (t.box.bottom > c.bottom + tolY || t.box.top < c.top - tolY))) {
        add('clipped', t.parent, { why: '조상이 글을 자름', by: name(p) });
        break;
      }
    }
  }
  for (const el of all) {
    if (el.matches('[data-fits="false"]')) add('clipped', el, { why: '글자 맞추기 실패' });
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if ((ownText || el.tagName === 'BUTTON') && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && (clipsX(el) || el.tagName === 'BUTTON')) {
      add('clipped', el, { why: '글이 버튼 · 상자 밖', need: el.scrollWidth, has: el.clientWidth });
    }
  }

  // ④ 가로 넘침 · 화면 밖
  const pageWidth = Math.max(doc.scrollWidth, document.body.scrollWidth);
  if (pageWidth > vw + 1) add('overflow', null, { why: '페이지 가로 넘침', need: pageWidth, has: vw });
  const spilling = all.filter((el) => {
    if (el.clientWidth === 0 || ['inline', 'contents', 'table-row', 'table-row-group', 'table-header-group'].includes(cs(el).display)) return false;
    return el.scrollWidth > el.clientWidth + 1 || (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1 && !['auto', 'scroll'].includes(cs(el).overflowY));
  });
  const spillSet = new Set(spilling);
  for (const el of spilling) {
    // 가장 안쪽 요소만(바깥 조상들은 같은 넘침을 물려받는다).
    if ([...el.querySelectorAll('*')].some((d) => spillSet.has(d))) continue;
    const wide = el.scrollWidth > el.clientWidth + 1;
    add('overflow', el, wide ? { why: '내용이 가로로 넘침', need: el.scrollWidth, has: el.clientWidth } : { why: '내용이 세로로 넘침', need: el.scrollHeight, has: el.clientHeight });
  }
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
      add('overflow', el, { why: '화면 밖', box: [round(r.left), round(r.top), round(r.right), round(r.bottom)].join(',') });
    }
  }

  // ⑤ 누르는 곳: 버튼 · 탭 · 링크 · 입력, 그리고 손가락 모양 커서를 가진 가장 바깥 요소.
  const targetSelector = 'button,a[href],select,textarea,input:not([type="hidden"]),[role="button"],[role="tab"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="option"],[tabindex]:not([tabindex="-1"])';
  const targets = new Set(all.filter((el) => el.matches(targetSelector)));
  for (const el of all) {
    if (targets.has(el) || cs(el).cursor !== 'pointer') continue;
    if (el.parentElement && cs(el.parentElement).cursor === 'pointer') continue;
    if (el.closest(targetSelector)) continue;
    targets.add(el);
  }
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    if (r.height < minTarget - 0.5 || r.width < minTarget - 0.5) add('shortTargets', el, { w: round(r.width), h: round(r.height), min: minTarget });
  }

  // ⑥ 스크롤: 페이지 스크롤, 스크롤 영역, 스크롤 상자 안의 목록, 반쯤 잘린 줄.
  const pageHeight = Math.max(doc.scrollHeight, document.body.scrollHeight);
  if (pageHeight > vh + 1) add('scroll', null, { why: '페이지 세로 스크롤', need: pageHeight, has: vh });
  const listItem = 'li,tr,[role="row"],[role="listitem"],[role="option"],.sn-check,.sn-key,.sn-kb-key,.pos-van-row,.pos-choice-button,.pos-visit-choice';
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const s = cs(el);
    const scrollY = ['auto', 'scroll'].includes(s.overflowY);
    const scrollX = ['auto', 'scroll'].includes(s.overflowX);
    if (!scrollY && !scrollX) continue;
    if ((scrollY && el.scrollHeight > el.clientHeight + 1) || (scrollX && el.scrollWidth > el.clientWidth + 1)) add('scroll', el, { why: '스크롤 영역' });
    else if (el.querySelector(listItem)) add('scroll', el, { why: '스크롤 상자 안의 목록' });
  }
  const frames = '.sn-ledger,.sn-slip-items,.sn-checklist-list,.sn-dialog,.sn-keypad,.sn-kb,.sn-sheet,.sn-slip,.pos-side,.pos-card,.sn-footer,.sn-rowbar';
  for (const item of root.querySelectorAll(listItem)) {
    if (!visible(item)) continue;
    const r = item.getBoundingClientRect();
    const boxes = [{ top: 0, bottom: vh, by: '화면' }];
    for (let p = item.parentElement; p && p !== doc && p !== document.body; p = p.parentElement) {
      if (clipsY(p) || p.matches(frames)) { const c = p.getBoundingClientRect(); boxes.push({ top: c.top, bottom: c.bottom, by: name(p) }); }
    }
    const cut = boxes.find((b) => r.top < b.top - 1 || r.bottom > b.bottom + 1);
    if (cut) add('scroll', item, { why: '반쯤 잘린 줄', by: cut.by });
  }

  // ⑦ 주 버튼: 창 · 화면 안에 하나, 색은 등급 강조색.
  const primaries = all.filter((el) => el.matches('[data-primary="true"]'));
  const painted = all.filter((el) => el.matches('button,[role="button"]') && !el.matches('[data-primary="true"]') && accentColors.some((c) => sameColor(c, parseColor(cs(el).backgroundColor))));
  for (const el of painted) add('primaries', el, { why: '주 버튼 표시 없는 강조색 버튼' });
  if (primaries.length + painted.length > 1) for (const el of primaries) add('primaries', el, { why: '주 버튼 ' + (primaries.length + painted.length) + '개' });
  for (const el of primaries) {
    if (el.disabled) continue;
    if (!sameColor(accentColor, parseColor(cs(el).backgroundColor))) add('primaries', el, { why: '등급 강조색(' + accent + ')이 아님', color: cs(el).backgroundColor });
  }

  // ⑧ 빨강은 늦은 것에만: 글자 · 바탕 · 테두리 · 윤곽선 · 그림자 · 그림 색.
  const lateOk = (el) => Boolean(el.closest(lateSelector));
  const colorsOf = (el) => {
    const s = cs(el);
    const found = [];
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText) found.push(['글자', s.color]);
    found.push(['바탕', s.backgroundColor]);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(s['border' + side + 'Width']) > 0 && s['border' + side + 'Style'] !== 'none') found.push(['테두리', s['border' + side + 'Color']]);
    }
    if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) found.push(['윤곽선', s.outlineColor]);
    if (s.boxShadow && s.boxShadow !== 'none') for (const m of s.boxShadow.matchAll(/rgba?\([^)]+\)/g)) found.push(['그림자', m[0]]);
    return found;
  };
  for (const el of all) {
    if (lateOk(el)) continue;
    for (const [what, value] of colorsOf(el)) if (isRed(parseColor(value))) { add('red', el, { why: what, color: value }); break; }
  }
  for (const svg of root.querySelectorAll('svg')) {
    if (!visible(svg) || lateOk(svg)) continue;
    for (const part of [svg, ...svg.querySelectorAll('*')]) {
      const s = getComputedStyle(part);
      const hit = [['그림 선', s.stroke], ['그림 칠', s.fill]].find(([, v]) => isRed(parseColor(v)));
      if (hit) { add('red', svg.parentElement ?? svg, { why: hit[0], color: hit[1] }); break; }
    }
  }

  return {
    dialog: dialogs.length > 0,
    dialogTitle: dialogs.length ? (dialogs.at(-1).querySelector('h2')?.textContent ?? '').trim() : '',
    device,
    minFont,
    minTarget,
    viewport: [vw, vh],
    primaries: primaries.length,
    problems: Object.fromEntries(Object.entries(out).filter(([, rows]) => rows.length)),
  };
}
