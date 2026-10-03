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
| 状态 | Zustand（herbStore / methodStore / batchStore / sampleStore / handoverStore） |
| 存储 | IndexedDB（Dexie，库名 `gbherbprocess-db`） |
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
│       ├── types/             # herb-material / processing-method / process-batch / retain-sample / handover
│       ├── stores/            # herbStore / methodStore / batchStore / sampleStore / handoverStore
│       ├── components/common/ # RatioCalculator / FireLevelTag / CabinetGrid / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useHerbFilter / useRatio
│       ├── pages/             # ProcessBoard / HerbList / MethodList / BatchBoard / SampleLedger / HandoverCenter
│       ├── router/index.tsx   # 路由表
│       └── utils/             # db.ts / degree.ts / export.ts / reconcile.ts / seed.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 首页总览 | 待炮制批次、留样到期提示、最近工序时间线、平均得率 |
| `/herbs` | 药材台账 | 药材与批次登记，按基原/药用部位筛选，按药材分组汇总 |
| `/methods` | 炮制方法 | 辅料比例、火力与判断标准维护，辅料折算台与复制派生 |
| `/batches` | 工序记录台 | 选方法自动带出辅料比例/火候/判断标准，录入锅温时长与得率并判定程度 |
| `/samples` | 留样台账 | 柜位网格、到期提醒、按日期追加观察记录 |
| `/handover` | 交接对账 | 平板交接包校验暂存 → 按生产批号/留样编号续接写入 → 两版复核 |

## 交接对账（可续接增量，不清库）

平板带回的交接包在「交接对账」页处理，**不再使用整库覆盖**：

1. **先校验并暂存**：拖入 JSON 后仅做归一化、字段校验与逐条对账，整包（含解析失败的包）原样留存于 `handoverPackages` / `handoverItems`，本机台账不改动。
2. **按业务键续接写入**：药材按批号、方法按方法名、工序按生产批号、留样按留样编号；引用的药材/方法按业务键重新映射为本机主键。断网或中断后再次「续接写入」即可，**已写入项不重复**，状态为一致的自动跳过。
3. **两版保留待复核**：同一批号的**锅温、时长、程度**任一有差异，或留样**同次观察**内容不一致，两版并存待人工复核，不自动覆盖。
4. **锁定结果不覆盖**：本机已锁定批次的任何差异都标记「本机已锁定」，复核时只能保留本机版；确需采平板版须先在工序记录台由质检员解锁。
5. **补录后重试**：缺药材/炮制方法（或留样缺所属批次）的条目标「缺引用待补录」，在对应台账补录后回到本页续接，条目不丢。
6. **旧版包兼容**：缺 `locked`、锅温 `potTempC`、时长 `durationMin`、柜位等字段时补默认值（时长可由起止时间推导），缺字段本身不判为差异；硬错误条目标「条目异常」并保留。
7. **复核后同步**：采平板版则按差异字段合并写入（留样观察按日期并集追加），保留本机版则仅同步工序状态与留样台账页面。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbherbprocess-db`），表：`herbs`、`methods`、`batches`、`samples`、`meta`、`handoverPackages`、`handoverItems`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为 `batches` 增加 `locked` 索引并回填历史数据；`db.version(3)` 增加交接包暂存表与逐条对账表（增量升级，不清空既有台账），批次另增非索引字段实际锅温 `potTempC` / 时长 `durationMin`。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入一批示例台账（`src/utils/seed.ts`），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
