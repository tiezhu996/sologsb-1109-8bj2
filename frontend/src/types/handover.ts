import type { HerbMaterial } from './herb-material';
import type { ProcessingMethod } from './processing-method';
import type { ProcessBatch } from './process-batch';
import type { RetainSample } from './retain-sample';

/** 交接包条目类型 */
export type HandoverEntityType = 'herb' | 'method' | 'batch' | 'sample';

/** 单条对账状态 */
export type HandoverItemStatus =
  /** 新增（本机无此业务键） */
  | 'new'
  /** 完全一致，跳过 */
  | 'identical'
  /** 可自动合并的差异（非锁定字段） */
  | 'merge'
  /** 冲突，两版并存待复核（锅温/时长/程度/留样观察有差异） */
  | 'conflict'
  /** 本机已锁定，禁止覆盖，待复核（只能保留本机版） */
  | 'locked'
  /** 引用的药材/方法尚未补录 */
  | 'missing-ref'
  /** 条目本身缺必填字段或取值非法 */
  | 'invalid'
  /** 已写入台账 */
  | 'applied'
  /** 复核后决定保留本机版 */
  | 'skipped'
  /** 写入时失败，保留待重试 */
  | 'failed';

/** 包级状态 */
export type HandoverPackageStatus =
  /** 已校验暂存，尚未开始写入 */
  | 'staged'
  /** 已部分写入，可续接 */
  | 'partial'
  /** 存在待复核两版 */
  | 'review'
  /** 全部条目已处理（applied/skipped/invalid） */
  | 'done'
  /** 整包校验失败，仅留存原始文件 */
  | 'error';

/** 复核裁决 */
export type ReviewDecision = 'incoming' | 'local';

/** 字段级差异（复核时两版对照） */
export interface FieldDiff {
  field: string;
  label: string;
  local?: unknown;
  incoming: unknown;
}

/** 暂存交接包（整包留存，失败也不删） */
export interface HandoverPackage {
  id: string;
  /** 包文件名或来源说明（如「平板-2026-10-03」） */
  label: string;
  /** 包标记版本：旧版备份可能没有版本/锅温时长字段 */
  schemaVersion: number;
  importedAt: string;
  /** 归一化后的原始 JSON，整包留存用于重试 */
  raw: {
    herbs: unknown[];
    methods: unknown[];
    batches: unknown[];
    samples: unknown[];
  };
  /** 内容校验和，重复导入同一包时提示 */
  checksum: string;
  status: HandoverPackageStatus;
  /** 解析/校验失败原因（status=error 时） */
  error?: string;
  stats: {
    total: number;
    new: number;
    identical: number;
    merge: number;
    conflict: number;
    locked: number;
    missingRef: number;
    invalid: number;
    applied: number;
    skipped: number;
    failed: number;
  };
  lastTriedAt?: string;
}

/** 包内单条对账记录 */
export interface HandoverItem {
  id: string;
  packageId: string;
  entityType: HandoverEntityType;
  status: HandoverItemStatus;
  /** 业务键：药材=批号、方法=方法名、工序=生产批号、留样=留样编号 */
  naturalKey: string;
  /** 归一化后的平板版数据 */
  incoming: Record<string, unknown>;
  /** 暂存时命中的本机版快照（用于两版对照，避免复核时本机数据已变） */
  localSnapshot?: Record<string, unknown>;
  /** 复核时再次比对出的字段差异 */
  diffs?: FieldDiff[];
  /** 缺失引用说明（missing-ref） */
  missingRefs?: string[];
  /** 校验失败原因（invalid） */
  reason?: string;
  /** 写入失败原因（failed） */
  failReason?: string;
  /** 复核决定 */
  reviewDecision?: ReviewDecision;
  reviewedBy?: string;
  reviewedAt?: string;
  appliedAt?: string;
  /** 冲突两版的简短标题 */
  conflictTitle?: string;
}

/** 归一化后的交接包条目 */
export interface NormalizedPackage {
  herbs: HerbMaterial[];
  methods: ProcessingMethod[];
  batches: ProcessBatch[];
  samples: RetainSample[];
  schemaVersion: number;
}
