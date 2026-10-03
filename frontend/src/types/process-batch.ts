import type { FireLevel } from './processing-method';

/** 炮制程度 */
export type ProcessDegree = '不及' | '适中' | '太过';

/** 复核状态：normal=正本；pending=交接差异副本，两版并存待复核 */
export type BatchReviewState = 'normal' | 'pending';

/** 炮制工序记录 */
export interface ProcessBatch {
  id: string;
  /** 生产批号 */
  batchNo: string;
  /** 关联药材 */
  herbId: string;
  /** 采用方法 */
  methodId: string;
  /** 投料量（kg） */
  feedKg: number;
  /** 辅料实际用量（kg） */
  auxUsedKg: number;
  /** 火候 */
  fireLevel: FireLevel;
  /** 实际锅温（℃）——锅温是交接对账关键维度 */
  actualTemp?: number;
  /** 实际炮制时长（min）——时长是交接对账关键维度 */
  durationMin?: number;
  /** 开始时间 ISO */
  startedAt: string;
  /** 结束时间 ISO */
  endedAt: string;
  /** 得率（%） */
  yieldRate: number;
  /** 程度判定 */
  degree: ProcessDegree;
  /** 操作人 */
  operator: string;
  /** 得率与程度提交后锁定，仅质检员可改 */
  locked: boolean;
  /** 锁定时间 */
  lockedAt?: string;
  /** 质检员放行/改判人 */
  qcBy?: string;
  /** 备注（现场观察记录） */
  remark?: string;
  /** 复核状态，默认正本 */
  reviewState?: BatchReviewState;
  /** 待复核副本：对应正本批号记录 id */
  duplicateOf?: string;
  /** 副本来源交接包 id */
  handoffPackageId?: string;
  /** 交接来源（平板/班组） */
  handoffFrom?: string;
  /** 平板原始 id，便于同包续接幂等 */
  handoffRefId?: string;
}

/** 程度判定规则说明 */
export interface DegreeRule {
  degree: ProcessDegree;
  condition: string;
  action: string;
}

export const PROCESS_DEGREES: ProcessDegree[] = ['不及', '适中', '太过'];
