# dsh-deepseek-balance

[![build](https://github.com/Jianwen-Xu/dsh-deepseek-balance/actions/workflows/ci.yml/badge.svg)](https://github.com/Jianwen-Xu/dsh-deepseek-balance/actions/workflows/ci.yml)

在 DSH Web 侧边栏底部显示 DeepSeek API 账户余额、是否可用，以及当前处于高峰 / 空闲计费时段和距下一次切换的倒计时。

## 功能

- **余额**：显示 `total_balance` 与币种；悬停查看赠送余额 / 充值余额明细。
- **扣费时段**：按官方价格页的规则本地判断——**北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，其余时间为空闲（空闲价为高峰价的一半）**。
- **倒计时**：徽标显示距下一次时段切换的时间。
- **状态点**：绿=正常、黄=账户不可用、红=读取失败、蓝=加载中；点击整行可强制刷新。

## 安装

本插件是「组合包」（bundle）：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入插件行。安装即把它加入某个 profile 的 bundles 列表。

### 从本地 checkout 安装（开发）

把 profile 依赖指向本地目录，改完构建即可生效：

```bash
dsh plugin --profile web add /path/to/dsh-deepseek-balance
pnpm build     # 产出 lib/
```

`add` 会以 `link:` 链接该目录，并自动把包名追加进 profile 的 `dsh.profile.bundles`。验证层已生效再启动：

```bash
dsh --profile web --dump-config   # 应能看到 dsh-deepseek-balance 层
dsh web
```

`link:` 安装不执行构建脚本，**不需要**下面的 `allowBuilds` 授权——产物由你手动 `pnpm build` 生成。Host 侧改动（`src/index.ts`）需重启 `dsh web`；客户端改动（`src/client/index.ts`）构建后刷新页面即可。

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:Jianwen-Xu/dsh-deepseek-balance
```

git 安装拉取的是**源码**，需要在安装时构建出 `lib/`。本包已声明 `prepare` 脚本（= `tsdown`），pnpm 会在安装后自动运行它。

但 **pnpm ≥ 10 默认拒绝执行 git 依赖的构建脚本**，首次 `add` 会因此失败（缺少 `lib/`）。按提示把 pnpm 打印的包键写进该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-deepseek-balance: true
```

然后重新执行 `add`。⚠️ 这项授权等于允许该包的代码在安装时于你机器上执行，请只对可信来源授权，并用 commit 锁定内容：

```bash
dsh plugin --profile web add github:Jianwen-Xu/dsh-deepseek-balance#<sha>
```

不想授权就改成 tarball 安装（产物在打包时已构建好）：

```bash
pnpm pack && dsh plugin --profile web add ./dsh-deepseek-balance-1.0.0.tgz
```

## 配置 API Key

插件按以下顺序解析 `DEEPSEEK_API_KEY`：

1. 凭据服务 `ctx.credentials.resolve('DEEPSEEK_API_KEY')`（推荐：在 Web 的 Models 设置页保存，或写入 `~/.dsh/.credentials.yaml`）。
2. 进程环境变量 `DEEPSEEK_API_KEY`（兜底）。

缺失时接口返回 `{"ok":false,"code":"no-api-key"}`，UI 显示红色状态点。

## 构建

```bash
pnpm install
pnpm build      # 产出 lib/index.js（Host 侧，ESM）+ lib/client.js（浏览器侧，__ModuleLoader__ 包装）
```

> 两个产物都来自 `src/`。`lib/` 不入库，**不要直接改它**：`pnpm build` 会覆盖，克隆后也必须先构建。
>
> `build` 与 `prepare` 是同一个命令：前者供手动/CI 调用，后者供 `dsh plugin add <git-url>` 时由 pnpm 自动触发。

CI（`.github/workflows/ci.yml`）在每次 push 和 PR 上跑 `pnpm install --frozen-lockfile && pnpm build`，并校验两份产物的契约：Host 侧必须导出 `name` / `inject` / `apply`，浏览器侧必须以包名向 `window.__ModuleLoader__` 注册。

## 接口

`GET /deepseek-balance`（精确匹配）

| 参数 | 说明 |
| --- | --- |
| `refresh=1` | 跳过 60s 缓存，强制向上游请求一次 |

响应示例：

```json
{
  "ok": true,
  "isAvailable": true,
  "display": { "currency": "CNY", "totalBalance": "17.49", "grantedBalance": "0.00", "toppedUpBalance": "17.49" },
  "peakHour": false,
  "peakLabel": "空闲",
  "nextLabel": "高峰",
  "nextSwitchAt": 1789347657403,
  "fetchedAt": 1789125085432
}
```

失败时返回 `ok:false` 且带 `code`（`no-api-key` / `http-error` / `no-balance-info` / `fetch-error`）与 `message`。

## 实现要点

- 路由以 `kind: 'exact'` 注册，并挂在 `ctx.effect` 上，插件卸载时自动注销。
- 处理器拿到的是原始 `IncomingMessage`，**没有** `req.query`，查询串从 `req.url` 解析。
- 上游请求有 10s 超时；并发读共用同一个 in-flight Promise，避免连点导致请求风暴。
- 响应带 `Cache-Control: no-store`，防止浏览器缓存让手动刷新失效。
- 时段判断先把时间平移 8 小时再读 UTC 字段，结果与宿主时区无关（旧实现叠加 `getTimezoneOffset()`，在东八区宿主上会算错）。

## License

[MIT](./LICENSE)
