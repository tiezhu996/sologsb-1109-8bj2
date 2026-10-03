/** 单次留样观察记录 */
export interface ObserveLog {
  id: string;
  /** 观察日期 YYYY-MM-DD */
  date: string;
  /** 色泽 */
  color: string;
  /** 气味 */
  odor: string;
  /** 霉变情况 */
  mold: string;
  /** 观察人 */
  observer: string;
  /** 备注 */
  note?: string;
}

/** 复核状态：normal=正本；pending=交接差异副本，两版并存待复核 */
export type SampleReviewState = 'normal' | 'pending';

/** 留样 */
export interface RetainSample {
  id: string;
  /** 留样编号 */
  sampleNo: string;
  /** 关联炮制批次 */
  batchId: string;
  /** 留样量（g） */
  amountG: number;
  /** 留样期（月） */
  retainMonths: number;
  /** 柜位 */
  cabinet: string;
  /** 留样日期 ISO */
  retainedAt: string;
  /** 观察记录，按日期追加 */
  observeLogs: ObserveLog[];
  /** 复核状态，默认正本 */
  reviewState?: SampleReviewState;
  /** 待复核副本：对应正本留样 id */
  duplicateOf?: string;
  /** 副本来源交接包 id */
  handoffPackageId?: string;
  /** 交接来源（平板/班组） */
  handoffFrom?: string;
  /** 平板原始 id，便于同包续接幂等 */
  handoffRefId?: string;
}

/** 留样柜位（A/B/C 三柜，每柜 12 位） */
export const CABINETS: string[] = ['A', 'B', 'C'].flatMap((c) =>
  Array.from({ length: 12 }, (_, i) => `${c}-${String(i + 1).padStart(2, '0')}`),
);

/** 留样到期派生态 */
export type SampleExpiryState = '已到期' | '临期' | '观察中';

/** 留样到期派生信息 */
export interface SampleExpiry {
  sample: RetainSample;
  /** 到期日 YYYY-MM-DD */
  expireAt: string;
  /** 距到期剩余天数（负数表示已过期） */
  daysLeft: number;
  state: SampleExpiryState;
}
