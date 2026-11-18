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
npm run build        # 用上游 _worker.js 重新生成：去 BOM、去巨型注释、重新打安全补丁
npm run check        # 结构 / 语法 / 补丁完整性 / 体积门禁 / 内嵌脚本一致性
npm test             # 认证行为 + 页面优选接口（共 21 条：登录限流、令牌伪造、候选生成、归属缓存…）
npm run sync:bestip  # 把 patches/page-bestip*.js 同步进 _worker.js（改了浮层脚本后必跑）
npm run mirror       # 把后台面板四个静态页镜像到 dist/panel，供自建托管或内嵌
npm run embed        # 把镜像好的面板内嵌进脚本，产出 dist/standalone/_worker.js 并自检
npm run e2e:bestip   # 用真实 chromium 点开浮层、跑一次测速、写入订阅（需本机 chromium）
npm run verify       # build + check + test 串跑
```

`_worker.js` 是构建产物，不要直接手改：手改的内容会在下一次 `npm run build` 时被覆盖。要改行为请改 `patches/` 下的片段或 `scripts/build.mjs` 的补丁逻辑。唯一的例外是 `patches/` 里没有对应片段的功能（例如页面优选的路由），那部分直接写在 `_worker.js` 里，`build.mjs` 不会动它。

**上游同步：已停止。** 本仓库自 v3 起自持分支，`.github/workflows/sync.yml` 已删除，不再每天拉取上游。`_worker.js` 现在是真正的主源，可以直接改；`scripts/build.mjs` 只在你想把补丁重新打到一份新的上游文件上时才用（它会跳过已打补丁的文件，不会覆盖手改内容）。`verify.yml` 仍会在每次推送时跑 `build` → `check` → `test` 作为门禁。

## 五、没有“修复”的项，以及原因

1. **第三方单点依赖**：默认反代 IP 指向作者域名，订阅转换走 `sub.cmliussss.net`。`PROXYIP` 可覆盖前者，订阅转换仍需要在线 `SUBAPI`（除非自建 subconverter）。**后台面板这条已经断开了**：用 `edgetunnel-standalone.zip` 时四个页面全在脚本内部，运行期一次都不请求作者服务器（见第六、七节）。
2. **代码中的规避检测写法**（`特征码字典` 拼接隐藏仓库地址、域名拆写为 `SsSs.nEt`）：属于上游的对抗性设计，改动会破坏节点连通性，因此保留原状。
3. **合规风险**：此类工具在 Cloudflare ToS 与所在地区法律下都有明确限制，README 的免责声明不构成授权。是否部署、部署在哪，由部署者自行承担。

## 六、部署提醒

- Workers 体积上限是 **64 MiB（未压缩）**，且没有压缩后上限；基础版 341 KB，独立内嵌版 1.56 MB，都远低于上限。
- 必须绑定 KV（变量名 `KV`），并设置 `ADMIN`，否则会看到 `noKV` 提示页或直接返回 `Welcome to nginx` 伪装页（这是上游的默认兜底行为，不是故障）。

```bash
npm run pack     # 打两个包：embed 生成独立版 → zip → 校验包内文件与源码逐字节一致
```

| 包 | 体积 | 面板来源 | 用途 |
| :--- | :--- | :--- | :--- |
| `dist/edgetunnel-standalone.zip` | 343 KB | **脚本内置，4 个页面全在代码里** | 只要单文件、运行期不取第三方页面的场景 |
| `dist/edgetunnel-pages.zip` | 88 KB | 运行时按 `PAGES_URL` 或上游地址实时取 | 想继续跟随上游面板的场景 |
| `dist/edgetunnel-panel.zip` | 253 KB | 自建静态站，供 `PAGES_URL` 指向 | 想自己托管面板但又不愿把 1.5 MB 塞进脚本 |

三个包内都是根目录一个 `_worker.js`，Pages 的“上传资产”直接认。

## 六之二、残余外部请求清单（实测，非估计）

“零依赖”只对面板页面成立。整份程序跑起来仍然会访问下面这些地址，按能否替换分类：

**Worker 侧（你的脚本主动发起）**

| 地址 | 什么时候会发生 | 能否替换 |
| :--- | :--- | :--- |
| `${colo}.<拼接域名>` 默认反代 IP | 每个出站连接，未设 `PROXYIP` 时 | 设 `PROXYIP` 即完全替换 |
| `sub.cmliussss.net`（`SUBAPI`） | 拉 Clash / Sing-box / Surge 订阅且走在线转换时 | 面板配置里换成自建 subconverter |
| `ip-api.com/batch` | 面板内「优选测速」查归属地 | 有 KV 缓存 7 天；查不到就标“未知”，不影响测速与写入 |
| `raw.githubusercontent.com/…/CF-CIDR.txt` | 运营商优选取段，失败回落到 `104.16.0.0/13` | 有内置兜底 |
| `dns.alidns.com` / `sm2.doh.pub` / `cloudflare-dns.com` | 反代目标是域名时的 DoH 解析 | 只在用域名型 `PROXYIP` 时触发 |
| `api.cloudflare.com` | 面板查账号用量（需先存凭证） | 不用该功能即不触发 |
| `api.telegram.org` | 开了 TG 通知 | 不配 BotToken 即不触发 |

**浏览器侧（面板页面自己发起，不经过你的 Worker、不带后台凭证）**

| 地址 | 用途 |
| :--- | :--- |
| `fonts.googleapis.com` / `fonts.gstatic.com` | 面板字体 |
| `ipdata.co` | 节点列表里的国家旗帜图 |
| `api.ipapi.is` / `api.090227.xyz` | 面板自带的 IP 归属地查询 |

这两组都在浏览器里，改它需要动面板 JS 本身；删掉不影响后台管理与订阅生成，只影响对应显示。

**订阅地址是否会变**：不会，只要 `ADMIN`、`KEY`/`SECRET`、`HOST` 三个值不变。订阅令牌是 `MD5(host + UUID)`，UUID 是 `MD5(管理员密码 + 加密秘钥)`，两者都是纯函数，跟代码版本无关。快速订阅地址 `/{KEY}` 同理。

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

## 八、按本机网络优选，并让订阅显示国家

有两条路，**面板里那条是首选**（不用开终端），命令行那条留给批量/定时场景。

### 8.1 在 `/admin` 页面里直接测（推荐）

登录后台后，右下角有个 **⚡ 优选测速** 浮层按钮：

1. 点开，填「候选 IP」（默认 60）、「端口」（默认 `443,2053,2083`）、「保留」（默认 10）；
2. 点「开始测速」，浏览器会并发对每个 `IP:端口` 发一次 HTTPS 请求，约 10~20 秒出排名；
3. 表格按延迟升序显示 `地址 / 国家·城市 / 延迟`，默认全勾选；
4. 点「写入订阅」，它自动做两件事：把「随机IP」开关关掉、把勾选结果写进 `ADD.txt`，并回读校验。

订阅备注随后变成 `188.114.99.51:2083#中国香港·430ms` 这种形式，客户端节点列表里直接能看到国家和延迟。

**原理**（为什么浏览器能测出延迟）：请求 `https://IP:端口/` 时 SNI 是 IP，证书必然不匹配，但 TCP+TLS 握手已经跑完才会报错。这个「报错前的耗时」就是本机到该 IP 的真实 RTT；死 IP 则是一路超时，两者区分得开。已交叉验证：活 IP 报证书错耗时 395~537 ms，假 IP 6 s 超时，与 `curl --resolve` 的 `time_appconnect` 基本吻合。

**接口**（都要求已登录，未登录一律 302 到 `/login`）：

| 路径 | 作用 |
| :--- | :--- |
| `GET /admin/bestip.js` | 浮层脚本本体（由 `patches/page-bestip.js` 原样内嵌） |
| `GET /admin/bestip/candidates?count=60&ports=443,2053` | 从内置 Cloudflare 官方网段等距取点生成候选 |
| `GET /admin/bestip/geo?ips=a,b,c` | 批量查归属地（ip-api.com，最多 100 条/次，KV 缓存 7 天） |

**浮层是怎么挂上去的**：`/admin` 返回 HTML 时由 `注入优选脚本()` 在 `</body>` 前插入一行 `<script src="/admin/bestip.js" defer>`。不改面板源码，所以面板将来更新也照样生效；`PAGES_URL` 自建面板、内嵌面板两种模式都适用。

**改脚本的流程**：前端逻辑在 `patches/page-bestip.js`，Worker 侧在 `patches/page-bestip-worker.js`，改完跑 `npm run sync:bestip` 同步进 `_worker.js`。`npm run check` 会比对两边 sha256，忘了同步会直接报错。

**这个功能的三个真实限制**：

- **国家/城市取自 IP 归属地数据库，不是你实际落地的机房。** 任播网络下实际出口由你所在位置决定，同一个 IP 在别处连可能落到别的机房。要精确的落地机房，走 8.2 的命令行脚本（它能读 `colo`）。
- **浏览器挂了代理，测出的耗时会含代理开销**，数值偏大。要测裸线路先关掉代理再测。
- **候选可用率不高**（本机实测 60 个里通 14 个，约 23%）。任播大段里很多地址不被路由。可用数不够时把候选数调大重测，界面会提示。

### 为什么面板里的「随机优选」没有国家、也不快

`生成随机IP()` 从 `CF-CIDR.txt`（兜底 `104.16.0.0/13`）里随机抽 IP、随机挑端口，备注直接拼 `${cfname}${序号}`，全程不测速、不查位置。而 `104.16.0.0/13` 是上百万个任播地址，随机抽样等价于瞎猜：抽到的 IP 在哪个机房落地，取决于**你的**网络怎么路由过去，跟 IP 本身无关。所以备注里的“1、2、3”只是编号，不是地区。

### 8.2 命令行批量优选（备选，能拿到落地机房）

### 真正决定“节点在哪”的是落地机房

Cloudflare 是任播：同一个 IP，你在香港连就落香港机房，在美国连就落洛杉矶机房。因此：

- **节点位置 = 你实测到的机房（colo）**，不是 IP 的注册地；
- **快不快 = 你本机到该 IP:端口 的握手延迟**，Worker 在边缘测不出来——它到该 IP 的距离跟你到该 IP 的距离无关。

`scripts/optimize.mjs` 就是按这两条做的：在你自己的机器上逐个握手、读 `cdn-cgi/trace` 的 `colo`、按延迟排序，再把带国家/城市/延迟的备注写回 KV。

```bash
# 只测不写，看排名
npm run optimize -- --host 你的域名 --dry

# 测完写入：登录 → 关闭随机优选 → 写 ADD.txt → 回读校验
npm run optimize -- --host 你的域名 --password 你的后台密码
```

可用参数：`--sample 200`（候选 IP 数，越大越慢但越容易命中好线路）、`--ports 443,2053`、`--top 16`、`--timeout 4000`、`--concurrency 16`。

想让它自己定期跑（Cloudflare 的 Cron 触发器做不到这件事，它测的是边缘到 IP 的距离，不是你的），就在跑代理客户端的那台机器上加一条系统定时任务：

```bash
# 每 6 小时重测一次并覆盖 KV，密码从环境变量读，不写进命令行
0 */6 * * * EDGETUNNEL_PASSWORD='你的密码' /usr/bin/node /path/to/edgetunnel/scripts/optimize.mjs --host 你的域名 >> /var/log/edgetunnel-optimize.log 2>&1
```

写入后的订阅备注形如 `104.16.132.235:443#美国·洛杉矶·138ms`：国家与城市取自实测落地机房，延迟是你本机到该 IP 的握手耗时。想换回随机优选，在面板里把优选来源切回「随机」即可。

### 机房 → 位置对照（内置的一部分）

`HKG 中国香港·香港`、`TPE 中国台湾·台北`、`NRT 日本·东京`、`KIX 日本·大阪`、`ICN 韩国·首尔`、`SIN 新加坡`、`LAX 美国·洛杉矶`、`SJC/SFO 美国·旧金山`、`SEA 美国·西雅图`、`DEN 美国·丹佛`、`DFW 美国·达拉斯`、`ORD 美国·芝加哥`、`IAD 美国·华盛顿`、`JFK 美国·纽约`、`YYZ 加拿大·多伦多`、`LHR 英国·伦敦`、`FRA 德国·法兰克福`、`AMS 荷兰·阿姆斯特丹`、`CDG 法国·巴黎`、`SYD 澳大利亚·悉尼`。表里没有的代码回落到 IP 注册地并标注「注册地」。

### 实测口径与已知限制

- 延迟来自**运行脚本的这台机器**。如果你的代理客户端在另一台设备上，请在那台设备上跑同一个脚本，否则测的是别处的线路。
- 候选里有相当比例连不通（本机实测约 80% 失败，多为连接被重置或超时）。脚本会补测一次，命中率仍与所在网络有关；命中少时把 `--sample` 调大。
- 只测 TCP+TLS 握手与首字节，不测下载吞吐。要测吞吐请在客户端里对这几个节点做一次实际测速。
- 免费版 Workers 每天 10 万请求，本脚本只在你手动执行时访问你的域名几次（登录、读配置、写文件、回读），不占额度。
