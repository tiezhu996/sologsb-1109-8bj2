import type { HerbMaterial, HerbOrigin, HerbPart } from '../types/herb-material';
import type {
  Auxiliary,
  CriterionDimension,
  FireLevel,
  ProcessingMethod,
} from '../types/processing-method';
import type { ProcessBatch, ProcessDegree } from '../types/process-batch';
import type { ObserveLog, RetainSample } from '../types/retain-sample';
import type {
  FieldDiff,
  HandoverEntityType,
  HandoverItem,
  HandoverItemStatus,
  HandoverPackage,
  HandoverPackageStatus,
  NormalizedPackage,
} from '../types/handover';
import {
  AUXILIARIES,
  CRITERION_DIMENSIONS,
  FIRE_LEVELS,
  METHOD_NAMES,
} from '../types/processing-method';
import { HERB_ORIGINS, HERB_PARTS } from '../types/herb-material';
import { PROCESS_DEGREES } from '../types/process-batch';

/* ------------------------------------------------------------------ */
/* 状态元数据                                                           */
/* ------------------------------------------------------------------ */

export const ITEM_STATUS_META: Record<HandoverItemStatus, { label: string; color: string }> = {
  new: { label: '新增', color: 'blue' },
  identical: { label: '一致', color: 'default' },
  merge: { label: '可合并', color: 'cyan' },
  conflict: { label: '两版待复核', color: 'orange' },
  locked: { label: '本机已锁定', color: 'red' },
  'missing-ref': { label: '缺引用待补录', color: 'gold' },
  invalid: { label: '条目异常', color: 'default' },
  applied: { label: '已写入', color: 'green' },
  skipped: { label: '保留本机版', color: 'default' },
  failed: { label: '写入失败', color: 'red' },
};

/** 可被自动写入/重算的非终态 */
const PENDING_STATUSES: HandoverItemStatus[] = ['new', 'merge', 'missing-ref', 'failed'];

/** 终态：不会再被 apply 重算 */
export const TERMINAL_STATUSES: HandoverItemStatus[] = ['applied', 'skipped', 'identical', 'invalid'];

const ENTITY_LABEL: Record<HandoverEntityType, string> = {
  herb: '药材',
  method: '炮制方法',
  batch: '工序批号',
  sample: '留样编号',
};

export function entityLabel(t: HandoverEntityType): string {
  return ENTITY_LABEL[t];
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return isFiniteNumber(n) ? n : fallback;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim();
}

function validIso(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** 由起止时间推导时长（min），旧版交接包缺 durationMin 时兼容补全 */
export function deriveDurationMin(startedAt: string, endedAt: string): number | undefined {
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (Number.isNaN(ms) || ms < 0) return undefined;
  return Math.round(ms / 60000);
}

/** FNV-1a 校验和：用于识别同一交接包的重复导入 */
export function checksum(value: unknown): string {
  const json = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/* ------------------------------------------------------------------ */
/* 归一化 + 校验（旧版交接包缺字段时补默认值；硬错误标 invalid）           */
/* ------------------------------------------------------------------ */

export interface NormalizeResult<T> {
  value?: T;
  errors: string[];
}

function normalizeHerb(raw: unknown): NormalizeResult<HerbMaterial> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const batchNo = str(r.batchNo);
  const name = str(r.name);
  if (!batchNo) errors.push('缺少药材批号');
  if (!name) errors.push('缺少药材名');
  const origin = oneOf(r.origin, HERB_ORIGINS) ?? ('植物' satisfies HerbOrigin);
  const part = oneOf(r.part, HERB_PARTS) ?? ('根' satisfies HerbPart);
  const receivedAt = validIso(r.receivedAt) ? r.receivedAt : new Date(0).toISOString();
  if (!validIso(r.receivedAt)) errors.push('入库时间缺失或不可解析');
  if (errors.length) return { errors };
  return {
    value: {
      id: str(r.id) || `herb-import-${batchNo}`,
      name,
      origin,
      part,
      batchNo,
      feedKg: num(r.feedKg),
      receivedAt,
      remark: str(r.remark) || undefined,
    },
    errors,
  };
}

function normalizeMethod(raw: unknown): NormalizeResult<ProcessingMethod> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const name = oneOf(r.name, METHOD_NAMES);
  if (!name) errors.push(`方法名缺失或不在标准内（${METHOD_NAMES.join('/')}）`);
  if (errors.length || !name) return { errors };
  const range = Array.isArray(r.tempRange) ? r.tempRange : [];
  const tempRange: [number, number] = [num(range[0], 100), num(range[1], 150)];
  return {
    value: {
      id: str(r.id) || `method-import-${name}`,
      name,
      auxiliary: oneOf(r.auxiliary, AUXILIARIES) ?? ('无' satisfies Auxiliary),
      auxRatio: num(r.auxRatio),
      fireLevel: oneOf(r.fireLevel, FIRE_LEVELS) ?? ('文火' satisfies FireLevel),
      tempRange,
      duration: num(r.duration),
      criterion: str(r.criterion) || '按标准方法判定',
      criterionDimension:
        oneOf(r.criterionDimension, CRITERION_DIMENSIONS) ?? ('色泽' satisfies CriterionDimension),
      applicable: str(r.applicable) || '通用',
      derivedFrom: str(r.derivedFrom) || undefined,
    },
    errors,
  };
}

function normalizeBatch(raw: unknown): NormalizeResult<ProcessBatch> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const batchNo = str(r.batchNo);
  if (!batchNo) errors.push('缺少生产批号');
  const degree = oneOf(r.degree, PROCESS_DEGREES);
  if (!degree) errors.push(`程度判定缺失或非法（${PROCESS_DEGREES.join('/')}）`);
  const fireLevel = oneOf(r.fireLevel, FIRE_LEVELS);
  if (!fireLevel) errors.push(`火候缺失或非法（${FIRE_LEVELS.join('/')}）`);
  if (!validIso(r.startedAt)) errors.push('开始时间缺失或不可解析');
  if (!validIso(r.endedAt)) errors.push('结束时间缺失或不可解析');
  if (errors.length || !degree || !fireLevel || !validIso(r.startedAt) || !validIso(r.endedAt)) {
    return { errors };
  }
  const locked = typeof r.locked === 'boolean' ? r.locked : false;
  const durationMin = isFiniteNumber(r.durationMin)
    ? r.durationMin
    : isFiniteNumber(r.duration)
      ? r.duration
      : deriveDurationMin(r.startedAt, r.endedAt);
  const potTempC = isFiniteNumber(r.potTempC)
    ? r.potTempC
    : isFiniteNumber(r.temp)
      ? r.temp
      : undefined;
  return {
    value: {
      id: str(r.id) || `batch-import-${batchNo}`,
      batchNo,
      herbId: str(r.herbId),
      methodId: str(r.methodId),
      feedKg: num(r.feedKg),
      auxUsedKg: num(r.auxUsedKg),
      fireLevel,
      potTempC,
      durationMin,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      yieldRate: num(r.yieldRate),
      degree,
      operator: str(r.operator) || '待补录',
      locked,
      lockedAt: validIso(r.lockedAt) ? r.lockedAt : undefined,
      qcBy: str(r.qcBy) || undefined,
      remark: str(r.remark) || undefined,
    },
    errors,
  };
}

function normalizeObserveLogs(raw: unknown): ObserveLog[] {
  if (!Array.isArray(raw)) return [];
  const logs: ObserveLog[] = [];
  raw.forEach((item, i) => {
    const r = (item ?? {}) as Record<string, unknown>;
    if (!str(r.date)) return;
    logs.push({
      id: str(r.id) || `log-import-${i}-${str(r.date)}`,
      date: str(r.date),
      color: str(r.color),
      odor: str(r.odor),
      mold: str(r.mold),
      observer: str(r.observer) || '待补录',
      note: str(r.note) || undefined,
    });
  });
  return logs;
}

function normalizeSample(raw: unknown): NormalizeResult<RetainSample> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const sampleNo = str(r.sampleNo);
  if (!sampleNo) errors.push('缺少留样编号');
  if (!validIso(r.retainedAt)) errors.push('留样日期缺失或不可解析');
  if (errors.length) return { errors };
  return {
    value: {
      id: str(r.id) || `sample-import-${sampleNo}`,
      sampleNo,
      batchId: str(r.batchId),
      amountG: num(r.amountG),
      retainMonths: num(r.retainMonths, 6),
      // 旧版包可能无柜位：留空待补录，不臆造柜位
      cabinet: str(r.cabinet),
      retainedAt: r.receivedAt as string,
      observeLogs: normalizeObserveLogs(r.observeLogs),
    },
    errors,
  };
}

export interface RawPackage {
  herbs?: unknown[];
  methods?: unknown[];
  batches?: unknown[];
  samples?: unknown[];
  schemaVersion?: number;
}

/** 归一化整包：硬错误条目剔除并由调用方登记为 invalid，其余补全默认值 */
export function normalizePackage(raw: RawPackage): {
  result: NormalizedPackage;
  invalid: Array<{ entityType: HandoverEntityType; naturalKey: string; reason: string; raw: Record<string, unknown> }>;
} {
  const invalid: Array<{ entityType: HandoverEntityType; naturalKey: string; reason: string; raw: Record<string, unknown> }> = [];
  const collect = <T,>(
    list: unknown[] | undefined,
    entityType: HandoverEntityType,
    keyOf: (r: Record<string, unknown>) => string,
    normalize: (raw: unknown) => NormalizeResult<T>,
  ): T[] =>
    (list ?? []).flatMap((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const n = normalize(raw);
      if (!n.value) {
        invalid.push({ entityType, naturalKey: keyOf(r) || '（无业务键）', reason: n.errors.join('；'), raw: r });
        return [];
      }
      return [n.value];
    });

  const result: NormalizedPackage = {
    herbs: collect(raw.herbs, 'herb', (r) => str(r.batchNo), normalizeHerb),
    methods: collect(raw.methods, 'method', (r) => str(r.name), normalizeMethod),
    batches: collect(raw.batches, 'batch', (r) => str(r.batchNo), normalizeBatch),
    samples: collect(raw.samples, 'sample', (r) => str(r.sampleNo), normalizeSample),
    schemaVersion: isFiniteNumber(raw.schemaVersion) ? raw.schemaVersion : 1,
  };
  return { result, invalid };
}

/* ------------------------------------------------------------------ */
/* 对账规划（纯数据：本机快照 + 归一化包 → 逐条对账状态）                  */
/* ------------------------------------------------------------------ */

/** 本机台账快照 */
export interface LedgerSnapshot {
  herbs: HerbMaterial[];
  methods: ProcessingMethod[];
  batches: ProcessBatch[];
  samples: RetainSample[];
}

export const emptySnapshot: LedgerSnapshot = { herbs: [], methods: [], batches: [], samples: [] };

interface Refs {
  /** 包内药材 id → 批号 */
  herbIdToBatchNo: Map<string, string>;
  /** 包内方法 id → 方法名 */
  methodIdToName: Map<string, string>;
  /** 包内批次 id → 生产批号 */
  batchIdToNo: Map<string, string>;
  /** 批号 → 药材 id（本机∪包内，写入时实际主键） */
  herbBatchNoToId: Map<string, string>;
  /** 方法名 → 方法 id */
  methodNameToId: Map<string, string>;
  /** 生产批号 → 批次 id */
  batchNoToId: Map<string, string>;
}

function buildRefs(snap: LedgerSnapshot, pkg: NormalizedPackage): Refs {
  const refs: Refs = {
    herbIdToBatchNo: new Map(),
    methodIdToName: new Map(),
    batchIdToNo: new Map(),
    herbBatchNoToId: new Map(),
    methodNameToId: new Map(),
    batchNoToId: new Map(),
  };
  snap.herbs.forEach((h) => refs.herbBatchNoToId.set(h.batchNo, h.id));
  snap.methods.forEach((m) => refs.methodNameToId.set(m.name, m.id));
  snap.batches.forEach((b) => refs.batchNoToId.set(b.batchNo, b.id));
  pkg.herbs.forEach((h) => {
    refs.herbIdToBatchNo.set(h.id, h.batchNo);
    if (!refs.herbBatchNoToId.has(h.batchNo)) refs.herbBatchNoToId.set(h.batchNo, h.id);
  });
  pkg.methods.forEach((m) => {
    refs.methodIdToName.set(m.id, m.name);
    if (!refs.methodNameToId.has(m.name)) refs.methodNameToId.set(m.name, m.id);
  });
  pkg.batches.forEach((b) => {
    refs.batchIdToNo.set(b.id, b.batchNo);
    if (!refs.batchNoToId.has(b.batchNo)) refs.batchNoToId.set(b.batchNo, b.id);
  });
  return refs;
}

/** 解析工序的药材/方法引用，返回缺失说明 */
function resolveBatchRefs(
  incoming: ProcessBatch,
  snap: LedgerSnapshot,
  refs: Refs,
): { herbId?: string; methodId?: string; missing: string[] } {
  const herbBatchNo = refs.herbIdToBatchNo.get(incoming.herbId)
    ?? snap.herbs.find((h) => h.id === incoming.herbId)?.batchNo;
  const methodName = refs.methodIdToName.get(incoming.methodId)
    ?? snap.methods.find((m) => m.id === incoming.methodId)?.name;
  const missing: string[] = [];
  if (!herbBatchNo) missing.push(`药材引用不存在（${incoming.herbId || '空'}）`);
  if (!methodName) missing.push(`炮制方法不存在（${incoming.methodId || '空'}）`);
  if (missing.length) return { missing };
  return {
    herbId: refs.herbBatchNoToId.get(herbBatchNo!),
    methodId: refs.methodNameToId.get(methodName!),
    missing,
  };
}

/** 解析留样所属批次（包内优先，其次本机） */
function resolveSampleBatchNo(sample: RetainSample, snap: LedgerSnapshot, refs: Refs): string | undefined {
  return refs.batchIdToNo.get(sample.batchId) ?? snap.batches.find((b) => b.id === sample.batchId)?.batchNo;
}

/* ----------------------------- 字段差异 ----------------------------- */

const BATCH_DIFF_FIELDS: Array<{ field: keyof ProcessBatch; label: string; protected: boolean }> = [
  { field: 'potTempC', label: '锅温(℃)', protected: true },
  { field: 'durationMin', label: '时长(min)', protected: true },
  { field: 'degree', label: '程度判定', protected: true },
  { field: 'fireLevel', label: '火候', protected: false },
  { field: 'feedKg', label: '投料量(kg)', protected: false },
  { field: 'auxUsedKg', label: '辅料用量(kg)', protected: false },
  { field: 'yieldRate', label: '得率(%)', protected: false },
  { field: 'startedAt', label: '开始时间', protected: false },
  { field: 'endedAt', label: '结束时间', protected: false },
  { field: 'operator', label: '操作人', protected: false },
  { field: 'remark', label: '备注', protected: false },
];

const SAMPLE_SCALAR_FIELDS: Array<{ field: keyof RetainSample; label: string }> = [
  { field: 'amountG', label: '留样量(g)' },
  { field: 'retainMonths', label: '留样期(月)' },
  { field: 'cabinet', label: '柜位' },
  { field: 'retainedAt', label: '留样日期' },
];

function valuesDiffer(a: unknown, b: unknown): boolean {
  // 旧版包缺字段（undefined）视为兼容补全，不算差异
  if (b === undefined || b === null || b === '') return false;
  if (a === undefined || a === null || a === '') return true;
  if (isFiniteNumber(a) && isFiniteNumber(b)) return Number(a) !== Number(b);
  return String(a) !== String(b);
}

function diffRecord<T extends object>(
  local: T,
  incoming: T,
  fields: Array<{ field: keyof T; label: string; protected?: boolean }>,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  fields.forEach(({ field, label, protected: prot }) => {
    if (valuesDiffer(local[field], incoming[field])) {
      diffs.push({
        field: String(field),
        label: prot ? `${label}（锁定项）` : label,
        local: local[field],
        incoming: incoming[field],
      });
    }
  });
  return diffs;
}

function observeLogKey(log: ObserveLog): string {
  return log.id || `${log.date}|${log.observer}`;
}

/** 留样观察记录对账：同键内容不同 → 观察差异；新观察记录可追加 */
function diffObserveLogs(local: ObserveLog[], incoming: ObserveLog[]): { diffs: FieldDiff; appended: ObserveLog[] } | undefined {
  const localMap = new Map(local.map((l) => [observeLogKey(l), l]));
  const appended: ObserveLog[] = [];
  let conflict: FieldDiff | undefined;
  incoming.forEach((inc) => {
    const key = observeLogKey(inc);
    const loc = localMap.get(key);
    if (!loc) {
      appended.push(inc);
      return;
    }
    const changed = (['date', 'color', 'odor', 'mold', 'observer', 'note'] as const).some(
      (f) => (loc[f] ?? '') !== (inc[f] ?? ''),
    );
    if (changed && !conflict) {
      conflict = {
        field: 'observeLogs',
        label: '观察记录（同次观察内容不一致）',
        local: `${loc.date} ${loc.color ?? ''}/${loc.odor ?? ''}/${loc.mold ?? ''} · ${loc.observer}`,
        incoming: `${inc.date} ${inc.color ?? ''}/${inc.odor ?? ''}/${inc.mold ?? ''} · ${inc.observer}`,
      };
    }
  });
  if (!conflict && appended.length === 0) return undefined;
  return { diffs: conflict ?? { field: 'observeLogs', label: `新增观察记录 ${appended.length} 条`, local: `${local.length} 条`, incoming: `${incoming.length} 条` }, appended };
}

/* ----------------------------- 规划结果 ----------------------------- */

export interface PlannedItem {
  entityType: HandoverEntityType;
  naturalKey: string;
  status: HandoverItemStatus;
  incoming: Record<string, unknown>;
  localSnapshot?: Record<string, unknown>;
  diffs?: FieldDiff[];
  missingRefs?: string[];
  reason?: string;
  conflictTitle?: string;
}

export function planItems(snap: LedgerSnapshot, pkg: NormalizedPackage): PlannedItem[] {
  const refs = buildRefs(snap, pkg);
  const items: PlannedItem[] = [];
  pkg.herbs.forEach((h) => items.push(classifyHerb(h, snap)));
  pkg.methods.forEach((m) => items.push(classifyMethod(m, snap)));
  pkg.batches.forEach((b) => items.push(classifyBatch(b, snap, refs)));
  pkg.samples.forEach((s) => items.push(classifySample(s, snap, refs)));
  return items;
}

/** 重新规划单条（重试/复核前按当前本机台账再对一次） */
export function classifyItem(
  snap: LedgerSnapshot,
  pkg: NormalizedPackage,
  entityType: HandoverEntityType,
  naturalKey: string,
): PlannedItem | undefined {
  const refs = buildRefs(snap, pkg);
  if (entityType === 'herb') {
    const incoming = pkg.herbs.find((h) => h.batchNo === naturalKey);
    return incoming ? classifyHerb(incoming, snap) : undefined;
  }
  if (entityType === 'method') {
    const incoming = pkg.methods.find((m) => m.name === naturalKey);
    return incoming ? classifyMethod(incoming, snap) : undefined;
  }
  if (entityType === 'batch') {
    const incoming = pkg.batches.find((b) => b.batchNo === naturalKey);
    return incoming ? classifyBatch(incoming, snap, refs) : undefined;
  }
  const incoming = pkg.samples.find((s) => s.sampleNo === naturalKey);
  return incoming ? classifySample(incoming, snap, refs) : undefined;
}

function classifyHerb(incoming: HerbMaterial, snap: LedgerSnapshot): PlannedItem {
  const local = snap.herbs.find((h) => h.batchNo === incoming.batchNo);
  const diffs = local
    ? diffRecord(local, incoming, [
        { field: 'name', label: '药材名' },
        { field: 'origin', label: '基原' },
        { field: 'part', label: '药用部位' },
        { field: 'feedKg', label: '投料量(kg)' },
        { field: 'receivedAt', label: '入库时间' },
        { field: 'remark', label: '备注' },
      ])
    : [];
  return {
    entityType: 'herb',
    naturalKey: incoming.batchNo,
    status: !local ? 'new' : diffs.length ? 'merge' : 'identical',
    incoming: incoming as unknown as Record<string, unknown>,
    localSnapshot: local as unknown as Record<string, unknown>,
    diffs,
  };
}

function classifyMethod(incoming: ProcessingMethod, snap: LedgerSnapshot): PlannedItem {
  const local = snap.methods.find((m) => m.name === incoming.name);
  const diffs = local
    ? diffRecord(local, incoming, [
        { field: 'auxiliary', label: '辅料' },
        { field: 'auxRatio', label: '辅料比例(kg/100kg)' },
        { field: 'fireLevel', label: '火力' },
        { field: 'duration', label: '标准时长(min)' },
        { field: 'criterion', label: '判断标准' },
      ])
    : [];
  return {
    entityType: 'method',
    naturalKey: incoming.name as string,
    status: !local ? 'new' : diffs.length ? 'merge' : 'identical',
    incoming: incoming as unknown as Record<string, unknown>,
    localSnapshot: local as unknown as Record<string, unknown>,
    diffs,
  };
}

function classifyBatch(incoming: ProcessBatch, snap: LedgerSnapshot, refs: Refs): PlannedItem {
  const base: PlannedItem = {
    entityType: 'batch',
    naturalKey: incoming.batchNo,
    status: 'new',
    incoming: incoming as unknown as Record<string, unknown>,
  };
  const resolved = resolveBatchRefs(incoming, snap, refs);
  if (resolved.missing.length) {
    return { ...base, status: 'missing-ref', missingRefs: resolved.missing };
  }
  const local = snap.batches.find((b) => b.batchNo === incoming.batchNo);
  if (!local) return base;
  const diffs = diffRecord(local, incoming, BATCH_DIFF_FIELDS);
  if (!diffs.length) {
    return { ...base, status: 'identical', localSnapshot: local as unknown as Record<string, unknown> };
  }
  const protectedDiff = diffs.some((d) => BATCH_DIFF_FIELDS.find((f) => f.field === d.field)?.protected);
  return {
    ...base,
    // 锅温/时长/程度任一有差异：两版保留待复核；
    // 本机批次已锁定时，任何差异都不得覆盖，标记锁定待复核（只能保留本机版或先解锁）
    status: protectedDiff ? (local.locked ? 'locked' : 'conflict') : local.locked ? 'locked' : 'merge',
    localSnapshot: local as unknown as Record<string, unknown>,
    diffs,
    conflictTitle: `${incoming.batchNo}：${diffs.map((d) => d.label).join('、')}不一致`,
  };
}

function classifySample(incoming: RetainSample, snap: LedgerSnapshot, refs: Refs): PlannedItem {
  const base: PlannedItem = {
    entityType: 'sample',
    naturalKey: incoming.sampleNo,
    status: 'new',
    incoming: incoming as unknown as Record<string, unknown>,
  };
  if (!resolveSampleBatchNo(incoming, snap, refs)) {
    return { ...base, status: 'missing-ref', missingRefs: [`所属工序批次不存在（${incoming.batchId || '空'}）`] };
  }
  const local = snap.samples.find((s) => s.sampleNo === incoming.sampleNo);
  if (!local) return base;
  const scalarDiffs = diffRecord(local, incoming, SAMPLE_SCALAR_FIELDS);
  const logResult = diffObserveLogs(local.observeLogs ?? [], incoming.observeLogs ?? []);
  if (!scalarDiffs.length && !logResult) {
    return { ...base, status: 'identical', localSnapshot: local as unknown as Record<string, unknown> };
  }
  const diffs = [...scalarDiffs];
  if (logResult) diffs.push(logResult.diffs);
  // 同次观察内容不一致 → 两版保留待复核；仅追加新观察或柜位等标量差异 → 可合并
  const observeConflict = logResult !== undefined && logResult.diffs.label.startsWith('观察记录');
  return {
    ...base,
    status: observeConflict ? 'conflict' : 'merge',
    localSnapshot: local as unknown as Record<string, unknown>,
    diffs,
    conflictTitle: observeConflict ? `${incoming.sampleNo}：观察记录不一致` : undefined,
  };
}

/** 状态分类里的「待复核」判定（观察内容冲突，而非仅追加新观察） */
export function isObserveConflict(status: HandoverItemStatus, diffs: FieldDiff[] | undefined): boolean {
  if (status !== 'conflict') return false;
  return Boolean(diffs?.some((d) => d.field === 'observeLogs' && d.label.startsWith('观察记录')));
}

/* ------------------------------------------------------------------ */
/* 写入构造（把裁决结果变成可落库的记录；引用重新映射为本机主键）           */
/* ------------------------------------------------------------------ */

export interface WriteOp {
  type: HandoverEntityType;
  /** 目标主键：命中本机记录时为本机 id，新增时为包内 id（天然幂等） */
  id: string;
  value: Record<string, unknown>;
}

function overlayDefined(target: Record<string, unknown>, source: Record<string, unknown>, fields: string[]): void {
  fields.forEach((f) => {
    const v = source[f];
    if (v !== undefined && v !== null && v !== '') target[f] = v;
  });
}

/** 针对一条对账项构造写入操作（仅在 new/merge/conflict 采平板版时调用） */
export function buildWriteOp(
  item: HandoverItem,
  snap: LedgerSnapshot,
  refs: Refs,
): WriteOp | { missingRefs: string[] } {
  const incoming = item.incoming;

  if (item.entityType === 'herb') {
    const local = snap.herbs.find((h) => h.batchNo === item.naturalKey);
    if (local) {
      const merged: Record<string, unknown> = { ...local };
      overlayDefined(merged, incoming, ['name', 'origin', 'part', 'feedKg', 'receivedAt', 'remark']);
      return { type: 'herb', id: local.id, value: merged };
    }
    return { type: 'herb', id: String(incoming.id), value: { ...incoming } };
  }

  if (item.entityType === 'method') {
    const local = snap.methods.find((m) => m.name === item.naturalKey);
    if (local) {
      const merged: Record<string, unknown> = { ...local };
      overlayDefined(merged, incoming, ['auxiliary', 'auxRatio', 'fireLevel', 'tempRange', 'duration', 'criterion', 'criterionDimension', 'applicable']);
      return { type: 'method', id: local.id, value: merged };
    }
    return { type: 'method', id: String(incoming.id), value: { ...incoming } };
  }

  if (item.entityType === 'batch') {
    const resolved = resolveBatchRefs(incoming as unknown as ProcessBatch, snap, refs);
    if (resolved.missing.length) return { missingRefs: resolved.missing };
    const local = snap.batches.find((b) => b.batchNo === item.naturalKey);
    if (local) {
      // 合并：保留本机 id 与锁定痕迹；只覆盖已判定有差异的字段，锁定项永不由导入覆盖
      const merged: Record<string, unknown> = { ...local };
      const fields = item.status === 'conflict'
        ? BATCH_DIFF_FIELDS.map((f) => String(f.field))
        : (item.diffs ?? []).map((d) => d.field);
      overlayDefined(merged, incoming, fields);
      merged.id = local.id;
      merged.herbId = resolved.herbId;
      merged.methodId = resolved.methodId;
      return { type: 'batch', id: local.id, value: merged };
    }
    return {
      type: 'batch',
      id: String(incoming.id),
      value: { ...incoming, herbId: resolved.herbId, methodId: resolved.methodId },
    };
  }

  // sample
  const batchNo = resolveSampleBatchNo(incoming as unknown as RetainSample, snap, refs);
  if (!batchNo) return { missingRefs: [`所属工序批次不存在（${String(incoming.batchId || '空')}）`] };
  const batchId = refs.batchNoToId.get(batchNo) ?? snap.batches.find((b) => b.batchNo === batchNo)?.id;
  const local = snap.samples.find((s) => s.sampleNo === item.naturalKey);
  if (local) {
    const merged: Record<string, unknown> = { ...local };
    const scalarFields = item.status === 'conflict'
      ? SAMPLE_SCALAR_FIELDS.map((f) => String(f.field))
      : (item.diffs ?? []).map((d) => d.field).filter((f) => f !== 'observeLogs');
    overlayDefined(merged, incoming, scalarFields);
    // 观察记录并集：保留本机全部，追加平板新增；同次内容冲突已在复核环节处理
    const localLogs = (local.observeLogs ?? []) as ObserveLog[];
    const inLogs = (incoming.observeLogs ?? []) as ObserveLog[];
    const seen = new Set(localLogs.map(observeLogKey));
    inLogs.forEach((l) => {
      if (!seen.has(observeLogKey(l))) {
        localLogs.push(l);
        seen.add(observeLogKey(l));
      }
    });
    merged.observeLogs = localLogs.sort((a, b) => a.date.localeCompare(b.date));
    merged.id = local.id;
    merged.batchId = batchId;
    return { type: 'sample', id: local.id, value: merged };
  }
  return { type: 'sample', id: String(incoming.id), value: { ...incoming, batchId } };
}

/* ------------------------------------------------------------------ */
/* 应用一批待写入项（成功项幂等不重复；失败项保留可重试）                   */
/* ------------------------------------------------------------------ */

export type WriteExecutor = (ops: WriteOp[]) => Promise<void>;

export interface ApplyChange {
  itemId: string;
  status: HandoverItemStatus;
  diffs?: FieldDiff[];
  missingRefs?: string[];
  failReason?: string;
  localSnapshot?: Record<string, unknown>;
  appliedAt?: string;
  conflictTitle?: string;
}

/**
 * 对非终态项按当前本机快照重新对账并写入：
 * 药材 → 方法 → 工序 → 留样 顺序解析引用；写入交由 exec 在单事务内完成。
 * 已 applied / skipped / identical / invalid 的项不再处理（成功项不重复）。
 */
export async function applyPending(
  items: HandoverItem[],
  snap: LedgerSnapshot,
  pkg: NormalizedPackage,
  exec: WriteExecutor,
): Promise<ApplyChange[]> {
  const refs = buildRefs(snap, pkg);
  const changes: ApplyChange[] = [];
  const ops: WriteOp[] = [];
  const nowIso = new Date().toISOString();

  const order: HandoverEntityType[] = ['herb', 'method', 'batch', 'sample'];
  const pending = items
    .filter((it) => PENDING_STATUSES.includes(it.status))
    .sort((a, b) => order.indexOf(a.entityType) - order.indexOf(b.entityType));

  for (const item of pending) {
    // 重试前按当前本机台账重新对一次（药材/方法补录后即可解析引用）
    const replanned = classifyItem(snap, pkg, item.entityType, item.naturalKey) ?? {
      entityType: item.entityType,
      naturalKey: item.naturalKey,
      status: item.status,
      incoming: item.incoming,
    };
    const { status } = replanned;

    if (status === 'identical') {
      changes.push({ itemId: item.id, status: 'identical', localSnapshot: replanned.localSnapshot });
      continue;
    }
    if (status === 'conflict' || status === 'locked') {
      changes.push({
        itemId: item.id,
        status,
        diffs: replanned.diffs,
        localSnapshot: replanned.localSnapshot,
        conflictTitle: replanned.conflictTitle,
      });
      continue;
    }
    if (status === 'missing-ref') {
      changes.push({ itemId: item.id, status: 'missing-ref', missingRefs: replanned.missingRefs });
      continue;
    }
    const working: HandoverItem = {
      ...item,
      status,
      diffs: replanned.diffs,
      localSnapshot: replanned.localSnapshot,
    };
    const op = buildWriteOp(working, snap, refs);
    if ('missingRefs' in op) {
      changes.push({ itemId: item.id, status: 'missing-ref', missingRefs: op.missingRefs });
      continue;
    }
    ops.push(op);
    changes.push({ itemId: item.id, status: 'applied', appliedAt: nowIso });
  }

  if (ops.length) {
    try {
      await exec(ops);
    } catch (err) {
      // 整批写入失败：全部回退为 failed 保留，条目与整包都不丢
      const reason = (err as Error)?.message || String(err);
      return changes.map((c) =>
        c.status === 'applied'
          ? { ...c, status: 'failed' as HandoverItemStatus, failReason: reason }
          : c,
      );
    }
  }
  return changes;
}

/* ------------------------------------------------------------------ */
/* 复核裁决                                                             */
/* ------------------------------------------------------------------ */

export interface ReviewResult {
  change: ApplyChange;
  op?: WriteOp;
}

/** 复核一条两版记录。锁定记录采平板版会被拒绝（不能覆盖锁定结果） */
export function resolveReview(
  item: HandoverItem,
  decision: 'incoming' | 'local',
  snap: LedgerSnapshot,
  pkg: NormalizedPackage,
): ReviewResult {
  const refs = buildRefs(snap, pkg);
  if (decision === 'local') {
    return { change: { itemId: item.id, status: 'skipped' } };
  }
  if (item.status === 'locked') {
    return {
      change: {
        itemId: item.id,
        status: 'locked',
        failReason: '本机批次已锁定，导入不得覆盖；如确需改判，请先在工序记录台由质检员解锁',
      },
    };
  }
  const op = buildWriteOp(item, snap, refs);
  if ('missingRefs' in op) {
    return { change: { itemId: item.id, status: 'missing-ref', missingRefs: op.missingRefs } };
  }
  return { change: { itemId: item.id, status: 'applied', appliedAt: new Date().toISOString() }, op };
}

/* ------------------------------------------------------------------ */
/* 包状态与统计                                                          */
/* ------------------------------------------------------------------ */

export function emptyStats(): HandoverPackage['stats'] {
  return {
    total: 0,
    new: 0,
    identical: 0,
    merge: 0,
    conflict: 0,
    locked: 0,
    missingRef: 0,
    invalid: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
  };
}

export function tally(items: HandoverItem[]): HandoverPackage['stats'] {
  const stats = emptyStats();
  stats.total = items.length;
  items.forEach((it) => {
    switch (it.status) {
      case 'new': stats.new += 1; break;
      case 'identical': stats.identical += 1; break;
      case 'merge': stats.merge += 1; break;
      case 'conflict': stats.conflict += 1; break;
      case 'locked': stats.locked += 1; break;
      case 'missing-ref': stats.missingRef += 1; break;
      case 'invalid': stats.invalid += 1; break;
      case 'applied': stats.applied += 1; break;
      case 'skipped': stats.skipped += 1; break;
      case 'failed': stats.failed += 1; break;
    }
  });
  return stats;
}

/** 由条目状态聚合包级状态 */
export function packageStatus(items: HandoverItem[]): HandoverPackageStatus {
  if (!items.length) return 'staged';
  const terminal: HandoverItemStatus[] = ['applied', 'skipped', 'identical', 'invalid'];
  if (items.every((it) => terminal.includes(it.status))) return 'done';
  if (items.some((it) => it.status === 'conflict' || it.status === 'locked')) return 'review';
  if (items.some((it) => it.status === 'applied')) return 'partial';
  return 'staged';
}

export const PACKAGE_STATUS_META: Record<HandoverPackageStatus, { label: string; color: string }> = {
  staged: { label: '已暂存', color: 'blue' },
  partial: { label: '部分写入（可续接）', color: 'cyan' },
  review: { label: '有待复核两版', color: 'orange' },
  done: { label: '已完成', color: 'green' },
  error: { label: '整包异常已留存', color: 'red' },
};
