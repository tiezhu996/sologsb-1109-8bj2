import type { HerbMaterial } from './herb-material';
import type { ProcessingMethod } from './processing-method';
import type { ProcessBatch } from './process-batch';
import type { RetainSample } from './retain-sample';

/** 交接包条目类型：药材 / 炮制方法 / 工序 / 留样 */
export type HandoffKind = 'herb' | 'method' | 'batch' | 'sample';

/**
 * 条目状态机：
 * - invalid   结构校验未过（枚举/关键字段缺失），整包保留，不写入
 * - blocked   缺药材 / 炮制方法 / 关联批次，档案补录后重新对账即可放行
 * - new       本机没有，待写入
 * - identical 与本机完全一致，成功项不重复写入
 * - conflict  同批号/同留样编号但关键维度有差异，两版待复核
 * - applied   已成功写入台账
 * - reviewing 冲突副本已进台账，等待复核
 * - resolved  复核完成（采用交接版 / 保留本机版 / 合并观察）
 */
export type HandoffItemState =
  | 'invalid'
  | 'blocked'
  | 'new'
  | 'identical'
  | 'conflict'
  | 'applied'
  | 'reviewing'
  | 'resolved';

/** 复核裁决方式 */
export type ReviewResolution = 'keep-local' | 'adopt-incoming' | 'merge-logs';

/** 字段级差异 */
export interface FieldDiff {
  field: string;
  label: string;
  local?: unknown;
  incoming?: unknown;
  /** 是否关键维度：锅温 / 时长 / 程度 / 观察 */
  key: boolean;
}

/** 阻塞项缺失的档案（可一键补录） */
export interface MissingRef {
  kind: 'herb' | 'method';
  /** 业务键（药材=名称|批号，方法=名称|辅料|比例|火力|温区|时长） */
  key: string;
  /** 展示名 */
  label: string;
  data: HerbMaterial | ProcessingMethod;
}

export interface HandoffItem {
  kind: HandoffKind;
  /** 包内原始 id（旧包缺 id 时按业务键确定性补全） */
  refId: string;
  /** 业务键：批号 / 留样编号 / 药材键 / 方法键 */
  businessKey: string;
  /** 列表展示名 */
  label: string;
  state: HandoffItemState;
  /** 校验失败原因 / 阻塞原因 */
  errors: string[];
  /** 旧包兼容补全说明 */
  notes: string[];
  /** 字段差异（conflict 时） */
  diffs: FieldDiff[];
  /** 阻塞时缺失的档案 */
  missing: MissingRef[];
  /** 规范化后的完整数据 */
  data: HerbMaterial | ProcessingMethod | ProcessBatch | RetainSample;
  /** 写入本地后的台账 id */
  localId?: string;
  /** 冲突对端的本机正本 id */
  localCounterpartId?: string;
  appliedAt?: string;
  resolution?: ReviewResolution;
  resolvedAt?: string;
  resolvedBy?: string;
}

/** 整包状态：已暂存 / 部分写入 / 全部完成 / 本次写入有失败（整包保留可重试） */
export type HandoffState = 'staged' | 'partial' | 'applied' | 'failed';

export interface HandoffEnvelope {
  app?: string;
  schemaVersion?: number;
  exportedAt?: string;
  packagedAt?: string;
  device?: string;
  source?: string;
  herbs?: unknown[];
  methods?: unknown[];
  batches?: unknown[];
  samples?: unknown[];
}

/** 暂存的交接包（原始整包保留，导入失败/断电后可重试） */
export interface HandoffPackage {
  id: string;
  /** 来源平板 / 班组 */
  device: string;
  /** 交接包生成时间 ISO */
  packageAt: string;
  /** 本机暂存时间 ISO */
  receivedAt: string;
  schemaVersion?: number;
  /** 旧版交接包（缺字段，已做兼容补全） */
  legacy: boolean;
  /** 包级兼容补全说明 */
  completionNotes: string[];
  state: HandoffState;
  lastError?: string;
  items: HandoffItem[];
  appliedAt?: string;
  /** 原始整包 JSON（失败后保留整包、重新导出用） */
  raw: {
    herbs: unknown[];
    methods: unknown[];
    batches: unknown[];
    samples: unknown[];
  };
}

export const HANDOFF_ITEM_STATE_META: Record<HandoffItemState, { label: string; color: string }> = {
  invalid: { label: '校验失败', color: 'red' },
  blocked: { label: '缺档案·阻塞', color: 'orange' },
  new: { label: '待写入', color: 'blue' },
  identical: { label: '本机一致', color: 'default' },
  conflict: { label: '两版待复核', color: 'gold' },
  applied: { label: '已写入', color: 'green' },
  reviewing: { label: '待复核', color: 'gold' },
  resolved: { label: '已复核', color: 'success' },
};

export const HANDOFF_STATE_META: Record<HandoffState, { label: string; color: string }> = {
  staged: { label: '已暂存·待写入', color: 'blue' },
  partial: { label: '部分写入·可续接', color: 'orange' },
  applied: { label: '已全部完成', color: 'green' },
  failed: { label: '写入有失败·整包保留', color: 'red' },
};
