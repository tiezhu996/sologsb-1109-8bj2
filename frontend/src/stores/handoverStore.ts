import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import type {
  HandoverItem,
  HandoverPackage,
  NormalizedPackage,
  ReviewDecision,
} from '../types/handover';
import {
  applyPending,
  checksum,
  normalizePackage,
  packageStatus,
  planItems,
  resolveReview,
  tally,
  type LedgerSnapshot,
  type WriteOp,
} from '../utils/reconcile';

export interface StageResult {
  ok: boolean;
  packageId?: string;
  duplicate?: boolean;
  error?: string;
  counts?: HandoverPackage['stats'];
}

interface HandoverState {
  packages: HandoverPackage[];
  items: HandoverItem[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 第一步：校验 + 暂存（不写本机台账、不清库），整包留存可重试 */
  stageText: (text: string, label: string) => Promise<StageResult>;
  /** 续接：把可写入项按业务键写入；成功项不重复，失败/待补录/待复核保留 */
  applyPackage: (packageId: string) => Promise<HandoverPackage | undefined>;
  /** 复核裁决：两版取平板版或保留本机版（锁定项禁止覆盖） */
  reviewItem: (packageId: string, itemId: string, decision: ReviewDecision, reviewer: string) => Promise<{ ok: boolean; error?: string }>;
  /** 删除整包（仅删除暂存副本，不影响已入账数据） */
  removePackage: (packageId: string) => Promise<void>;
}

async function loadSnapshot(): Promise<LedgerSnapshot> {
  const [herbs, methods, batches, samples] = await Promise.all([
    db.herbs.toArray(),
    db.methods.toArray(),
    db.batches.toArray(),
    db.samples.toArray(),
  ]);
  return { herbs, methods, batches, samples };
}

function reNormalize(pkg: HandoverPackage): NormalizedPackage {
  return normalizePackage({
    herbs: pkg.raw.herbs,
    methods: pkg.raw.methods,
    batches: pkg.raw.batches,
    samples: pkg.raw.samples,
    schemaVersion: pkg.schemaVersion,
  }).result;
}

async function execWrites(ops: WriteOp[]): Promise<void> {
  const groups: Record<WriteOp['type'], WriteOp[]> = { herb: [], method: [], batch: [], sample: [] };
  ops.forEach((op) => groups[op.type].push(op));
  if (groups.herb.length) await db.herbs.bulkPut(groups.herb.map((o) => o.value) as never[]);
  if (groups.method.length) await db.methods.bulkPut(groups.method.map((o) => o.value) as never[]);
  if (groups.batch.length) await db.batches.bulkPut(groups.batch.map((o) => o.value) as never[]);
  if (groups.sample.length) await db.samples.bulkPut(groups.sample.map((o) => o.value) as never[]);
}

export const useHandoverStore = create<HandoverState>()((set, get) => ({
  packages: [],
  items: [],
  hydrated: false,

  hydrate: async () => {
    const [packages, items] = await Promise.all([
      db.handoverPackages.orderBy('importedAt').reverse().toArray(),
      db.handoverItems.toArray(),
    ]);
    set({ packages, items, hydrated: true });
  },

  stageText: async (text, label) => {
    let parsed: Partial<{
      app: unknown;
      schemaVersion: unknown;
      herbs: unknown;
      methods: unknown;
      batches: unknown;
      samples: unknown;
    }>;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // 连 JSON 都不是：登记一个 error 包留存原始文本，便于事后核对
      const pkg: HandoverPackage = {
        id: uid('handover'),
        label: label || '无法解析的交接包',
        schemaVersion: 0,
        importedAt: new Date().toISOString(),
        raw: { herbs: [], methods: [], batches: [], samples: [] },
        checksum: checksum(text),
        status: 'error',
        error: `JSON 解析失败：${(err as Error).message}`,
        stats: { total: 0, new: 0, identical: 0, merge: 0, conflict: 0, locked: 0, missingRef: 0, invalid: 0, applied: 0, skipped: 0, failed: 0 },
      };
      await db.handoverPackages.put(pkg);
      set({ packages: [pkg, ...get().packages] });
      return { ok: false, packageId: pkg.id, error: pkg.error };
    }

    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: '交接包不是有效的 JSON 对象' };
    }
    // 兼容：标准备份包带 app 标记；平板裸包只要含四张台账数组也接收
    const looksLikeBackup = parsed.app === 'gbherbprocess';
    const hasTables = ['herbs', 'methods', 'batches', 'samples'].some((k) => Array.isArray((parsed as Record<string, unknown>)[k]));
    if (!looksLikeBackup && !hasTables) {
      return { ok: false, error: '交接包格式不匹配（缺少 app=gbherbprocess 标记，也未找到台账数组）' };
    }

    const rawArrays = {
      herbs: Array.isArray(parsed.herbs) ? parsed.herbs : [],
      methods: Array.isArray(parsed.methods) ? parsed.methods : [],
      batches: Array.isArray(parsed.batches) ? parsed.batches : [],
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
    };
    const sum = checksum({ ...rawArrays });
    const existed = get().packages.find((p) => p.checksum === sum && p.status !== 'error');
    if (existed) {
      return { ok: false, duplicate: true, packageId: existed.id, error: '该交接包此前已导入暂存，未重复建包' };
    }

    const schemaVersion = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1;
    const { result, invalid } = normalizePackage({ ...rawArrays, schemaVersion });

    const packageId = uid('handover');
    const snap = await loadSnapshot();
    const planned = planItems(snap, result);

    const items: HandoverItem[] = [];
    planned.forEach((p) => {
      items.push({
        id: uid('item'),
        packageId,
        entityType: p.entityType,
        status: p.status,
        naturalKey: p.naturalKey,
        incoming: p.incoming,
        localSnapshot: p.localSnapshot,
        diffs: p.diffs,
        missingRefs: p.missingRefs,
        reason: p.reason,
        conflictTitle: p.conflictTitle,
      });
    });
    invalid.forEach((iv) => {
      items.push({
        id: uid('item'),
        packageId,
        entityType: iv.entityType,
        status: 'invalid',
        naturalKey: iv.naturalKey,
        incoming: iv.raw,
        reason: iv.reason,
      });
    });

    const stats = tally(items);
    const pkg: HandoverPackage = {
      id: packageId,
      label: label || `平板交接包 ${new Date().toLocaleString('zh-CN')}`,
      schemaVersion,
      importedAt: new Date().toISOString(),
      raw: rawArrays,
      checksum: sum,
      status: packageStatus(items),
      stats,
    };

    await db.transaction('rw', db.handoverPackages, db.handoverItems, async () => {
      await db.handoverPackages.put(pkg);
      if (items.length) await db.handoverItems.bulkPut(items);
    });

    set({ packages: [pkg, ...get().packages], items: [...get().items, ...items] });
    return { ok: true, packageId, counts: stats };
  },

  applyPackage: async (packageId) => {
    const pkg = get().packages.find((p) => p.id === packageId);
    if (!pkg || pkg.status === 'error') return undefined;
    const items = get().items.filter((it) => it.packageId === packageId);
    const norm = reNormalize(pkg);

    let updated: HandoverPackage = pkg;
    await db.transaction(
      'rw',
      [
        db.herbs,
        db.methods,
        db.batches,
        db.samples,
        db.handoverItems,
        db.handoverPackages,
      ],
      async () => {
        // 事务内取最新本机台账：引用补录、上次部分写入都能即时反映
        const snap = await loadSnapshot();
        const changes = await applyPending(items, snap, norm, execWrites);
        const changeMap = new Map(changes.map((c) => [c.itemId, c]));
        const nextItems = items.map((it) => {
          const c = changeMap.get(it.id);
          if (!c) return it;
          return {
            ...it,
            status: c.status,
            diffs: c.diffs ?? it.diffs,
            missingRefs: c.missingRefs,
            failReason: c.failReason,
            localSnapshot: c.localSnapshot ?? it.localSnapshot,
            conflictTitle: c.conflictTitle ?? it.conflictTitle,
            appliedAt: c.appliedAt,
          };
        });
        await db.handoverItems.bulkPut(nextItems);
        updated = {
          ...pkg,
          status: packageStatus(nextItems),
          stats: tally(nextItems),
          lastTriedAt: new Date().toISOString(),
        };
        await db.handoverPackages.put(updated);
      },
    );

    set({
      packages: get().packages.map((p) => (p.id === packageId ? updated : p)),
      items: await db.handoverItems.toArray(),
    });
    return updated;
  },

  reviewItem: async (packageId, itemId, decision, reviewer) => {
    const pkg = get().packages.find((p) => p.id === packageId);
    const item = get().items.find((it) => it.id === itemId);
    if (!pkg || !item) return { ok: false, error: '暂存记录不存在' };
    if (item.status !== 'conflict' && item.status !== 'locked') {
      return { ok: false, error: '该条目不在待复核状态' };
    }
    const norm = reNormalize(pkg);

    let error: string | undefined;
    let updated = pkg;
    await db.transaction(
      'rw',
      [
        db.herbs,
        db.methods,
        db.batches,
        db.samples,
        db.handoverItems,
        db.handoverPackages,
      ],
      async () => {
        const snap = await loadSnapshot();
        const { change, op } = resolveReview(item, decision, snap, norm);
        if (op) await execWrites([op]);
        if (change.status === 'locked' || change.status === 'missing-ref') {
          error = change.failReason ?? change.missingRefs?.join('；');
          return;
        }
        const nextItem: HandoverItem = {
          ...item,
          status: change.status,
          missingRefs: change.missingRefs,
          reviewDecision: decision,
          reviewedBy: reviewer.trim() || '质检员',
          reviewedAt: new Date().toISOString(),
          appliedAt: change.appliedAt,
        };
        await db.handoverItems.put(nextItem);
        const allItems = (await db.handoverItems.where('packageId').equals(packageId).toArray());
        updated = { ...pkg, status: packageStatus(allItems), stats: tally(allItems) };
        await db.handoverPackages.put(updated);
      },
    );

    if (error) return { ok: false, error };
    await get().hydrate();
    return { ok: true };
  },

  removePackage: async (packageId) => {
    await db.transaction('rw', db.handoverPackages, db.handoverItems, async () => {
      await db.handoverPackages.delete(packageId);
      await db.handoverItems.where('packageId').equals(packageId).delete();
    });
    set({
      packages: get().packages.filter((p) => p.id !== packageId),
      items: get().items.filter((it) => it.packageId !== packageId),
    });
  },
}));
