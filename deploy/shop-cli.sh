#!/usr/bin/env bash
# 매장 명령줄의 서버 쪽 입구(deploy.sh --shop-cli). 릴리스와 함께 /srv/skinote/current/deploy/shop-cli.sh에 놓이고(root 소유), 맥의
# deploy.sh가 ssh로 늘 같은 명령(`[sudo -n] bash /srv/skinote/current/deploy/shop-cli.sh`)을 부른다. 할 일은 명령줄 인자가 아니라 표준
# 입력의 JSON 하나({ "op": "…", "args": { … } })로 받는다: 직원 이름 · 매장 id가 서버의 프로세스 목록에 보이지 않게.
#
# 받은 JSON을 skinote 계정의 `node server/bin/shop.js --stdin`에 그대로 넘기고, 설정(/etc/skinote/skinote.env)과 비밀값
# (/etc/skinote/secrets.env)은 그 프로세스의 환경으로만 준다. 출력(비밀번호 표 · 등록 번호)은 ssh를 거쳐 부른 사람의 터미널로만 간다:
# 이 스크립트는 파일 · 기록에 아무것도 적지 않는다.
# provision · load-sample은 매장 파일을 혼자 써야 해서 서버를 잠깐 멈추고, 끝나면(실패해도) 다시 켠다. 배포 작업과 같은 잠금
# (/run/skinote-deploy.lock)을 잡아 배포와 겹치지 않는다.
# 끝 코드: bin/shop.js의 끝 코드(0 성공, 64 쓰는 법, 65 자료, 69 지금 못 함, 70 처리 오류, 78 설정), 이 스크립트의 거절은 64 · 75 · 77.
set -euo pipefail

BASE=/srv/skinote
NODE=/usr/local/bin/node
SERVER="$BASE/current/server"
ENV_FILE=/etc/skinote/skinote.env
SECRETS_FILE=/etc/skinote/secrets.env

say() { printf '[서버] %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || { say 'root로 돌려야 합니다(sudo -n)'; exit 77; }
[ -f "$SERVER/bin/shop.js" ] || { say "릴리스에 명령줄이 없습니다: $SERVER/bin/shop.js"; exit 77; }
[ -f "$ENV_FILE" ] || { say "설정 파일이 없습니다: $ENV_FILE (먼저 배포)"; exit 77; }

exec 9>/run/skinote-deploy.lock
flock -n 9 || { say '배포 작업이 도는 중입니다(/run/skinote-deploy.lock). 끝난 뒤 다시 하세요'; exit 75; }

# 요청(256 KB까지). 파일에 남기지 않는다.
request="$(head -c 262144)"
op="$(printf '%s' "$request" | "$NODE" -e '
let text = "";
process.stdin.setEncoding("utf8").on("data", (c) => { text += c; }).on("end", () => {
  try { const r = JSON.parse(text); process.stdout.write(typeof r.op === "string" ? r.op : ""); } catch { process.stdout.write(""); }
});')"
case "$op" in
  provision | load-sample) solo=1 ;;
  device-code | rotate-pin | revoke-device | status) solo=0 ;;
  *) say "요청이 { \"op\": …, \"args\": { … } } JSON이 아니거나 모르는 명령입니다: ${op:-없음}"; exit 64 ;;
esac

# 설정 · 비밀값 파일의 SKINOTE_이름=값 줄만 환경으로(실행하지 않는다).
vars=(PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production)
for file in "$ENV_FILE" "$SECRETS_FILE"; do
  [ -f "$file" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in SKINOTE_[A-Z_]*=*) vars+=("$line") ;; esac
  done <"$file"
done

restart=0
finish() {
  code=$?
  if [ "$restart" = 1 ]; then
    if systemctl start skinote-server.service; then say '서버를 다시 켰습니다'; else say '주의: 서버를 다시 켜지 못했습니다(journalctl -u skinote-server)'; fi
  fi
  exit "$code"
}
trap finish EXIT

if [ "$solo" = 1 ] && systemctl is-active --quiet skinote-server.service; then
  say "$op: 매장 파일을 혼자 쓰도록 서버를 잠깐 멈춥니다"
  systemctl stop skinote-server.service
  restart=1
fi

cd "$SERVER"
set +e
printf '%s' "$request" | runuser -u skinote -- env -i "${vars[@]}" "$NODE" --disable-warning=ExperimentalWarning bin/shop.js --stdin
code=$?
set -e
exit "$code"
