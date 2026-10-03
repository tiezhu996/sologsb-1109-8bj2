# 中草药炮制工序记录台（gbherbprocess）

面向中药饮片厂炮制班组与质检员：登记药材批次、按炮制方法折算辅料比例与火力时间、逐批判定炮制程度、管理留样观察台账。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21809>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（5 条路由） |
| 状态 | Zustand（herbStore / methodStore / batchStore / sampleStore / handoffStore） |
| 存储 | IndexedDB（Dexie，库名 `gbherbprocess-db`，schema v3，含交接包暂存表 `handoffs`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21809
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # herb-material / processing-method / process-batch / retain-sample
│       ├── stores/            # herbStore / methodStore / batchStore / sampleStore
│       ├── components/common/ # RatioCalculator / FireLevelTag / CabinetGrid / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useHerbFilter / useRatio
│       ├── pages/             # ProcessBoard / HerbList / MethodList / BatchBoard / SampleLedger
│       ├── router/index.tsx   # 路由表
│       └── utils/             # db.ts / degree.ts / export.ts / seed.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 首页总览 | 待炮制批次、留样到期提示、交接待复核/阻塞提示、最近工序时间线、平均得率 |
| `/herbs` | 药材台账 | 药材与批次登记，按基原/药用部位筛选，按药材分组汇总 |
| `/methods` | 炮制方法 | 辅料比例、火力与判断标准维护，辅料折算台与复制派生 |
| `/batches` | 工序记录台 | 选方法自动带出辅料比例/火候/判断标准，录入实际锅温/时长与得率并判定程度 |
| `/samples` | 留样台账 | 柜位网格、到期提醒、按日期追加观察记录 |
| `/handoff` | 交接对账 | 平板交接包增量对账：校验暂存、按批号/留样编号写入、差异两版复核、断网续接 |

## 平板交接包：增量对账（不清空台账）

班组从平板拷回交接包（JSON，含 `app=gbherbprocess`）后，在「交接对账」页导入。流程与旧版整库覆盖完全不同：

1. **先校验并暂存**：逐项结构校验，非法包不暂存；暂存包落 `handoffs` 表，断网/刷新后仍在。
2. **旧版包兼容补全**：缺 `schemaVersion`、锅温/时长、温区、留样期、观察记录等字段时按规则补全并逐条标注。
3. **业务对账后写入**：药材按「名称+批号」、方法按工艺业务键、工序按**生产批号**、留样按**留样编号**匹配；完全一致跳过（成功项不重复），新记录写入，引用的药材/方法/所属工序缺失则置「阻塞」。
4. **差异两版待复核**：同批号的**实际锅温、实际时长、炮制程度、现场观察（备注）**任一不同，正本一行不动，另存 `reviewState=pending` 副本；锁定结果绝不自动覆盖。留样观察记录差异同样两版并存。
5. **失败保留整包、补录续接**：缺药材或炮制方法可在包内一键补录，或到台账手工补录后点「继续续接」，多轮收敛，已写入项不重复；整包可随时导出回传平板。
6. **复核后同步落账**：复核可选「保留本机版 / 采用交接版 / 合并观察记录」；采用交接版覆盖**已锁定**批次时必须勾选质检改判并签名，落账后自动同步工序状态与留样台账。

> 旧的整库恢复（`clear()` 后覆盖）已停用并从入口移除，`importBackup` 仅保留为显式报错的拦截函数。页面上有「生成演示交接包试跑」按钮，可一键构造覆盖一致/差异/锁定/阻塞/旧包场景的交接包。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbherbprocess-db`），表：`herbs`、`methods`、`batches`、`samples`、`meta`、`handoffs`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为 `batches` 增加 `locked` 索引并回填；`db.version(3).upgrade(...)` 增加 `handoffs` 暂存表与 `batches/samples` 复核索引，并为历史批次按所用方法标准值补录 `actualTemp`/`durationMin`（供同批号对账）。升级前可用顶栏「导出备份」导出全量 JSON。
- 全量备份不含 `handoffs`（暂存区属过程数据，避免再导入时重复暂存）。
- 首次打开且表为空时写入一批示例台账（`src/utils/seed.ts`），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
