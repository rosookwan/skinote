// 잠금 시험의 자식 프로세스: 쓰는 사람 잠금을 잡고 'held'(못 잡으면 'busy')를 한 줄 쓴 뒤, 죽을 때까지 쥐고 있다.
//   node test/fixtures/hold-lock.ts <dataDir> <shopId>
import { acquireWriterLock } from '../../src/lock.ts';

const [dataDir = '', shopId = ''] = process.argv.slice(2);
const lock = acquireWriterLock(dataDir, shopId);
process.stdout.write((lock ? 'held' : 'busy') + '\n');
if (lock) setInterval(() => undefined, 60_000);
