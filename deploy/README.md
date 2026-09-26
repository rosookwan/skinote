# 서버 배포(상태 확인 · 마이그레이션 · 날마다 백업 · 장부 API · 매장 명령줄)

작성 2026-09-25. 고침 2026-09-26: 서버 장부(API · 저장소)가 붙었다 — 릴리스에 저장소 · 도메인 · 계약 패키지와 서버 표시를 찍은 앱 뼈대, 비밀값 파일,
앱 주소(`SKINOTE_PUBLIC_ORIGIN`), 앞단 표, 관리 소켓 자리(`/run/skinote`), 배포 전 끝까지 시험 기록, 매장 명령줄(`--shop-cli`, 9절), 시험 매장 새로 만들기(9-1), 같은 날 시험 매장의 열린 기기 등록과 서버 설정 바꾸기(`--set-env`, 9-2). 스키노트 중앙 서버의 **첫 뼈대**를 여러 앱이 함께 쓰는 VPS 한 대에 올리는 방법이다. 설계는 [deployment.md](../docs/architecture/deployment.md)(ADR-19 클라우드 중심)이고, 이 문서는 그 가운데 지금 만든 부분만 다룬다. 서버 주소 · IP · 계정 정보는 저장소에 적지 않는다(공개 저장소). 주소는 배포할 때 환경 변수로 준다.

> **이 서버에는 아직 실제 손님 자료를 넣지 않는다.** 백업이 같은 서버의 같은 디스크에만 있고 암호화 · 다른 구역 복제가 없다(7절). 시험 · 체험 자료만 둔다. 실제 매장이 쓰기 전에 deployment 6-1의 복제 · 암호화와 sync 10-2의 되살리기 순서를 먼저 만든다.

## 1. 무엇이 어디서 도나

| 무엇 | 어디(서버) | 하는 일 |
|---|---|---|
| 매장 앱(PWA) | `/srv/skinote/current/app` | `apps/pos/dist`를 그대로 올린 정적 파일. Caddy가 내준다 |
| 스키노트 서버 | `skinote-server.service`(계정 `skinote`), `127.0.0.1:3100` | 시작할 때 control · 매장 파일 마이그레이션, `GET /api/health` · `GET /api/health/live`, 기기 등록 · 직원 로그인 · 장부 API(`/api/v2/*`, 알림 연결), 관리 소켓(`/run/skinote/admin.sock`: 서버가 도는 동안 등록 번호 · 비밀번호 새로 · 기기 끊기) |
| 데이터베이스 | `/var/lib/skinote/db/control.sqlite`, `/var/lib/skinote/db/shops/<매장 id>.sqlite` | 매장마다 파일 하나(deployment 2-1). WAL · `synchronous = FULL` |
| 날마다 백업 | `skinote-backup.timer` → `skinote-backup.service`, 새벽 04:00(한국 시간) | `/var/lib/skinote/backups/<날짜>/`에 `VACUUM INTO` 사본 + `quick_check` + sha256, 가장 새 14일 |
| 마이그레이션 백업 | `/var/lib/skinote/backups/migrations/` | 실행기가 적용 전 · 뒤에 남기는 사본. 파일 · 종류마다 가장 새 판 2개, 판마다 3개 |
| 알림 자리 | `skinote-alert@.service` | 서버 · 백업 유닛이 실패하면 journald에 crit 한 줄과 `/var/log/skinote-ops/alerts`에 한 줄. 감시 서비스를 붙일 곳 |
| 앞단 | Caddy(공통 설정) + `/etc/caddy/sites/skinote.caddy` | HTTPS 인증서, `/api/*` → `127.0.0.1:3100`(`/api/health`는 바깥에서 404), 나머지는 정적 파일, 안전 머리(CSP · HSTS …) |
| 설정 | `/etc/skinote/skinote.env`(root:skinote 0640) | 자료 폴더 · 포트 · 앱 주소 · 매장 id · 시간대 · 하루 기준 시각 · 백업 여유 · 시험 매장의 열린 기기 등록(`SKINOTE_TEST_OPEN_ENROLL`, 기본 off, 9-2). 비밀값 없음([skinote.env.example](skinote.env.example)) |
| 비밀값 | `/etc/skinote/secrets.env`(root:skinote 0640) | 배포가 없을 때 한 번 만든다: `SKINOTE_PIN_PEPPER` · `SKINOTE_SESSION_KEY` · `SKINOTE_FINGERPRINT_KEY` · `SKINOTE_IP_KEY` · `SKINOTE_PROXY_TOKEN`(앞단 표). 값은 이 파일에만 있다(저장소 · 기록 · 화면 · 백업에 없음) |
| 기록 | journald, `/var/log/skinote-ops/deploy/` | `journalctl -u skinote-server` · `-u skinote-backup` · `-u caddy`, 배포 작업마다 `<작업>.log` |

릴리스 폴더(`/srv/skinote/releases/<UTC 시각>-<커밋>`)는 다음으로 이루어진다.

```text
app/                         빌드한 매장 앱. index.html에만 서버 표시(<meta name="skinote-runtime" content="server">)를 찍는다
server/                      packages/server(시험 폴더 빼고) + RELEASE(릴리스 이름)
schema/                      packages/schema(시험 · 도구 빼고)
contract/ domain/ store/     packages/*의 TypeScript 원본 그대로(시험 빼고). Node 22.18+가 형을 지우고 읽는다
node_modules/@skinote/<이름> -> ../../<이름>   (schema · contract · domain · store)
deploy/                      유닛 · Caddy 틀 · 설정 예시 · 이 문서 · 매장 명령줄 입구(shop-cli.sh), 그리고 사이트 주소만 채운 skinote.caddy
RELEASE
```

`current`는 그 가운데 하나를 가리키는 링크이고 한 번에 바뀐다. 가장 새 릴리스 5개만 남긴다. 켜진 차례는 `/srv/skinote/history`에 적는다(되돌리기가 거꾸로 따라간다). 코드는 root 소유(읽기만)이고, 서버 계정 `skinote`가 쓰는 곳은 `/var/lib/skinote` · `/var/log/skinote`뿐이다(systemd `ProtectSystem=strict`). 서버 프로세스는 날마다 백업 폴더를 **읽기만** 하고(`ReadOnlyPaths`), 실행기의 `backups/migrations`에만 쓴다. 날마다 백업은 따로 된 유닛(`skinote-backup`)이 쓴다.

## 2. 처음 한 번

서버 쪽은 이미 준비되어 있어야 한다: Ubuntu 24.04(systemd 255), `/usr/local/bin/node`(**22.18 이상**: 저장소 · 도메인 패키지를 TypeScript 원본 그대로 읽는다), Caddy **2.5 이상**과 `caddy` 그룹(사이트 파일을 root:caddy 0640으로 둔다), 공통 Caddyfile(`static_app` 조각 + `import /etc/caddy/sites/*.caddy`), `rsync`, 계정 `skinote`, 폴더 `/srv/skinote`(755) · `/var/lib/skinote`(750, 주인 skinote) · `/var/log/skinote`. **공통 Caddyfile은 고치지 않는다.** 스키노트는 `/etc/caddy/sites/skinote.caddy` 하나만 가진다. 배포 스크립트는 배포 전에 공통 Caddyfile의 `(static_app)` 조각을 읽어 보여 주고(고치지 않음), 그 조각이 `root`를 정하거나 인자(`{args…}`)를 받으면 멈춘다: 스키노트의 `root`를 덮어 릴리스의 다른 파일을 내줄 수 있기 때문이다.

맥에서:

1. ssh 키로 서버에 붙는지 본다. root가 아닌 계정이면 비밀번호 없는 `sudo`가 있어야 한다(배포가 유닛 · Caddy 파일을 바꾼다).
2. 저장소 밖으로 나가지 않는 `deploy/.env.local`을 만든다(`.gitignore`가 막는다). 값은 예시다.

   ```sh
   SKINOTE_SSH=<ssh 별칭 또는 user@host>
   SKINOTE_SITE=<앱 주소, 예: skinote.<IP를-대시로>.sslip.io>
   ```

   환경 변수로 줘도 된다(환경 변수가 이긴다). sslip.io는 이름 안의 IP로 풀리는 공개 DNS라 도메인 없이도 인증서를 받는다. 도메인이 정해지면(열린 질문 21) `SKINOTE_SITE`만 바꿔 다시 배포한다. **앱 출처가 바뀌면 기기의 보냄 대기가 따라오지 않는다**(deployment 3절): 실제 매장이 쓰기 전에 주소를 정한다.
3. 첫 배포(아래 3절)가 `/etc/skinote/skinote.env`를 만들고 첫 매장 id(ULID)를 새로 넣는다. 그 id는 배포 기록과 서버 안의 `/api/health`에 보인다. 같은 배포가 `/etc/skinote/secrets.env`(비밀값 넷 + 앞단 표)를 만들고, 설정에 `SKINOTE_PUBLIC_ORIGIN=https://<SKINOTE_SITE>`를 넣는다(이미 있는 설정에도 없으면 더하고, 사이트 주소가 바뀌면 따라 고친다). 첫 배포는 날마다 백업도 한 번 돌린다.
4. 배포가 끝나면 매장을 만든다(9절: `deploy/deploy.sh --shop-cli provision …`). 만들기 전에는 기기가 등록 화면에서 멈춘다.

## 3. 배포

```sh
npm run build            # apps/pos/dist(배포 스크립트는 빌드하지 않는다)
npm run test:e2e         # 서버 끝까지 시험: 끝 코드 0이어야 한다(기록 work/e2e/<시각>/report.json을 배포가 본다)
deploy/deploy.sh         # 커밋한 것만. 커밋하지 않은 시험 배포는 deploy/deploy.sh --allow-dirty
```

차례:

1. 로컬 확인: 커밋하지 않은 변경이 있으면 멈춘다(`--allow-dirty`면 이름 끝에 `-dirty`). `apps/pos/dist`가 있고 원본(apps/pos · ui · contract · layout)보다 새것인지, `check-dist`, 시험(`packages/server` · `store` · `schema` · `domain`).
2. **서버 끝까지 시험 기록:** `work/e2e/`의 가장 새 `report.json`이 지금 빌드(`apps/pos/dist/index.html`)와 서버 코드(server · store · domain · contract · schema)보다 새롭고 모든 확인이 `ok`여야 한다(실패 · 막힘이 하나라도 있으면 멈춤). 시험 배포만 `--allow-no-e2e`로 넘긴다.
3. 서버 확인(ssh): Node 판(22.18 이상), Caddy 판(2.5 이상) · `caddy` 그룹, sudo, rsync · caddy · systemd-run · flock · runuser, 계정 · 폴더, 공통 `static_app` 조각.
4. 릴리스 사본을 임시 폴더에 만든다: 앱의 `index.html`에 서버 표시를 찍고(`server/bin/stamp-runtime.js`, dist는 그대로), 저장소 · 도메인 · 계약 패키지와 `node_modules/@skinote/*` 링크를 넣고, Caddy 파일에는 사이트 주소만 채운다(앞단 표 자리는 서버가 채운다). **그 사본으로 서버를 한 번 띄워 본다**(`server/bin/smoke.js`: 이 점검만의 새 비밀값 · 관리 소켓 끔, 두 상태 확인 길, 앞단을 거친 요청에는 `{ok}`만, 장부 API의 문 — 세션 없음 401 · Origin 없는 명령 403 · 세션 없는 명령 401, 백업 명령, SIGTERM 종료).
5. `rsync`로 `releases/.incoming-<이름>`에 올린다.
6. 설치는 **서버에서 떼어 낸 작업**(`systemd-run`, 유닛 `skinote-deploy-<이름>`)으로 돈다. ssh가 끊기거나 Ctrl-C를 눌러도 서버에서는 끝까지 돌고, 맥은 기록(`/var/log/skinote-ops/deploy/deploy-<이름>.log`)을 이어 보여 준다. 한 번에 하나만 돈다(`/run/skinote-deploy.lock`). 끊겼으면 `deploy/deploy.sh --status`가 마지막 작업의 기록과 끝 코드를 보인다.
7. 서버에서: `/etc/skinote/skinote.env`가 없으면 만든다(있으면 그대로, `SKINOTE_PUBLIC_ORIGIN`만 사이트 주소에 맞춘다). `/etc/skinote/secrets.env`가 없으면 만들고(값은 찍지 않음), 앞단 표가 없는 옛 파일에는 표만 더한다. 자료 폴더(`db` · `db/shops` · `backups` · `backups/migrations`)를 skinote 0700으로 맞춘다.
8. systemd 유닛을 `systemd-analyze verify`로 검사하고 **바뀐 때만** 바꾼다. 바꾸기 전의 유닛은 `/etc/skinote/units.prev/`에 남긴다. 백업 타이머를 켠다.
9. Caddy 사이트 파일: 릴리스의 파일에 앞단 표를 채운 것(서버 안에서만)이 지금 파일과 다를 때만 바꾸고(root:caddy 0640) `caddy validate`나 `systemctl reload caddy`에 걸리면 되돌린다(다른 프로젝트의 다음 reload가 스키노트 파일에 걸리지 않게).
10. `current`를 새 릴리스로 바꾸고 서버를 다시 시작한다(`reset-failed` 먼저). 새 마이그레이션이 없으면 60초, 있으면 15분까지 기다린다(마이그레이션 동안 서버는 답하지 않는다). `/api/health/live`가 답하고 **서버 안의 `/api/health`가 `ok: true`이고 릴리스 이름이 맞아야** 켜진 것이다.
   - 준비되지 않았고 **새 마이그레이션이 없으면**: 유닛 · Caddy 파일 · `current`를 모두 전 것으로 되돌리고 실패로 끝난다.
   - 준비되지 않았고 **새 마이그레이션이 있으면**: 되돌리지 않는다(파일이 이미 새 판일 수 있어 옛 코드는 그 파일을 거절한다). 기록을 보고 **앞으로 고친다**. 새 코드가 파일을 열기 전에 죽었다면(기록에 `적용` 줄이 없음) `deploy/deploy.sh --rollback --force`.
11. 오래된 릴리스 · 한 시간 넘은 올림 폴더 · 오래된 작업 기록을 지운다. 날마다 백업이 하나도 없으면 한 번 돌린다.
12. 바깥에서 확인한다(첫 배포는 인증서를 받는 동안 최대 2분 기다린다): `https://<SKINOTE_SITE>/api/health/live`가 `ok`, 바깥의 `/api/health`는 404, `/`에 CSP · HSTS · nosniff, `/sw.js`는 `no-cache`, 없는 `/assets` 파일에 1년 캐시가 붙지 않음, `/RELEASE` · `/server/src/main.js` · `/schema/package.json` · `/deploy/skinote.caddy` · `/../RELEASE`가 보이지 않음. 그다음 ssh로 서버 안의 `/api/health`(ok · 릴리스 · 경고)를 본다.

그 밖의 선택: `--status`(릴리스 · 서비스 · 상태 · 경고 · 마지막 배포 작업 · 알림), `--stage <폴더>`(서버 없이 릴리스 사본만 만들고 점검. 저장소 밖이나 git이 무시하는 폴더만, 주소는 늘 `example.invalid`), `--allow-stale-dist`(낡은 빌드인 줄 알고 억지로), `--allow-no-e2e`(끝까지 시험 기록 없이, 시험 배포만), `--shop-cli`(9절).

**손님 주소와 앞단 표:** 사이트 파일은 `header_up X-Forwarded-For {remote_host}` · `header_up -Forwarded`로 손님 주소를 Caddy가 본 상대 주소 하나로 못 박고, `header_up X-Skinote-Proxy <표>`를 붙인다. 서버는 표가 맞는 요청의 `X-Forwarded-For`만 믿는다(로그인 제한 · 기록의 주소, IPv6은 /64로 셈). 같은 VPS의 다른 프로세스가 `127.0.0.1:3100`에 바로 붙으면 모두 한 통(`direct`)으로 센다.

## 4. 되돌리기

```sh
deploy/deploy.sh --rollback
```

켜진 차례(`/srv/skinote/history`)에서 지금 것 바로 앞의 릴리스로 `current`를 바꾸고 다시 시작한다. 저절로 되돌린 실패 릴리스와 마이그레이션 때문에 남겨 둔 실패 릴리스는 차례에 없으므로 고르지 않는다. 한 번 더 하면 그 앞으로 간다. **코드만 되돌린다**(유닛 · Caddy · 설정 · 자료는 그대로). 되돌리기도 떼어 낸 작업으로 돈다.

- 지금 릴리스에 되돌릴 릴리스에 없는 마이그레이션이 있으면 거절한다. 실행기는 앱이 모르는 판이 적용된 파일을 읽기 전용으로 열기 때문이다(data-model 7-3, deployment 7절). 그때는 되돌리지 말고 **앞으로 고친다**. 꼭 필요하면 `--force`(그 파일들은 읽기 전용이 되고 `/api/health`가 503).
- 되돌릴 릴리스가 뜨지 않으면 원래 릴리스로 다시 돌려놓고 실패로 끝난다.

## 5. 백업과 되살리기

**날마다 백업**은 새벽 04:00(한국 시간)에 돈다. 서버가 꺼져 있어 놓치면 켜질 때 바로 돈다.

```sh
sudo systemctl start skinote-backup.service      # 지금 한 번
journalctl -u skinote-backup -n 20 --no-pager    # 결과(백업 폴더 전체 크기 · 디스크 여유도 적힘)
systemctl list-timers skinote-backup.timer       # 다음 시각
sudo ls /var/lib/skinote/backups/
```

- 날짜 폴더(설정 시간대의 달력 날짜) 하나에 파일마다 `<control|매장 id>.daily.v<판>.<UTC 시각>.sqlite`, `SHA256SUMS`, `manifest.json`(돌린 때마다 영업일 · 파일 · 판 · 크기 · sha256 · 결과 · 지운 것)이 있다. **폴더 D에는 영업일 D-1의 마감 뒤 모습이 든다**(04:00은 하루 기준 시각 06:00 앞이다). 12월 26일 영업일을 되살리려면 12-27 폴더다. manifest의 `businessDate`가 그 영업일이다.
- 사본은 먼저 `.partial-*` 폴더에서 만들고 `quick_check`와 sha256이 끝난 것만 날짜 폴더로 옮긴다. 다음 실행은 남은 `.partial-*`와 `SHA256SUMS`에 없는 사본을 지운다.
- **디스크를 채우지 않게:** 쓰기 전에 여유가 (원본 합계 × 2 + `SKINOTE_BACKUP_RESERVE_MB`, 기본 2048)보다 적으면 먼저 오래된 폴더를 지워 보고, 그래도 모자라면 아무것도 쓰지 않고 `NO_SPACE`로 실패한다. 오래된 날짜 폴더는 결과와 상관없이 지운다: 가장 새 14개와 오늘, 그리고 파일마다 온전한 사본이 든 가장 새 폴더(그 파일이 요즘 계속 실패해도 마지막 사본은 남는다)를 남긴다. 같은 날 여러 번 돌리면 파일마다 가장 새 3개만 남긴다.
- 하나라도 실패하면 끝 코드 1이고 알림 유닛(`skinote-alert@skinote-backup`)이 돈다.
- 서버 안의 `/api/health`에서 파일마다 `lastBackupAt`(마지막 성공 시각)과 경고 `BACKUP_MISSING` · `BACKUP_STALE`(26시간 넘음) · `DISK_LOW`(80% 넘게 찼거나 여유가 `SKINOTE_BACKUP_RESERVE_MB`보다 적음)를 본다. 경고는 `ok`를 바꾸지 않는다.

**매장 파일 하나 되살리기**(그날 백업 시각으로 돌아간다. 그 뒤의 기록은 잃는다):

1. 서버를 멈춘다: `sudo systemctl stop skinote-server`
2. 백업을 고르고 확인한다. **`SHA256SUMS`에 적힌 파일만 쓴다**(적히지 않은 사본은 끝까지 확인하지 못한 것이다).

   ```sh
   cd /var/lib/skinote/backups/<날짜>
   sudo -u skinote sha256sum -c SHA256SUMS
   ```

3. 지금 파일을 **`-wal` · `-shm`과 함께** 옆으로 옮긴다(남은 WAL이 되살린 파일에 겹쳐지면 망가진다).

   ```sh
   cd /var/lib/skinote/db/shops
   stamp=$(date -u +%Y%m%dT%H%M%SZ)
   for f in <매장 id>.sqlite <매장 id>.sqlite-wal <매장 id>.sqlite-shm; do
     [ -e "$f" ] && sudo -u skinote mv "$f" "$f.before-restore-$stamp"
   done
   ```

4. 백업을 제자리에 **주인 skinote, 권한 0600으로** 놓는다: `sudo install -m 600 -o skinote -g skinote /var/lib/skinote/backups/<날짜>/<매장 id>.daily.v0001.<시각>.sqlite /var/lib/skinote/db/shops/<매장 id>.sqlite`
5. 서버를 켜고 확인한다: `sudo systemctl start skinote-server`, `curl -s http://127.0.0.1:3100/api/health`(그 파일이 `up_to_date` · `writable: true`인지). 권한이 틀리면 `READ_ONLY_FILE`이나 `SQLITE_READONLY`로 쓰기가 막힌다.
6. 옮겨 둔 옛 파일은 원인을 본 뒤 지운다. 운영 자료이므로 저장소 · AI 도구 · 해외 서비스에 올리지 않는다(AGENTS.md).

control 파일도 같은 순서다(`/var/lib/skinote/db/control.sqlite`). **실제 매장 자료가 들어가기 전에** sync 10-2의 되살리기 순서(새 epoch, `rev_floor`, 번호 건너뛰기, 기기 다시 보냄)를 만든다. 지금 순서는 그것 없이 파일만 바꾸는 것이라 시험 자료에만 쓴다.

**규칙:** `/var/lib/skinote` 아래에서 node 도구(`bin/backup.js`, `schema/bin/migrate.js` …)를 손으로 돌릴 때는 **늘 `sudo -u skinote`로** 돌린다. root로 돌리면 root 소유의 `-wal` · `-shm` · 날짜 폴더가 생겨 서비스가 `EACCES` · 읽기 전용으로 멈춘다.

## 6. 기록과 상태

```sh
systemctl status skinote-server
journalctl -u skinote-server -f                  # 요청 한 줄: 방법 경로 상태 시간(물음표 뒤는 적지 않음, 끊긴 답은 aborted)
journalctl -u skinote-server -b --no-pager | grep -E '거절|실패|열지 못함|망가짐|쓸 수 없음'
journalctl -p crit -t skinote-alert -t skinote-server --since today   # 죽음 · 실패 알림
curl -s http://127.0.0.1:3100/api/health         # 서버 안에서(자세한 본문)
deploy/deploy.sh --status                        # 맥에서
```

`/api/health`는 모든 파일이 쓰기 가능하면 200, 아니면 503이다. **자세한 본문은 서버 안에서만 준다**(판 · Node 판 · 매장 id · 파일 크기 · 백업 시각 · 디스크는 운영 내부 사정이다). Caddy는 바깥의 `/api/health`를 404로 막고, 그래도 앞단을 거쳐 온 요청(`X-Forwarded-*` · `Forwarded` · `Via`)에는 서버가 `{ "ok": … }`만 준다. 바깥 가동 확인 서비스에는 `/api/health/live`(글자 `ok`)를 건다.

본문: `ok`, `release`, `node`, `serverTime`(UTC), `warnings`(5절, 그리고 시험 매장의 열린 기기 등록이 켜져 있으면 `TEST_OPEN_ENROLL` · 기한이 지났으면 `TEST_OPEN_ENROLL_EXPIRED` · 꺼졌는데 스스로 붙은 기기가 남았으면 `TEST_OPEN_DEVICES_LEFT` — 9-2), `testOpenEnroll`(설정 `flag` · 켜짐 `active` · 기한 `until` · 남은 날 `daysLeft` · 기한 지남 `expired` · 끊기지 않은 열린 기기 수 `devices` · 시작할 때 끊은 수 `cutAtStart`, 켜졌으면 `shopId` · 끝 수 `cap` · 24시간의 새 기기 `enrolled24h` · 열린 기기의 틀린 비밀번호 `pinFailures24h`), 매장마다 `businessDate`(하루 기준 시각 06:00을 넣은 영업일) · `writable`, 파일마다 `kind` · `shopId` · `file`(이름만) · `status`(`migrated` · `up_to_date` · `refused` · `failed`) · `mode` · `schemaVersion` · `knownVersion` · `migrationCount` · `reason`(코드만, 예: `UNKNOWN_MIGRATION` · `CONTROL_UNAVAILABLE` · `SQLITE_READONLY` · `SQLITE_CORRUPT`) · `warnings` · `journalMode` · `pageCount` · `pageSize` · `lastBackupAt`, 디스크 여유. 손님 · 직원 자료와 경로는 싣지 않는다.

쓰기를 막는 경우(파일의 `writable: false`):

- 한 파일이 거절(앱이 모르는 더 새 판 · checksum 다름)되거나 실패. 서버는 멈추지 않고 그 파일만 읽기 전용이다.
- **control이 쓰기 불가면** 모든 매장이 쓰기 불가이고, 매장 파일은 마이그레이션하지 않고 읽기 전용으로만 연다(`CONTROL_UNAVAILABLE`, 파일을 바꾸지 않는다).
- `READ_ONLY_FILE`: 파일 · 폴더 권한 때문에 SQLite가 말없이 읽기 전용으로 열었다(5절의 규칙).
- `POST_MIGRATION_BACKUP_MISSING`: 그 판의 적용 뒤 사본이 없거나 망가졌고 다시 받지도 못했다. 잘린 사본(도중에 죽은 `VACUUM INTO`)은 `<이름>.broken`으로 치우고 다시 받는다(`POST_MIGRATION_BACKUP_RETAKEN`, 쓰기는 됨).

멈춤 · 다시 시작: 서버는 SIGTERM을 받으면 시작(마이그레이션 · 사본) 중이면 그 일을 마친 뒤, 아니면 곧바로 요청을 끝내고 데이터베이스를 닫는다(유닛 `TimeoutStopSec=10min`). 죽으면 systemd가 2초에서 60초까지 늦춰 가며 계속 다시 띄운다(포기하지 않음). 죽을 때마다 journald에 `skinote-alert` crit 한 줄이 남는다.

설정이 틀리면 서버는 끝 코드 78로 끝나고 systemd가 다시 띄우지 않는다(알림 유닛이 돈다, `journalctl -u skinote-server`에 틀린 값이 모두 적힌다). `/etc/skinote/skinote.env`를 고친 뒤 `sudo systemctl restart skinote-server`.

첫 배포 뒤 한 번: `systemd-analyze security skinote-server skinote-backup`으로 막기 점수를 보고, `ProcSubset=pid` · `SystemCallFilter=~@privileged @resources`를 더해도 서버가 뜨는지 시험한다(아직 넣지 않았다).

## 7. 아직 안 한 것

- **객체 저장소 복제 · 암호화:** WAL 복제(다른 구역), 작업 기록 구간(다른 회사), 올리기 전 공개 키 암호화, 버전 관리 · 객체 잠금(deployment 6-1). 지금 백업은 같은 서버의 같은 디스크에만 있다(그래서 실제 손님 자료를 넣지 않는다). 서버 유닛은 바깥으로 나가는 연결을 막아 두었다(`IPAddressDeny=any`): 복제를 붙일 때 함께 연다.
- **백업을 따로 된 계정으로:** 날마다 백업을 `skinote-backup` 계정(db 폴더를 그룹으로 읽기, backups/daily의 유일한 쓰는 쪽)으로 돌리고 `migrationBackupDir`를 날마다 백업 폴더 밖으로 옮긴다. 백업 폴더만의 디스크 할당량이나 볼륨.
- **좁은 배포 계정:** 지금은 배포 계정이 `sudo bash`로 무엇이든 돌린다. root 소유의 `/usr/local/sbin/skinote-install`과 그 명령 하나만 허락하는 sudoers로 바꾼다(deployment 7절).
- **매장 끝내기 · 매장 id 늘리기:** 매장 id는 설정(`SKINOTE_SHOP_IDS`)에서만 온다. 새 매장은 설정에 id를 더하고 다시 시작한 뒤 `--shop-cli provision`.
- **장부 API의 남은 몫:** 기사 기기의 보냄 대기(서버 판에는 없다: 명령은 바로 보내거나 거절), 카운터 오프라인 동작(LocalClient), 라이선스, 쓰기 Worker, 열린 날 창만 읽기(지금은 매장의 모든 접수를 읽는다).
- **매장 파일마다 운영체제 잠금**(deployment 2-2): 지금은 systemd 한 인스턴스와 '포트를 먼저 잡고 파일을 연다'로만 막는다.
- 감시 · 알림 보내기(알림 유닛은 자리만), 연습 서버(staging), 되살리기 연습, GitHub Actions 배포, 도메인, Trusted Types(앱에 정책을 넣은 뒤 CSP에 더함).
- 백업 결과를 control `backups` 표에 적기, 매장 끝내기, 가게 보관용 내보내기.

## 8. 파일

| 파일 | 무엇 |
|---|---|
| [deploy.sh](deploy.sh) | 배포 · 되돌리기 · 상태 · 사본 점검 · 매장 명령줄(`--shop-cli`) · 서버 설정 한 줄 바꾸기(`--set-env`, 허락한 이름만) |
| [shop-cli.sh](shop-cli.sh) | 서버 쪽 매장 명령줄 입구(릴리스와 함께 놓임, 표준 입력의 JSON → skinote 계정의 `bin/shop.js --stdin`, 혼자 쓰는 명령 `provision` · `load-sample` · `reset-test-shop`은 서버를 잠깐 멈춤) |
| [shop-cli-request.mjs](shop-cli-request.mjs) | 맥 쪽: `bin/shop.js`와 같은 깃발을 요청 JSON 하나로(명세 파일은 객체로 넣음) |
| [skinote-server.service](skinote-server.service) | 서버 유닛(막기 설정, 메모리 512 MB, 포트 3100만, 백업 폴더 읽기 전용, 늦춰 가며 다시 시작) |
| [skinote-backup.service](skinote-backup.service) · [skinote-backup.timer](skinote-backup.timer) | 날마다 백업(네트워크 없음, 실패하면 알림) |
| [skinote-alert@.service](skinote-alert@.service) | 알림 자리(journald crit + `/var/log/skinote-ops/alerts`) |
| [skinote.caddy.template](skinote.caddy.template) | Caddy 사이트(`__SKINOTE_SITE__` 자리는 배포가, 앞단 표 자리는 서버의 설치 작업이 채움, 손님 주소를 못 박음, `/api/health`는 바깥에서 404) |
| [skinote.env.example](skinote.env.example) | 서버 설정 예시(비밀값 없음, 앱 주소는 예시) |
| [.gitignore](.gitignore) | 채운 `skinote.caddy` · `stage/` · `.env.local`을 올리지 않음 |
| [../packages/server](../packages/server) | 서버 코드(`src/main.js`, `bin/shop.js`, `bin/backup.js`, `bin/smoke.js`, `bin/stamp-runtime.js`, `bin/new-shop-id.js`)와 시험(`test/deploy-files.test.js`가 이 폴더의 파일을 본다) |

## 9. 매장 명령줄(`--shop-cli`)

서버에서 `server/bin/shop.js`를 돌린다. 맥이 깃발을 요청 JSON 하나로 바꿔([shop-cli-request.mjs](shop-cli-request.mjs), `--spec` 파일은 객체로 넣음) **ssh 표준 입력**으로 보내고, 서버 쪽은 늘 같은 명령(`[sudo -n] bash /srv/skinote/current/deploy/shop-cli.sh`)이다: 직원 이름 · 매장 id가 서버의 프로세스 목록 · 명령 기록에 남지 않는다. 입구는 skinote 계정으로 `bin/shop.js --stdin`을 돌리고 설정 · 비밀값은 그 프로세스의 환경으로만 준다. **비밀번호 표 · 등록 번호는 부른 사람의 터미널에만 한 번 찍힌다**(서버 · 맥의 파일이나 기록에 남지 않음: 옮겨 적은 뒤 터미널을 지운다). 배포 작업과 같은 잠금을 잡는다.

```sh
# 시험 매장 만들기(견본 명세 · 직원). provision · load-sample은 서버를 잠깐 멈췄다가 다시 켠다.
deploy/deploy.sh --shop-cli provision --shop <매장 id> --code <매장 코드> --name "<매장 이름>" --sample --test \
  --staff "<이름>:manager" --staff "<이름>:counter" --staff "<이름>:driver:<차량 id>"
#   → 직원 · 역할 · 비밀번호 표(한 번). 매장 id는 /etc/skinote/skinote.env의 SKINOTE_SHOP_IDS(배포 기록에도 보임).
deploy/deploy.sh --shop-cli load-sample --shop <매장 id> --date today       # 시험 매장에만: 견본 하루(날짜마다 한 번)
deploy/deploy.sh --shop-cli reset-test-shop --shop <매장 id>                # 시험 매장에만: 사본을 받고 지금 견본으로 다시 만듦(아래 9-1)
deploy/deploy.sh --shop-cli device-code --shop <매장 id> --kind pos --label "카운터 1"   # 등록 번호 1234-5678-9012(60분, 한 번)
deploy/deploy.sh --shop-cli device-code --shop <매장 id> --kind driver_phone --label "1호 차량 기사 휴대폰" --vehicle <차량 id>   # 첫 매장 기사는 개인 휴대폰(태블릿이면 --kind driver_tablet)
deploy/deploy.sh --shop-cli rotate-pin --shop <매장 id> --staff "<이름>"      # 새 비밀번호(한 번), 잠금 풀기
deploy/deploy.sh --shop-cli revoke-device --shop <매장 id> --device "카운터 1" # 기기 끊기(세션 · 알림 연결이 끝남)
deploy/deploy.sh --shop-cli status --shop <매장 id>                           # rev · 영업일 · 접수 수 · 기기 · 직원 수(스스로 붙은 기기는 기기마다 한 줄, 9-2)
```

- 서버가 도는 동안 `device-code` · `rotate-pin` · `revoke-device` · `status`는 관리 소켓(`/run/skinote/admin.sock`, 서버 유닛의 `RuntimeDirectory`)으로 서버에 보낸다. `provision` · `load-sample` · `reset-test-shop`은 매장 파일을 혼자 써야 해서 입구가 서버를 멈췄다가 끝나면(실패해도) 다시 켠다.
- 끝 코드: 0 성공, 64 쓰는 법, 65 자료(명세 · 인자 · 시험 매장 아님), 69 지금 못 함(매장 파일 없음 · 쓰는 사람 잠금 · 디스크 여유 …), 70 처리 오류(파일 바꾸기 실패 포함: 옛 파일 그대로), 75 배포 작업이 도는 중, 77 입구를 부를 수 없음(root 아님 · 명령줄 없음), 78 설정 오류.
- 시험 매장(`--test`)에만 견본 하루를 부른다. 실제 매장 자료는 이 서버에 넣지 않는다(맨 위의 주의). 견본 모양(첫 매장 · 번호 매장)은 그 매장의 목록에서 고르고, 목록과 맞지 않으면(옛 견본으로 만든 시험 매장 · 다른 명세) `견본 모양이 다릅니다 · reset-test-shop 먼저`로 거절한다(끝 코드 65).
- **기사가 그만두면(개인 휴대폰, deployment 10-5):** 그날 `revoke-device --device "<그 휴대폰 이름>"`으로 끊는다. 서버의 그 기기 세션 · 알림 연결이 곧 끝나고 휴대폰은 기기 등록 화면으로 돌아가며 앱 저장소의 사본을 지운다. 새 기사는 `device-code`로 새로 등록한다.

### 9-1. 시험 매장 새로 만들기(`reset-test-shop`)

옛 견본(번호 실물 · 보증금 …)으로 만든 시험 매장을 **지금 견본**(또는 명세 파일)으로 다시 만든다. 장부는 지우지 않는다는 규칙의 예외이고 **시험 매장에만** 된다: control과 매장 파일이 모두 시험 매장(`provision --test`)이 아니면 아무것도 바꾸지 않고 끝 코드 65로 거절한다. 새 매장 id를 만들 필요가 없고, 직원 · 기기를 다시 등록하지 않아도 된다.

```sh
deploy/deploy.sh --shop-cli reset-test-shop --shop <매장 id>                     # 지금 견본으로(--sample과 같음)
deploy/deploy.sh --shop-cli reset-test-shop --shop <매장 id> --spec <명세.json>  # 명세 파일로(파일은 맥에만, 요청 JSON에 실려 감)
deploy/deploy.sh --shop-cli load-sample --shop <매장 id> --date today            # 그다음 견본 하루를 다시 넣는다
```

- **그대로 두는 것:** 매장 id · 코드 · 이름, 직원(같은 직원 id · 이름 · 역할 · 계정, 명세 파일의 `staff`는 쓰지 않는다)과 **비밀번호**(control에 그대로라 새로 찍지 않는다), 등록한 기기(같은 기기 id · 기기 번호 · 열쇠, 끊긴 기기는 끊긴 채)와 아직 쓰지 않은 등록 번호, **열린 로그인 세션**. 기기는 다시 등록하지 않고 로그인도 그대로 이어진다.
- **새로 되는 것:** 품목 · 요금 · 결제 수단 · 운영 규칙 · 재고 · 돈통은 새 명세에서, 접수 · 돈 · 재고 이동 · 마감 같은 장부와 기기 로그인 기록은 비어서 시작한다(옛 것은 사본에만). epoch이 하나 오르고(`shop_instance` · control `tenant_epochs`), rev는 지금까지 쓴 가장 큰 rev + 1,000,000 위에서 이어진다(sync 10-2의 되살리기와 같은 규칙). 열려 있던 화면은 다음 머리 묻기 · 알림 연결에서 새 자료를 읽고, 옛 화면에서 누른 명령은 `자료 복구 · 재확인 필요`(EPOCH_CHANGED)로 적용되지 않는다.
- **끊는 것:** 새 명세에 그 차량이 없는 기사 기기는 옮기지 않고 그 세션을 끝낸다(`device-code`로 다시 등록). 그 차량의 기사는 새 명세의 첫 차량으로 옮긴다. 둘 다 표준 오류에 한 줄씩 적힌다.
- **순서:** 새 명세를 메모리에서 먼저 만들어 보고(틀린 명세는 파일을 건드리지 않음, 끝 코드 65) → 디스크 여유(옛 파일 × 2 + `SKINOTE_BACKUP_RESERVE_MB`, 모자라면 69) → **옛 파일의 사본** `/var/lib/skinote/backups/resets/<매장 id>.before_reset.v<판>.<UTC 시각>.sqlite`(VACUUM INTO · quick_check, 같은 폴더의 `SHA256SUMS`에 한 줄) → 새 파일을 `db/shops/.reset-<매장 id>-<시각>.sqlite`에 만들고(마이그레이션 0001 + 0002 …, 매장 만들기 + 이어 가기가 한 트랜잭션) → 옛 연결을 닫고 이름 한 번 바꾸기(rename)로 제자리에 놓는다(제자리에는 늘 온전한 파일 하나) → 새 파일의 적용 뒤 백업(`backups/migrations`) → control에 새 epoch, 끊은 기기의 세션 끝.
- **표준 출력:** `시험 매장 새로 만듦` · `직원`(수) · `기기`(그대로 · 끊음) · `세션`(그대로 · 끝냄) · `epoch`(번호, 새 rev의 시작) · `백업`(사본 경로) · `sha256`. 이름 · 비밀번호는 찍지 않는다.
- 두 번 해도 된다: 할 때마다 사본이 하나 더 생기고 epoch이 하나 오른다. 도중에 멈추면(죽임 · 디스크) 제자리의 파일은 옛 것이거나 새 것 하나다. 다시 하면 남은 임시 파일을 치우고 처음부터 한다. 새 파일로 바뀐 뒤 control 기록 전에 멈췄으면 다시 한 번 하면 맞는다.
- **옛 자료로 되돌리기:** 5절의 '매장 파일 하나 되살리기'와 같은 순서에서 백업 대신 `backups/resets`의 사본을 쓴다(`cd /var/lib/skinote/backups/resets && sudo -u skinote sha256sum -c SHA256SUMS`로 먼저 확인). 직원 · 기기 id가 같아 로그인은 그대로 이어진다. control `tenant_epochs`에는 새로 만들 때의 epoch 줄이 남는다(시험 매장이라 그대로 둔다).
- `backups/resets`의 사본은 날마다 백업이 지우지 않는다. 쓸모가 끝난 사본은 사람이 지운다(운영 자료라 저장소 · AI 도구 · 해외 서비스에 올리지 않는다).

### 9-2. 시험 매장의 열린 기기 등록(`SKINOTE_TEST_OPEN_ENROLL`)

2026-09-26 사용자 요청("일단 테스트 중이니 등록번호는 좀 빼줘"): 시험하는 동안 기기마다 `device-code`로 번호를 받아 12자리를 치지 않게 한다. 설계는 [deployment 5-3](../docs/architecture/deployment.md)의 '시험 매장의 예외', 화면 말은 [wording 3-19](../docs/design/wording.md)다.

- **언제 켜지나:** 설정 `SKINOTE_TEST_OPEN_ENROLL=on`이고, 기한 `SKINOTE_TEST_OPEN_ENROLL_UNTIL`(마지막 영업일, 오늘 ~ 오늘 + 14일)이 지나지 않았고, 이 서버의 매장이 하나(`SKINOTE_SHOP_IDS`)이며, 그 매장이 시험 매장(`provision --test`: control과 매장 파일이 모두 `is_test`)일 때만. `on`인데 기한 줄이 없거나 14일보다 멀면 서버가 시작하지 않는다(설정 오류). 설정 예시와 처음 배포가 만드는 설정은 `off`이고, **배포(설치)는 이 줄을 바꾸지 않는다**(비밀값 파일 `secrets.env`에 이 줄이 있으면 설치가 멈춘다). 켜져 있어도 조건이 맞지 않으면(실제 매장 · 매장 둘 이상) 번호 등록 그대로이고 서버 시작 기록에 `주의: SKINOTE_TEST_OPEN_ENROLL=on이지만 쓰지 않습니다`가 남는다. **기한이 지나면 저절로 꺼진다**(끈 것과 같다, 아래).
- **켜지면:** 등록하지 않은 기기가 앱을 열면 `기기 등록`(12자리) 대신 `기기 선택`이 나온다. 휴대폰 폭이면 `기사 휴대폰`이 먼저이고 주 버튼, 카운터 폭이면 `카운터(포스)`가 먼저다. `카운터(포스)`를 누르면 바로, `기사 휴대폰` · `기사 태블릿`은 `차량 선택`(매장의 차량)에서 차량을 고르면 등록된다. 이름은 `시험 기기 N`(N = 기기 번호). 그다음은 번호 등록과 같다: 직원 타일 → 비밀번호, 기사 기기는 기사만. 로그인 화면의 매장 이름 줄에 기기 모양(`기사 휴대폰 · 1호 차량`)이 붙는다. 스스로 붙은 기사 기기의 차량 범위는 **그 기사의 차량이 먼저**다(기기를 붙인 사람이 고른 차량이 아니라: 기사에게 차량이 없을 때만 기기의 차량).
- **종류 · 차량을 잘못 골랐을 때:** 로그인 화면 바닥줄의 `기기 선택`을 누르면 그 기기의 등록을 끊고(자리가 빈다) 다시 `기기 선택`으로 간다. 로그인한 뒤면 나가기 → `로그아웃` → `기기 선택`. 번호로 붙인 기기에는 이 버튼이 없다.
- **막는 것:**
  - 주소마다 15분에 10번(번호 등록과 따로 셈), 끊기지 않은 열린 기기 30대까지(넘으면 화면에 `기기 수 초과 · 관리자 확인 필요`). 붙은 뒤 한 시간 넘게 한 번도 로그인하지 않은 열린 기기는 새 기기가 붙을 때 먼저 끊는다(자리를 비움).
  - **비밀번호 잠금은 스스로 붙은 기기 모두가 한 기기다:** 한 계정을 열린 기기들에서 15분 안에 모두 합쳐 5번 틀리면 그 계정이 모든 열린 기기에서 잠기고(10분, 설정 `login_lockout`), 열린 기기들이 모두 합쳐 한 시간에 20번 틀리면 모든 열린 기기의 비밀번호 로그인을 30분 쉰다(`ALERT open_enroll_pin` 한 줄). 기기를 더 붙여 맞춰 보는 길을 늘리지 못한다. 번호로 붙인 기기의 로그인은 이 셈에 들지 않는다(열린 기기의 시도가 진짜 직원을 막거나 늦추지 않음).
  - 등록마다 `journalctl -u skinote-server`에 `ALERT open_enroll <매장 id> <종류> <N>번 · 열린 기기 n/30` 한 줄, 끝 수에 닿으면 `ALERT open_enroll_limit`(한 시간에 한 줄). `deploy.sh --status`가 지난 24시간의 `ALERT open_enroll*` 줄 수와 마지막 다섯 줄을 보인다.
- **누가 붙었는지 볼 때 · 끊을 때:**

  ```sh
  deploy/deploy.sh --status                                             # 설정 줄(도는 서버 · 설정 파일) · '주의: 열린 기기 등록 켜짐(…)' · 경보 줄
  deploy/deploy.sh --shop-cli status --shop <매장 id>                    # openDevices: 기기마다 이름표 · 종류 · 차량 · 붙은 때 · 로그인 수 · 마지막 로그인 · 브라우저 모양(직원 이름 없음)
  deploy/deploy.sh --shop-cli revoke-device --shop <매장 id> --device "시험 기기 3"   # 한 대 끊기(세션이 곧 끝남)
  deploy/deploy.sh --shop-cli revoke-device --shop <매장 id> --open-all              # 스스로 붙은 기기 모두 끊기(번호로 붙인 기기는 그대로)
  ```

  켜 둔 동안에는 끊긴 기기도 `기기 선택`으로 다시 붙을 수 있다. **모르는 기기가 붙어 비밀번호를 맞춰 보면 끊기보다 설정을 끈다**(`--set-env SKINOTE_TEST_OPEN_ENROLL=off`: 스스로 붙은 기기가 모두 끊기고 새 기기는 번호로만 붙는다).
- **켜기 · 끄기**(맥에서, 서버를 다시 켠다 — 몇 초 동안 기기가 `연결 끊김`을 보였다가 돌아온다):

  ```sh
  deploy/deploy.sh --set-env SKINOTE_TEST_OPEN_ENROLL=on                    # 기한 = 오늘(영업일) + 7일을 함께 적는다. 시험 매장 하나일 때만 쓰인다
  deploy/deploy.sh --set-env SKINOTE_TEST_OPEN_ENROLL_UNTIL=2026-10-09      # 켜 둔 기한 바꾸기(오늘 ~ 오늘 + 14일)
  deploy/deploy.sh --set-env SKINOTE_TEST_OPEN_ENROLL=off                   # 끄기: 기한 줄을 지우고, 스스로 붙은 기기를 모두 끊는다
  ```

  `--set-env`는 허락한 이름(`SKINOTE_TEST_OPEN_ENROLL` · `SKINOTE_TEST_OPEN_ENROLL_UNTIL`)과 값(`on` · `off`, 날짜)만 받고, 틀리면 ssh에 붙기 전에 멈춘다(틀린 값은 찍지 않는다). 서버에서는 배포 작업과 같은 잠금을 잡고 `/etc/skinote/skinote.env`의 그 줄을 바꾸거나 더한 뒤(권한 root:skinote 0640 그대로) `systemctl restart skinote-server` → 살아 있음 → 서버 안의 상태 한 줄을 보인다. `on`이면 아래 '켜는 조건'을 다시 찍고, `off`면 `열린 기기 등록 꺼짐: 시작할 때 스스로 붙은 시험 기기 N대를 끊음`을 찍는다. 비밀값 · 경로 · 포트는 이것으로 바꾸지 않는다(설정 파일을 손으로 고치고 다시 켠다, 6절).
- **끄면(기한이 지나도, 매장이 둘이 되거나 시험 매장이 아니게 되어도):** 스스로 붙은 기기(`시험 기기 N`)는 **모두 끊긴다** — 서버가 시작할 때(그리고 그런 기기의 요청을 볼 때) 기기 행을 끊고(`revoke_reason` `open_enroll_off` · `open_enroll_expired` · `open_enroll_closed`) 그 세션(기사 기기의 14일 세션 포함) · 알림 연결을 끝낸다. 기록에 `ALERT open_enroll_cut <매장 id> · … · 시험 기기 N대 끊음`. 그 기기들은 곧 `기기 등록`(등록 번호) 화면으로 가고, 계속 쓰려면 `device-code`로 다시 붙인다. 번호로 붙인 기기는 그대로다. 다시 켜도 끊긴 기기는 돌아오지 않는다(새로 `기기 선택`).
- **켜져 있는 동안 보이는 것:** 서버 안의 `/api/health`의 `warnings`에 `TEST_OPEN_ENROLL`(기한이 지났으면 `TEST_OPEN_ENROLL_EXPIRED`도, 꺼졌는데 스스로 붙은 기기가 남았으면 `TEST_OPEN_DEVICES_LEFT`), `testOpenEnroll`에 설정 · 켜짐 · 기한 · 남은 날 · 매장 · 열린 기기 수 · 끝 수 · 24시간의 새 기기 · 열린 기기의 틀린 비밀번호 수(경고는 `ok`를 바꾸지 않음). `deploy.sh --status`의 설정 줄은 **도는 서버의 값**(상태 확인)을 기준으로 보이고 설정 파일의 줄과 다르면 `주의: 도는 서버(…)와 설정 파일(…)이 다릅니다`를 더한다. 서버 시작 기록의 `주의:` 줄.
- **내주는 것 · 켜는 조건:** 켜 둔 동안에는 앱 주소를 아는 누구나 기기를 붙여(30대까지) **모든 직원 이름(사장님 · 관리자 포함)을 볼 수 있고** 비밀번호를 맞춰 볼 수 있다(위의 한 기기 잠금 · 쉼으로 한 시간에 20번쯤). 등록 방법 묻기(로그인 전)는 매장 차량 이름도 보인다. 그래서 켜기 전에:
  - 시험 자료만 있는 시험 매장에서, 시험하는 동안만(기한 7일, 길어도 14일) 켠다.
  - 시험 매장의 직원 이름은 시험용 이름이나 이름만(성 없이) 쓴다(`provision --staff`). 실제 사람의 성명을 넣지 않는다.
  - 비밀번호는 6자리로 한다(`--shop-cli rotate-pin --shop <매장 id> --staff <이름> --pin-digits 6`, 처음 만들 때 `provision --pin-digits 6`).
  - 차량 이름은 `1호 차량`처럼 번호로만 쓴다(번호판 · 기사 이름을 넣지 않는다).
- **실제 손님 자료를 넣기 전에 끈다**(`--set-env SKINOTE_TEST_OPEN_ENROLL=off`). 끄면 스스로 붙은 `시험 기기`는 모두 끊기므로 남길 기기는 `device-code`로 다시 붙인다. 실제 매장은 늘 등록 번호(`device-code`)로 붙인다.

