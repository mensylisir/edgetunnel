# 本 Fork 的改动说明

上游：[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)。本仓库是它的 fork，除下列改动外与上游保持一致。

## 一、代码层面（`_worker.js`）

| 项目 | 改动前 | 改动后 |
| :--- | :--- | :--- |
| 文件体积 | 5.0 MB / 33,158 行（其中 4.6 MB 是单个块注释，内含希伯来文《塔纳赫》全文） | 313 KB / 6,762 行 |
| 压缩后体积 | gzip 约 1.05 MB | gzip 约 78 KB（面板整份内嵌的独立版 333 KB） |
| 文件头 | 带 UTF-8 BOM（`EF BB BF`） | 无 BOM |
| 会话 Cookie | `MD5(UA + 加密秘钥 + 管理员密码)`，静态不变、服务端不校验有效期 | `到期时间戳.HMAC-SHA256(UA\|到期时间)`，服务端校验签名与有效期，1 天过期 |
| 登录防护 | 无失败计数、无锁定，口令按字符提前返回（时序侧信道） | 同一来源 IP 连续 5 次失败锁定 10 分钟，返回 429；口令做恒定时间比较 |
| 后台密码来源 | `ADMIN / PASSWORD / pswd / TOKEN / KEY / UUID` 任一 | 仅 `ADMIN / PASSWORD / pswd / TOKEN`，不再把 `KEY`、`UUID` 当密码 |
| 节点 UUID 密钥 | 只能用 `KEY`，缺失时用硬编码默认密钥 | 新增 `SECRET`，优先级高于 `KEY`；使用默认密钥时会打印告警 |
| Cloudflare 凭证 | `/admin/getCloudflareUsage?GlobalAPIKey=...` 走 URL | 只读取 KV 中已保存的凭证，URL 传参直接返回 400 |
| 后台面板来源 | 硬编码 `https://edt-pages.github.io`，无法更换 | 调用收口到 `取静态页()`：可设 `PAGES_URL` 指向自建副本，也可由 `npm run embed` 整份内嵌进脚本（零外部请求） |

## 二、环境变量

原有变量不变，新增两个：

| 变量 | 必填 | 说明 |
| :--- | :---: | :--- |
| `SECRET` | 建议 | 参与会话签名与节点 UUID 推导。设置后不再依赖硬编码默认密钥，`KEY` 的快速订阅路径语义保持不变 |
| `PAGES_URL` | 可选 | 后台面板静态文件的托管地址（如 `https://你的面板.pages.dev`）。留空则用上游 `https://edt-pages.github.io`，行为不变 |

## 三、升级时要知道的兼容性变化

1. **旧登录态失效**：Cookie 格式变了，升级后需要重新输入一次后台密码。
2. **只配 `KEY`、不配 `ADMIN` 的部署会变成 `noADMIN` 页**：这是有意的，`KEY` 会出现在 `/{KEY}` 订阅路径里，不能再兼任后台密码。请显式设置 `ADMIN`。
3. **节点 UUID 算法未改**：`MD5(管理员密码 + 加密秘钥)` 保持不变，已导入的节点不会失效。只有当你**主动**设置 `SECRET` 时 UUID 才会变化，此时需要重新导入节点。
4. **`/admin/getCloudflareUsage` 不再接受 URL 参数**：凭证必须先在后台保存到 KV（`cf.json`）。
5. **`wrangler.toml` 的 `name` 改为 `edgetunnel`**：如果你之前用 `v20251104` 这个名字部署过 Worker，改回旧名再部署，避免出现第二个 Worker。

## 四、日常维护

```bash
npm run build    # 用上游 _worker.js 重新生成：去 BOM、去巨型注释、重新打安全补丁
npm run check    # 结构 / 语法 / 补丁完整性 / 体积门禁
npm test         # 认证行为测试（登录、限流、令牌伪造与过期、凭证不外带、面板基址覆盖）
npm run mirror   # 把后台面板四个静态页镜像到 dist/panel，供自建托管或内嵌
npm run embed    # 把镜像好的面板内嵌进脚本，产出 dist/standalone/_worker.js 并自检
npm run verify   # 前三个串跑
```

`_worker.js` 是构建产物，不要直接手改：手改的内容会在下一次 `npm run build` 时被覆盖。要改行为请改 `patches/` 下的片段或 `scripts/build.mjs` 的补丁逻辑。

**上游同步**：`.github/workflows/sync.yml` 每天拉取上游，用上游的 `_worker.js` 覆盖本地文件后自动重跑 `build` → `check` → `test`，通过才提交。上游结构变化导致补丁锚点失效时，流程会失败并自动开 issue，不会再强推覆盖本地提交。

## 五、没有“修复”的项，以及原因

1. **第三方单点依赖**：默认反代 IP 指向作者域名，订阅转换走 `sub.cmliussss.net`。`PROXYIP`、`URL` 可覆盖前两者，订阅转换仍是硬依赖。**后台面板已可自建**（见第七节），`PAGES_URL` 一设就断开。
2. **代码中的规避检测写法**（`特征码字典` 拼接隐藏仓库地址、域名拆写为 `SsSs.nEt`）：属于上游的对抗性设计，改动会破坏节点连通性，因此保留原状。
3. **合规风险**：此类工具在 Cloudflare ToS 与所在地区法律下都有明确限制，README 的免责声明不构成授权。是否部署、部署在哪，由部署者自行承担。

## 六、部署提醒

- Workers 体积上限是 **64 MiB（未压缩）**，且没有压缩后上限；当前产物 313 KB，gzip 78 KB。独立内嵌版 1.54 MB，同样远低于上限。
- 必须绑定 KV（变量名 `KV`），并设置 `ADMIN`，否则只能看到 `noKV` / `noADMIN` 提示页。

> 更正：先前说明里写过“gzip 1.05 MB 越过免费版 1 MiB 上限”，那是已经废止的旧限制。剥离 4.6 MB 注释的真实收益是全局作用域的解析开销（启动时间上限 1 秒）、仓库与 clone 体积、以及可读的 diff，而不是撞体积墙。

## 七、后台面板：三种取得方式

面板是**纯静态单页**：`/admin/`、`/login/`、`/noADMIN/`、`/noKV/` 各一个 HTML 文件，上游用 GitHub Pages 托管（响应头 `server: GitHub.com`，前置 Fastly CDN），没有服务端逻辑。它所有数据请求（`/admin/config.json`、`/admin/init`、`/version` …）都是站点根相对路径，由浏览器打回**你自己的 Worker 域名**，所以页面放哪儿都能用。

| 方式 | 运行期是否请求别人服务器 | 面板更新 | 操作 |
| :--- | :--- | :--- | :--- |
| 默认（不设变量） | 是，每次打开都去 `edt-pages.github.io` 取 | 自动跟随上游 | 无 |
| 自建静态托管 | 否，只请求你自己的站点 | 手动 `npm run mirror` + 重新部署 | 建一个静态站点，设 `PAGES_URL` |
| **整份内嵌进脚本** | **否，零外部请求** | 手动 `npm run mirror && npm run embed` | 只上传一个 `_worker.js` |

内嵌是三者里最省事的：不新增项目、不设变量，`/admin` 直接从你自己的脚本里返回。代价是脚本涨到 1.54 MB，且面板不再自动跟随上游。

```bash
npm run mirror   # 拉四个页面到 dist/panel
npm run embed    # 生成 dist/standalone/_worker.js，自检：内嵌命中 + 零外部请求
```

为什么要搬：面板 JS 运行在你的后台域名下，能带着你的会话 Cookie 调 `/admin/init` 改写 KV 配置。作者若改动或投毒那个仓库，等于拿到你的面板控制权。搬走之后这条链路只剩你自己的托管。

镜像目录结构就是站点根目录：`admin/index.html`、`login/index.html`、`noADMIN/index.html`、`noKV/index.html`。

**残留的第三方请求**：面板 HTML 里引用了 Google Fonts（字体）、`ipdata.co`（国家旗帜图）；面板 JS 还会在浏览器侧调 `api.ipapi.is`、`api.090227.xyz` 做 IP 归属地查询。这些是页面自身的内容与功能请求，不携带你的后台凭证，也不经过你的 Worker；去掉需要改面板 JS。
