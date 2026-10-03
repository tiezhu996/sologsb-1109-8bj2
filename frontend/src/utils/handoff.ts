import { db } from './db';
import { uid } from './id';
import { HERB_ORIGINS, HERB_PARTS, type HerbMaterial } from '../types/herb-material';
import {
  AUXILIARIES,
  CRITERION_DIMENSIONS,
  FIRE_LEVELS,
  METHOD_NAMES,
  type ProcessingMethod,
} from '../types/processing-method';
import { PROCESS_DEGREES, type ProcessBatch, type ProcessDegree } from '../types/process-batch';
import type { ObserveLog, RetainSample } from '../types/retain-sample';
import {
  type FieldDiff,
  type HandoffEnvelope,
  type HandoffItem,
  type HandoffKind,
  type HandoffPackage,
  type MissingRef,
} from '../types/handoff';

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function isValidDate(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Date.parse(v));
}

function numEqual(a: unknown, b: unknown): boolean {
  const x = asNum(a);
  const y = asNum(b);
  if (x === undefined || y === undefined) return (a ?? '') === (b ?? '');
  return Math.abs(x - y) < 1e-6;
}

function dateOnly(v: unknown): string {
  return isValidDate(v) ? v.slice(0, 10) : String(v ?? '');
}

/** djb2 哈希：旧包缺 id 时按业务键生成确定性 id（同包重试稳定） */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export function herbBusinessKey(name: string, batchNo: string): string {
  return `${name}|${batchNo}`;
}

export function methodBusinessKey(m: {
  name: string;
  auxiliary: string;
  auxRatio: number;
  fireLevel: string;
  tempRange: [number, number];
  duration: number;
}): string {
  return `${m.name}|${m.auxiliary}|${m.auxRatio}|${m.fireLevel}|${m.tempRange[0]}-${m.tempRange[1]}|${m.duration}`;
}

/** 观察记录去重签名：日期 + 色泽/气味/霉变/观察人/备注 */
export function observeLogSignature(log: ObserveLog): string {
  return [log.date, log.color, log.odor, log.mold, log.observer, log.note ?? ''].join('§');
}

function observeSummary(logs: ObserveLog[]): string {
  if (logs.length === 0) return '无观察记录';
  const dates = logs.map((l) => l.date).sort();
  return `${logs.length} 条观察（${dates[0]} 起）`;
}

/* ------------------------------------------------------------------ */
/* 解析 + 兼容补全（旧版交接包缺字段）                                  */
/* ------------------------------------------------------------------ */

/** 解析交接包文本；非 gbherbprocess 包直接拒绝，不进暂存区 */
export function parseHandoffText(text: string): HandoffEnvelope {
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch {
    throw new Error('交接包不是合法 JSON 文件');
  }
  if (!isRecord(env) || env.app !== 'gbherbprocess') {
    throw new Error('交接包格式不匹配（缺少 app=gbherbprocess 标记）');
  }
  return env as HandoffEnvelope;
}

interface NormalizeResult {
  item: HandoffItem;
  legacyField: boolean;
}

function normalizeHerb(raw: unknown, index: number): NormalizeResult {
  const r = isRecord(raw) ? raw : {};
  const errors: string[] = [];
  const notes: string[] = [];
  const name = asStr(r.name);
  const batchNo = asStr(r.batchNo);
  const origin = asStr(r.origin) as HerbMaterial['origin'] | undefined;
  const part = asStr(r.part) as HerbMaterial['part'] | undefined;
  const feedKg = asNum(r.feedKg);

  if (!name) errors.push('缺少药材名 name');
  if (!batchNo) errors.push('缺少药材批号 batchNo');
  if (!origin || !HERB_ORIGINS.includes(origin)) errors.push(`基原非法（应为 ${HERB_ORIGINS.join('/')}）`);
  if (!part || !HERB_PARTS.includes(part)) errors.push(`药用部位非法（应为 ${HERB_PARTS.join('/')}）`);
  if (feedKg === undefined || feedKg < 0) errors.push('投料量 feedKg 非法');

  let receivedAt = asStr(r.receivedAt);
  if (!receivedAt) {
    receivedAt = new Date().toISOString();
    notes.push('旧包缺 receivedAt，已补为暂存时间');
  } else if (!isValidDate(receivedAt)) {
    errors.push('receivedAt 日期无法识别');
  }
  const remark = asStr(r.remark);

  const businessKey = name && batchNo ? herbBusinessKey(name, batchNo) : `herb-invalid-${index}`;
  const refId = asStr(r.id) ?? `herb-${hashStr(businessKey)}`;
  const data: HerbMaterial = {
    id: refId,
    name: name ?? '',
    batchNo: batchNo ?? '',
    origin: origin ?? HERB_ORIGINS[0],
    part: part ?? HERB_PARTS[0],
    feedKg: feedKg ?? 0,
    receivedAt,
    remark,
  };
  return {
    item: {
      kind: 'herb',
      refId,
      businessKey,
      label: name && batchNo ? `${name} · ${batchNo}` : `药材#${index + 1}（字段不全）`,
      state: errors.length ? 'invalid' : 'new',
      errors,
      notes,
      diffs: [],
      missing: [],
      data,
    },
    legacyField: notes.length > 0,
  };
}

function normalizeMethod(raw: unknown, index: number): NormalizeResult {
  const r = isRecord(raw) ? raw : {};
  const errors: string[] = [];
  const notes: string[] = [];
  const name = asStr(r.name) as ProcessingMethod['name'] | undefined;
  const auxiliary = asStr(r.auxiliary) as ProcessingMethod['auxiliary'] | undefined;
  const fireLevel = asStr(r.fireLevel) as ProcessingMethod['fireLevel'] | undefined;
  const criterionDimension = asStr(r.criterionDimension) as ProcessingMethod['criterionDimension'] | undefined;
  const auxRatio = asNum(r.auxRatio);
  const duration = asNum(r.duration);
  const criterion = asStr(r.criterion);
  const applicable = asStr(r.applicable) ?? '';

  if (!name || !METHOD_NAMES.includes(name)) errors.push(`炮制方法名非法（应为 ${METHOD_NAMES.join('/')} 之一）`);
  if (!auxiliary || !AUXILIARIES.includes(auxiliary)) errors.push('辅料 auxiliary 非法');
  if (!fireLevel || !FIRE_LEVELS.includes(fireLevel)) errors.push('火力 fireLevel 非法');
  if (auxRatio === undefined || auxRatio < 0) errors.push('辅料比例 auxRatio 非法');
  if (duration === undefined || duration <= 0) errors.push('炮制时长 duration 非法');
  if (!criterion) errors.push('缺少判断标准 criterion');

  // 温区兼容：旧包可能只给单个 temp 或缺失
  let tempRange: [number, number] | undefined;
  if (Array.isArray(r.tempRange) && r.tempRange.length === 2) {
    const [lo, hi] = [asNum(r.tempRange[0]), asNum(r.tempRange[1])];
    if (lo !== undefined && hi !== undefined && lo >= 0 && hi >= lo) {
      tempRange = [lo, hi];
    }
  }
  const tempSingle = asNum(r.temp);
  if (!tempRange && tempSingle !== undefined) {
    tempRange = [Math.round(tempSingle * 0.9), Math.round(tempSingle * 1.1)];
    notes.push('旧包用单值 temp 表示锅温，已按 ±10% 补全温区 tempRange');
  }
  if (!tempRange) {
    if (fireLevel && FIRE_LEVELS.includes(fireLevel)) {
      const fallback: Record<ProcessingMethod['fireLevel'], [number, number]> = {
        文火: [90, 130],
        中火: [120, 180],
        武火: [180, 300],
      };
      tempRange = fallback[fireLevel];
      notes.push('旧包缺温区，已按火力常用区间补全 tempRange');
    } else {
      errors.push('缺少温度区间 tempRange');
      tempRange = [0, 0];
    }
  }
  const dimension = criterionDimension && CRITERION_DIMENSIONS.includes(criterionDimension) ? criterionDimension : '色泽';
  if (!criterionDimension || !CRITERION_DIMENSIONS.includes(criterionDimension)) {
    notes.push('旧包缺判断维度 criterionDimension，已补为「色泽」');
  }

  const partial = {
    name: name ?? '清炒',
    auxiliary: auxiliary ?? '无',
    auxRatio: auxRatio ?? 0,
    fireLevel: fireLevel ?? '文火',
    tempRange,
    duration: duration ?? 0,
  };
  const businessKey = name ? methodBusinessKey(partial) : `method-invalid-${index}`;
  const refId = asStr(r.id) ?? `method-${hashStr(businessKey)}`;
  const data: ProcessingMethod = {
    id: refId,
    ...partial,
    criterion: criterion ?? '',
    criterionDimension: dimension,
    applicable,
    derivedFrom: asStr(r.derivedFrom),
  };
  return {
    item: {
      kind: 'method',
      refId,
      businessKey,
      label: name ? `${name} · ${partial.auxiliary} ${partial.auxRatio}kg/100kg` : `方法#${index + 1}（字段不全）`,
      state: errors.length ? 'invalid' : 'new',
      errors,
      notes,
      diffs: [],
      missing: [],
      data,
    },
    legacyField: notes.length > 0,
  };
}

function normalizeBatch(raw: unknown, index: number): NormalizeResult {
  const r = isRecord(raw) ? raw : {};
  const errors: string[] = [];
  const notes: string[] = [];
  const batchNo = asStr(r.batchNo);
  const herbId = asStr(r.herbId);
  const methodId = asStr(r.methodId);
  const fireLevel = asStr(r.fireLevel) as ProcessBatch['fireLevel'] | undefined;
  const degree = asStr(r.degree) as ProcessDegree | undefined;
  const feedKg = asNum(r.feedKg);
  const auxUsedKg = asNum(r.auxUsedKg) ?? 0;
  const yieldRate = asNum(r.yieldRate);
  const operator = asStr(r.operator);
  const startedAt = asStr(r.startedAt);
  const endedAt = asStr(r.endedAt);
  const actualTemp = asNum(r.actualTemp);
  const durationMin = asNum(r.durationMin);

  if (!batchNo) errors.push('缺少生产批号 batchNo');
  if (!herbId) errors.push('缺少关联药材 herbId');
  if (!methodId) errors.push('缺少炮制方法 methodId');
  if (!fireLevel || !FIRE_LEVELS.includes(fireLevel)) errors.push('火力 fireLevel 非法');
  if (feedKg === undefined || feedKg <= 0) errors.push('投料量 feedKg 必须大于 0');
  if (auxUsedKg < 0) errors.push('辅料用量 auxUsedKg 非法');
  if (yieldRate === undefined || yieldRate <= 0 || yieldRate > 200) errors.push('得率 yieldRate 非法（0~200）');
  if (!degree || !PROCESS_DEGREES.includes(degree)) errors.push('程度判定 degree 非法（不及/适中/太过）');
  if (!operator) errors.push('缺少操作人 operator');
  if (!startedAt || !isValidDate(startedAt)) errors.push('开始时间 startedAt 非法');
  if (!endedAt || !isValidDate(endedAt)) errors.push('结束时间 endedAt 非法');

  // 旧包缺锅温/时长：先记账，对账阶段能匹配到本机方法时再用标准值兼容补全
  if (actualTemp === undefined) notes.push('旧包缺实际锅温 actualTemp');
  if (durationMin === undefined) notes.push('旧包缺实际时长 durationMin');

  let locked = false;
  if (typeof r.locked === 'boolean') {
    locked = r.locked;
  } else {
    notes.push('旧包缺 locked 标记，已补为未锁定');
  }

  const refId = asStr(r.id) ?? (batchNo ? `batch-${hashStr(batchNo)}` : `batch-invalid-${index}`);
  const data: ProcessBatch = {
    id: refId,
    batchNo: batchNo ?? '',
    herbId: herbId ?? '',
    methodId: methodId ?? '',
    feedKg: feedKg ?? 0,
    auxUsedKg,
    fireLevel: fireLevel ?? '文火',
    actualTemp,
    durationMin,
    startedAt: startedAt ?? '',
    endedAt: endedAt ?? '',
    yieldRate: yieldRate ?? 0,
    degree: degree ?? '适中',
    operator: operator ?? '',
    locked,
    lockedAt: isValidDate(r.lockedAt) ? r.lockedAt : undefined,
    qcBy: asStr(r.qcBy),
    remark: asStr(r.remark),
  };
  return {
    item: {
      kind: 'batch',
      refId,
      businessKey: batchNo ?? '',
      label: batchNo ?? `工序#${index + 1}（字段不全）`,
      state: errors.length ? 'invalid' : 'new',
      errors,
      notes,
      diffs: [],
      missing: [],
      data,
    },
    legacyField: notes.length > 0,
  };
}

function normalizeSample(raw: unknown, index: number): NormalizeResult {
  const r = isRecord(raw) ? raw : {};
  const errors: string[] = [];
  const notes: string[] = [];
  const sampleNo = asStr(r.sampleNo);
  const batchId = asStr(r.batchId);
  const cabinet = asStr(r.cabinet);
  const retainedAt = asStr(r.retainedAt);
  const amountG = asNum(r.amountG);

  if (!sampleNo) errors.push('缺少留样编号 sampleNo');
  if (!batchId) errors.push('缺少关联批次 batchId');
  if (!cabinet) errors.push('缺少柜位 cabinet');
  if (amountG === undefined || amountG < 0) errors.push('留样量 amountG 非法');
  if (!retainedAt || !isValidDate(retainedAt)) errors.push('留样日期 retainedAt 非法');

  let retainMonths = asNum(r.retainMonths);
  if (retainMonths === undefined) {
    retainMonths = 6;
    notes.push('旧包缺留样期 retainMonths，已补为 6 个月');
  }

  // 观察记录兼容：缺 observeLogs 视为空；字段不全的条目忽略并记账，不阻塞整包
  let logs: ObserveLog[] = [];
  if (r.observeLogs === undefined) {
    notes.push('旧包缺观察记录 observeLogs，已补为空台账');
  } else if (!Array.isArray(r.observeLogs)) {
    errors.push('观察记录 observeLogs 必须是数组');
  } else {
    let dropped = 0;
    logs = r.observeLogs.flatMap((entry) => {
      const e = isRecord(entry) ? entry : {};
      const date = asStr(e.date);
      const color = asStr(e.color);
      const odor = asStr(e.odor);
      const mold = asStr(e.mold);
      const observer = asStr(e.observer);
      if (!date || !isValidDate(date) || !color || !odor || !mold || !observer) {
        dropped += 1;
        return [];
      }
      return [
        {
          id: asStr(e.id) ?? `log-${hashStr(`${date}|${color}|${odor}|${mold}|${observer}`)}`,
          date: date.slice(0, 10),
          color,
          odor,
          mold,
          observer,
          note: asStr(e.note),
        } satisfies ObserveLog,
      ];
    });
    if (dropped > 0) notes.push(`已忽略 ${dropped} 条字段不全的观察记录`);
  }

  const refId = asStr(r.id) ?? (sampleNo ? `sample-${hashStr(sampleNo)}` : `sample-invalid-${index}`);
  const data: RetainSample = {
    id: refId,
    sampleNo: sampleNo ?? '',
    batchId: batchId ?? '',
    amountG: amountG ?? 0,
    retainMonths,
    cabinet: cabinet ?? '',
    retainedAt: retainedAt ?? '',
    observeLogs: logs,
  };
  return {
    item: {
      kind: 'sample',
      refId,
      businessKey: sampleNo ?? '',
      label: sampleNo ?? `留样#${index + 1}（字段不全）`,
      state: errors.length ? 'invalid' : 'new',
      errors,
      notes,
      diffs: [],
      missing: [],
      data,
    },
    legacyField: notes.length > 0,
  };
}

/**
 * 第一步：校验并暂存。
 * 解析交接包 → 逐项规范化 / 旧包兼容补全 → 结构校验（invalid 不写台账）。
 * 业务对账（批号/留样编号比对）在 reconcilePackage 中进行，可反复重跑。
 */
export async function stageHandoff(text: string): Promise<HandoffPackage> {
  const env = parseHandoffText(text);
  const receivedAt = new Date().toISOString();
  let legacyField = false;
  const items: HandoffItem[] = [];

  const collect = (list: unknown[] | undefined, kind: HandoffKind, fn: (raw: unknown, i: number) => NormalizeResult) => {
    (list ?? []).forEach((raw, i) => {
      const result = fn(raw, i);
      legacyField = legacyField || result.legacyField;
      items.push(result.item);
    });
  };
  collect(env.herbs, 'herb', normalizeHerb);
  collect(env.methods, 'method', normalizeMethod);
  collect(env.batches, 'batch', normalizeBatch);
  collect(env.samples, 'sample', normalizeSample);

  if (items.length === 0) {
    throw new Error('交接包内没有任何药材/方法/工序/留样条目');
  }

  const schemaVersion = typeof env.schemaVersion === 'number' ? env.schemaVersion : undefined;
  const legacy = schemaVersion === undefined || schemaVersion < 2 || legacyField;
  const completionNotes = Array.from(
    new Set(items.flatMap((i) => i.notes).concat(legacy && schemaVersion === undefined ? ['旧版交接包无 schemaVersion，已按最新字段结构兼容补全'] : [])),
  );

  const pkg: HandoffPackage = {
    id: uid('handoff'),
    device: asStr(env.device) ?? asStr(env.source) ?? '平板交接',
    packageAt: asStr(env.packagedAt) ?? (isValidDate(env.exportedAt) ? env.exportedAt : receivedAt),
    receivedAt,
    schemaVersion,
    legacy,
    completionNotes,
    state: 'staged',
    items,
    raw: {
      herbs: Array.isArray(env.herbs) ? env.herbs : [],
      methods: Array.isArray(env.methods) ? env.methods : [],
      batches: Array.isArray(env.batches) ? env.batches : [],
      samples: Array.isArray(env.samples) ? env.samples : [],
    },
  };

  const reconciled = reconcilePackage(pkg, await buildContext(pkg));
  await db.handoffs.put(reconciled);
  return reconciled;
}

/* ------------------------------------------------------------------ */
/* 第二步：业务对账（按生产批号 / 留样编号 / 业务键，可反复重跑）        */
/* ------------------------------------------------------------------ */

interface RefContext {
  herbs: HerbMaterial[];
  methods: ProcessingMethod[];
  batches: ProcessBatch[];
  samples: RetainSample[];
  herbByKey: Map<string, HerbMaterial>;
  herbById: Map<string, HerbMaterial>;
  methodByKey: Map<string, ProcessingMethod>;
  methodById: Map<string, ProcessingMethod>;
  canonicalBatchByNo: Map<string, ProcessBatch>;
  canonicalSampleByNo: Map<string, RetainSample>;
  pkgItemByRef: Map<string, HandoffItem>;
}

async function buildContext(pkg: HandoffPackage): Promise<RefContext> {
  const [herbs, methods, batches, samples] = await Promise.all([
    db.herbs.toArray(),
    db.methods.toArray(),
    db.batches.toArray(),
    db.samples.toArray(),
  ]);
  const canonicalBatches = batches.filter((b) => b.reviewState !== 'pending');
  const canonicalSamples = samples.filter((s) => s.reviewState !== 'pending');
  return {
    herbs,
    methods,
    batches,
    samples,
    herbByKey: new Map(herbs.map((h) => [herbBusinessKey(h.name, h.batchNo), h])),
    herbById: new Map(herbs.map((h) => [h.id, h])),
    methodByKey: new Map(methods.map((m) => [methodBusinessKey(m), m])),
    methodById: new Map(methods.map((m) => [m.id, m])),
    canonicalBatchByNo: new Map(canonicalBatches.map((b) => [b.batchNo, b])),
    canonicalSampleByNo: new Map(canonicalSamples.map((s) => [s.sampleNo, s])),
    pkgItemByRef: new Map(pkg.items.map((i) => [i.refId, i])),
  };
}

/** 解析包内药材引用 → 本机药材 id（先直连 id，再按业务键） */
function resolveHerbId(ctx: RefContext, refId: string): { herb?: HerbMaterial; pkgItem?: HandoffItem } {
  if (ctx.herbById.has(refId)) return { herb: ctx.herbById.get(refId) };
  const pkgItem = ctx.pkgItemByRef.get(refId);
  if (pkgItem?.kind === 'herb') {
    return { herb: ctx.herbByKey.get(pkgItem.businessKey), pkgItem };
  }
  return {};
}

function resolveMethodId(ctx: RefContext, refId: string): { method?: ProcessingMethod; pkgItem?: HandoffItem } {
  if (ctx.methodById.has(refId)) return { method: ctx.methodById.get(refId) };
  const pkgItem = ctx.pkgItemByRef.get(refId);
  if (pkgItem?.kind === 'method') {
    return { method: ctx.methodByKey.get(pkgItem.businessKey), pkgItem };
  }
  return {};
}

/** 解析包内批次引用 → 本机批次 id（同批号正本 / 已写入副本映射 / 直连 id） */
function resolveBatchId(ctx: RefContext, refId: string): { batch?: ProcessBatch; pkgItem?: HandoffItem } {
  const direct = ctx.batches.find((b) => b.id === refId && b.reviewState !== 'pending');
  if (direct) return { batch: direct };
  const mapped = ctx.batches.find((b) => b.handoffRefId === refId && b.reviewState !== 'pending');
  if (mapped) return { batch: mapped };
  const pkgItem = ctx.pkgItemByRef.get(refId);
  if (pkgItem?.kind === 'batch') {
    return { batch: ctx.canonicalBatchByNo.get(pkgItem.businessKey), pkgItem };
  }
  return {};
}

function missingOf(pkgItem: HandoffItem | undefined, kind: 'herb' | 'method'): MissingRef[] {
  if (!pkgItem || pkgItem.state === 'invalid') return [];
  return [
    {
      kind,
      key: pkgItem.businessKey,
      label: pkgItem.label,
      data: pkgItem.data as MissingRef['data'],
    },
  ];
}

function diffRow(field: string, label: string, local: unknown, incoming: unknown, key: boolean): FieldDiff {
  return { field, label, local, incoming, key };
}

/** 同批号工序比对：锅温 / 时长 / 程度 / 现场观察 为关键维度，任一不同即两版待复核 */
function diffBatch(local: ProcessBatch, incoming: ProcessBatch): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (!numEqual(local.actualTemp, incoming.actualTemp)) {
    diffs.push(diffRow('actualTemp', '实际锅温(℃)', local.actualTemp ?? '未记录', incoming.actualTemp ?? '未记录', true));
  }
  if (!numEqual(local.durationMin, incoming.durationMin)) {
    diffs.push(diffRow('durationMin', '实际时长(min)', local.durationMin ?? '未记录', incoming.durationMin ?? '未记录', true));
  }
  if (local.degree !== incoming.degree) {
    diffs.push(diffRow('degree', '炮制程度', local.degree, incoming.degree, true));
  }
  if ((local.remark ?? '') !== (incoming.remark ?? '')) {
    diffs.push(diffRow('remark', '现场观察/备注', local.remark ?? '无', incoming.remark ?? '无', true));
  }
  if (local.fireLevel !== incoming.fireLevel) {
    diffs.push(diffRow('fireLevel', '火力', local.fireLevel, incoming.fireLevel, false));
  }
  if (!numEqual(local.feedKg, incoming.feedKg)) diffs.push(diffRow('feedKg', '投料量(kg)', local.feedKg, incoming.feedKg, false));
  if (!numEqual(local.auxUsedKg, incoming.auxUsedKg)) diffs.push(diffRow('auxUsedKg', '辅料用量(kg)', local.auxUsedKg, incoming.auxUsedKg, false));
  if (!numEqual(local.yieldRate, incoming.yieldRate)) diffs.push(diffRow('yieldRate', '得率(%)', local.yieldRate, incoming.yieldRate, false));
  if (local.operator !== incoming.operator) diffs.push(diffRow('operator', '操作人', local.operator, incoming.operator, false));
  if (dateOnly(local.startedAt) !== dateOnly(incoming.startedAt)) diffs.push(diffRow('startedAt', '开始日期', dateOnly(local.startedAt), dateOnly(incoming.startedAt), false));
  if (dateOnly(local.endedAt) !== dateOnly(incoming.endedAt)) diffs.push(diffRow('endedAt', '结束日期', dateOnly(local.endedAt), dateOnly(incoming.endedAt), false));
  return diffs;
}

function diffSample(ctx: RefContext, local: RetainSample, incoming: RetainSample): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const localSig = local.observeLogs.map(observeLogSignature).sort().join('|');
  const incomingSig = incoming.observeLogs.map(observeLogSignature).sort().join('|');
  if (localSig !== incomingSig) {
    diffs.push(diffRow('observeLogs', '观察记录', observeSummary(local.observeLogs), observeSummary(incoming.observeLogs), true));
  }
  if (!numEqual(local.amountG, incoming.amountG)) diffs.push(diffRow('amountG', '留样量(g)', local.amountG, incoming.amountG, false));
  if (!numEqual(local.retainMonths, incoming.retainMonths)) diffs.push(diffRow('retainMonths', '留样期(月)', local.retainMonths, incoming.retainMonths, false));
  if (local.cabinet !== incoming.cabinet) diffs.push(diffRow('cabinet', '柜位', local.cabinet, incoming.cabinet, false));
  if (dateOnly(local.retainedAt) !== dateOnly(incoming.retainedAt)) diffs.push(diffRow('retainedAt', '留样日期', dateOnly(local.retainedAt), dateOnly(incoming.retainedAt), false));

  const localBatch = ctx.batches.find((b) => b.id === local.batchId && b.reviewState !== 'pending');
  const incomingBatch = resolveBatchId(ctx, incoming.batchId).batch;
  if (localBatch && incomingBatch && localBatch.batchNo !== incomingBatch.batchNo) {
    diffs.push(diffRow('batchNo', '关联批号', localBatch.batchNo, incomingBatch.batchNo, false));
  }
  return diffs;
}

const DONE_STATES = new Set(['applied', 'reviewing', 'resolved', 'identical']);

function recomputePackageState(pkg: HandoffPackage, lastError?: string): HandoffPackage['state'] {
  if (lastError) return 'failed';
  const items = pkg.items;
  const hasDone = items.some((i) => DONE_STATES.has(i.state));
  const hasPending = items.some((i) => !DONE_STATES.has(i.state));
  if (hasDone && hasPending) return 'partial';
  if (hasDone) return 'applied';
  return 'staged';
}

/**
 * 业务对账（幂等，可反复重跑）：
 * 已写入/复核中的条目冻结不动（成功项不重复）；其余条目按当前台账重新判定。
 */
export function reconcilePackage(input: HandoffPackage, ctx: RefContext): HandoffPackage {
  const pkg: HandoffPackage = { ...input, items: input.items.map((i) => ({ ...i, errors: [...i.errors], notes: [...i.notes], diffs: [], missing: [] })) };

  for (const item of pkg.items) {
    if (DONE_STATES.has(item.state)) continue;
    if (item.state === 'invalid') continue;

    if (item.kind === 'herb') {
      const local = ctx.herbByKey.get(item.businessKey);
      item.state = local ? 'identical' : 'new';
      item.localId = local?.id;
      continue;
    }

    if (item.kind === 'method') {
      const local = ctx.methodByKey.get(item.businessKey);
      item.state = local ? 'identical' : 'new';
      item.localId = local?.id;
      continue;
    }

    if (item.kind === 'batch') {
      const data = item.data as ProcessBatch;
      const { herb, pkgItem: herbPkg } = resolveHerbId(ctx, data.herbId);
      const { method, pkgItem: methodPkg } = resolveMethodId(ctx, data.methodId);
      item.missing = [];
      const blockErrors: string[] = [];
      if (!herb) {
        item.missing.push(...missingOf(herbPkg, 'herb'));
        blockErrors.push(herbPkg ? `缺药材档案：${herbPkg.label}，补录后重试` : `关联药材 ${data.herbId} 不在交接包内，请在药材台账补录后重试`);
      }
      if (!method) {
        item.missing.push(...missingOf(methodPkg, 'method'));
        blockErrors.push(methodPkg ? `缺炮制方法：${methodPkg.label}，补录后重试` : `炮制方法 ${data.methodId} 不在交接包内，请在方法台账补录后重试`);
      }
      if (!herb || !method) {
        item.state = 'blocked';
        item.errors = blockErrors;
        item.diffs = [];
        continue;
      }
      item.errors = [];

      // 旧包兼容补全：锅温/时长缺失时取该机方法标准值，避免旧包误判为差异
      const fillNotes: string[] = [];
      if (data.actualTemp === undefined) {
        data.actualTemp = Math.round((method.tempRange[0] + method.tempRange[1]) / 2);
        fillNotes.push(`actualTemp 已按「${method.name}」温区中值补为 ${data.actualTemp}℃`);
      }
      if (data.durationMin === undefined) {
        data.durationMin = method.duration;
        fillNotes.push(`durationMin 已按「${method.name}」标准时长补为 ${data.durationMin}min`);
      }
      item.notes = Array.from(new Set([...item.notes.filter((n) => !n.startsWith('旧包缺 actualTemp') && !n.startsWith('旧包缺 durationMin')), ...fillNotes]));

      const local = ctx.canonicalBatchByNo.get(data.batchNo);
      if (!local) {
        item.state = 'new';
        item.localCounterpartId = undefined;
        continue;
      }
      item.localCounterpartId = local.id;
      item.localId = local.id;
      const diffs = diffBatch(local, data);
      if (diffs.length === 0) {
        item.state = 'identical';
      } else {
        item.state = 'conflict';
        item.diffs = diffs;
      }
      continue;
    }

    if (item.kind === 'sample') {
      const data = item.data as RetainSample;
      const { batch, pkgItem: batchPkg } = resolveBatchId(ctx, data.batchId);
      if (!batch) {
        item.state = 'blocked';
        item.errors = [
          batchPkg
            ? `所属工序 ${batchPkg.label} 尚未写入，执行写入后自动续接`
            : `关联批次 ${data.batchId} 既不在交接包内也不在本机台账，请补录工序后重试`,
        ];
        item.diffs = [];
        continue;
      }
      item.errors = [];
      data.batchId = batch.id;

      const local = ctx.canonicalSampleByNo.get(data.sampleNo);
      if (!local) {
        item.state = 'new';
        item.localCounterpartId = undefined;
        continue;
      }
      item.localCounterpartId = local.id;
      item.localId = local.id;
      const diffs = diffSample(ctx, local, data);
      if (diffs.length === 0) {
        item.state = 'identical';
      } else {
        item.state = 'conflict';
        item.diffs = diffs;
      }
    }
  }

  return { ...pkg, state: recomputePackageState(pkg), lastError: undefined };
}

/* ------------------------------------------------------------------ */
/* 第三步：分阶段写入（药材→方法→工序→留样；失败整包保留，可续接）      */
/* ------------------------------------------------------------------ */

const KIND_ORDER: Record<HandoffKind, number> = { herb: 0, method: 1, batch: 2, sample: 3 };

async function safeId(table: { get: (id: string) => Promise<unknown> }, id: string): Promise<string> {
  const collided = await table.get(id);
  return collided ? uid(id.split('-')[0] ?? 'row') : id;
}

/** 执行写入：多轮收敛（先写药材方法，再放行阻塞的工序留样）。成功项冻结不重复。 */
export async function applyPackage(pkgId: string): Promise<HandoffPackage> {
  const persisted = await db.handoffs.get(pkgId);
  if (!persisted) throw new Error('暂存交接包不存在或已删除');

  let pkg = reconcilePackage(persisted, await buildContext(persisted));
  const failures: string[] = [];

  for (let round = 0; round < 4; round += 1) {
    const actionable = pkg.items
      .filter((i) => i.state === 'new' || i.state === 'conflict')
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    if (actionable.length === 0) break;

    let progressed = false;
    for (const item of actionable) {
      try {
        const ctx = await buildContext(pkg);
        await writeItem(pkg, item, ctx);
        progressed = true;
      } catch (error) {
        failures.push(`${item.label}：${(error as Error).message}`);
      }
    }

    pkg = reconcilePackage(pkg, await buildContext(pkg));
    if (!progressed) break;
  }

  const lastError = failures.length ? `${failures.length} 项写入失败，整包保留可重试：${failures.slice(0, 3).join('；')}` : undefined;
  const next: HandoffPackage = {
    ...pkg,
    state: recomputePackageState(pkg, lastError),
    lastError,
    appliedAt: pkg.appliedAt ?? new Date().toISOString(),
  };
  await db.handoffs.put(next);
  return next;
}

async function writeItem(pkg: HandoffPackage, item: HandoffItem, ctx: RefContext): Promise<void> {
  if (item.kind === 'herb' && item.state === 'new') {
    const data = { ...(item.data as HerbMaterial), id: await safeId(db.herbs, item.refId) };
    await db.herbs.put(data);
    item.state = 'applied';
    item.localId = data.id;
    item.appliedAt = new Date().toISOString();
    return;
  }

  if (item.kind === 'method' && item.state === 'new') {
    const data = { ...(item.data as ProcessingMethod), id: await safeId(db.methods, item.refId) };
    await db.methods.put(data);
    item.state = 'applied';
    item.localId = data.id;
    item.appliedAt = new Date().toISOString();
    return;
  }

  if (item.kind === 'batch') {
    const data = item.data as ProcessBatch;
    if (item.state === 'new') {
      const { herb } = resolveHerbId(ctx, data.herbId);
      const { method } = resolveMethodId(ctx, data.methodId);
      if (!herb || !method) throw new Error('药材或炮制方法尚未补录');
      const record: ProcessBatch = {
        ...data,
        id: await safeId(db.batches, item.refId),
        herbId: herb.id,
        methodId: method.id,
        reviewState: 'normal',
        handoffPackageId: pkg.id,
        handoffFrom: pkg.device,
        handoffRefId: item.refId,
      };
      await db.batches.put(record);
      item.state = 'applied';
      item.localId = record.id;
      item.appliedAt = new Date().toISOString();
      return;
    }
    if (item.state === 'conflict') {
      // 差异：正本一行不动，另存待复核副本；锁定结果绝不覆盖
      const canonical = item.localCounterpartId ? await db.batches.get(item.localCounterpartId) : undefined;
      if (!canonical) throw new Error('本机同批号正本已不存在');
      const { herb } = resolveHerbId(ctx, data.herbId);
      const { method } = resolveMethodId(ctx, data.methodId);
      if (!herb || !method) throw new Error('药材或炮制方法尚未补录');
      const duplicate: ProcessBatch = {
        ...data,
        id: uid('batch'),
        herbId: herb.id,
        methodId: method.id,
        batchNo: canonical.batchNo,
        reviewState: 'pending',
        duplicateOf: canonical.id,
        handoffPackageId: pkg.id,
        handoffFrom: pkg.device,
        handoffRefId: item.refId,
        locked: false,
        lockedAt: undefined,
      };
      await db.batches.put(duplicate);
      item.state = 'reviewing';
      item.localId = duplicate.id;
      item.appliedAt = new Date().toISOString();
    }
    return;
  }

  if (item.kind === 'sample') {
    const data = item.data as RetainSample;
    if (item.state === 'new') {
      const { batch } = resolveBatchId(ctx, data.batchId);
      if (!batch) throw new Error('关联工序尚未写入');
      const record: RetainSample = {
        ...data,
        id: await safeId(db.samples, item.refId),
        batchId: batch.id,
        reviewState: 'normal',
        handoffPackageId: pkg.id,
        handoffFrom: pkg.device,
        handoffRefId: item.refId,
      };
      await db.samples.put(record);
      item.state = 'applied';
      item.localId = record.id;
      item.appliedAt = new Date().toISOString();
      return;
    }
    if (item.state === 'conflict') {
      const canonical = item.localCounterpartId ? await db.samples.get(item.localCounterpartId) : undefined;
      if (!canonical) throw new Error('本机同留样编号正本已不存在');
      const { batch } = resolveBatchId(ctx, data.batchId);
      if (!batch) throw new Error('关联工序尚未写入');
      const duplicate: RetainSample = {
        ...data,
        id: uid('sample'),
        batchId: batch.id,
        sampleNo: canonical.sampleNo,
        reviewState: 'pending',
        duplicateOf: canonical.id,
        handoffPackageId: pkg.id,
        handoffFrom: pkg.device,
        handoffRefId: item.refId,
      };
      await db.samples.put(duplicate);
      item.state = 'reviewing';
      item.localId = duplicate.id;
      item.appliedAt = new Date().toISOString();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 第四步：复核裁决（同步工序状态 / 留样台账）、补录、删包              */
/* ------------------------------------------------------------------ */

export interface ReviewAction {
  resolution: 'keep-local' | 'adopt-incoming' | 'merge-logs';
  /** 采用交接版覆盖锁定批次时必填质检员 */
  qcBy?: string;
}

/** 复核一条冲突：保留本机版 / 采用交接版 / 合并观察记录。落账后同步包状态。 */
export async function resolveReview(pkgId: string, itemRefId: string, action: ReviewAction): Promise<HandoffPackage> {
  const pkg = await db.handoffs.get(pkgId);
  if (!pkg) throw new Error('暂存交接包不存在或已删除');
  const item = pkg.items.find((i) => i.refId === itemRefId && i.state === 'reviewing');
  if (!item) throw new Error('该条目不在待复核状态');

  const resolvedAt = new Date().toISOString();

  if (item.kind === 'batch') {
    const dup = item.localId ? await db.batches.get(item.localId) : undefined;
    const canonicalId = item.localCounterpartId ?? dup?.duplicateOf;
    const canonical = canonicalId ? await db.batches.get(canonicalId) : undefined;
    if (!dup || !canonical) throw new Error('待复核两版数据不完整');

    if (action.resolution === 'keep-local') {
      await db.batches.delete(dup.id);
    } else {
      // adopt-incoming：同步锅温/时长/程度/观察与工序锁定状态；锁定行必须质检员裁决
      const qcBy = action.qcBy?.trim();
      if (canonical.locked && !qcBy) {
        throw new Error('本机批号已锁定，采用交接版需质检员签名');
      }
      const locked = canonical.locked || dup.locked;
      const merged: ProcessBatch = {
        ...canonical,
        feedKg: dup.feedKg,
        auxUsedKg: dup.auxUsedKg,
        fireLevel: dup.fireLevel,
        actualTemp: dup.actualTemp,
        durationMin: dup.durationMin,
        startedAt: dup.startedAt,
        endedAt: dup.endedAt,
        yieldRate: dup.yieldRate,
        degree: dup.degree,
        operator: dup.operator,
        remark: dup.remark,
        locked,
        lockedAt: locked ? canonical.lockedAt ?? dup.lockedAt ?? resolvedAt : undefined,
        qcBy: canonical.locked ? qcBy : dup.qcBy ?? canonical.qcBy,
      };
      await db.batches.put(merged);
      await db.batches.delete(dup.id);
    }
  } else if (item.kind === 'sample') {
    const dup = item.localId ? await db.samples.get(item.localId) : undefined;
    const canonicalId = item.localCounterpartId ?? dup?.duplicateOf;
    const canonical = canonicalId ? await db.samples.get(canonicalId) : undefined;
    if (!dup || !canonical) throw new Error('待复核两版数据不完整');

    if (action.resolution === 'keep-local') {
      await db.samples.delete(dup.id);
    } else if (action.resolution === 'adopt-incoming') {
      await db.samples.put({
        ...canonical,
        amountG: dup.amountG,
        retainMonths: dup.retainMonths,
        cabinet: dup.cabinet,
        retainedAt: dup.retainedAt,
        observeLogs: dup.observeLogs,
      });
      await db.samples.delete(dup.id);
    } else {
      // merge-logs：按观察签名并集，按日期排序追加
      const seen = new Set(canonical.observeLogs.map(observeLogSignature));
      const mergedLogs = [...canonical.observeLogs];
      dup.observeLogs.forEach((log) => {
        const sig = observeLogSignature(log);
        if (!seen.has(sig)) {
          seen.add(sig);
          mergedLogs.push(log);
        }
      });
      mergedLogs.sort((a, b) => a.date.localeCompare(b.date));
      await db.samples.put({ ...canonical, observeLogs: mergedLogs });
      await db.samples.delete(dup.id);
    }
  } else {
    throw new Error('仅工序与留样条目需要复核');
  }

  item.state = 'resolved';
  item.resolution = action.resolution;
  item.resolvedAt = resolvedAt;
  item.resolvedBy = action.qcBy?.trim() || undefined;

  const next: HandoffPackage = { ...pkg, state: recomputePackageState(pkg), lastError: undefined };
  await db.handoffs.put(next);
  return next;
}

/** 药材 / 炮制方法补录：把包内新档案一键登记进台账，随后重跑对账放通阻塞项 */
export async function supplementMasterData(pkgId: string): Promise<{ herbs: number; methods: number; pkg: HandoffPackage }> {
  const persisted = await db.handoffs.get(pkgId);
  if (!persisted) throw new Error('暂存交接包不存在或已删除');

  let herbs = 0;
  let methods = 0;
  for (const item of persisted.items) {
    if (item.state !== 'new') continue;
    if (item.kind === 'herb') {
      const data = { ...(item.data as HerbMaterial), id: await safeId(db.herbs, item.refId) };
      await db.herbs.put(data);
      item.state = 'applied';
      item.localId = data.id;
      item.appliedAt = new Date().toISOString();
      herbs += 1;
    } else if (item.kind === 'method') {
      const data = { ...(item.data as ProcessingMethod), id: await safeId(db.methods, item.refId) };
      await db.methods.put(data);
      item.state = 'applied';
      item.localId = data.id;
      item.appliedAt = new Date().toISOString();
      methods += 1;
    }
  }

  const next = reconcilePackage(persisted, await buildContext(persisted));
  await db.handoffs.put(next);
  return { herbs, methods, pkg: next };
}

/** 删除交接包：仅清理尚未裁决的待复核副本，正本台账不动 */
export async function removeHandoffPackage(pkgId: string): Promise<void> {
  const [pendingBatches, pendingSamples] = await Promise.all([
    db.batches.where('handoffPackageId').equals(pkgId).toArray(),
    db.samples.where('handoffPackageId').equals(pkgId).toArray(),
  ]);
  await Promise.all([
    ...pendingBatches.filter((b) => b.reviewState === 'pending').map((b) => db.batches.delete(b.id)),
    ...pendingSamples.filter((s) => s.reviewState === 'pending').map((s) => db.samples.delete(s.id)),
    db.handoffs.delete(pkgId),
  ]);
}

/** 重新导出整包（失败保留整包后，可交回平板核对） */
export function serializeHandoff(pkg: HandoffPackage): string {
  return JSON.stringify(
    {
      app: 'gbherbprocess',
      schemaVersion: pkg.schemaVersion ?? 1,
      packagedAt: pkg.packageAt,
      device: pkg.device,
      herbs: pkg.raw.herbs,
      methods: pkg.raw.methods,
      batches: pkg.raw.batches,
      samples: pkg.raw.samples,
    },
    null,
    2,
  );
}
