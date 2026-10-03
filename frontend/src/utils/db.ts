import Dexie, { type Table } from 'dexie';
import type { HerbMaterial } from '../types/herb-material';
import type { ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch } from '../types/process-batch';
import type { RetainSample } from '../types/retain-sample';
import type { HandoffPackage } from '../types/handoff';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbherbprocess-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class HerbProcessDB extends Dexie {
  herbs!: Table<HerbMaterial, string>;
  methods!: Table<ProcessingMethod, string>;
  batches!: Table<ProcessBatch, string>;
  samples!: Table<RetainSample, string>;
  meta!: Table<{ key: string; value: string }, string>;
  /** 交接包暂存区：校验对账后落此表，断网可续接 */
  handoffs!: Table<HandoffPackage, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      herbs: 'id, name, origin, part, batchNo, receivedAt',
      methods: 'id, name, auxiliary, fireLevel',
      batches: 'id, batchNo, herbId, methodId, degree, startedAt',
      samples: 'id, sampleNo, batchId, cabinet, retainedAt',
      meta: 'key',
    });

    // v2：批次表增加 locked 索引（锁定/质检放行查询更快），并回填历史数据的 locked 字段。
    // 升级前请在「导出备份」中导出 JSON。
    this.version(2)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('batches')
          .toCollection()
          .modify((row: ProcessBatch) => {
            if (typeof row.locked !== 'boolean') {
              row.locked = false;
            }
          });
      });

    // v3：交接对账。
    // - 新增 handoffs 暂存表（先校验暂存、再写入，断网续接，失败保留整包）
    // - batches / samples 增加复核状态索引（差异两版并存）
    // - 历史批次补录实际锅温、实际时长（取所用方法标准值中值/标准时长），供同批号对账
    this.version(3)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked, reviewState, duplicateOf, handoffPackageId',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt, reviewState, duplicateOf, handoffPackageId',
        meta: 'key',
        handoffs: 'id, device, state, receivedAt',
      })
      .upgrade(async (tx) => {
        const methodRows = await tx.table<ProcessingMethod>('methods').toArray();
        const methodMap = new Map(methodRows.map((m) => [m.id, m]));
        await tx
          .table<ProcessBatch>('batches')
          .toCollection()
          .modify((row) => {
            if (typeof row.actualTemp !== 'number' || typeof row.durationMin !== 'number') {
              const method = methodMap.get(row.methodId);
              if (method) {
                row.actualTemp = Math.round((method.tempRange[0] + method.tempRange[1]) / 2);
                row.durationMin = method.duration;
              }
            }
            if (row.reviewState === undefined) {
              row.reviewState = 'normal';
            }
          });
        await tx
          .table<RetainSample>('samples')
          .toCollection()
          .modify((row) => {
            if (row.reviewState === undefined) {
              row.reviewState = 'normal';
            }
            if (!Array.isArray(row.observeLogs)) {
              row.observeLogs = [];
            }
          });
      });
  }
}

export const db = new HerbProcessDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
