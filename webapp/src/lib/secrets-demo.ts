/**
 * 机密管理器（Secrets Manager）演示数据 —— **仅限 Web UI 骨架阶段**。
 *
 * 真实数据要等加密层与后端端点就绪（组织密钥 → 客户端解密），在那之前用本文件让
 * 页面先跑起来；接入真实数据时应整体删除本文件。
 *
 * ⚠️ 真实实现的名称 / 值 / 备注都是密文（EncString type 2），这里给的是**明文占位**，
 * 不要据此推断字段形态。
 */

export interface SecretDemoProject {
  id: string;
  name: string;
}

export interface SecretDemoSecret {
  id: string;
  /** 真实契约里一个 secret 同一时刻只属于一个 project；`null` = 未分配。 */
  projectId: string | null;
  name: string;
  value: string;
  note: string;
  updatedAt: string;
}

export interface SecretDemoMachineAccount {
  id: string;
  name: string;
  /** 已创建的 access token 数量。 */
  tokenCount: number;
  /** 被授权的 project id。 */
  projectIds: string[];
}

export const SECRETS_DEMO_PROJECTS: SecretDemoProject[] = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Production' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Staging' },
];

export const SECRETS_DEMO_MACHINE_ACCOUNTS: SecretDemoMachineAccount[] = [
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Deploy pipeline',
    tokenCount: 1,
    projectIds: ['11111111-1111-4111-8111-111111111111'],
  },
];

export const SECRETS_DEMO_SECRETS: SecretDemoSecret[] = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: '11111111-1111-4111-8111-111111111111',
    name: 'DATABASE_URL',
    value: 'postgres://demo:demo@db.internal:5432/app',
    note: '',
    updatedAt: '2026-10-01T09:12:00.000Z',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    projectId: '11111111-1111-4111-8111-111111111111',
    name: 'STRIPE_SECRET_KEY',
    value: 'sk_live_demo_placeholder',
    note: 'Live key — rotate quarterly',
    updatedAt: '2026-09-28T15:40:00.000Z',
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    projectId: '22222222-2222-4222-8222-222222222222',
    name: 'SMTP_PASSWORD',
    value: 'demo-smtp-password',
    note: '',
    updatedAt: '2026-09-20T08:05:00.000Z',
  },
];

/** 按 project 取名称；`null` / 未知 id 返回 `null`，由调用方决定占位文案。 */
export function findDemoProjectName(projectId: string | null): string | null {
  if (!projectId) return null;
  return SECRETS_DEMO_PROJECTS.find((project) => project.id === projectId)?.name ?? null;
}

/** 列表里显示的时间：只到分钟，避免骨架阶段引入日期格式化的额外依赖。 */
export function formatDemoTimestamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}
