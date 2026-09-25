#!/usr/bin/env node
// deploy.sh --shop-cli의 맥 쪽: 명령줄 인자(bin/shop.js와 같은 모양)를 서버 입구(deploy/shop-cli.sh)가 받을 JSON 하나로 바꿔 표준 출력에
// 쓴다. 인자는 bin/shop.js의 parseArgs로 읽는다(깃발이 늘 같게). --spec 파일은 여기서 읽어 명세 객체로 넣는다(서버에는 그 파일이 없다).
//   node deploy/shop-cli-request.mjs provision --shop <id> --code <code> --name <이름> --sample --test --staff "<이름>:manager" …
// 끝 코드: 0 성공, 64 쓰는 법이 틀림, 65 명세 파일을 읽지 못함.
import { readFileSync } from 'node:fs';
import { parseArgs } from '../packages/server/bin/shop.js';

const argv = process.argv.slice(2);
let parsed;
try {
  parsed = parseArgs(argv);
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exit(64);
}
if (parsed.stdin) {
  process.stderr.write('--shop-cli 다음에는 명령과 깃발을 적습니다(--stdin 아님)\n');
  process.exit(64);
}
const args = { ...parsed.args };
if (typeof args.spec === 'string') {
  try {
    args.spec = JSON.parse(readFileSync(args.spec, 'utf8'));
  } catch (error) {
    process.stderr.write(`명세 파일을 읽지 못했습니다: ${args.spec} (${error instanceof Error ? error.message : String(error)})\n`);
    process.exit(65);
  }
}
process.stdout.write(JSON.stringify({ op: parsed.op, args }));
