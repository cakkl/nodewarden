// 令牌可用性判定（`webapp/src/lib/sm-token-groups.ts`）：⭐ 核心是「过期也算失效」，
// 口径与服务端一致（换 token 时撤销与过期都拒）；只按 `revokedAt` 判会把过期令牌当有效。
//
// 运行方式：npm run test:webapp-lib
import assert from 'node:assert/strict';
import test from 'node:test';

import { splitTokensByUsable, tokenInactiveReason } from '../../webapp/src/lib/sm-token-groups';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');

type Token = { id: string; revokedAt: string | null; expiresAt: string };
const token = (id: string, revokedAt: string | null, expiresAt: string): Token => ({ id, revokedAt, expiresAt });

test('失效原因：撤销 / 过期 / 可用三种', () => {
  assert.equal(tokenInactiveReason(token('a', '2026-10-01T00:00:00.000Z', '2027-01-08T00:00:00.000Z'), NOW), 'revoked');
  assert.equal(tokenInactiveReason(token('b', null, '2026-10-01T00:00:00.000Z'), NOW), 'expired');
  assert.equal(tokenInactiveReason(token('c', null, '2027-01-08T00:00:00.000Z'), NOW), null);
});

test('⭐ 过期边界与服务端同口径：到期那一刻（`==`）就算过期', () => {
  assert.equal(tokenInactiveReason(token('a', null, '2026-10-10T12:00:00.000Z'), NOW), 'expired');
  assert.equal(tokenInactiveReason(token('b', null, '2026-10-10T12:00:00.001Z'), NOW), null);
});

test('两者都命中时算「撤销」（先撤销，行上的撤销时间才是用户关心的）', () => {
  assert.equal(tokenInactiveReason(token('a', '2026-10-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), NOW), 'revoked');
});

test('没有到期时间（空串）不判过期', () => {
  assert.equal(tokenInactiveReason(token('a', null, ''), NOW), null);
});

test('拆分：撤销与过期都进「已失效」，可用那批保持传入顺序', () => {
  const { active, inactive } = splitTokensByUsable(
    [
      token('a', null, '2027-01-08T00:00:00.000Z'),
      token('b', '2026-10-01T00:00:00.000Z', '2027-01-08T00:00:00.000Z'),
      token('c', null, '2025-01-01T00:00:00.000Z'),
      token('d', null, '2027-01-08T00:00:00.000Z'),
    ],
    NOW
  );
  assert.deepEqual(active.map((item) => item.id), ['a', 'd']);
  assert.deepEqual(inactive.map((item) => item.id), ['b', 'c'], '组内顺序 = 传入顺序（服务端按创建时间给）');
});

test('空列表 / 全可用 / 全失效都不崩，且不改动入参', () => {
  assert.deepEqual(splitTokensByUsable([], NOW), { active: [], inactive: [] });

  const items = [token('a', '2026-10-01T00:00:00.000Z', '2027-01-08T00:00:00.000Z')];
  const { active, inactive } = splitTokensByUsable(items, NOW);
  assert.deepEqual(active, [], '全失效时可用那批为空 ⇒ 界面只显示「已失效」组头');
  assert.equal(inactive.length, 1);
  assert.deepEqual(items.map((item) => item.id), ['a']);
  assert.notEqual(inactive, items);
});
