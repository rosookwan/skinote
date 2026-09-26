#!/usr/bin/env bash
# 스키노트 서버 배포(맥 → VPS). 빌드는 하지 않는다: apps/pos/dist는 먼저 `npm run build`로 만든다.
#
#   deploy/deploy.sh                 새 릴리스를 올리고 켜고 확인한다(커밋한 것만, 아니면 --allow-dirty)
#   deploy/deploy.sh --rollback      바로 전 릴리스로 되돌린다(코드만, 마이그레이션이 든 릴리스는 --force 없이는 거절)
#   deploy/deploy.sh --status        서버의 릴리스 · 서비스 · 상태 · 마지막 배포 작업 · 알림만 본다
#   deploy/deploy.sh --stage <폴더>  서버에 붙지 않고 릴리스 사본만 <폴더>/<릴리스 이름>에 만들고 점검한다(저장소 밖이나 무시 폴더)
#   deploy/deploy.sh --shop-cli <명령> [깃발…]
#                                    서버에서 매장 명령줄(server/bin/shop.js: provision · load-sample · reset-test-shop · device-code ·
#                                    rotate-pin · revoke-device · status)을 돌린다. 요청은 ssh 표준 입력의 JSON으로 가고(서버의 고정 입구
#                                    deploy/shop-cli.sh), 비밀번호 · 등록 번호는 이 터미널에만 찍힌다(파일 · 기록 없음).
#                                    provision · load-sample · reset-test-shop은 서버를 잠깐 멈췄다가 다시 켠다.
#
# 선택: --allow-dirty(커밋하지 않은 변경을 시험 배포), --allow-stale-dist(낡은 빌드인 줄 알고), --force(되돌리기에서만),
#       --allow-no-e2e(서버 끝까지 시험 기록 없이: 시험 배포만)
#
# 배포 전에 서버 끝까지 시험(npm run test:e2e)이 지금 빌드 · 서버 코드로 모두 통과한 기록(work/e2e/<시각>/report.json)이 있어야 한다.
#
# 설정(환경 변수가 먼저, 없으면 git에 올리지 않는 deploy/.env.local):
#   SKINOTE_SSH    ssh 별칭이나 user@host. root가 아니면 비밀번호 없는 sudo가 있어야 한다(ssh 키, BatchMode).
#   SKINOTE_SITE   사이트 주소(예: skinote.<IP를 대시로>.sslip.io). 저장소에 적지 않는다.
#
# 서버에서의 모양(/srv/skinote):
#   releases/<UTC 시각>-<커밋>[-dirty]/{app,server,schema,contract,domain,store,deploy,RELEASE,
#                                       node_modules/@skinote/{schema,contract,domain,store} -> ../../<이름>}
#   app/index.html에는 서버 모드 표시(<meta name="skinote-runtime" content="server">)를 찍는다(apps/pos/dist는 그대로: 체험판).
#   current -> releases/<…>   (한 번에 바꾸는 링크, 가장 새 5개만 남김)
# 설치 · 되돌리기는 서버에서 떼어 낸 작업(systemd-run)으로 돈다: ssh가 끊기거나 Ctrl-C를 눌러도 서버에서는 끝까지 돌고,
# 기록은 /var/log/skinote-ops/deploy/<작업>.log에 남는다(--status가 보인다). 한 번에 하나만(/run/skinote-deploy.lock).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"
DIST="$REPO_ROOT/apps/pos/dist"

REMOTE_BASE=/srv/skinote
REMOTE_NODE=/usr/local/bin/node
APP_PORT=3100
KEEP_RELEASES=5
NODE_MIN_MAJOR=22
# 22.18부터 .ts를 깃발 없이 읽는다(저장소 · 도메인 · 계약 패키지가 TypeScript 원본 그대로 돈다).
NODE_MIN_MINOR=18
# Caddy 2.5부터 reverse_proxy가 들어온 X-Forwarded-For를 믿지 않는다(사이트 파일도 header_up으로 못 박는다).
CADDY_MIN_MAJOR=2
CADDY_MIN_MINOR=5
# 릴리스에 넣는 서버 쪽 패키지(TypeScript 원본 그대로, node_modules/@skinote/<이름>으로 잇는다).
SERVER_PACKAGES=(schema contract domain store)
UNIT_FILES=(skinote-server.service skinote-backup.service skinote-backup.timer skinote-alert@.service)
# 서버 작업을 기다리는 한도(초). 설치 안에서 마이그레이션을 최대 15분 기다린다.
INSTALL_JOB_LIMIT=1500
ROLLBACK_JOB_LIMIT=300

MODE=deploy
STAGE_PARENT=
FORCE=0
ALLOW_STALE_DIST=0
ALLOW_DIRTY=0
ALLOW_NO_E2E=0
SHOP_CLI_ARGS=()

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '배포 중단: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rollback) MODE=rollback ;;
    --status) MODE=status ;;
    --stage)
      MODE=stage
      [[ $# -ge 2 ]] || die '--stage 다음에 폴더가 필요합니다'
      STAGE_PARENT="$2"
      shift
      ;;
    --force) FORCE=1 ;;
    --allow-stale-dist) ALLOW_STALE_DIST=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --allow-no-e2e) ALLOW_NO_E2E=1 ;;
    --shop-cli)
      MODE=shop-cli
      shift
      [[ $# -ge 1 ]] || die '--shop-cli 다음에 명령이 필요합니다(provision · load-sample · reset-test-shop · device-code · rotate-pin · revoke-device · status)'
      SHOP_CLI_ARGS=("$@")
      break
      ;;
    -h | --help) usage; exit 0 ;;
    *) die "모르는 선택: $1 (--help)" ;;
  esac
  shift
done

# deploy/.env.local: KEY=VALUE 줄만 읽는다(실행하지 않음). 이미 있는 환경 변수가 이긴다.
load_env_file() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(SKINOTE_[A-Z_]+)=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      value="${BASH_REMATCH[3]}"
      value="${value%\"}"; value="${value#\"}"
      value="${value%\'}"; value="${value#\'}"
      if [[ -z "${!key+x}" ]]; then
        export "$key=$value"
      fi
    else
      die "$file: 알 수 없는 줄입니다(SKINOTE_이름=값만): $line"
    fi
  done <"$file"
}
load_env_file "$DEPLOY_DIR/.env.local"

need_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 명령이 없습니다"
}

# ── 로컬 점검 ─────────────────────────────────────────────────────────────

check_dist() {
  step '빌드한 앱 확인(apps/pos/dist)'
  [[ -f "$DIST/index.html" ]] || die "빌드한 앱이 없습니다: apps/pos/dist/index.html (먼저 npm run build)"
  local f
  for f in sw.js manifest.webmanifest; do
    [[ -f "$DIST/$f" ]] || die "빌드에 $f가 없습니다(먼저 npm run build)"
  done
  # 빌드에 들어가는 원본이 index.html보다 새로우면 빌드가 낡은 것이다.
  local sources=() p
  for p in apps/pos/src apps/pos/index.html apps/pos/public apps/pos/pwa apps/pos/vite.config.ts apps/pos/package.json \
    packages/ui/src packages/contract/src packages/contract/ui-defaults.json packages/layout/src; do
    [[ -e "$REPO_ROOT/$p" ]] && sources+=("$REPO_ROOT/$p")
  done
  local newer=''
  [[ ${#sources[@]} -eq 0 ]] || newer="$(find "${sources[@]}" -type f -newer "$DIST/index.html" ! -name '.DS_Store' 2>/dev/null | head -n 5 || true)"
  if [[ -n "$newer" ]]; then
    say "빌드보다 새로 고친 원본:"
    printf '  %s\n' "${newer//$REPO_ROOT\//}"
    if [[ "$ALLOW_STALE_DIST" = 1 ]]; then
      say '(--allow-stale-dist: 낡은 빌드인 줄 알고 계속합니다)'
    else
      die 'apps/pos/dist가 원본보다 낡았습니다. npm run build 뒤 다시 하세요(억지로: --allow-stale-dist)'
    fi
  fi
  if [[ -f "$REPO_ROOT/scripts/check-dist.mjs" ]]; then
    local out
    if ! out="$(node "$REPO_ROOT/scripts/check-dist.mjs" 2>&1)"; then
      printf '%s\n' "$out" >&2
      die '빌드 확인(check-dist)에 걸렸습니다'
    fi
    say '빌드 확인(check-dist) 통과'
  fi
}

check_server_tests() {
  step '서버 시험(packages/server · store · schema · domain)'
  local out pkg
  for pkg in server store schema; do
    if ! out="$(cd "$REPO_ROOT/packages/$pkg" && npm test --silent 2>&1)"; then
      printf '%s\n' "$out" | tail -n 40 >&2
      die "시험이 실패했습니다: packages/$pkg"
    fi
    printf '  %s: %s\n' "$pkg" "$(printf '%s\n' "$out" | grep -E '^# (pass|fail) ' | tr '\n' ' ')"
  done
  if ! out="$(cd "$REPO_ROOT/packages/domain" && npm test --silent 2>&1)"; then
    printf '%s\n' "$out" | tail -n 40 >&2
    die '시험이 실패했습니다: packages/domain'
  fi
  printf '  domain: %s\n' "$(printf '%s\n' "$out" | grep -E '^ *Tests ' | tail -n 1 | sed 's/^ *//')"
}

# 서버 끝까지 시험(npm run test:e2e)의 마지막 기록이 지금 빌드 · 서버 코드보다 새롭고 모두 통과인지(배포 전 문).
check_e2e() {
  step '서버 끝까지 시험 기록(work/e2e)'
  local latest='' newer='' problem=''
  latest="$(ls -1d "$REPO_ROOT"/work/e2e/*/report.json 2>/dev/null | sort | tail -n 1 || true)"
  if [[ -z "$latest" ]]; then
    problem='기록이 없습니다'
  elif [[ ! "$latest" -nt "$DIST/index.html" ]]; then
    problem="마지막 기록(${latest#"$REPO_ROOT"/})이 지금 빌드보다 오래되었습니다"
  else
    newer="$(find "$REPO_ROOT/packages/server/src" "$REPO_ROOT/packages/server/bin" "$REPO_ROOT/packages/store/src" "$REPO_ROOT/packages/domain/src" \
      "$REPO_ROOT/packages/contract/src" "$REPO_ROOT/packages/schema/migrations" "$REPO_ROOT/packages/schema/src" \
      -type f -newer "$latest" ! -name '.DS_Store' 2>/dev/null | head -n 3 || true)"
    if [[ -n "$newer" ]]; then
      problem="마지막 기록 뒤에 고친 서버 코드가 있습니다: $(printf '%s ' ${newer//$REPO_ROOT\//})"
    elif ! node -e '
const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const bad = (r.results || []).filter((x) => x.state !== "ok");
for (const b of bad.slice(0, 5)) console.log("  " + (b.state === "blocked" ? "막힘" : "실패") + ": " + b.name);
process.exit(r.results && r.results.length && !bad.length ? 0 : 1);' "$latest"; then
      problem="마지막 기록(${latest#"$REPO_ROOT"/})에 실패 · 막힘이 있습니다"
    fi
  fi
  if [[ -z "$problem" ]]; then
    say "통과: ${latest#"$REPO_ROOT"/}"
  elif [[ "$ALLOW_NO_E2E" = 1 ]]; then
    say "주의: $problem (--allow-no-e2e: 시험 배포로 계속합니다)"
  else
    die "$problem. npm run build && npm run test:e2e 뒤 다시 하세요(시험 배포면 --allow-no-e2e)"
  fi
}

release_name() {
  local stamp sha dirty=''
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  sha="$(git -C "$REPO_ROOT" rev-parse --short=7 HEAD 2>/dev/null)" || die 'git 커밋을 읽지 못했습니다'
  local paths=(apps/pos packages/server packages/schema packages/store packages/domain packages/ui packages/contract packages/layout deploy)
  if ! git -C "$REPO_ROOT" diff --quiet HEAD -- "${paths[@]}" 2>/dev/null; then
    dirty='-dirty'
  elif [[ -n "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard -- "${paths[@]}" 2>/dev/null | head -n 1)" ]]; then
    dirty='-dirty'
  fi
  printf '%s-%s%s' "$stamp" "$sha" "$dirty"
}

# 릴리스 사본을 만든다: $1 = 부모 폴더, $2 = 릴리스 이름, $3 = 사이트 주소(Caddy 파일의 자리에 넣음)
stage_release() {
  local parent="$1" name="$2" site="$3" dir
  dir="$parent/$name"
  [[ ! -e "$dir" ]] || die "이미 있는 폴더입니다: $dir"
  mkdir -p "$dir"
  rsync -a --exclude '.DS_Store' "$DIST/" "$dir/app/"
  # 서버 판의 앱 뼈대: 릴리스의 index.html에만 서버 모드 표시를 찍는다(apps/pos/dist · GitHub Pages는 체험판 그대로).
  node "$REPO_ROOT/packages/server/bin/stamp-runtime.js" "$dir/app/index.html" >/dev/null || die '앱 뼈대에 서버 표시를 넣지 못했습니다'
  grep -q '<meta name="skinote-runtime" content="server">' "$dir/app/index.html" || die '릴리스의 index.html에 서버 표시가 없습니다'
  grep -q 'skinote-runtime' "$DIST/index.html" && die 'apps/pos/dist/index.html에 서버 표시가 있습니다(체험판 빌드에는 없어야 함)'
  rsync -a --exclude '.DS_Store' --exclude 'test/' --exclude 'data/' --exclude 'node_modules/' --exclude 'RELEASE' \
    "$REPO_ROOT/packages/server/" "$dir/server/"
  rsync -a --exclude '.DS_Store' --exclude 'test/' --exclude 'tools/' --exclude 'node_modules/' \
    "$REPO_ROOT/packages/schema/" "$dir/schema/"
  # 서버가 읽는 TypeScript 패키지(원본 그대로: Node가 형을 지우고 읽는다). 시험 · 설정 파일은 넣지 않는다.
  local pkg
  for pkg in contract domain store; do
    rsync -a --exclude '.DS_Store' --exclude 'test/' --exclude 'node_modules/' --exclude 'tsconfig*.json' --exclude 'vitest.config.*' \
      "$REPO_ROOT/packages/$pkg/" "$dir/$pkg/"
  done
  mkdir -p "$dir/deploy"
  local f
  for f in "${UNIT_FILES[@]}" skinote.caddy.template skinote.env.example README.md deploy.sh shop-cli.sh; do
    cp "$DEPLOY_DIR/$f" "$dir/deploy/$f"
  done
  # 사이트 주소만 채운다. 앞단 표 자리(__SKINOTE_PROXY_TOKEN__)는 서버의 설치 작업이 secrets.env 값으로 채운다(표는 서버 밖으로 나가지 않음).
  sed "s/__SKINOTE_SITE__/$site/g" "$DEPLOY_DIR/skinote.caddy.template" >"$dir/deploy/skinote.caddy"
  grep -q '__SKINOTE_SITE__' "$dir/deploy/skinote.caddy" && die 'Caddy 사이트 파일의 자리를 채우지 못했습니다'
  grep -q 'header_up X-Skinote-Proxy __SKINOTE_PROXY_TOKEN__' "$dir/deploy/skinote.caddy" || die 'Caddy 사이트 파일에 앞단 표 자리가 없습니다'
  mkdir -p "$dir/node_modules/@skinote"
  for pkg in "${SERVER_PACKAGES[@]}"; do
    ln -s "../../$pkg" "$dir/node_modules/@skinote/$pkg"
  done
  printf '%s\n' "$name" >"$dir/RELEASE"
  printf '%s\n' "$name" >"$dir/server/RELEASE"
  chmod -R u=rwX,go=rX "$dir"
  # 운영 자료 · 비밀이 섞이지 않았는지
  if find "$dir" \( -name '*.sqlite*' -o -name '.env*' -o -name '*.db' -o -name 'secrets.env' \) -print | grep -q .; then
    die '릴리스에 데이터베이스나 .env 파일이 섞였습니다'
  fi
  say "릴리스 사본: $dir ($(du -sh "$dir" | cut -f1))"
  # 사본에서 서버를 띄워 본다(빠진 파일, @skinote/* 연결, 앞단을 거친 상태 확인, 장부 API의 문, 백업 명령, 종료).
  node "$dir/server/bin/smoke.js" --expect-release "$name" || die '릴리스 사본 점검에 실패했습니다'
}

# ── 서버와 이야기 ─────────────────────────────────────────────────────────

SSH_CONTROL_DIR=
SSH_OPTS=()
REMOTE_SHELL=bash
RSYNC_PATH=rsync
STAGE_TMP=

cleanup() {
  if [[ -n "$SSH_CONTROL_DIR" ]]; then
    ssh -o ControlPath="$SSH_CONTROL_DIR/%C" -O exit "$SKINOTE_SSH" >/dev/null 2>&1 || true
    rm -rf "$SSH_CONTROL_DIR"
  fi
  [[ -n "$STAGE_TMP" ]] && rm -rf "$STAGE_TMP"
  return 0
}
trap cleanup EXIT

setup_ssh() {
  [[ -n "${SKINOTE_SSH:-}" ]] || die 'SKINOTE_SSH가 없습니다(환경 변수나 deploy/.env.local)'
  [[ "$SKINOTE_SSH" =~ ^[A-Za-z0-9._@-]+$ ]] || die 'SKINOTE_SSH는 ssh 별칭이나 user@host 모양이어야 합니다'
  need_tool ssh
  SSH_CONTROL_DIR="$(mktemp -d /tmp/skinote-ssh.XXXXXX)"
  SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
    -o ControlMaster=auto -o ControlPath="$SSH_CONTROL_DIR/%C" -o ControlPersist=120)
}

check_site() {
  [[ -n "${SKINOTE_SITE:-}" ]] || die 'SKINOTE_SITE가 없습니다(환경 변수나 deploy/.env.local)'
  [[ "$SKINOTE_SITE" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] \
    || die 'SKINOTE_SITE는 호스트 이름만 적습니다(https:// · 경로 · 포트 없이)'
}

# 원격에서 스크립트(표준 입력)를 돌린다: remote_run <스크립트> [인자…]
remote_run() {
  local script="$1"
  shift
  local quoted='' arg
  for arg in "$@"; do
    [[ "$arg" =~ ^[A-Za-z0-9._:/@=-]*$ ]] || die "원격 인자 모양이 틀렸습니다: $arg"
    quoted+=" ${arg:-''}"
  done
  printf '%s\n' "$script" | ssh "${SSH_OPTS[@]}" "$SKINOTE_SSH" "$REMOTE_SHELL -s --$quoted"
}

# 원격 준비 확인(부르는 계정 그대로, 바꾸는 것 없음). 공통 Caddyfile의 static_app 조각을 읽어 보인다(고치지 않음).
REMOTE_PREFLIGHT='{
set -u
uid=$(id -u); echo "uid=$uid"
if [ "$uid" -ne 0 ]; then if sudo -n true 2>/dev/null; then echo "sudo=ok"; else echo "sudo=no"; fi; else echo "sudo=root"; fi
echo "node=$('"$REMOTE_NODE"' --version 2>/dev/null || echo missing)"
echo "caddy=$(caddy version 2>/dev/null | head -n 1 || echo missing)"
if getent group caddy >/dev/null 2>&1; then echo "group caddy=ok"; else echo "group caddy=missing"; fi
for t in rsync caddy systemd-run flock runuser; do if command -v "$t" >/dev/null 2>&1; then echo "tool $t=ok"; else echo "tool $t=missing"; fi; done
if id skinote >/dev/null 2>&1; then echo "user=ok"; else echo "user=missing"; fi
for d in '"$REMOTE_BASE"' /var/lib/skinote /etc/caddy/sites; do if [ -d "$d" ]; then echo "dir $d=ok"; else echo "dir $d=missing"; fi; done
echo "current=$(readlink '"$REMOTE_BASE"'/current 2>/dev/null || true)"
if [ -r /etc/caddy/Caddyfile ]; then sed -n "/^(static_app)/,/^}/p" /etc/caddy/Caddyfile | sed "s/^/snippet| /"; else echo "snippet=unreadable"; fi
}'

preflight() {
  step "서버 확인($SKINOTE_SSH)"
  local out
  out="$(printf '%s\n' "$REMOTE_PREFLIGHT" | ssh "${SSH_OPTS[@]}" "$SKINOTE_SSH" 'sh -s')" || die 'ssh로 서버에 붙지 못했습니다'
  get() { printf '%s\n' "$out" | sed -n "s|^$1=||p" | head -n 1; }
  case "$(get sudo)" in
    root) REMOTE_SHELL=bash; RSYNC_PATH=rsync ;;
    ok) REMOTE_SHELL='sudo -n bash'; RSYNC_PATH='sudo -n rsync' ;;
    *) die 'root가 아닌 계정인데 비밀번호 없는 sudo가 없습니다' ;;
  esac
  local node_version major minor
  node_version="$(get node)"
  [[ "$node_version" =~ ^v([0-9]+)\.([0-9]+)\. ]] || die "서버에 $REMOTE_NODE가 없습니다($node_version)"
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  if ((major < NODE_MIN_MAJOR || (major == NODE_MIN_MAJOR && minor < NODE_MIN_MINOR))); then
    die "서버 Node가 낡았습니다: $node_version (필요 v$NODE_MIN_MAJOR.$NODE_MIN_MINOR 이상)"
  fi
  local t
  for t in rsync caddy systemd-run flock runuser; do
    [[ "$(get "tool $t")" = ok ]] || die "서버에 $t 명령이 없습니다"
  done
  local caddy_version
  caddy_version="$(get caddy)"
  [[ "$caddy_version" =~ ^v?([0-9]+)\.([0-9]+) ]] || die "서버의 Caddy 판을 읽지 못했습니다($caddy_version)"
  if ((BASH_REMATCH[1] < CADDY_MIN_MAJOR || (BASH_REMATCH[1] == CADDY_MIN_MAJOR && BASH_REMATCH[2] < CADDY_MIN_MINOR))); then
    die "서버 Caddy가 낡았습니다: ${caddy_version%% *} (필요 v$CADDY_MIN_MAJOR.$CADDY_MIN_MINOR 이상: 들어온 X-Forwarded-For를 믿지 않는 판)"
  fi
  # 사이트 파일(앞단 표가 든다)은 root:caddy 0640으로 둔다.
  [[ "$(get 'group caddy')" = ok ]] || die '서버에 caddy 그룹이 없습니다(사이트 파일을 root:caddy 0640으로 둔다)'
  [[ "$(get user)" = ok ]] || die '서버에 skinote 계정이 없습니다'
  local d
  for d in "$REMOTE_BASE" /var/lib/skinote /etc/caddy/sites; do
    [[ "$(get "dir $d")" = ok ]] || die "서버에 $d 폴더가 없습니다"
  done
  say "계정 uid $(get uid) · sudo $(get sudo) · node $node_version · caddy ${caddy_version%% *} · 지금 릴리스 $(get current || true)"

  # 매장 명령줄은 Caddy 조각을 보지 않는다.
  [[ "$MODE" != shop-cli ]] || return 0
  # 공통 static_app 조각: root나 인자({args…})가 있으면 스키노트의 root를 덮거나 빈 값으로 가져온다.
  local snippet
  snippet="$(printf '%s\n' "$out" | sed -n 's/^snippet| //p')"
  if [[ -z "$snippet" ]]; then
    say '주의: 공통 Caddyfile에서 (static_app) 조각을 찾지 못했습니다(다른 파일에 있거나 읽을 수 없음). 배포 뒤 바깥 확인이 대신 봅니다'
  else
    say '공통 static_app 조각(읽기만):'
    printf '%s\n' "$snippet" | sed 's/^/    /'
    if [[ "$MODE" = deploy ]]; then
      if printf '%s\n' "$snippet" | grep -Eq '^[[:space:]]*root([[:space:]]|$)'; then
        die '공통 static_app이 root를 정합니다: 스키노트의 root(/srv/skinote/current/app)를 덮어 다른 폴더를 내줄 수 있습니다. 조각을 보고 skinote.caddy.template을 맞춘 뒤 다시 하세요'
      fi
      if printf '%s\n' "$snippet" | grep -q '{args'; then
        die '공통 static_app이 인자({args…})를 받습니다: import static_app에 줄 값을 정해 skinote.caddy.template을 고친 뒤 다시 하세요'
      fi
    fi
  fi
}

# 상태 요약(서버에서 node로 돈다). 인자: 기대 릴리스(비면 보지 않음), 포트. ok이고 릴리스가 맞으면 끝 코드 0.
HEALTH_JS='
const [want, port] = process.argv.slice(1);
fetch("http://127.0.0.1:" + port + "/api/health", { signal: AbortSignal.timeout(5000) })
  .then(r => r.json())
  .then(h => {
    const dbs = (h.databases || []).map(d => d.file + "=" + d.status + (d.writable ? "" : "(쓰기 막음 " + (d.reason || (d.warnings || []).join("+") || "-") + ")")).join(", ");
    const warn = (h.warnings || []).length ? " · 주의 " + h.warnings.join(",") : "";
    const disk = h.disk ? " · 디스크 " + h.disk.usedPercent + "% 사용" : "";
    console.log("  [서버] 상태 ok=" + h.ok + " · 릴리스 " + h.release + " · " + dbs + warn + disk);
    process.exit(h.ok === true && (!want || h.release === want) ? 0 : 1);
  }, e => { console.log("  [서버] 상태 확인 실패: " + e.message); process.exit(1); });
'

# 원격 스크립트의 머리: HEALTH_JS 정의(서버의 bash가 그대로 읽는 %q 모양).
health_js_line() {
  printf 'HEALTH_JS=%q\n' "$HEALTH_JS"
}

# 원격 설치(root로, 떼어 낸 작업): 인자 = 릴리스 이름, 포트, 남길 개수, 사이트 주소
remote_install_script() {
  health_js_line
  cat <<'REMOTE'
# 한 덩어리로 읽힌 뒤 돈다.
{
set -euo pipefail
NAME="$1"; PORT="$2"; KEEP="$3"; SITE="$4"
BASE=/srv/skinote; REL="$BASE/releases"; NEW="$REL/$NAME"; INC="$REL/.incoming-$NAME"
NODE=/usr/local/bin/node; DATA=/var/lib/skinote; OPS=/var/log/skinote-ops
UNIT_DIR=/etc/systemd/system; SITE_FILE=/etc/caddy/sites/skinote.caddy; ENV_FILE=/etc/skinote/skinote.env
SECRETS_FILE=/etc/skinote/secrets.env
SECRET_NAMES="SKINOTE_PIN_PEPPER SKINOTE_SESSION_KEY SKINOTE_FINGERPRINT_KEY SKINOTE_IP_KEY SKINOTE_PROXY_TOKEN"
PREV_UNITS=/etc/skinote/units.prev; SITE_PREV=/etc/skinote/skinote.caddy.prev
UNITS="skinote-server.service skinote-backup.service skinote-backup.timer skinote-alert@.service"
log() { printf '  [서버] %s\n' "$*" || true; }
fail() { printf '  [서버] 실패: %s\n' "$*" >&2 || true; exit 1; }
exec 9>/run/skinote-deploy.lock
flock -n 9 || fail "다른 배포 작업이 도는 중입니다(/run/skinote-deploy.lock)"
case "$SITE" in '' | *[!A-Za-z0-9.-]*) fail "사이트 주소 모양이 틀렸습니다" ;; esac

live() { "$NODE" -e "fetch('http://127.0.0.1:$PORT/api/health/live',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; }
# wait_live <초>: 그 시간 안에 살아 있음이 답하면 0. 마이그레이션 동안은 서버가 답하지 않는다(동기).
wait_live() { local until=$((SECONDS + $1)); while [ "$SECONDS" -lt "$until" ]; do if live; then return 0; fi; sleep 1; done; return 1; }
health_ok() { "$NODE" -e "$HEALTH_JS" "$1" "$PORT"; }
restart_server() { systemctl reset-failed skinote-server.service >/dev/null 2>&1 || true; systemctl restart skinote-server.service; }
switch_to() { ln -sfn "releases/$1" "$BASE/current.new"; mv -Tf "$BASE/current.new" "$BASE/current"; }

[ -d "$INC" ] || fail "올린 폴더가 없습니다: $INC"
[ ! -e "$NEW" ] || fail "같은 이름의 릴리스가 이미 있습니다: $NAME"
chown -R root:root "$INC"
chmod -R u=rwX,go=rX "$INC"
mv -T "$INC" "$NEW"
PREV="$(readlink "$BASE/current" 2>/dev/null || true)"
PREV_NAME="${PREV#releases/}"
[ -z "$PREV_NAME" ] || [ -d "$REL/$PREV_NAME" ] || PREV_NAME=""

# 새 마이그레이션(전 릴리스에 없는 파일). 있으면 저절로 되돌리지 않고, 마이그레이션을 오래 기다린다.
if [ -n "$PREV_NAME" ]; then
  added="$(comm -23 <(ls -1 "$NEW/schema/migrations" | sort) <(ls -1 "$REL/$PREV_NAME/schema/migrations" 2>/dev/null | sort) | tr '\n' ' ')"
else
  added="(첫 배포)"
fi
[ -z "$added" ] || log "새 마이그레이션: $added"

# 1) 설정 파일(없을 때만, 첫 매장 id를 새로 만든다)과 자료 폴더.
install -d -m 755 -o root -g root /etc/skinote
if [ ! -f "$ENV_FILE" ]; then
  shop_id="$(runuser -u skinote -- "$NODE" "$NEW/server/bin/new-shop-id.js")"
  case "$shop_id" in *[!0-9A-Z]* | '') fail "매장 id를 만들지 못했습니다" ;; esac
  sed -e "s/^SKINOTE_SHOP_IDS=.*/SKINOTE_SHOP_IDS=$shop_id/" -e "s/^SKINOTE_PORT=.*/SKINOTE_PORT=$PORT/" \
    "$NEW/deploy/skinote.env.example" >"$ENV_FILE.tmp"
  chown root:skinote "$ENV_FILE.tmp"
  chmod 640 "$ENV_FILE.tmp"
  mv -f "$ENV_FILE.tmp" "$ENV_FILE"
  log "설정 파일을 만들었습니다: $ENV_FILE (첫 매장 id $shop_id)"
fi
# 앱 주소(SKINOTE_PUBLIC_ORIGIN): 서버가 Origin을 맞춰 보고 기기 서명 문장에 넣는다. 없으면 넣고, 사이트 주소가 바뀌었으면 따라 고친다.
want_origin="https://$SITE"
env_origin="$(sed -n 's/^SKINOTE_PUBLIC_ORIGIN=//p' "$ENV_FILE" | tail -n 1)"
if [ -z "$env_origin" ]; then
  printf '\n# 앱 주소(배포가 SKINOTE_SITE로 넣음)\nSKINOTE_PUBLIC_ORIGIN=%s\n' "$want_origin" >>"$ENV_FILE"
  log "설정에 앱 주소를 넣었습니다: SKINOTE_PUBLIC_ORIGIN=$want_origin"
elif [ "$env_origin" != "$want_origin" ]; then
  sed -i "s|^SKINOTE_PUBLIC_ORIGIN=.*|SKINOTE_PUBLIC_ORIGIN=$want_origin|" "$ENV_FILE"
  log "설정의 앱 주소를 사이트 주소에 맞췄습니다: $env_origin → $want_origin"
fi
chown root:skinote "$ENV_FILE"
chmod 640 "$ENV_FILE"
# 비밀값(없을 때만 한 번 만든다: 넷 + 앞단 표). 값은 이 파일에만 있고 기록 · 화면에 찍지 않는다. 앞단 표가 없는 옛 파일에는 표만 더한다.
new_secret() { "$NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'; }
if [ ! -f "$SECRETS_FILE" ]; then
  ( umask 077
    { printf '# 스키노트 서버 비밀값(배포가 만듦, root:skinote 0640). 저장소 · 기록 · 백업에 옮기지 않는다.\n'
      for n in $SECRET_NAMES; do printf '%s=%s\n' "$n" "$(new_secret)"; done; } >"$SECRETS_FILE.tmp" )
  chown root:skinote "$SECRETS_FILE.tmp"
  chmod 640 "$SECRETS_FILE.tmp"
  mv -f "$SECRETS_FILE.tmp" "$SECRETS_FILE"
  log "비밀값 파일을 만들었습니다: $SECRETS_FILE (값은 찍지 않음)"
elif ! grep -q '^SKINOTE_PROXY_TOKEN=' "$SECRETS_FILE"; then
  printf 'SKINOTE_PROXY_TOKEN=%s\n' "$(new_secret)" >>"$SECRETS_FILE"
  log "비밀값 파일에 앞단 표를 더했습니다(값은 찍지 않음)"
fi
chown root:skinote "$SECRETS_FILE"
chmod 640 "$SECRETS_FILE"
for n in $SECRET_NAMES; do grep -q "^$n=" "$SECRETS_FILE" || fail "$SECRETS_FILE에 $n이(가) 없습니다"; done
env_port="$(sed -n 's/^SKINOTE_PORT=//p' "$ENV_FILE" | tail -n 1)"
[ -z "$env_port" ] || [ "$env_port" = "$PORT" ] || fail "설정의 SKINOTE_PORT($env_port)가 Caddy · 유닛 · 배포의 포트($PORT)와 다릅니다"
env_data="$(sed -n 's/^SKINOTE_DATA_DIR=//p' "$ENV_FILE" | tail -n 1)"
[ -z "$env_data" ] || [ "$env_data" = "$DATA" ] || fail "설정의 SKINOTE_DATA_DIR($env_data)가 유닛이 쓰기를 허락한 $DATA와 다릅니다"
owner="$(stat -c %U "$DATA")"
[ "$owner" = skinote ] || log "주의: $DATA 주인이 skinote가 아닙니다($owner)"
# 서버 유닛은 backups/를 읽기 전용으로, backups/migrations만 쓰기로 연다: 시작 전에 폴더가 있어야 그 막음이 걸린다.
for d in db db/shops backups backups/migrations; do install -d -m 700 -o skinote -g skinote "$DATA/$d"; done
[ -d /var/log/skinote ] || install -d -m 750 -o skinote -g skinote /var/log/skinote
install -d -m 700 -o root -g root "$OPS"

# 2) systemd 유닛(바뀐 때만). 먼저 검사하고, 지금 것을 PREV_UNITS에 남긴다(되돌릴 때 함께 되돌린다).
vdir="$(mktemp -d)"
cp "$NEW/deploy/skinote-server.service" "$NEW/deploy/skinote-backup.service" "$NEW/deploy/skinote-backup.timer" "$NEW/deploy/skinote-alert@.service" "$vdir/"
cp "$NEW/deploy/skinote-alert@.service" "$vdir/skinote-alert@verify.service"
if ! out="$(SYSTEMD_UNIT_PATH="$vdir:" systemd-analyze verify "$vdir/skinote-server.service" "$vdir/skinote-backup.service" "$vdir/skinote-backup.timer" "$vdir/skinote-alert@verify.service" 2>&1)"; then
  rm -rf "$vdir"
  printf '%s\n' "$out" >&2
  fail "systemd 유닛 검사에 걸렸습니다"
fi
rm -rf "$vdir"
[ -z "$out" ] || printf '%s\n' "$out" | sed 's/^/  [서버] 유닛 검사: /'
rm -rf "$PREV_UNITS"
install -d -m 700 -o root -g root "$PREV_UNITS"
for unit in $UNITS; do
  if [ -f "$UNIT_DIR/$unit" ]; then cp -p "$UNIT_DIR/$unit" "$PREV_UNITS/$unit"; else : >"$PREV_UNITS/$unit.absent"; fi
done
units_changed=0
restore_units() {
  [ "$units_changed" = 1 ] || return 0
  for unit in $UNITS; do
    if [ -f "$PREV_UNITS/$unit" ]; then install -m 644 -o root -g root "$PREV_UNITS/$unit" "$UNIT_DIR/$unit"
    elif [ -f "$PREV_UNITS/$unit.absent" ]; then rm -f "$UNIT_DIR/$unit"; fi
  done
  systemctl daemon-reload || true
  units_changed=0
  log "systemd 유닛을 전 것으로 되돌렸습니다"
}
for unit in $UNITS; do
  if ! cmp -s "$NEW/deploy/$unit" "$UNIT_DIR/$unit"; then
    install -m 644 -o root -g root "$NEW/deploy/$unit" "$UNIT_DIR/$unit"
    units_changed=1
    log "유닛 바꿈: $unit"
  fi
done
if [ "$units_changed" = 1 ]; then systemctl daemon-reload || { restore_units; fail "systemctl daemon-reload"; }; fi
systemctl enable skinote-server.service >/dev/null 2>&1 || { restore_units; fail "skinote-server.service를 켜지 못했습니다(enable)"; }
systemctl enable --now skinote-backup.timer >/dev/null 2>&1 || { restore_units; fail "skinote-backup.timer를 켜지 못했습니다"; }

# 3) Caddy 사이트(바뀐 때만). 검사 · 다시 읽기에 걸리면 되돌린다(다른 프로젝트의 다음 reload가 이 파일에 걸리지 않게).
# 공통 Caddyfile은 고치지 않는다. 릴리스의 사이트 파일에 앞단 표를 채워(서버 안에서만) root:caddy 0640으로 둔다.
site_changed=0
had_site=0
proxy_token="$(sed -n 's/^SKINOTE_PROXY_TOKEN=//p' "$SECRETS_FILE" | tail -n 1)"
case "$proxy_token" in '' | *[!A-Za-z0-9_-]*) fail "$SECRETS_FILE의 SKINOTE_PROXY_TOKEN 모양이 틀렸습니다" ;; esac
SITE_NEW="$(mktemp /etc/skinote/skinote.caddy.XXXXXX)"
sed "s/__SKINOTE_PROXY_TOKEN__/$proxy_token/g" "$NEW/deploy/skinote.caddy" >"$SITE_NEW"
grep -q '__SKINOTE_PROXY_TOKEN__' "$SITE_NEW" && { rm -f "$SITE_NEW"; fail "Caddy 사이트 파일에 앞단 표를 채우지 못했습니다"; }
chown root:caddy "$SITE_NEW"
chmod 640 "$SITE_NEW"
restore_site() {
  [ "$site_changed" = 1 ] || return 0
  if [ "$had_site" = 1 ]; then cp -p "$SITE_PREV" "$SITE_FILE"; chown root:caddy "$SITE_FILE"; chmod 640 "$SITE_FILE"; else rm -f "$SITE_FILE"; fi
  systemctl reload caddy || log "주의: 되돌린 뒤에도 Caddy를 다시 읽지 못했습니다(journalctl -u caddy)"
  site_changed=0
  log "Caddy 사이트 파일을 전 것으로 되돌렸습니다"
}
if ! cmp -s "$SITE_NEW" "$SITE_FILE"; then
  if [ -f "$SITE_FILE" ]; then cp -p "$SITE_FILE" "$SITE_PREV"; had_site=1; fi
  install -m 640 -o root -g caddy "$SITE_NEW" "$SITE_FILE"
  if ! out="$(caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
    if [ "$had_site" = 1 ]; then cp -p "$SITE_PREV" "$SITE_FILE"; else rm -f "$SITE_FILE"; fi
    restore_units
    printf '%s\n' "$out" | tail -n 20 >&2
    fail "Caddy 설정 검사에 걸려 사이트 파일을 되돌렸습니다"
  fi
  site_changed=1
  if ! systemctl reload caddy; then
    restore_site
    restore_units
    fail "Caddy를 다시 읽지 못해 사이트 파일을 되돌렸습니다(journalctl -u caddy)"
  fi
  log "Caddy 사이트 바꿈"
fi
rm -f "$SITE_NEW"
# 옛 배포가 0644로 둔 파일도 표가 든 뒤에는 caddy 그룹만 읽는다.
chown root:caddy "$SITE_FILE"
chmod 640 "$SITE_FILE"

# 4) 링크를 한 번에 바꾸고 다시 시작한다. 살아 있음 + 서버 안의 상태(ok, 릴리스 이름)까지 확인한다.
switch_to "$NAME"
restart_server || true
if [ -n "$added" ]; then limit=900; else limit=60; fi
log "기다림: 최대 ${limit}초(마이그레이션이 있으면 길게)"
if wait_live "$limit" && health_ok "$NAME"; then
  # 켜진 릴리스의 차례(되돌리기가 이것을 거꾸로 따라간다: 저절로 되돌린 실패 릴리스로 가지 않게).
  if [ ! -f "$BASE/history" ] && [ -n "$PREV_NAME" ]; then printf '%s\n' "$PREV_NAME" >"$BASE/history"; fi
  printf '%s\n' "$NAME" >>"$BASE/history"
  log "켜짐: $NAME (전 릴리스 ${PREV_NAME:-없음})"
else
  journalctl -u skinote-server -n 40 --no-pager >&2 || true
  if [ -n "$added" ]; then
    fail "새 릴리스 $NAME이(가) 준비되지 않았습니다. 새 마이그레이션($added)이 든 릴리스라 저절로 되돌리지 않습니다(파일이 이미 새 판일 수 있음). journalctl -u skinote-server를 보고 앞으로 고치세요. 새 코드가 파일을 열기 전에 죽었다면(적용 줄이 없음) deploy.sh --rollback --force"
  fi
  if [ -n "$PREV_NAME" ]; then
    restore_units
    restore_site
    switch_to "$PREV_NAME"
    restart_server || true
    if wait_live 60; then
      health_ok "" || true
      log "새 릴리스가 준비되지 않아 $PREV_NAME(으)로 되돌렸습니다(유닛 · Caddy 파일 포함)"
    else
      log "되돌린 릴리스도 뜨지 않습니다: journalctl -u skinote-server"
    fi
  fi
  fail "새 릴리스 $NAME이(가) 준비되지 않았습니다(살아 있음 또는 상태 ok · 릴리스 확인 실패)"
fi

# 5) 정리: 오래된 릴리스(가장 새 $KEEP개, 지금 것과 바로 전 것은 늘 남김), 한 시간 넘은 올림 폴더(도는 다른 배포의 것은 남김),
# 오래된 작업 기록(가장 새 20개).
releases="$(ls -1 "$REL" | { grep -E '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+(-dirty)?$' || true; } | sort -r | tail -n +"$((KEEP + 1))")"
for old in $releases; do
  [ "$old" = "$NAME" ] && continue
  [ "$old" = "$PREV_NAME" ] && continue
  rm -rf -- "${REL:?}/$old"
  log "지움: $old"
done
find "$REL" -mindepth 1 -maxdepth 1 -name '.incoming-*' -mmin +60 -print -exec rm -rf -- {} + 2>/dev/null | sed 's|^.*/|  [서버] 남은 올림 폴더 지움: |' || true
{ ls -1t "$OPS/deploy"/*.log 2>/dev/null || true; } | tail -n +21 | while IFS= read -r f; do rm -f -- "$f" "${f%.log}.sh" "${f%.log}.status"; done

# 6) 날마다 백업이 아직 하나도 없으면(첫 배포) 한 번 돌린다.
if ! ls -1 "$DATA/backups" 2>/dev/null | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
  log "날마다 백업이 아직 없어 한 번 돌립니다"
  if systemctl start skinote-backup.service; then log "첫 백업 끝"; else log "주의: 첫 백업 실패(journalctl -u skinote-backup)"; fi
fi
log "설치 끝: $NAME"
}
REMOTE
}

# 원격 되돌리기(root로, 떼어 낸 작업): 인자 = 포트, force(0|1)
remote_rollback_script() {
  health_js_line
  cat <<'REMOTE'
# 한 덩어리로 읽힌 뒤 돈다.
{
set -euo pipefail
PORT="$1"; FORCE="$2"
BASE=/srv/skinote; REL="$BASE/releases"; NODE=/usr/local/bin/node
log() { printf '  [서버] %s\n' "$*" || true; }
fail() { printf '  [서버] 실패: %s\n' "$*" >&2 || true; exit 1; }
exec 9>/run/skinote-deploy.lock
flock -n 9 || fail "다른 배포 작업이 도는 중입니다(/run/skinote-deploy.lock)"
live() { "$NODE" -e "fetch('http://127.0.0.1:$PORT/api/health/live',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; }
wait_live() { local until=$((SECONDS + $1)); while [ "$SECONDS" -lt "$until" ]; do if live; then return 0; fi; sleep 1; done; return 1; }
health_ok() { "$NODE" -e "$HEALTH_JS" "$1" "$PORT"; }
restart_server() { systemctl reset-failed skinote-server.service >/dev/null 2>&1 || true; systemctl restart skinote-server.service; }
switch_to() { ln -sfn "releases/$1" "$BASE/current.new"; mv -Tf "$BASE/current.new" "$BASE/current"; }

HIST="$BASE/history"
CUR="$(readlink "$BASE/current" 2>/dev/null || true)"; CUR="${CUR#releases/}"
[ -n "$CUR" ] || fail "지금 릴리스가 없습니다"
# 되돌릴 곳: 켜진 차례(history)에서 가장 최근의, 지금 것이 아니고 아직 있는 릴리스. 차례가 없으면 이름 순서의 바로 앞.
# 저절로 되돌린 실패 릴리스와 마이그레이션 때문에 남겨 둔 실패 릴리스는 차례에 없으므로 고르지 않는다.
PREV=""
if [ -f "$HIST" ]; then
  PREV="$(tac "$HIST" | while IFS= read -r r; do if [ -n "$r" ] && [ "$r" != "$CUR" ] && [ -d "$REL/$r" ]; then printf '%s\n' "$r"; break; fi; done)"
fi
if [ -z "$PREV" ]; then
  PREV="$(ls -1 "$REL" | { grep -E '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+(-dirty)?$' || true; } | sort | awk -v cur="$CUR" '$0 == cur { print prev; exit } { prev = $0 }')"
fi
[ -n "$PREV" ] || fail "$CUR 앞의 릴리스가 없습니다"
# 마이그레이션이 든 릴리스는 코드만 되돌리면 파일이 읽기 전용이 된다(deployment 7절: 앞으로 고친다).
added="$(comm -23 <(ls -1 "$REL/$CUR/schema/migrations" | sort) <(ls -1 "$REL/$PREV/schema/migrations" | sort) | tr '\n' ' ')"
if [ -n "$added" ] && [ "$FORCE" != 1 ]; then
  fail "$CUR에는 $PREV에 없는 마이그레이션이 있습니다: $added— 되돌리지 말고 앞으로 고치세요(억지로: --force)"
fi
switch_to "$PREV"
restart_server || true
if ! wait_live 60; then
  journalctl -u skinote-server -n 40 --no-pager >&2 || true
  switch_to "$CUR"
  restart_server || true
  wait_live 60 || log "원래 릴리스도 뜨지 않습니다: journalctl -u skinote-server"
  fail "$PREV이(가) 뜨지 않아 $CUR(으)로 다시 돌렸습니다"
fi
# 차례를 PREV까지로 줄인다(한 번 더 되돌리면 그 앞으로 간다).
n="$(grep -nxF -- "$PREV" "$HIST" 2>/dev/null | tail -n 1 | cut -d: -f1 || true)"
if [ -n "$n" ]; then head -n "$n" "$HIST" >"$HIST.tmp" && mv -f "$HIST.tmp" "$HIST"; else printf '%s\n' "$PREV" >>"$HIST"; fi
health_ok "$PREV" || log "주의: 되돌린 릴리스의 상태가 ok가 아닙니다(마이그레이션 차이로 거절된 파일은 읽기 전용)"
log "되돌림: $CUR → $PREV (코드만. 유닛 · Caddy · 설정 · 자료는 그대로)"
}
REMOTE
}

# 떼어 낸 작업의 발사대(root로): 인자 = 작업 이름, 작업 인자…
# 작업 스크립트를 /var/log/skinote-ops/deploy/<작업>.sh로 쓰고 systemd-run으로 띄운다(ssh 세션과 떨어져 끝까지 돈다).
# 작업은 끝날 때 <작업>.status에 끝 코드를 남기고, 모든 출력은 <작업>.log에 쌓인다.
remote_launcher() {
  local script="$1"
  cat <<'HEAD'
{
set -euo pipefail
JOB="$1"; shift
OPS=/var/log/skinote-ops; DIR="$OPS/deploy"
install -d -m 700 -o root -g root "$OPS" "$DIR"
if ! flock -n /run/skinote-deploy.lock true; then echo "다른 배포 작업이 도는 중입니다(/run/skinote-deploy.lock). deploy.sh --status로 확인하세요" >&2; exit 3; fi
rm -f "$DIR/$JOB.log" "$DIR/$JOB.status"
cat >"$DIR/$JOB.sh" <<'SKINOTE_JOB_EOF'
trap 'printf "%s\n" "$?" >"${0%.sh}.status"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap '' HUP PIPE
HEAD
  printf '%s\n' "$script"
  cat <<'TAIL'
SKINOTE_JOB_EOF
chmod 600 "$DIR/$JOB.sh"
systemd-run --quiet --collect --unit="skinote-$JOB" --description="Skinote $JOB" \
  --property=StandardOutput="append:$DIR/$JOB.log" --property=StandardError="append:$DIR/$JOB.log" \
  /bin/bash "$DIR/$JOB.sh" "$@"
}
TAIL
}

# 작업 기록을 이어 읽는다(root로): 인자 = 작업 이름, 이미 읽은 바이트. 첫 줄 '@@job <상태> <크기>', 이어서 새 기록, 끝에 '@@end'.
# 상태: running | lost(끝 코드 없이 멈춤) | 끝 코드(숫자).
REMOTE_POLL='{
set -uo pipefail
JOB="$1"; OFF="$2"; DIR=/var/log/skinote-ops/deploy
if systemctl is-active --quiet "skinote-$JOB.service"; then active=1; else active=0; fi
if [ -f "$DIR/$JOB.status" ]; then status="$(head -n 1 "$DIR/$JOB.status")"
elif [ "$active" = 1 ]; then status=running
else sleep 1; if [ -f "$DIR/$JOB.status" ]; then status="$(head -n 1 "$DIR/$JOB.status")"; else status=lost; fi; fi
case "$status" in running | lost) ;; "" | *[!0-9]*) status=lost ;; esac
size=0; [ -f "$DIR/$JOB.log" ] && size="$(stat -c %s "$DIR/$JOB.log")"
echo "@@job $status $size"
if [ "$size" -gt "$OFF" ]; then tail -c +"$((OFF + 1))" "$DIR/$JOB.log" | head -c "$((size - OFF))"; fi
printf "@@end\n"
}'

# 서버 작업이 끝날 때까지 기록을 보이며 기다린다: wait_job <작업 이름> <한도 초>. 작업의 끝 코드를 돌려준다.
wait_job() {
  local job="$1" limit="$2" offset=0 fails=0 out head body status size open_line=0
  local until=$((SECONDS + limit)) re='^@@job ([a-z0-9]+) ([0-9]+)$'
  # 기록 조각이 줄 중간에서 끝났으면 멈춤 알림을 새 줄에서 찍는다.
  job_stop() { [[ "$open_line" = 0 ]] || printf '\n'; die "$1"; }
  while :; do
    if out="$(remote_run "$REMOTE_POLL" "$job" "$offset" 2>/dev/null)"; then
      fails=0
      head="${out%%$'\n'*}"
      if [[ "$head" =~ $re ]]; then
        status="${BASH_REMATCH[1]}"
        size="${BASH_REMATCH[2]}"
        body="${out#*$'\n'}"
        body="${body%@@end}"
        if [[ -n "$body" ]]; then
          printf '%s' "$body"
          if [[ "$body" == *$'\n' ]]; then open_line=0; else open_line=1; fi
        fi
        offset="$size"
        case "$status" in
          running) ;;
          lost) job_stop "서버 작업($job)이 끝 코드를 남기지 않고 멈췄습니다: journalctl -u skinote-$job, deploy.sh --status" ;;
          *) [[ "$open_line" = 0 ]] || printf '\n'; return "$status" ;;
        esac
      fi
    else
      fails=$((fails + 1))
      if ((fails >= 10)); then
        job_stop "서버와의 연결이 끊겼습니다. 서버의 작업($job)은 계속 돕니다: 잠시 뒤 deploy.sh --status로 결과를 보세요"
      fi
    fi
    if ((SECONDS >= until)); then
      job_stop "${limit}초가 지나도 작업($job)이 끝나지 않았습니다. 서버에서는 계속 돕니다: deploy.sh --status"
    fi
    sleep 2
  done
}

# 서버 작업을 띄우고 끝까지 기다린다: run_job <작업 이름> <스크립트> <한도 초> [인자…]
run_job() {
  local job="$1" script="$2" limit="$3"
  shift 3
  [[ "$job" =~ ^[A-Za-z0-9._-]+$ ]] || die "작업 이름 모양이 틀렸습니다: $job"
  say "서버 작업 skinote-$job (ssh가 끊겨도 서버에서 끝까지 돕니다. 기록: /var/log/skinote-ops/deploy/$job.log)"
  remote_run "$(remote_launcher "$script")" "$job" "$@" || die '서버 작업을 띄우지 못했습니다(다른 배포가 도는 중이면 deploy.sh --status)'
  local code=0
  wait_job "$job" "$limit" || code=$?
  ((code == 0)) || die "서버 작업이 실패했습니다(끝 코드 $code). 위의 [서버] 줄과 deploy.sh --status를 보세요"
}

# 원격 상태 보기(root로): 인자 = 포트
remote_status_script() {
  health_js_line
  cat <<'REMOTE'
{
set -uo pipefail
PORT="$1"; BASE=/srv/skinote; NODE=/usr/local/bin/node; OPS=/var/log/skinote-ops
echo "지금: $(readlink "$BASE/current" 2>/dev/null || echo 없음)"
echo "릴리스:"; ls -1 "$BASE/releases" 2>/dev/null | sed 's/^/  /'
echo "서비스: $(systemctl is-active skinote-server.service 2>/dev/null) · 백업 타이머: $(systemctl is-active skinote-backup.timer 2>/dev/null) · 마지막 백업: $(systemctl show -p Result --value skinote-backup.service 2>/dev/null)"
systemctl list-timers skinote-backup.timer --no-pager 2>/dev/null | sed -n '1,2p' | sed 's/^/  /'
"$NODE" -e "$HEALTH_JS" "" "$PORT" || true
last="$(ls -1t "$OPS/deploy"/*.log 2>/dev/null | head -n 1 || true)"
if [ -n "$last" ]; then
  code="$(head -n 1 "${last%.log}.status" 2>/dev/null || echo '없음(도는 중이거나 끊김)')"
  echo "마지막 배포 작업: $(basename "$last" .log) · 끝 코드 $code"
  tail -n 15 "$last" | sed 's/^/  /'
fi
if [ -s "$OPS/alerts" ]; then echo "알림(마지막 5줄, $OPS/alerts):"; tail -n 5 "$OPS/alerts" | sed 's/^/  /'; fi
}
REMOTE
}

# 서버 안의 자세한 상태(root로): 인자 = 포트, 기대 릴리스(비면 보지 않음). ok이고 릴리스가 맞으면 끝 코드 0.
remote_health_script() {
  health_js_line
  cat <<'REMOTE'
{
set -uo pipefail
PORT="$1"; WANT="${2:-}"
/usr/local/bin/node -e "$HEALTH_JS" "$WANT" "$PORT"
}
REMOTE
}

# 바깥에서 보이면 안 되는 릴리스 파일: probe_hidden <경로> <본문에 있으면 안 되는 모양(grep -E)>
probe_hidden() {
  local path="$1" pattern="$2" body
  body="$(curl -sS --path-as-is --max-time 10 "https://$SKINOTE_SITE$path" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -Eq "$pattern"; then
    say "틀림: 바깥에서 $path 이(가) 보입니다(공통 static_app의 root · try_files 확인)"
    return 1
  fi
  return 0
}

# 배포 뒤 확인: 바깥(https)에서 살아 있음 · 막힌 상태 확인 · 안전 머리 · 캐시 · 숨은 파일, 그리고 서버 안에서 자세한 상태.
check_public() {
  local expect="$1" site="https://$SKINOTE_SITE" body='' i fails=0 code headers h
  step "바깥에서 확인: $site"
  need_tool curl
  # 첫 배포는 인증서를 받는 동안 기다린다.
  for i in $(seq 1 24); do
    body="$(curl -sS --max-time 10 "$site/api/health/live" 2>/dev/null || true)"
    [[ "$body" == ok ]] && break
    sleep 5
  done
  [[ "$body" == ok ]] || die "$site/api/health/live 가 ok를 답하지 않습니다(인증서 · DNS · Caddy: journalctl -u caddy)"
  say '살아 있음: /api/health/live → ok'

  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$site/api/health" 2>/dev/null || true)"
  if [[ "$code" == 404 ]]; then say '막힘: 바깥의 /api/health → 404'; else say "틀림: 바깥의 /api/health가 ${code:-답 없음}입니다(404여야 함)"; fails=$((fails + 1)); fi

  headers="$(curl -sS -D - -o /dev/null --max-time 10 "$site/" 2>/dev/null | tr -d '\r' || true)"
  for h in content-security-policy strict-transport-security x-content-type-options; do
    if ! grep -qi "^$h:" <<<"$headers"; then say "틀림: / 에 $h 머리가 없습니다"; fails=$((fails + 1)); fi
  done
  headers="$(curl -sS -D - -o /dev/null --max-time 10 "$site/sw.js" 2>/dev/null | tr -d '\r' || true)"
  if ! grep -qiE '^cache-control:.*no-cache' <<<"$headers"; then say '틀림: /sw.js의 Cache-Control이 no-cache가 아닙니다'; fails=$((fails + 1)); fi
  headers="$(curl -sS -D - -o /dev/null --max-time 10 "$site/assets/skinote-missing-probe.js" 2>/dev/null | tr -d '\r' || true)"
  if grep -qiE '^cache-control:.*immutable' <<<"$headers"; then say '틀림: 없는 /assets 파일이 1년 캐시(immutable)를 받습니다'; fails=$((fails + 1)); fi

  probe_hidden /RELEASE '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+' || fails=$((fails + 1))
  probe_hidden /server/RELEASE '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+' || fails=$((fails + 1))
  probe_hidden /../RELEASE '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+' || fails=$((fails + 1))
  probe_hidden /server/src/main.js 'startServer' || fails=$((fails + 1))
  probe_hidden /schema/package.json '@skinote/schema' || fails=$((fails + 1))
  probe_hidden /deploy/skinote.caddy 'reverse_proxy' || fails=$((fails + 1))
  ((fails == 0)) || die "바깥 확인에서 ${fails}가지가 틀렸습니다(위의 '틀림' 줄)"
  say '안전 머리 · 캐시 · 숨은 파일 확인 통과'

  step '서버 안의 상태(127.0.0.1:3100/api/health)'
  remote_run "$(remote_health_script)" "$APP_PORT" "$expect" \
    || die "서버 안의 상태가 ok가 아닙니다${expect:+(또는 릴리스가 $expect가 아님)}: deploy.sh --status, journalctl -u skinote-server"
}

# ── 모드 ─────────────────────────────────────────────────────────────────

case "$MODE" in
  stage)
    need_tool rsync; need_tool node; need_tool git
    check_dist
    mkdir -p "$STAGE_PARENT"
    parent="$(cd "$STAGE_PARENT" && pwd -P)"
    repo="$(cd "$REPO_ROOT" && pwd -P)"
    # 사본에는 채운 Caddy 파일 · RELEASE가 든다: 저장소 안이면 git이 무시하는 폴더여야 한다(공개 저장소).
    if [[ "$parent/" == "$repo/"* ]] && ! git -C "$REPO_ROOT" check-ignore -q "$parent"; then
      rmdir "$parent" 2>/dev/null || true
      die "--stage 폴더가 저장소 안이고 git이 무시하지 않습니다: ${parent#"$repo"/} (저장소 밖이나 work/ · deploy/stage/ 같은 무시 폴더를 쓰세요)"
    fi
    name="$(release_name)"
    # 사본 점검에는 진짜 주소가 필요 없다: 주소(IP가 든 sslip.io 이름)가 파일로 남지 않게 늘 예시 주소를 쓴다.
    stage_release "$parent" "$name" example.invalid
    say "끝(서버에 붙지 않음): $name"
    ;;
  shop-cli)
    need_tool node
    setup_ssh
    preflight
    step "매장 명령줄: ${SHOP_CLI_ARGS[0]} (서버 $SKINOTE_SSH)"
    # 요청 JSON은 변수에만 두고 ssh 표준 입력으로 보낸다(파일 · 명령줄 인자 없음). 서버 쪽 명령은 늘 같다.
    request="$(node "$DEPLOY_DIR/shop-cli-request.mjs" "${SHOP_CLI_ARGS[@]}")" || die '매장 명령줄 인자가 틀렸습니다(위 줄)'
    code=0
    printf '%s' "$request" | ssh "${SSH_OPTS[@]}" "$SKINOTE_SSH" "$REMOTE_SHELL $REMOTE_BASE/current/deploy/shop-cli.sh" || code=$?
    unset request
    ((code == 0)) || die "서버의 매장 명령줄이 끝 코드 $code로 끝났습니다(64 쓰는 법 · 65 자료 · 69 지금 못 함 · 70 처리 오류 · 75 배포 중 · 78 설정)"
    ;;
  status)
    setup_ssh
    preflight
    step '서버 상태'
    remote_run "$(remote_status_script)" "$APP_PORT"
    ;;
  rollback)
    setup_ssh
    check_site
    preflight
    step '바로 전 릴리스로 되돌리기'
    run_job "rollback-$(date -u +%Y%m%dT%H%M%SZ)" "$(remote_rollback_script)" "$ROLLBACK_JOB_LIMIT" "$APP_PORT" "$FORCE"
    check_public ''
    ;;
  deploy)
    need_tool rsync; need_tool node; need_tool git
    setup_ssh
    check_site
    name="$(release_name)"
    if [[ "$name" == *-dirty && "$ALLOW_DIRTY" != 1 ]]; then
      die "커밋하지 않은 변경이 있습니다(릴리스 이름 $name). 커밋한 뒤 배포하세요(시험 배포면 --allow-dirty)"
    fi
    check_dist
    check_server_tests
    check_e2e
    preflight
    step "릴리스 만들기: $name"
    STAGE_TMP="$(mktemp -d /tmp/skinote-release.XXXXXX)"
    stage_release "$STAGE_TMP" "$name" "$SKINOTE_SITE"
    step '올리기(rsync)'
    remote_run "install -d -m 755 -o root -g root $REMOTE_BASE/releases" >/dev/null
    rsync -rlpt --delete -e "ssh ${SSH_OPTS[*]}" --rsync-path="$RSYNC_PATH" \
      "$STAGE_TMP/$name/" "$SKINOTE_SSH:$REMOTE_BASE/releases/.incoming-$name/"
    say '올림'
    step '설치 · 켜기'
    run_job "deploy-$name" "$(remote_install_script)" "$INSTALL_JOB_LIMIT" "$name" "$APP_PORT" "$KEEP_RELEASES" "$SKINOTE_SITE"
    check_public "$name"
    say "배포 끝: $name"
    ;;
esac
