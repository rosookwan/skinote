# 서버 배포(첫 판: 상태 확인 · 마이그레이션 · 날마다 백업)

작성 2026-09-25. 스키노트 중앙 서버의 **첫 뼈대**를 여러 앱이 함께 쓰는 VPS 한 대에 올리는 방법이다. 설계는 [deployment.md](../docs/architecture/deployment.md)(ADR-19 클라우드 중심)이고, 이 문서는 그 가운데 지금 만든 부분만 다룬다. 서버 주소 · IP · 계정 정보는 저장소에 적지 않는다(공개 저장소). 주소는 배포할 때 환경 변수로 준다.

> **이 서버에는 아직 실제 손님 자료를 넣지 않는다.** 백업이 같은 서버의 같은 디스크에만 있고 암호화 · 다른 구역 복제가 없다(7절). 시험 · 체험 자료만 둔다. 실제 매장이 쓰기 전에 deployment 6-1의 복제 · 암호화와 sync 10-2의 되살리기 순서를 먼저 만든다.

## 1. 무엇이 어디서 도나

| 무엇 | 어디(서버) | 하는 일 |
|---|---|---|
| 매장 앱(PWA) | `/srv/skinote/current/app` | `apps/pos/dist`를 그대로 올린 정적 파일. Caddy가 내준다 |
| 스키노트 서버 | `skinote-server.service`(계정 `skinote`), `127.0.0.1:3100` | 시작할 때 control · 매장 파일 마이그레이션, `GET /api/health` · `GET /api/health/live`. 그 밖의 API는 아직 없다(404) |
| 데이터베이스 | `/var/lib/skinote/db/control.sqlite`, `/var/lib/skinote/db/shops/<매장 id>.sqlite` | 매장마다 파일 하나(deployment 2-1). WAL · `synchronous = FULL` |
| 날마다 백업 | `skinote-backup.timer` → `skinote-backup.service`, 새벽 04:00(한국 시간) | `/var/lib/skinote/backups/<날짜>/`에 `VACUUM INTO` 사본 + `quick_check` + sha256, 가장 새 14일 |
| 마이그레이션 백업 | `/var/lib/skinote/backups/migrations/` | 실행기가 적용 전 · 뒤에 남기는 사본. 파일 · 종류마다 가장 새 판 2개, 판마다 3개 |
| 알림 자리 | `skinote-alert@.service` | 서버 · 백업 유닛이 실패하면 journald에 crit 한 줄과 `/var/log/skinote-ops/alerts`에 한 줄. 감시 서비스를 붙일 곳 |
| 앞단 | Caddy(공통 설정) + `/etc/caddy/sites/skinote.caddy` | HTTPS 인증서, `/api/*` → `127.0.0.1:3100`(`/api/health`는 바깥에서 404), 나머지는 정적 파일, 안전 머리(CSP · HSTS …) |
| 설정 | `/etc/skinote/skinote.env`(root:skinote 0640) | 자료 폴더 · 포트 · 매장 id · 시간대 · 하루 기준 시각 · 백업 여유. 비밀값 없음([skinote.env.example](skinote.env.example)) |
| 기록 | journald, `/var/log/skinote-ops/deploy/` | `journalctl -u skinote-server` · `-u skinote-backup` · `-u caddy`, 배포 작업마다 `<작업>.log` |

릴리스 폴더(`/srv/skinote/releases/<UTC 시각>-<커밋>`)는 다음으로 이루어진다.

```text
app/                         빌드한 매장 앱
server/                      packages/server(시험 폴더 빼고) + RELEASE(릴리스 이름)
schema/                      packages/schema(시험 · 도구 빼고)
node_modules/@skinote/schema -> ../../schema
deploy/                      유닛 · Caddy 틀 · 설정 예시 · 이 문서, 그리고 채운 skinote.caddy
RELEASE
```

`current`는 그 가운데 하나를 가리키는 링크이고 한 번에 바뀐다. 가장 새 릴리스 5개만 남긴다. 켜진 차례는 `/srv/skinote/history`에 적는다(되돌리기가 거꾸로 따라간다). 코드는 root 소유(읽기만)이고, 서버 계정 `skinote`가 쓰는 곳은 `/var/lib/skinote` · `/var/log/skinote`뿐이다(systemd `ProtectSystem=strict`). 서버 프로세스는 날마다 백업 폴더를 **읽기만** 하고(`ReadOnlyPaths`), 실행기의 `backups/migrations`에만 쓴다. 날마다 백업은 따로 된 유닛(`skinote-backup`)이 쓴다.

## 2. 처음 한 번

서버 쪽은 이미 준비되어 있어야 한다: Ubuntu 24.04(systemd 255), `/usr/local/bin/node`(22.13 이상), Caddy 2와 공통 Caddyfile(`static_app` 조각 + `import /etc/caddy/sites/*.caddy`), `rsync`, 계정 `skinote`, 폴더 `/srv/skinote`(755) · `/var/lib/skinote`(750, 주인 skinote) · `/var/log/skinote`. **공통 Caddyfile은 고치지 않는다.** 스키노트는 `/etc/caddy/sites/skinote.caddy` 하나만 가진다. 배포 스크립트는 배포 전에 공통 Caddyfile의 `(static_app)` 조각을 읽어 보여 주고(고치지 않음), 그 조각이 `root`를 정하거나 인자(`{args…}`)를 받으면 멈춘다: 스키노트의 `root`를 덮어 릴리스의 다른 파일을 내줄 수 있기 때문이다.

맥에서:

1. ssh 키로 서버에 붙는지 본다. root가 아닌 계정이면 비밀번호 없는 `sudo`가 있어야 한다(배포가 유닛 · Caddy 파일을 바꾼다).
2. 저장소 밖으로 나가지 않는 `deploy/.env.local`을 만든다(`.gitignore`가 막는다). 값은 예시다.

   ```sh
   SKINOTE_SSH=<ssh 별칭 또는 user@host>
   SKINOTE_SITE=<앱 주소, 예: skinote.<IP를-대시로>.sslip.io>
   ```

   환경 변수로 줘도 된다(환경 변수가 이긴다). sslip.io는 이름 안의 IP로 풀리는 공개 DNS라 도메인 없이도 인증서를 받는다. 도메인이 정해지면(열린 질문 21) `SKINOTE_SITE`만 바꿔 다시 배포한다. **앱 출처가 바뀌면 기기의 보냄 대기가 따라오지 않는다**(deployment 3절): 실제 매장이 쓰기 전에 주소를 정한다.
3. 첫 배포(아래 3절)가 `/etc/skinote/skinote.env`를 만들고 첫 매장 id(ULID)를 새로 넣는다. 그 id는 배포 기록과 서버 안의 `/api/health`에 보인다. 첫 배포는 날마다 백업도 한 번 돌린다.

## 3. 배포

```sh
npm run build            # apps/pos/dist(배포 스크립트는 빌드하지 않는다)
deploy/deploy.sh         # 커밋한 것만. 커밋하지 않은 시험 배포는 deploy/deploy.sh --allow-dirty
```

차례:

1. 로컬 확인: 커밋하지 않은 변경이 있으면 멈춘다(`--allow-dirty`면 이름 끝에 `-dirty`). `apps/pos/dist`가 있고 원본(apps/pos · ui · contract · layout)보다 새것인지, `check-dist`, 서버 시험(`packages/server`).
2. 서버 확인(ssh): Node 판, sudo, rsync · caddy · systemd-run · flock · runuser, 계정 · 폴더, 공통 `static_app` 조각.
3. 릴리스 사본을 임시 폴더에 만들고 **그 사본으로 서버를 한 번 띄워 본다**(`server/bin/smoke.js`: 두 상태 확인 길, 앞단을 거친 요청에는 `{ok}`만, 백업 명령, SIGTERM 종료).
4. `rsync`로 `releases/.incoming-<이름>`에 올린다.
5. 설치는 **서버에서 떼어 낸 작업**(`systemd-run`, 유닛 `skinote-deploy-<이름>`)으로 돈다. ssh가 끊기거나 Ctrl-C를 눌러도 서버에서는 끝까지 돌고, 맥은 기록(`/var/log/skinote-ops/deploy/deploy-<이름>.log`)을 이어 보여 준다. 한 번에 하나만 돈다(`/run/skinote-deploy.lock`). 끊겼으면 `deploy/deploy.sh --status`가 마지막 작업의 기록과 끝 코드를 보인다.
6. 서버에서: `/etc/skinote/skinote.env`가 없으면 만든다(있으면 그대로). 자료 폴더(`db` · `db/shops` · `backups` · `backups/migrations`)를 skinote 0700으로 맞춘다.
7. systemd 유닛을 `systemd-analyze verify`로 검사하고 **바뀐 때만** 바꾼다. 바꾸기 전의 유닛은 `/etc/skinote/units.prev/`에 남긴다. 백업 타이머를 켠다.
8. Caddy 사이트 파일이 바뀐 때만 바꾸고 `caddy validate`나 `systemctl reload caddy`에 걸리면 되돌린다(다른 프로젝트의 다음 reload가 스키노트 파일에 걸리지 않게).
9. `current`를 새 릴리스로 바꾸고 서버를 다시 시작한다(`reset-failed` 먼저). 새 마이그레이션이 없으면 60초, 있으면 15분까지 기다린다(마이그레이션 동안 서버는 답하지 않는다). `/api/health/live`가 답하고 **서버 안의 `/api/health`가 `ok: true`이고 릴리스 이름이 맞아야** 켜진 것이다.
   - 준비되지 않았고 **새 마이그레이션이 없으면**: 유닛 · Caddy 파일 · `current`를 모두 전 것으로 되돌리고 실패로 끝난다.
   - 준비되지 않았고 **새 마이그레이션이 있으면**: 되돌리지 않는다(파일이 이미 새 판일 수 있어 옛 코드는 그 파일을 거절한다). 기록을 보고 **앞으로 고친다**. 새 코드가 파일을 열기 전에 죽었다면(기록에 `적용` 줄이 없음) `deploy/deploy.sh --rollback --force`.
10. 오래된 릴리스 · 한 시간 넘은 올림 폴더 · 오래된 작업 기록을 지운다. 날마다 백업이 하나도 없으면 한 번 돌린다.
11. 바깥에서 확인한다(첫 배포는 인증서를 받는 동안 최대 2분 기다린다): `https://<SKINOTE_SITE>/api/health/live`가 `ok`, 바깥의 `/api/health`는 404, `/`에 CSP · HSTS · nosniff, `/sw.js`는 `no-cache`, 없는 `/assets` 파일에 1년 캐시가 붙지 않음, `/RELEASE` · `/server/src/main.js` · `/schema/package.json` · `/deploy/skinote.caddy` · `/../RELEASE`가 보이지 않음. 그다음 ssh로 서버 안의 `/api/health`(ok · 릴리스 · 경고)를 본다.

그 밖의 선택: `--status`(릴리스 · 서비스 · 상태 · 경고 · 마지막 배포 작업 · 알림), `--stage <폴더>`(서버 없이 릴리스 사본만 만들고 점검. 저장소 밖이나 git이 무시하는 폴더만, 주소는 늘 `example.invalid`), `--allow-stale-dist`(낡은 빌드인 줄 알고 억지로).

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

본문: `ok`, `release`, `node`, `serverTime`(UTC), `warnings`(5절), 매장마다 `businessDate`(하루 기준 시각 06:00을 넣은 영업일) · `writable`, 파일마다 `kind` · `shopId` · `file`(이름만) · `status`(`migrated` · `up_to_date` · `refused` · `failed`) · `mode` · `schemaVersion` · `knownVersion` · `migrationCount` · `reason`(코드만, 예: `UNKNOWN_MIGRATION` · `CONTROL_UNAVAILABLE` · `SQLITE_READONLY` · `SQLITE_CORRUPT`) · `warnings` · `journalMode` · `pageCount` · `pageSize` · `lastBackupAt`, 디스크 여유. 손님 · 직원 자료와 경로는 싣지 않는다.

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
- **매장 개설(`shop.provision`):** 매장 파일은 마이그레이션만 한 빈 파일이다. control `tenants` · 매장 `shops` 행, 하루 기준 시각 시드, 직원 · 기기 등록이 없다. 매장 id는 설정(`SKINOTE_SHOP_IDS`)에서만 온다.
- **상태 확인 밖의 API:** `/api/v2`(명령 · 동기화 · 부트스트랩 · 세션), SSE, 로그인 · 기기 인증, 라이선스, 쓰기 Worker. 쓰기 가능 여부 확인(`canWrite`)만 만들어 두었다.
- **매장 파일마다 운영체제 잠금**(deployment 2-2): 지금은 systemd 한 인스턴스와 '포트를 먼저 잡고 파일을 연다'로만 막는다.
- 감시 · 알림 보내기(알림 유닛은 자리만), 연습 서버(staging), 되살리기 연습, GitHub Actions 배포, 도메인, Trusted Types(앱에 정책을 넣은 뒤 CSP에 더함).
- 백업 결과를 control `backups` 표에 적기, 매장 끝내기, 가게 보관용 내보내기.

## 8. 파일

| 파일 | 무엇 |
|---|---|
| [deploy.sh](deploy.sh) | 배포 · 되돌리기 · 상태 · 사본 점검 |
| [skinote-server.service](skinote-server.service) | 서버 유닛(막기 설정, 메모리 512 MB, 포트 3100만, 백업 폴더 읽기 전용, 늦춰 가며 다시 시작) |
| [skinote-backup.service](skinote-backup.service) · [skinote-backup.timer](skinote-backup.timer) | 날마다 백업(네트워크 없음, 실패하면 알림) |
| [skinote-alert@.service](skinote-alert@.service) | 알림 자리(journald crit + `/var/log/skinote-ops/alerts`) |
| [skinote.caddy.template](skinote.caddy.template) | Caddy 사이트(`__SKINOTE_SITE__` 자리를 배포가 채움, `/api/health`는 바깥에서 404) |
| [skinote.env.example](skinote.env.example) | 서버 설정 예시(비밀값 없음) |
| [.gitignore](.gitignore) | 채운 `skinote.caddy` · `stage/` · `.env.local`을 올리지 않음 |
| [../packages/server](../packages/server) | 서버 코드(`src/main.js`, `bin/backup.js`, `bin/smoke.js`, `bin/new-shop-id.js`)와 시험 |
