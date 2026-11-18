import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const 根目录 = join(dirname(fileURLToPath(import.meta.url)), '..');
const 目标 = join(根目录, '_worker.js');
const 原始内容 = readFileSync(目标);
const 源码 = 原始内容.toString('utf8');
const 字节数 = 原始内容.length;
const 行数 = 源码.split('\n').length;

const 结果 = [];
const 记录 = (名称, 通过, 说明) => 结果.push({ 名称, 通过, 说明 });

记录('无 UTF-8 BOM', 原始内容[0] !== 0xef || 原始内容[1] !== 0xbb || 原始内容[2] !== 0xbf, `首字节 ${原始内容.subarray(0, 3).toString('hex')}`);
记录('体积在 250 KB ~ 900 KB', 字节数 >= 250 * 1024 && 字节数 <= 900 * 1024, `${(字节数 / 1024).toFixed(0)} KB`);
记录('行数 ≥ 6000', 行数 >= 6000, `${行数} 行`);

// 精确检测「整行开启、跨 500 行以上才关闭」的块注释：上游曾把整本塔纳赫塞进这样一个注释里。
// 不用正则正查 /\/\*[\s\S]{50000,}?\*\//，那会把 /** @type ... *\/ 之类的行内注释误判成巨型注释。
let 巨型注释行数 = 0, 注释起始 = -1;
const 全部行 = 源码.split('\n');
for (let 索引 = 0; 索引 < 全部行.length; 索引++) {
	const 内容 = 全部行[索引].trim();
	if (注释起始 === -1 && 内容.startsWith('/*')) { 注释起始 = 索引; continue; }
	if (注释起始 !== -1 && 内容.endsWith('*/')) {
		if (索引 - 注释起始 > 500) 巨型注释行数 = Math.max(巨型注释行数, 索引 - 注释起始);
		注释起始 = -1;
	}
}
记录('无跨 500 行的块注释', 巨型注释行数 === 0, 巨型注释行数 ? `存在 ${巨型注释行数} 行的巨型注释` : '未发现');
记录('无上游冗余注释内容', !源码.includes('Tanach with Nikkud') && !源码.includes('www.tanach.us'), '未发现塔纳赫注释残留');

const 语法 = spawnSync(process.execPath, ['--check', 目标], { encoding: 'utf8' });
记录('JS 语法检查', 语法.status === 0, 语法.status === 0 ? 'node --check 通过' : (语法.stderr || '').split('\n')[0]);

const 代码标记 = ['class TlsClient', 'socks5Connect', 'turnConnect', 'sstpConnect', '处理叉HTTP请求', '处理gRPC请求', '处理WS请求', '处理订阅'];
const 缺失代码 = 代码标记.filter((标记) => !源码.includes(标记));
记录('核心逻辑完整', 缺失代码.length === 0, 缺失代码.length ? `缺少：${缺失代码.join('、')}` : `${代码标记.length} 个关键符号齐备`);

const 补丁标记 = ['安全加固（本 fork 新增）', '恒定时间比较(', '生成会话令牌(', '校验会话令牌(', '登录失败上限', 'env.SECRET || env.KEY', 'function 静态页基址'];
const 缺失补丁 = 补丁标记.filter((标记) => !源码.includes(标记));
记录('安全补丁在位', 缺失补丁.length === 0, 缺失补丁.length ? `缺少：${缺失补丁.join('、')}` : `${补丁标记.length} 个补丁标记齐备`);

const 旧Cookie = 源码.includes('MD5MD5(UA + 加密秘钥 + 管理员密码)');
记录('旧静态 Cookie 已移除', !旧Cookie, 旧Cookie ? '仍存在 MD5(UA+KEY+ADMIN) 会话判定' : '已全部改为 HMAC 令牌校验');

// 密码链决定 UUID，UUID 决定 token，token 就是订阅地址。所以这里必须和上游逐项对齐：
// 少一项回退，只设那一项的老部署更新后订阅地址就会变（或缺 ADMIN 判定导致 404）。
const 密码链 = (源码.match(/\|\| env\.TOKEN \|\|[^\n]*/) || [''])[0];
const 保留KEY回退 = /\|\| env\.KEY \|\|/.test(密码链);
记录('密码链保留 KEY 回退', 保留KEY回退, 保留KEY回退 ? '只设 KEY 的老部署 UUID 不变' : '缺少 env.KEY 回退，只设 KEY 的部署订阅地址会变');
const UUID直连密码 = /\|\| env\.(UUID|uuid)\b/.test(密码链) && !密码链.includes('仅UUID占位');
记录('UUID 原文不当后台密码', !UUID直连密码, UUID直连密码 ? 'env.UUID 是公开值，出现在每个节点链接里' : '仅作非空占位，用随机不可猜值代替');

// PROXYIP 健康记忆同样要求逐字节一致：改了 patches/proxy-health.js 忘了重新注入，
// 线上跑的还是旧策略（随机/轮转），而出口 IP 漂移正是这里要防的。
let 健康一致 = false, 健康说明 = '';
try {
	const 健康补丁 = readFileSync(join(根目录, 'patches', 'proxy-health.js'), 'utf8');
	const 起 = 源码.indexOf('// >>> PROXYIP 健康记忆');
	const 止 = 源码.indexOf('// <<< PROXYIP 健康记忆');
	const 补丁起 = 健康补丁.indexOf('// >>> PROXYIP 健康记忆');
	const 补丁止 = 健康补丁.indexOf('// <<< PROXYIP 健康记忆');
	if (起 < 0 || 止 < 0 || 补丁起 < 0 || 补丁止 < 0) {
		健康说明 = '找不到 PROXYIP 健康记忆模块标记';
	} else {
		健康一致 = 源码.slice(起, 止) === 健康补丁.slice(补丁起, 补丁止);
		健康说明 = 健康一致 ? '与 patches/proxy-health.js 一致' : '与 patches/proxy-health.js 不一致，需重新注入';
	}
} catch (错误) {
	健康说明 = '读取 patches/proxy-health.js 失败：' + 错误.message;
}
记录('PROXYIP 健康策略已同步', 健康一致, 健康说明);

// 出口 IP 稳定性：多候选必须是「粘住 + 故障才切」，不能是随机或轮转
const 反代随机 = /proxyIPs\[Math\.floor\(Math\.random\(\) \* proxyIPs\.length\)\]/.test(源码);
记录('PROXYIP 全量候选', !反代随机, 反代随机 ? '仍在随机取一个，其余地址不参与选择' : '全部候选下传，由健康排序挑选');
const 反代轮转 = 源码.includes('(反代数组索引 + i + j)');
记录('出口 IP 不轮转', !反代轮转, 反代轮转 ? '仍按索引轮转，出口 IP 会在候选间漂移' : '粘住优先，连续失败才切换');

// 页面优选：内嵌的前端脚本必须和 patches/page-bestip.js 逐字节一致，否则改了源文件忘了同步，
// 线上跑的还是旧逻辑。这个坑很隐蔽，所以放进硬门禁。
const 前端文件 = join(根目录, 'patches', 'page-bestip.js');
let 内嵌一致 = false, 内嵌说明 = '';
try {
	const 前端源码 = readFileSync(前端文件, 'utf8');
	const 起 = 源码.indexOf('const 页面优选脚本 = String.raw`');
	const 止 = 起 > -1 ? 源码.indexOf('\n`;', 起) : -1;
	if (起 < 0 || 止 < 0) {
		内嵌说明 = '_worker.js 里找不到内嵌脚本块';
	} else {
		const 内嵌 = 源码.slice(起 + 'const 页面优选脚本 = String.raw`'.length, 止).trim();
		内嵌一致 = 内嵌 === 前端源码.trim();
		内嵌说明 = 内嵌一致 ? '与 patches/page-bestip.js 一致' : '与源文件不一致，跑 npm run sync:bestip';
	}
} catch (错误) {
	内嵌说明 = '读取 patches/page-bestip.js 失败：' + 错误.message;
}
记录('页面优选脚本已同步', 内嵌一致, 内嵌说明);

const 优选标记 = ['function 生成候选地址(', 'async function 查地址归属(', 'async function 注入优选脚本(', "区分大小写访问路径 === 'admin/bestip.js'", "'admin/bestip/candidates'", "'admin/bestip/geo'", '注入优选脚本(await 取静态页(env, \'/admin\' + url.search))'];
const 缺失优选 = 优选标记.filter((标记) => !源码.includes(标记));
记录('页面优选接口齐全', 缺失优选.length === 0, 缺失优选.length ? `缺少：${缺失优选.join('、')}` : `${优选标记.length} 个接口与注入点齐备`);

const 宽度 = Math.max(...结果.map((项) => 项.名称.length));
for (const 项 of 结果) console.log(`${项.通过 ? '通过' : '失败'}  ${项.名称.padEnd(宽度, '　')}  ${项.说明}`);

const 失败数 = 结果.filter((项) => !项.通过).length;
if (失败数) {
	console.error(`\n${失败数} 项检查未通过`);
	process.exit(1);
}
console.log(`\n全部 ${结果.length} 项检查通过`);
