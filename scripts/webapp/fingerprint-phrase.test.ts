// 指纹短语的黄金值（golden）：重构（词表按需加载 + 去重）前后，算法与输出都不得变 ——
// 两台设备对同一登录请求必须看到同一个短语。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { getFingerprintPhrase } from '../../webapp/src/lib/api/auth-requests';

const PUBLIC_KEY = new Uint8Array(Array.from({ length: 64 }, (_, index) => (index * 7) % 256));

test('指纹短语：固定输入产出固定短语', async () => {
  assert.equal(await getFingerprintPhrase('cakkl@qq.com', PUBLIC_KEY), 'tapioca-haphazard-saddled-punctual-sterling');
});
