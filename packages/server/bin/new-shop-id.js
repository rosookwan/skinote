#!/usr/bin/env node
// @ts-check
// 새 매장 id(ULID) 하나를 찍는다. deploy.sh가 /etc/skinote/skinote.env를 처음 만들 때 부른다.
import { ulid } from '../src/ulid.js';

console.log(ulid());
