import { db } from './db';
import type { HandoffEnvelope } from '../types/handoff';

/**
 * 基于当前本机台账构造一份「平板带回的交接包」演示数据，
 * 覆盖：一致项 / 未锁定差异 / 锁定差异（不能覆盖）/ 缺药材缺方法 /
 * 待复核观察记录 / 所属工序阻塞 / 旧版缺字段兼容。
 * 仅用于现场试跑与培训，不参与正式对账。
 */
export async function buildDemoHandoff(): Promise<string> {
  const batches = await db.batches.toArray();
  const methods = await db.methods.toArray();
  const herbs = await db.herbs.toArray();
  const samples = await db.samples.toArray();

  const lockedBatch = batches.find((b) => b.locked) ?? batches[0];
  const unlockedBatch = batches.find((b) => !b.locked) ?? batches[1] ?? batches[0];
  const sampleOfLocked = samples.find((s) => s.batchId === lockedBatch?.id) ?? samples[0];
  const method = methods.find((m) => m.id === lockedBatch?.methodId) ?? methods[0];
  const herb = herbs.find((h) => h.id === lockedBatch?.herbId) ?? herbs[0];

  const now = new Date();
  const iso = new Date(now.getTime() - 2 * 3600_000).toISOString();

  const envelope: HandoffEnvelope = {
    app: 'gbherbprocess',
    schemaVersion: 2,
    packagedAt: iso,
    device: '炮制一班 · 平板03',
    herbs: [
      // 本机已有药材，用于批号对账参照
      {
        id: herb?.id ?? 'herb-001',
        name: herb?.name ?? '白术',
        origin: '植物',
        part: '根',
        batchNo: herb?.batchNo ?? 'BT-2401',
        feedKg: herb?.feedKg ?? 120,
        receivedAt: herb?.receivedAt ?? iso,
      },
      // 本机没有的药材：触发「档案补录后重试」
      {
        id: 'herb-tab-099',
        name: '苍术',
        origin: '植物',
        part: '根',
        batchNo: 'CZ-2411',
        feedKg: 70,
        receivedAt: iso,
        remark: '湖北蕲春产，平板新登记',
      },
    ],
    methods: [
      // 本机没有的炮制方法（麸炒苍术，配比与现有派生方法不同）
      {
        id: 'method-tab-099',
        name: '麸炒',
        auxiliary: '麦麸',
        auxRatio: 8,
        fireLevel: '中火',
        tempRange: [125, 155],
        duration: 11,
        criterion: '表面黄褐、麸香浓郁、断面无白心',
        criterionDimension: '断面',
        applicable: '苍术',
      },
    ],
    batches: [
      // 1) 与本机完全一致 → 成功项不重复
      { ...lockedBatch },
      // 2) 锁定批次，锅温/时长/程度/观察全有差异 → 两版待复核，锁定结果不覆盖
      {
        ...lockedBatch,
        id: 'batch-tab-conflict-locked',
        actualTemp: Number(lockedBatch.actualTemp ?? 145) + 18,
        durationMin: Number(lockedBatch.durationMin ?? method.duration) + 4,
        degree: lockedBatch.degree === '太过' ? '适中' : '太过',
        remark: `${lockedBatch.remark ?? ''}｜平板复判：断面偏深，班组建议改判（待质检复核）`,
        locked: true,
        lockedAt: iso,
        qcBy: undefined,
      },
      // 3) 未锁定批次程度/观察差异 → 两版待复核，可直接采用
      {
        ...unlockedBatch,
        id: 'batch-tab-conflict-open',
        degree: unlockedBatch.degree === '不及' ? '适中' : '不及',
        actualTemp: Number(unlockedBatch.actualTemp ?? 110) - 12,
        remark: '平板记录：出锅前香气偏淡，班组判定不及需复炒',
        locked: false,
      },
      // 4) 本机没有的新批号 → 可直接写入
      {
        id: 'batch-tab-new-001',
        batchNo: 'PZ-TAB-2601',
        herbId: herb?.id ?? 'herb-001',
        methodId: method?.id ?? 'method-002',
        feedKg: 40,
        auxUsedKg: 4,
        fireLevel: '中火',
        actualTemp: 146,
        durationMin: 10,
        startedAt: iso,
        endedAt: new Date(now.getTime() - 3600_000).toISOString(),
        yieldRate: 95.8,
        degree: '适中',
        operator: '平板交接 · 周强',
        locked: false,
        remark: '平板现场录入，网断期间完成',
      },
      // 5) 缺药材+缺方法 → 阻塞，补录后重试
      {
        id: 'batch-tab-blocked-001',
        batchNo: 'PZ-TAB-2602',
        herbId: 'herb-tab-099',
        methodId: 'method-tab-099',
        feedKg: 70,
        auxUsedKg: 5.6,
        fireLevel: '中火',
        actualTemp: 140,
        durationMin: 11,
        startedAt: iso,
        endedAt: new Date(now.getTime() - 3000_000).toISOString(),
        yieldRate: 94.2,
        degree: '适中',
        operator: '平板交接 · 周强',
        locked: false,
      },
      // 6) 旧版交接包工序：缺锅温/时长/锁定字段 → 兼容补全
      {
        id: 'batch-tab-legacy-001',
        batchNo: 'PZ-OLD-2309',
        herbId: herb?.id ?? 'herb-001',
        methodId: method?.id ?? 'method-002',
        feedKg: 30,
        auxUsedKg: 3,
        fireLevel: '中火',
        startedAt: iso,
        endedAt: new Date(now.getTime() - 2400_000).toISOString(),
        yieldRate: 95.1,
        degree: '适中',
        operator: '平板交接 · 孙莉',
        remark: '旧版平板导出，无锅温时长字段',
      },
    ],
    samples: [
      // a) 与本机留样一致 → 不重复
      ...(sampleOfLocked ? [{ ...sampleOfLocked }] : []),
      // b) 同留样编号，观察记录有差异 → 两版待复核（可合并观察）
      ...(sampleOfLocked
        ? [
            {
              ...sampleOfLocked,
              id: 'sample-tab-conflict',
              observeLogs: [
                ...sampleOfLocked.observeLogs,
                {
                  id: 'log-tab-new',
                  date: new Date().toISOString().slice(0, 10),
                  color: '色泽偏深',
                  odor: '气味正常',
                  mold: '无霉变',
                  observer: '周强',
                  note: '断网期间平板补录的一次观察',
                },
              ],
            },
          ]
        : []),
      // c) 本机没有的新留样（关联新批号）→ 随工序写入后续接
      {
        id: 'sample-tab-new-001',
        sampleNo: 'LY-PZ-TAB-2601',
        batchId: 'batch-tab-new-001',
        amountG: 300,
        retainMonths: 12,
        cabinet: 'C-09',
        retainedAt: new Date(now.getTime() - 3000_000).toISOString(),
        observeLogs: [
          {
            id: 'log-tab-new-001',
            date: new Date().toISOString().slice(0, 10),
            color: '色泽符合标准',
            odor: '气味正常',
            mold: '无霉变',
            observer: '周强',
          },
        ],
      },
      // d) 所属工序阻塞 → 阻塞
      {
        id: 'sample-tab-blocked',
        sampleNo: 'LY-PZ-TAB-2602',
        batchId: 'batch-tab-blocked-001',
        amountG: 200,
        retainMonths: 6,
        cabinet: 'C-10',
        retainedAt: new Date(now.getTime() - 2400_000).toISOString(),
        observeLogs: [],
      },
      // e) 旧版留样：缺留样期与观察记录 → 兼容补全
      {
        id: 'sample-tab-legacy',
        sampleNo: 'LY-PZ-OLD-2309',
        batchId: 'batch-tab-legacy-001',
        amountG: 250,
        cabinet: 'C-11',
        retainedAt: new Date(now.getTime() - 1800_000).toISOString(),
      },
    ],
  };

  return JSON.stringify(envelope, null, 2);
}
