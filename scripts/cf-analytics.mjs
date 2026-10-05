#!/usr/bin/env node
// Cloudflare 线上指标查询（CPU / DO / KV / D1 行读写）。
//
// 为什么不用 `wrangler tail`：它走 WebSocket 长连接，在 WSL2 + 代理/防火墙环境下会被掐断
// （实测 `TypeError: fetch failed`）；GraphQL Analytics API 走普通 HTTPS，不受影响。
//
// 用法：
//   export CF_ANALYTICS_TOKEN='<带 Account Analytics: Read 权限的 token>'
//   export CF_ACCOUNT_ID='<account id>'
//   node scripts/cf-analytics.mjs [--days 7] [--only cpu,do,kv,d1] [--only describe]
//
// ⚠️ token 只从环境变量读（不进 shell history / 进程列表）；输出不含 token，可安全外传。
// ⛔ 不查 R2：其数据集名未核实（只查了 D1/KV/DO/Workers 四页官方文档）。

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

function parseArgs(argv) {
  const options = { days: 7, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') options.days = Number(argv[++i]);
    else if (argv[i] === '--only') options.only = new Set(String(argv[++i]).split(',').map((s) => s.trim()));
  }
  return options;
}

function isoDay(offsetDays) {
  const d = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function query(token, body) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL 报错：${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

/** 把 GraphQL 的 `{ sum: {...}, dimensions: {...} }` 数组打成表格 */
function printRows(rows, columns) {
  if (!rows?.length) {
    console.log('    （无数据）');
    return;
  }
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  console.log('    ' + columns.map((c, i) => c.label.padEnd(widths[i])).join('  '));
  console.log('    ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log('    ' + columns.map((c, i) => String(c.get(row) ?? '').padEnd(widths[i])).join('  '));
  }
}

async function reportWorkersCpu(token, accountId, start, end) {
  console.log('\n=== ③ Workers CPU / 请求（workersInvocationsAdaptive）===');
  // ⚠️ 只按 scriptName 分组，**不要**把时间放进 dimensions：按时间分桶后 quantiles 是「桶内分位数」，
  // 跨桶取 max 会得到荒谬值（实测 P50 显示 8517 ms，而单次请求 CPU 上限才 30 s）。
  const data = await query(token, {
    query: `query($accountTag: string!, $start: string!, $end: string!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
          sum { requests subrequests errors }
          quantiles { cpuTimeP50 cpuTimeP99 }
          dimensions { scriptName }
        }
      } }
    }`,
    variables: { accountTag: accountId, start, end },
  });
  const rows = data.viewer.accounts[0].workersInvocationsAdaptive ?? [];
  printRows(
    rows
      .map((r) => ({
        script: r.dimensions.scriptName,
        requests: r.sum.requests ?? 0,
        subrequests: r.sum.subrequests ?? 0,
        errors: r.sum.errors ?? 0,
        p50: r.quantiles?.cpuTimeP50 ?? 0,
        p99: r.quantiles?.cpuTimeP99 ?? 0,
      }))
      .sort((a, b) => b.requests - a.requests),
    [
      { label: 'script', get: (r) => r.script },
      { label: 'requests', get: (r) => r.requests },
      { label: 'subreq', get: (r) => r.subrequests },
      { label: 'errors', get: (r) => r.errors },
      { label: 'cpuP50(ms)', get: (r) => (r.p50 / 1000).toFixed(2) },
      { label: 'cpuP99(ms)', get: (r) => (r.p99 / 1000).toFixed(2) },
    ]
  );
  console.log('    注：cpuTime 的 schema 描述是「CPU time 50th/99th percentile - **microseconds**」');
  console.log('        ⇒ 已除以 1000 换算成毫秒。单次请求 CPU 上限 30 s。');
}

async function reportDurableObjects(token, accountId, start, end) {
  console.log('\n=== ④ Durable Objects（请求数 / CPU / 存储）===');
  // ⚠️ DO 三个数据集的 dimensions **不是同一套**，且类型名带 `Account` 前缀
  // （`AccountDurableObjectsInvocationsAdaptiveGroupsDimensions`）⇒ 逐个探测，不硬编码。
  const discovered = await discoverDoDimensions(token);
  if (discovered.error) {
    console.log(`    （无法取得 dimensions：${discovered.error}）`);
    return;
  }
  for (const [key, value] of Object.entries(discovered)) {
    if (value) console.log(`    ${key}: ${value.typeName} → ${value.fields.join(', ')}`);
  }
  // ⚠️ storage 的字段名是 **`namespaceIds`（复数）**，不是 `namespaceId` —— 取错会让 storedBytes 恒为 0。
  const pick = (entry) => {
    if (!entry) return null;
    const fields = entry.fields;
    const ns = fields.find((f) => /^namespaceIds?$/i.test(f)) ?? fields[0];
    return { ns, selection: ns };
  };
  const inv = pick(discovered.invocations);
  const per = pick(discovered.periodic);
  const sto = pick(discovered.storage);
  if (!inv && !per && !sto) {
    console.log('    （三个数据集都没有可用 dimensions，跳过）');
    return;
  }

  const data = await query(token, {
    query: `query($accountTag: string!, $start: string!, $end: string!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        ${inv ? `durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date_geq: $start, date_leq: $end }) {
          sum { requests responseBodySize }
          dimensions { ${inv.selection} }
        }` : ''}
        ${per ? `durableObjectsPeriodicGroups(limit: 1000, filter: { date_geq: $start, date_leq: $end }) {
          sum { cpuTime }
          dimensions { ${per.selection} }
        }` : ''}
        ${sto ? `durableObjectsStorageGroups(limit: 1000, filter: { date_geq: $start, date_leq: $end }) {
          max { storedBytes }
          dimensions { ${sto.selection} }
        }` : ''}
      } }
    }`,
    variables: { accountTag: accountId, start, end },
  });
  const acc = data.viewer.accounts[0];
  const invocations = acc.durableObjectsInvocationsAdaptiveGroups ?? [];
  const periodic = acc.durableObjectsPeriodicGroups ?? [];
  const storage = acc.durableObjectsStorageGroups ?? [];

  const byNs = new Map();
  const ensure = (id) => {
    if (!byNs.has(id)) byNs.set(id, { ns: id, requests: 0, cpuMs: 0, storedBytes: 0 });
    return byNs.get(id);
  };
  // 每个数据集用**自己的**字段名取值（invocations/periodic 是 namespaceId，storage 是 namespaceIds）
  for (const r of invocations) ensure(r.dimensions[inv.ns]).requests += r.sum.requests ?? 0;
  for (const r of periodic) ensure(r.dimensions[per.ns]).cpuMs += (r.sum.cpuTime ?? 0) / 1000;
  for (const r of storage) {
    // ⚠️ `namespaceIds` 的 schema 描述是「Durable Object namespace IDs」—— 名字是复数，
    // 但实测**不是数组**（按数组处理会让 storedBytes 恒为 0）。这里两种形态都兜住。
    const raw = r.dimensions[sto.ns];
    const ids = Array.isArray(raw) ? raw : [raw];
    for (const id of ids) {
      const e = ensure(id);
      e.storedBytes = Math.max(e.storedBytes, r.max.storedBytes ?? 0);
    }
  }
  if (!storage.length) {
    console.log('    ⚠️ storage 数据集返回 0 行 ⇒ storedBytes 无法取得（不是 0，是「没数据」）。');
  }
  printRows([...byNs.values()].sort((a, b) => b.requests - a.requests), [
    { label: 'namespaceId', get: (r) => r.ns },
    { label: 'requests', get: (r) => r.requests },
    { label: 'cpu(ms)', get: (r) => r.cpuMs.toFixed(1) },
    { label: 'storedBytes', get: (r) => r.storedBytes },
  ]);
  console.log('    注：cpuTime 的 schema 描述是「Sum of CPU time - **microseconds**」⇒ 已除以 1000 换算成毫秒。');
  console.log('        DO 的 duration 按 wall-clock 计费（等网络也算），本表未含 duration 字段 ——');
  console.log('        若需它，请到 dashboard 的 Durable Objects → Metrics 页确认字段名后再补。');
}

/**
 * 从 schema 里找出 DO 三个数据集**各自**的 dimensions 类型名与字段名。
 *
 * 官方文档只给了 DO 的 `sum` / `max` 示例、**未列 dimensions**，且三个数据集不是同一套
 * （`environmentName` / `scriptName` 都不在 PeriodicGroups 上）⇒ 只能逐个探测。
 */
async function discoverDoDimensions(token) {
  try {
    const data = await query(token, {
      query: `{ __schema { types { name kind fields { name } } } }`,
    });
    const types = data.__schema?.types ?? [];
    const find = (dataset) => {
      // 类型名形如 AccountDurableObjectsInvocationsAdaptiveGroupsDimensions。
      // 用全等比较而非 `new RegExp(...)`：原正则的 `^…$` 就是完全匹配，语义等价，
      // 且避免 Semgrep 的 detect-non-literal-regexp 告警（动态拼正则）。
      // ⚠️ 两侧都要转小写 —— 只转 `x.name` 会与未转小写的 `dataset` 对不上。
      const expected = `account${dataset}dimensions`.toLowerCase();
      const t = types.find((x) => x.name.toLowerCase() === expected);
      return t ? { typeName: t.name, fields: (t.fields ?? []).map((f) => f.name) } : null;
    };
    const result = {
      invocations: find('DurableObjectsInvocationsAdaptiveGroups'),
      periodic: find('DurableObjectsPeriodicGroups'),
      storage: find('DurableObjectsStorageGroups'),
    };
    if (!result.invocations && !result.periodic && !result.storage) {
      const doTypes = types.filter((t) => /durableObjects/i.test(t.name)).map((t) => t.name);
      return { error: `未找到任何 DO dimensions 类型。schema 里的 DO 相关类型：${doTypes.join(', ') || '（无）'}` };
    }
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function reportKv(token, accountId, start, end) {
  console.log('\n=== ⑤ KV 操作（kvOperationsAdaptiveGroups）===');
  const data = await query(token, {
    query: `query($accountTag: string!, $start: string!, $end: string!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        kvOperationsAdaptiveGroups(limit: 1000, filter: { date_geq: $start, date_leq: $end }) {
          sum { requests }
          dimensions { namespaceId actionType }
        }
      } }
    }`,
    variables: { accountTag: accountId, start, end },
  });
  const rows = data.viewer.accounts[0].kvOperationsAdaptiveGroups ?? [];
  printRows(rows.sort((a, b) => (b.sum.requests ?? 0) - (a.sum.requests ?? 0)), [
    { label: 'namespaceId', get: (r) => r.dimensions.namespaceId },
    { label: 'actionType', get: (r) => r.dimensions.actionType },
    { label: 'requests', get: (r) => r.sum.requests },
  ]);
  console.log('    注：若本实例用 R2 形态部署（wrangler.toml），这里会是空的 —— 属正常。');
}

async function reportD1(token, accountId, start, end) {
  console.log('\n=== ② D1 行读写（d1AnalyticsAdaptiveGroups）===');
  const data = await query(token, {
    query: `query($accountTag: string!, $start: string!, $end: string!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $start, date_leq: $end }) {
          sum { readQueries writeQueries rowsRead rowsWritten }
          dimensions { databaseId date }
        }
      } }
    }`,
    variables: { accountTag: accountId, start, end },
  });
  const rows = data.viewer.accounts[0].d1AnalyticsAdaptiveGroups ?? [];
  const byDb = new Map();
  for (const r of rows) {
    const key = r.dimensions.databaseId;
    const acc = byDb.get(key) ?? { db: key, readQ: 0, writeQ: 0, rowsRead: 0, rowsWritten: 0 };
    acc.readQ += r.sum.readQueries ?? 0;
    acc.writeQ += r.sum.writeQueries ?? 0;
    acc.rowsRead += r.sum.rowsRead ?? 0;
    acc.rowsWritten += r.sum.rowsWritten ?? 0;
    byDb.set(key, acc);
  }
  printRows([...byDb.values()].sort((a, b) => b.rowsRead - a.rowsRead), [
    { label: 'databaseId', get: (r) => r.db },
    { label: 'readQueries', get: (r) => r.readQ },
    { label: 'writeQueries', get: (r) => r.writeQ },
    { label: 'rowsRead', get: (r) => r.rowsRead },
    { label: 'rowsWritten', get: (r) => r.rowsWritten },
  ]);
  console.log('    注：逐条 SQL 的行读请用 `wrangler d1 insights`（本表只到库级）。');
}

/**
 * 查关键字段的 `description`（官方文档未写单位与语义，只能问 schema）。
 *
 * 为什么需要：`cpuTime` 的单位是 **microseconds**，误当毫秒会得出完全错误的结论
 * （实测把 DO 的 20,886,888 当毫秒 ⇒ 算出「5.8 小时/次」这种荒谬值）。
 */
async function describeFields(token) {
  console.log('\n=== 字段语义（introspection description）===');
  const targets = [
    ['AccountDurableObjectsPeriodicGroupsSum', ['cpuTime']],
    ['AccountDurableObjectsInvocationsAdaptiveGroupsSum', ['requests', 'responseBodySize']],
    ['AccountDurableObjectsStorageGroupsMax', ['storedBytes']],
    ['AccountDurableObjectsStorageGroupsDimensions', ['namespaceIds']],
    ['AccountWorkersInvocationsAdaptiveQuantiles', ['cpuTimeP50', 'cpuTimeP99']],
  ];
  for (const [typeName, fields] of targets) {
    try {
      const data = await query(token, {
        query: `{ __type(name: "${typeName}") { name fields { name description type { name kind ofType { name } } } } }`,
      });
      const t = data.__type;
      if (!t) {
        console.log(`\n  ${typeName}：类型不存在`);
        continue;
      }
      console.log(`\n  ${typeName}`);
      for (const f of t.fields ?? []) {
        if (!fields.includes(f.name)) continue;
        const typeStr = f.type?.name ?? f.type?.ofType?.name ?? f.type?.kind ?? '?';
        console.log(`    ${f.name} (${typeStr})`);
        console.log(`      ${f.description ?? '（无描述）'}`);
      }
    } catch (error) {
      console.log(`\n  ${typeName}：查询失败 —— ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function main() {
  const token = process.env.CF_ANALYTICS_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    console.error('缺少环境变量。请先设置：');
    console.error("  export CF_ANALYTICS_TOKEN='<带 Account Analytics: Read 权限的 token>'");
    console.error("  export CF_ACCOUNT_ID='<account id>'");
    process.exit(1);
  }

  const { days, only } = parseArgs(process.argv.slice(2));

  // --describe：查字段语义（单位 / 含义），用于避免把累计值误读成单次值
  if (only?.has('describe')) {
    await describeFields(token);
    return;
  }
  // ⚠️ 两类数据集要的日期格式不同（实测踩过）：
  //   - workersInvocationsAdaptive 用 `datetime_geq/leq`，要完整时间戳
  //   - d1 / kv / durableObjects 的 *AdaptiveGroups 用 `date_geq/leq`，**只接受 `YYYY-MM-DD`**
  const startDay = isoDay(days);
  const endDay = isoDay(0);
  const start = `${startDay}T00:00:00Z`;
  const end = `${endDay}T23:59:59Z`;
  console.log(`查询窗口：${start} → ${end}（最近 ${days} 天）`);

  const want = (name) => !only || only.has(name);
  const tasks = [
    ['cpu', () => reportWorkersCpu(token, accountId, start, end)],
    ['do', () => reportDurableObjects(token, accountId, startDay, endDay)],
    ['kv', () => reportKv(token, accountId, startDay, endDay)],
    ['d1', () => reportD1(token, accountId, startDay, endDay)],
  ];
  for (const [name, run] of tasks) {
    if (!want(name)) continue;
    try {
      await run();
    } catch (error) {
      console.log(`\n=== ${name} 查询失败 ===`);
      console.log(`    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

void main();
