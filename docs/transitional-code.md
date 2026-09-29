# 过渡代码清单（迁移完成后要删的东西）

> 建立于 1.1.0（存储层从 `chrome.storage.local` 换成 IndexedDB）。
> 这份清单的目的是：**迁移相关的代码只应该活一两个版本，不能被忘在库里。**

## 怎么找

代码里统一用 `TODO(过渡代码)` 标注，一条命令列全：

```bash
# ripgrep
rg "TODO\(过渡代码\)" src
# PowerShell
Select-String -Path src -Include *.ts,*.vue -Pattern 'TODO\(过渡代码\)' -Recurse
```

看到标记就来这份清单对照第几批、删的时候还要一起改什么。

## 为什么不能马上删

迁移必须**向后兼容**：用户可能跨越好几个版本升级，也可能装回过旧版本。
这些代码的存在理由就一条 —— **让任何版本的存量数据都能安全地搬过来**。
一旦确认不会有旧数据再出现（通常是一两个发布之后），它们就从"保障"变成"负担"：
没人读的历史分支会腐烂，还会让后来的人以为库里真会有那些形状。

## 清单

### 第一批（可以最早删：它们没有生产调用方）

| 条目 | 位置 | 说明 |
| --- | --- | --- |
| 干跑预览与报告渲染 | `src/logic/store/legacy.ts` 的 `previewMigration` / `renderMigrationReport` / `PreviewEnvironment` / `readEnvironment` / `readIdbDatabases` / `readEstimate` / `describeSecret` / `fmtBytes` / `formatFieldCounts` | 原本服务于侧边栏的临时「迁移预览」tab，**那个 tab 已删**，所以这些现在只有单测在调用。留着是因为"迁移出问题时还能把它接回界面再跑一次" |
| 单条记录读取 | `src/logic/store/records.ts` 的 `readRecord` | 为决策 B（侧边栏按当前岗位读一条）准备的。若决策 B 最终不做，它就是死代码 |

> `exportLegacySnapshot`（临时 tab 的"导出原始数据"按钮）**已经删除** —— 它当时已无任何调用方。需要那个功能时从 git 历史里取回。

### 第二批（确认存量数据不再出现之后）

| 条目 | 位置 | 一起要改的 |
| --- | --- | --- |
| **整个迁移模块** | `src/logic/store/legacy.ts`（`runMigration` / `planMigration` / `computeChecksums` / `applyPlan` / `verifyMigration` / `mergeLegacyAfterDowngrade` / `STORAGE_KEYS` / `MigrationMeta` / `MigrationResult`） | ① `src/logic/store/ready.ts` 去掉 `runMigration()` 调用；② `src/logic/storage.ts` 的 `resetAllStorage` 去掉删除旧键的兜底；③ 本文件第一批同时清掉 |
| 旧存储的四个键名 | `legacy.ts` 的 `STORAGE_KEYS` | 它是旧键名的**唯一**出处，随迁移模块一起消失 |
| 历史形状归一化 | `src/logic/store/migrations.ts` 的 `reviveLegacyString`（JSON 字符串化）、`migrateResumeShape`（`gist` / `syncedFrom`）、`migrateRecordKeys`（裸 `securityId` 键）、`LEGACY_RECORD_FIELD_FALLBACK` + `pickWithLegacyName` + `keySiteId` / `keyNaturalKey`（旧记录形状） | ⚠ 这些还被**日常读路径**用到（`readResume` 与 `useStoredValue` 都会跑 `normalizeResumeDoc`），删之前要确认库里不可能再有旧形状。保留 `mergeDefaults` / `ensureSourceConfigs` / `normalizeRecordShape` 的白名单骨架 |
| `storage` 权限 | `src/manifest.ts` 的 `permissions` | 决策 C 的后续动作：单独发一版移除，同时改 `docs/privacy-policy.md` §3.1 的括号段、§3.2 的历史说明、§5.1 的权限行、附录 A 相关行，以及 `docs/chrome-web-store.md` 的「需请求 storage 的理由」 |

### 不需要删的（澄清一下，免得被误删）

| 条目 | 为什么留着 |
| --- | --- |
| `src/platform/idb/*` | 新的存储机制本体 |
| `src/logic/store/{settings,records,events,ready}.ts` | 新的存储层 |
| `mergeDefaults` / `ensureSourceConfigs` | 长期不变量：读时补默认值、每个来源必须有完整配置形状 |
| `JOB_RECORD_FIELDS` + `normalizeRecordShape` 的白名单骨架 | 长期不变量：库里只允许存在当前模型的字段 |
| `src/tests/setup.ts`（fake-indexeddb） | 测试基建 |

## 删的时候怎么验证

1. `pnpm test` 全绿（删掉的功能对应的单测要一起删，别留下引用已删导出的测试）。
2. `pnpm typecheck` + `pnpm lint` 干净。
3. `pnpm build` 产物里搜不到留下的字符串：`Select-String -Path extension/dist -Include *.js -Pattern '迁移|chrome.storage' -Recurse`。
4. 隐私政策里所有关于 `chrome.storage`/旧版本的说法都跟着收窄 —— 文档比代码更容易忘记。
