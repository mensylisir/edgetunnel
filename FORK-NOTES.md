# 本 Fork 的改动说明

上游：[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)。本仓库是它的 fork，除下列改动外与上游保持一致。

## 一、代码层面（`_worker.js`）

| 项目 | 改动前 | 改动后 |
| :--- | :--- | :--- |
| 文件体积 | 5.0 MB / 33,158 行（其中 4.6 MB 是单个块注释，内含希伯来文《塔纳赫》全文） | 312 KB / 6,742 行 |
| 压缩后体积 | gzip 约 1.05 MB（越过 Workers 免费版 1 MiB 脚本上限） | gzip 约 76 KB |
| 文件头 | 带 UTF-8 BOM（`EF BB BF`） | 无 BOM |
| 会话 Cookie | `MD5(UA + 加密秘钥 + 管理员密码)`，静态不变、服务端不校验有效期 | `到期时间戳.HMAC-SHA256(UA\|到期时间)`，服务端校验签名与有效期，1 天过期 |
| 登录防护 | 无失败计数、无锁定，口令按字符提前返回（时序侧信道） | 同一来源 IP 连续 5 次失败锁定 10 分钟，返回 429；口令做恒定时间比较 |
| 后台密码来源 | `ADMIN / PASSWORD / pswd / TOKEN / KEY / UUID` 任一 | 仅 `ADMIN / PASSWORD / pswd / TOKEN`，不再把 `KEY`、`UUID` 当密码 |
| 节点 UUID 密钥 | 只能用 `KEY`，缺失时用硬编码默认密钥 | 新增 `SECRET`，优先级高于 `KEY`；使用默认密钥时会打印告警 |
| Cloudflare 凭证 | `/admin/getCloudflareUsage?GlobalAPIKey=...` 走 URL | 只读取 KV 中已保存的凭证，URL 传参直接返回 400 |

## 二、环境变量

原有变量不变，新增一个：

| 变量 | 必填 | 说明 |
| :--- | :---: | :--- |
| `SECRET` | 建议 | 参与会话签名与节点 UUID 推导。设置后不再依赖硬编码默认密钥，`KEY` 的快速订阅路径语义保持不变 |

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
npm test         # 认证行为测试（登录、限流、令牌伪造与过期、凭证不外带）
npm run verify   # 以上三步串跑
```

`_worker.js` 是构建产物，不要直接手改：手改的内容会在下一次 `npm run build` 时被覆盖。要改行为请改 `patches/` 下的片段或 `scripts/build.mjs` 的补丁逻辑。

**上游同步**：`.github/workflows/sync.yml` 每天拉取上游，用上游的 `_worker.js` 覆盖本地文件后自动重跑 `build` → `check` → `test`，通过才提交。上游结构变化导致补丁锚点失效时，流程会失败并自动开 issue，不会再强推覆盖本地提交。

## 五、没有“修复”的项，以及原因

1. **第三方单点依赖**：默认反代 IP 指向作者域名，订阅转换走 `sub.cmliussss.net`，静态页走 `edt-pages.github.io`。这些是上游的运行设计，不在本仓库可控范围；可在 Cloudflare 环境变量里用 `PROXYIP`、`URL` 覆盖反代与伪装页，静态页与订阅转换无法替换（除非自行托管）。
2. **代码中的规避检测写法**（`特征码字典` 拼接隐藏仓库地址、域名拆写为 `SsSs.nEt`）：属于上游的对抗性设计，改动会破坏节点连通性，因此保留原状。
3. **合规风险**：此类工具在 Cloudflare ToS 与所在地区法律下都有明确限制，README 的免责声明不构成授权。是否部署、部署在哪，由部署者自行承担。

## 六、部署提醒

- Workers 免费版脚本上限 1 MiB（压缩后）；当前产物 gzip 约 76 KB，余量充足。
- 必须绑定 KV（变量名 `KV`），并设置 `ADMIN`，否则只能看到 `noKV` / `noADMIN` 提示页。
