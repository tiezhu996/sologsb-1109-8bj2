import { create } from 'zustand';
import { db } from '../utils/db';
import {
  applyPackage,
  removeHandoffPackage,
  resolveReview,
  stageHandoff,
  supplementMasterData,
  type ReviewAction,
} from '../utils/handoff';
import type { HandoffPackage } from '../types/handoff';
import { useHerbStore } from './herbStore';
import { useMethodStore } from './methodStore';
import { useBatchStore } from './batchStore';
import { useSampleStore } from './sampleStore';

/** 台账刷新：交接写入/复核后同步工序状态与留样台账到内存 */
async function refreshLedgers() {
  await Promise.all([
    useHerbStore.getState().hydrate(),
    useMethodStore.getState().hydrate(),
    useBatchStore.getState().hydrate(),
    useSampleStore.getState().hydrate(),
  ]);
}

interface HandoffState {
  packages: HandoffPackage[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 第一步：校验并暂存（含旧包兼容补全与业务对账） */
  stageText: (text: string) => Promise<HandoffPackage>;
  /** 第二步/续接：写入可写入项，失败整包保留，已成功项不重复 */
  apply: (pkgId: string) => Promise<HandoffPackage>;
  /** 药材或炮制方法补录后重跑对账 */
  supplement: (pkgId: string) => Promise<{ herbs: number; methods: number; pkg: HandoffPackage }>;
  /** 复核裁决：保留本机版 / 采用交接版 / 合并观察记录 */
  resolve: (pkgId: string, itemRefId: string, action: ReviewAction) => Promise<HandoffPackage>;
  remove: (pkgId: string) => Promise<void>;
  /** 全库待复核条目数（工序 + 留样两版并存） */
  pendingReviewCount: () => number;
  /** 全库阻塞条目数（提示补录后重试） */
  blockedCount: () => number;
}

export const useHandoffStore = create<HandoffState>()((set, get) => ({
  packages: [],
  hydrated: false,

  hydrate: async () => {
    const packages = await db.handoffs.orderBy('receivedAt').reverse().toArray();
    set({ packages, hydrated: true });
  },

  stageText: async (text) => {
    const pkg = await stageHandoff(text);
    set({ packages: [pkg, ...get().packages] });
    return pkg;
  },

  apply: async (pkgId) => {
    const next = await applyPackage(pkgId);
    set({ packages: get().packages.map((p) => (p.id === pkgId ? next : p)) });
    await refreshLedgers();
    return next;
  },

  supplement: async (pkgId) => {
    const result = await supplementMasterData(pkgId);
    set({ packages: get().packages.map((p) => (p.id === pkgId ? result.pkg : p)) });
    await refreshLedgers();
    return result;
  },

  resolve: async (pkgId, itemRefId, action) => {
    const next = await resolveReview(pkgId, itemRefId, action);
    set({ packages: get().packages.map((p) => (p.id === pkgId ? next : p)) });
    await refreshLedgers();
    return next;
  },

  remove: async (pkgId) => {
    await removeHandoffPackage(pkgId);
    set({ packages: get().packages.filter((p) => p.id !== pkgId) });
    await refreshLedgers();
  },

  pendingReviewCount: () =>
    get().packages.reduce((sum, pkg) => sum + pkg.items.filter((i) => i.state === 'reviewing').length, 0),

  blockedCount: () =>
    get().packages.reduce((sum, pkg) => sum + pkg.items.filter((i) => i.state === 'blocked').length, 0),
}));
