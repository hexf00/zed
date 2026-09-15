# Fork 长期维护计划

本 fork 的目标:基于上游 Zed 构建自用版本,做内置插件组合与键法定制,同时
长期跟进 zed-industries/zed 的改动。本文档描述分支模型、CI、同步节奏和
定制的落地方式。

## 核心原则:核心 diff 最小化

Zed 上游每周合入大量 PR,fork 的长期成本几乎完全取决于自己改了多少核心代码。
因此:

1. **能用扩展/配置解决的,绝不改核心代码。** Zed 官方的定制通道有:
   - 扩展(extension,Rust→WASM):语法、主题、语言支持、slash command、context server 等;
   - `assets/keymaps/default-windows.json`:默认键位(改这个文件会有少量冲突面);
   - `assets/settings/initial_user_settings.json`:新用户默认设置。
2. **必须改核心时,把改动隔离**:独立 crate / 独立目录,commit message 用
   `fork:` 前缀标记,一个改动一个 commit,方便逐个评估 "上游是否已实现同功能"。
3. 每次上游合并后检查:自己的 fork 改动是否可以用上游新能力替代并删除。
   fork diff 只减不增是长期可维护的唯一路径。

## 分支模型

| 分支 | 内容 | 规则 |
|------|------|------|
| `main` | 上游 main + fork 基础设施(本目录、两个 fork workflow) | 不要在这里直接改代码;同步 workflow 自动维护 |
| `custom` | main + 全部个人定制 | 日常开发分支;CI 构建这里 |

fork 基础设施文件(`.github/workflows/fork-*.yml`、`docs/fork-maintenance.md`)
是纯新增文件,上游不会创建同名路径,所以 main 与上游的合并永远干净。

## CI

### Fork Windows Build(`fork-build-windows.yml`)

- 触发:**仅手动 dispatch**(Actions 页面选 `custom` 分支点 Run workflow,或
  `gh workflow run fork-build-windows.yml --ref custom`)。构建动辄数小时,
  不做任何自动触发。
- 费用与时长上限:本 fork 是**公开仓库**,GitHub Actions 免费、不限时长
  (2000 分钟/月额度只对私有仓库生效);唯一硬限制是单 job 6 小时,
  workflow 的 timeout 350 分钟留了余量。
- 产物:未签名的 Windows 安装包 + zed-remote-server zip,在 run 的 Artifacts 里下载。
- 缓存:sccache(GHA backend)+ cargo registry 缓存。两个规则要记住:
  - GHA 缓存总量约 10GB,LRU 逐出;
  - **7 天未被访问的缓存条目会被清除**——超过一周不构建,下次会向冷构建回落。
  - 建议:至少每周(比如每次上游同步后)手动构建一次,让缓存保持热。
- 时长预期(4 核托管 runner):
  - 首次冷构建:约 2.5–4 小时(上游 32 核冷构建约 31 分钟,核心数差 8 倍);
    这次构建同时把 sccache 填满,是最慢的一次,也是唯一一次;
  - 之后暖缓存:约 30–60 分钟(只剩自研 crate 重编 + 链接 + 打包);
  - 签名/Inno Setup/打包约 5 分钟,缓存无法消除。
- 已做的环境适配(不改上游脚本):
  - VS 2022 Community → Enterprise 目录 junction(bundle 脚本硬编码了 Community 路径);
  - Inno Setup 6 缺失时 choco 兜底;
  - 无签名密钥,bundle 脚本自动跳过签名;无 sentry/自动更新密钥,相关步骤自动跳过。
- 构建渠道:`crates/zed/RELEASE_CHANNEL` 当前为 `dev`,安装的是 "Zed Dev"。
  **建议保持 dev**:它不会与官方 stable 的 auto-update 冲突,避免自用构建被
  官方更新覆盖。

### Fork Upstream Sync(`fork-sync-upstream.yml`)

- 每周一 09:30(北京时间)自动运行,也可手动触发。
- 流程:fetch 上游 main → merge 进 `main` 并 push → merge `main` 进 `custom`
  → 冲突时自动开 issue。**不会自动触发构建**(构建手动),同步完想出新包
  就自己 dispatch 一次。
- 注意:GitHub 仓库 60 天无活动会暂停 schedule workflow,长期不用时手动
  跑一次或 re-enable。

## 上游同步节奏与冲突处理

- 默认每周自动同步。冲突面小的时候每周几分钟就结束;如果某周冲突多,
  也可以放慢到每两周、每个上游 minor release 一次,自行手动触发即可。
- 冲突处理原则:
  1. `assets/keymaps`、`assets/settings` 的冲突:以上游为基准,把自己的块重新套用;
  2. `extensions/` 下自己的扩展:纯新增目录,理论上不会冲突;
  3. 核心 `crates/` 的 `fork:` commit:逐个 rebase/重放,先检查上游是否已有等价实现;
  4. 拿不准的文件默认取上游版本,再把自己的改动重新加上——保证不落后于上游行为。
- 本地手动同步:

  ```bash
  git remote add upstream https://github.com/zed-industries/zed.git   # 一次性
  git fetch upstream main
  git checkout main && git merge upstream/main && git push origin main
  git checkout custom && git merge main        # 冲突则按上面原则处理
  ```

## 定制的推荐落地顺序

1. **键法**:优先 `assets/keymaps/default-windows.json`(随安装包生效),或
   纯用户级 `keymap.json`(不需要 fork)。上游对该文件改动是追加式的,冲突好解。
2. **插件组合**:在 `extensions/` 下新增自己的扩展目录(参考现有内置扩展结构),
   并通过默认 settings 启用。纯新增,零冲突。
3. **默认设置**:`assets/settings/initial_user_settings.json` 追加键值。
4. **核心功能**:最后手段,遵守 `fork:` 前缀 + 独立目录原则。

## 当前 fork diff 清单

fork 对上游源码的全部改动都必须登记在这里,同步上游时逐条复查。

| 改动 | 文件 | 内容 | 恢复方式 |
|------|------|------|----------|
| SKIP-1 | `script/bundle-windows.ps1` | 跳过 remote_server 构建(fork 用不到 SSH 远程开发;它占上游冷构建约 40%)。由 `ZED_FORK_SKIP_REMOTE_SERVER=1` 环境变量门控,不设变量时行为与上游完全一致;同时 pdb 打包列表做了相应条件化 | workflow 里删掉该环境变量即可,脚本改动可无害保留 |

上游同步时:该脚本若被上游修改,冲突处理原则是保留上游逻辑、重新套用
`if ($env:ZED_FORK_SKIP_REMOTE_SERVER)` 门控。如果将来上游接受类似的
opt-out 开关(PR 上游是更干净的终局),删除本地 diff。

## 已知取舍

- 无代码签名:安装时 SmartScreen 会告警,自用可接受。
- 托管 runner 4 核:暖缓存后 30–60 分钟可接受;若追求上游那种 15 分钟级,
  需要自建 runner 或付费 larger runner(把 workflow 里 `runs-on` 改掉即可,
  sccache bucket 也可换自建 S3/R2)。
- GHA 缓存 10GB 上限对 Zed 的依赖树偏紧,LRU 逐出会导致命中率波动;
  观察构建日志末尾的 sccache stats,命中率差时考虑换自建缓存后端。
- Artifacts 默认保留 90 天,需要的安装包请及时下载或转 Release。
