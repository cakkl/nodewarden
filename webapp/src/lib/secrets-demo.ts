/**
 * 机密管理器的**演示数据**（`npm run dev:demo` 专用）。
 *
 * demo 模式没有后端，页面数据一律由 props 提供（仓库既有架构）⇒ 这里是静态数据来源，
 * 由 `lib/demo.ts` 的 `createDemoSecretsManager()` 包成 `SecretsManagerProps`。
 *
 * ⚠️ 真实数据里 key / value / note 都是密文（EncString type 2）；这里给的是**明文**，
 * 因为 demo 不经过加解密层。不要据此推断字段形态。
 */
export interface DemoSecretProject {
  id: string;
  name: string;
  createdAt: string;
  revisionDate: string;
}

export interface DemoSecret {
  id: string;
  name: string;
  projectIds: string[];
  value: string;
  note: string;
  createdAt: string;
  revisionDate: string;
}

export interface DemoMachineAccountGrant {
  projectId: string;
  permission: 'read' | 'write';
}

/** 演示用访问令牌（⚠️ 明文只在创建时出现，演示数据里自然也没有）。 */
export interface DemoMachineAccountToken {
  id: string;
  name: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface DemoMachineAccount {
  id: string;
  name: string;
  createdAt: string;
  revisionDate: string;
  grants: DemoMachineAccountGrant[];
  tokens: DemoMachineAccountToken[];
}

export const SECRETS_DEMO_PROJECTS: DemoSecretProject[] = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Production', createdAt: '2026-03-01T09:00:00.000Z', revisionDate: '2026-10-01T09:12:00.000Z' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Staging', createdAt: '2026-04-15T09:00:00.000Z', revisionDate: '2026-09-20T08:05:00.000Z' },
];

export const SECRETS_DEMO_SECRETS: DemoSecret[] = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'DATABASE_URL',
    projectIds: ['11111111-1111-4111-8111-111111111111'],
    value: 'postgres://demo:demo@db.internal:5432/app',
    note: '',
    createdAt: '2026-03-22T10:00:00.000Z',
    revisionDate: '2026-10-01T09:12:00.000Z',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'STRIPE_SECRET_KEY',
    projectIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    value: 'sk_live_demo_placeholder',
    note: 'Live key — rotate quarterly',
    createdAt: '2026-04-02T11:20:00.000Z',
    revisionDate: '2026-09-28T15:40:00.000Z',
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    name: 'SMTP_PASSWORD',
    projectIds: ['22222222-2222-4222-8222-222222222222'],
    value: 'demo-smtp-password',
    note: '',
    createdAt: '2026-05-11T07:30:00.000Z',
    revisionDate: '2026-09-20T08:05:00.000Z',
  },
  {
    // 「未分配」：删掉项目后遗留的那种数据（关联没了、本体还在），不带任何 projectIds
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    name: 'LEGACY_API_KEY',
    projectIds: [],
    value: 'legacy-demo-value',
    note: 'Was assigned to a project that no longer exists',
    createdAt: '2026-01-15T09:00:00.000Z',
    revisionDate: '2026-06-01T12:00:00.000Z',
  },
];

export const SECRETS_DEMO_TRASH: DemoSecret[] = [
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    name: 'OLD_SIGNING_KEY',
    projectIds: ['11111111-1111-4111-8111-111111111111'],
    value: 'retired',
    note: '',
    createdAt: '2026-02-01T09:00:00.000Z',
    revisionDate: '2026-09-10T11:00:00.000Z',
  },
];

export const SECRETS_DEMO_MACHINE_ACCOUNTS: DemoMachineAccount[] = [
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Deploy pipeline',
    createdAt: '2026-04-20T09:00:00.000Z',
    revisionDate: '2026-10-05T14:20:00.000Z',
    // 只授权 Production —— Staging 不在列表里（要加的时候才会出现）
    grants: [{ projectId: '11111111-1111-4111-8111-111111111111', permission: 'write' }],
    tokens: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'CI deploy',
        expiresAt: '2027-04-20T09:00:00.000Z',
        revokedAt: null,
        lastUsedAt: '2026-10-08T02:15:00.000Z',
        createdAt: '2026-04-20T09:05:00.000Z',
      },
    ],
  },
];

/**
 * 演示用的事件日志（与真实接口同一形状，但名称已是明文）。
 * 真实接口回的是**密文**，由数据层解密后填进 `name`。
 */
export interface DemoMachineAccountEvent {
  id: string;
  actorType: 'user' | 'machine_account';
  /** 官方的数字类型码。 */
  typeCode: number;
  secretId: string | null;
  projectId: string | null;
  name: string | null;
  createdAt: string;
}

export const SECRETS_DEMO_MACHINE_ACCOUNT_EVENTS: DemoMachineAccountEvent[] = [
  {
    id: 'e1000000-0000-4000-8000-000000000001',
    actorType: 'machine_account',
    typeCode: 2100,
    secretId: '11111111-1111-4111-8111-111111111111',
    projectId: null,
    name: 'DATABASE_URL',
    createdAt: '2026-10-08T02:15:00.000Z',
  },
  {
    id: 'e1000000-0000-4000-8000-000000000002',
    actorType: 'machine_account',
    typeCode: 2100,
    secretId: '22222222-2222-4222-8222-222222222222',
    projectId: null,
    name: 'STRIPE_SECRET_KEY',
    createdAt: '2026-10-07T18:40:00.000Z',
  },
  {
    id: 'e1000000-0000-4000-8000-000000000003',
    actorType: 'machine_account',
    typeCode: 2102,
    secretId: '11111111-1111-4111-8111-111111111111',
    projectId: null,
    name: 'DATABASE_URL',
    createdAt: '2026-10-05T14:20:00.000Z',
  },
  {
    id: 'e1000000-0000-4000-8000-000000000004',
    actorType: 'user',
    typeCode: 2304,
    secretId: null,
    projectId: null,
    name: 'Deploy pipeline',
    createdAt: '2026-04-20T09:00:00.000Z',
  },
];

/** 按 project 取名称；未知 id 返回 `null`，由调用方决定占位文案。 */
export function findDemoProjectName(projectId: string | null): string | null {
  if (!projectId) return null;
  return SECRETS_DEMO_PROJECTS.find((project) => project.id === projectId)?.name ?? null;
}
