import { db, SCHEMA_VERSION } from './db';

export interface BackupPayload {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  herbs: unknown[];
  methods: unknown[];
  batches: unknown[];
  samples: unknown[];
}

/** 汇总全部本地表为 JSON 备份（schema 迁移前先导出） */
export async function buildBackup(): Promise<BackupPayload> {
  const [herbs, methods, batches, samples] = await Promise.all([
    db.herbs.toArray(),
    db.methods.toArray(),
    db.batches.toArray(),
    db.samples.toArray(),
  ]);
  return {
    app: 'gbherbprocess',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    herbs,
    methods,
    batches,
    samples,
  };
}

export async function exportBackupJson(): Promise<string> {
  return JSON.stringify(await buildBackup(), null, 2);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出 CSV（台账打印用） */
export function downloadCsv<T extends Record<string, unknown>>(filename: string, rows: T[], columns: Array<{ key: keyof T; title: string }>): void {
  const header = columns.map((c) => `"${c.title}"`).join(',');
  const body = rows
    .map((row) => columns.map((c) => `"${String(row[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  downloadText(filename, `\ufeff${header}\n${body}`, 'text/csv');
}

/**
 * 已废弃：旧版「恢复备份」会 clear() 全表再覆盖，平板交接时会清空本机台账。
 * 交接包请走增量对账（utils/handoff.stageHandoff）：先校验暂存、按批号/留样编号写入、差异两版复核。
 * 保留此函数仅为拦截旧调用，明确拒绝整库覆盖。
 */
export async function importBackup(): Promise<never> {
  throw new Error('整库导入已停用，请使用「交接对账」做增量写入，避免清空本机台账');
}
