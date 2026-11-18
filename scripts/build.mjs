import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const 根目录 = join(dirname(fileURLToPath(import.meta.url)), '..');
const 工作文件 = join(根目录, '_worker.js');
const 读取片段 = (名称) => readFileSync(join(根目录, 'patches', 名称), 'utf8').replace(/\n$/, '').split('\n');
const 安全标记 = '安全加固（本 fork 新增）';
const 体积上限 = 900 * 1024;

let 源码 = readFileSync(工作文件, 'utf8');
const 原始字节 = Buffer.byteLength(源码, 'utf8');
const 变更 = [];

if (源码.charCodeAt(0) === 0xfeff) {
	源码 = 源码.slice(1);
	变更.push('移除文件头 UTF-8 BOM');
}

// 只剥掉文件末尾那个超大块注释（上游把整本塔纳赫塞进了 _worker.js）。
// 必须从尾部反查，不能用正则正查：正则会从代码里更早的 /* 起算，把有效代码一并吞掉。
let 注释字节 = 0;
const 尾锚 = 源码.lastIndexOf('*/');
if (尾锚 > 0 && 源码.slice(尾锚 + 2).trim() === '') {
	const 头锚 = 源码.lastIndexOf('/*', 尾锚);
	const 块体 = 头锚 >= 0 ? 源码.slice(头锚, 尾锚) : '';
	if (头锚 > 0 && 块体.length > 100000 && !块体.includes('*/')) {
		注释字节 = Buffer.byteLength(块体 + '*/', 'utf8');
		源码 = 源码.slice(0, 头锚) + 源码.slice(尾锚 + 2);
	}
}
if (注释字节 > 0) 变更.push(`移除末尾超大块注释 ${(注释字节 / 1048576).toFixed(2)} MB`);

const 行 = 源码.split('\n');

function 定位(特征, 起点 = 0) {
	const 位置 = 行.findIndex((内容, 索引) => 索引 >= 起点 && 内容.includes(特征));
	if (位置 < 0) throw new Error(`补丁锚点失效，找不到：${特征} —— 上游结构已变化，请人工复核 scripts/build.mjs`);
	return 位置;
}

if (!源码.includes(安全标记)) {
	const 替换行 = (特征, 新行) => {
		const 位置 = 定位(特征);
		行.splice(位置, 1, ...新行);
	};

	// 密码链必须与上游逐项对齐，否则老部署的 UUID 会变、订阅地址跟着变：
	//   · 少了 env.KEY 回退 → 「只设 KEY」的部署 UUID 从 MD5MD5(KEY+KEY) 变成 MD5MD5("undefined"+KEY)，地址直接变
	//   · 少了 env.UUID 回退 → 「只设 UUID」的部署被判成未配置 ADMIN，/sub 返回 404，订阅直接断
	// env.UUID 是公开值（每个节点链接里都有），不能当登录密码用，所以合法 UUID 只做「非空占位」，
	// 用随机不可猜值代替原值：订阅照常、地址不变，但后台无法用 UUID 撞进来，需补设 ADMIN 才可登录。
	替换行('const 管理员密码 = env.ADMIN', [
		"\t\tconst 环境UUID占位 = env.UUID || env.uuid;",
		"\t\tconst 管理员密码 = env.ADMIN || env.admin || env.PASSWORD || env.password || env.pswd || env.TOKEN || env.KEY || (环境UUID占位 && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(环境UUID占位) ? '仅UUID占位-' + crypto.randomUUID() : 环境UUID占位);"
	]);
	替换行('const 加密秘钥 = env.KEY ||', [
		"\t\tconst 加密秘钥 = env.SECRET || env.KEY || 默认加密秘钥;",
		"\t\t提示默认密钥(加密秘钥);"
	]);

	const 主程序位置 = 定位('主程序入口');
	行.splice(主程序位置, 0, ...readFileSync(join(根目录, 'patches', 'security-helpers.js'), 'utf8').replace(/\n$/, '').split('\n'), '');

	const 登录位置 = 定位("} else if (访问路径 === 'login')");
	const 管理位置 = 定位("} else if (访问路径 === 'admin' || 访问路径.startsWith('admin/'))", 登录位置);
	行.splice(登录位置, 管理位置 - 登录位置, ...读取片段('login-block.txt'));

	const 管理头 = 定位("} else if (访问路径 === 'admin' || 访问路径.startsWith('admin/'))");
	const 管理校验 = 定位('if (!authCookie || authCookie !== await MD5MD5', 管理头);
	行.splice(管理头 + 1, 管理校验 - 管理头, ...读取片段('admin-guard.txt'));

	const 位置头 = 定位("} else if (访问路径 === 'locations')");
	const 位置校验 = 定位('if (authCookie && authCookie == await MD5MD5', 位置头);
	行.splice(位置头 + 1, 位置校验 - 位置头 - 1);
	const 新位置校验 = 定位('if (authCookie && authCookie == await MD5MD5', 位置头);
	行[新位置校验] = 行[新位置校验].replace('if (authCookie && authCookie == await MD5MD5(UA + 加密秘钥 + 管理员密码))', 'if (await 校验会话令牌(读取会话令牌(request), UA, 管理员密码, 加密秘钥))');

	const 用量头 = 定位("} else if (区分大小写访问路径 === 'admin/getCloudflareUsage')");
	const 用量尾 = 定位("} else if (区分大小写访问路径 === 'admin/getADDAPI')", 用量头);
	行.splice(用量头, 用量尾 - 用量头, ...读取片段('usage-route.txt'));

	// PROXYIP 写多个地址时不能随机取一个：随机 = 每次请求换出口 IP，目标站点会当成异地登录。
	// 全量传下去，由 connectProxyIP 按健康度稳定排序后粘住一个，连续失败才切。
	const 反代起始 = 定位('const proxyIPs = await 整理成数组(env.PROXYIP)');
	const 反代结束 = 定位('默认反代兜底 = false;', 反代起始);
	行.splice(反代起始, 反代结束 - 反代起始 + 1,
		'\t\t\tconst proxyIPs = (await 整理成数组(env.PROXYIP)).filter(Boolean);',
		'\t\t\tif (proxyIPs.length) {',
		'\t\t\t\t// 不能只随机取一个：解析地址端口 + connectProxyIP 本来就支持「多候选遍历 + 并发拨号 + 失败换下一个」，',
		'\t\t\t\t// 只取一个等于把这份能力废掉，PROXYIP 里写的其余地址根本不参与选择。',
		'\t\t\t\t// 全部传下去，让 connectProxyIP 按健康度排序后自己挑。',
		"\t\t\t\t默认反代IP = proxyIPs.join(',');",
		'\t\t\t\t默认反代兜底 = false;',
		'\t\t\t}'
	);

	// 健康记忆模块：插到 log() 之后，供 connectProxyIP 排序与记账使用
	const 日志头 = 定位('function log(...args)');
	let 日志尾 = 日志头;
	while (日志尾 < 行.length && 行[日志尾].trim() !== '}') 日志尾++;
	行.splice(日志尾 + 1, 0, '', ...读取片段('proxy-health.js'));

	// connectProxyIP 接入健康排序：不再按索引轮转（轮转 = 出口 IP 漂移）
	替换行('let 反代数组索引 = 0;', []);
	替换行('if (所有反代数组 && 所有反代数组.length > 0) {', [
		'\t\t\tif (所有反代数组 && 所有反代数组.length > 0) {',
		'\t\t\t\t// 按健康度做稳定排序：粘住的排第一，冷却的排最后，其余保持配置顺序。',
		'\t\t\t\t所有反代数组 = 按健康排序反代候选(所有反代数组);'
	]);
	替换行('const 索引 = (反代数组索引 + i + j) % 所有反代数组.length;', [
		'\t\t\t\t\tconst 索引 = (i + j) % 所有反代数组.length;'
	]);
	替换行('反代数组索引 = candidate.index;', [
		'\t\t\t\t\t标记反代成功(candidate.hostname, candidate.port);'
	]);
	替换行('log(`[反代连接] 本批连接失败: ${err.message || err}`);', [
		'\t\t\t\t\t// 整批都失败才记失败：并发时落败的候选是被主动关掉的，不算它不可用',
		'\t\t\t\t\tfor (const 候选 of 候选列表) 标记反代失败(候选.hostname, 候选.port);',
		'\t\t\t\t\tlog(`[反代连接] 本批连接失败: ${err.message || err}`);'
	]);

	变更.push('注入会话令牌/HMAC 校验与登录限流', '收紧密码变量回退链', '引入 SECRET 变量', 'Cloudflare 凭证改为只读 KV', 'PROXYIP 全量候选 + 粘性健康记忆');
}

// 后台面板是纯静态单页（约 1 MB HTML），上游托管在作者的 GitHub Pages 上。
// 它的数据请求全是站点根相对路径，由浏览器打回本 Worker，所以页面放哪儿都不影响功能。
// 这里做两件事：① 基址可由 PAGES_URL 覆盖；② 四个调用点收口到 取静态页()，
// 让 scripts/embed-panel.mjs 可以把面板整份塞进脚本，一个文件、零外部请求。
if (!源码.includes('let 内嵌页面')) {
	const 常量区 = 定位('全局常量和工具函数');
	const 追加 = [];

	if (!源码.includes('function 静态页基址(')) {
		追加.push(
			'// 静态页基址可配置（本 fork 新增）：设环境变量 PAGES_URL 指向自己镜像的后台面板，',
			'// 留空则沿用上游默认地址，行为与上游一致。',
			'function 静态页基址(env) {',
			'\tconst 覆盖 = env && (env.PAGES_URL || env.静态页面);',
			"\treturn 覆盖 ? String(覆盖).trim().replace(/\\/+$/, '') : Pages静态页面;",
			'}',
			''
		);
	}

	追加.push(
		'// 面板内嵌位（本 fork 新增）：默认 null 走网络；由 npm run embed 替换成面板 HTML 后，',
		'// /admin、/login 等页面直接从脚本内部返回，不再请求任何第三方站点。',
		'let 内嵌页面 = null;',
		'',
		'function 取静态页(env, 路径) {',
		"\tconst 键 = 路径.split('?')[0];",
		'\tif (内嵌页面 && Object.prototype.hasOwnProperty.call(内嵌页面, 键)) {',
		"\t\treturn Promise.resolve(new Response(内嵌页面[键], { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));",
		'\t}',
		'\tconst 目标地址 = 静态页基址(env) + 路径;',
		'\treturn fetch(目标地址);',
		'}',
		''
	);

	行.splice(常量区, 0, ...追加);

	let 引用数 = 0;
	for (let 索引 = 0; 索引 < 行.length; 索引++) {
		if (!行[索引].includes('Pages静态页面 +')) continue;
		行[索引] = 行[索引].split('Pages静态页面 +').join('静态页基址(env) +');
		引用数++;
	}
	if (引用数 !== 4) throw new Error(`静态页基址引用点数量异常：期望 4 处，实际 ${引用数} 处 —— 上游结构变了，请复核`);

	let 收口数 = 0;
	for (let 索引 = 0; 索引 < 行.length; 索引++) {
		if (!行[索引].includes('fetch(静态页基址(env) + ')) continue;
		行[索引] = 行[索引].split('fetch(静态页基址(env) + ').join('取静态页(env, ');
		收口数++;
	}
	if (收口数 !== 4) throw new Error(`静态页 fetch 调用点数量异常：期望 4 处，实际 ${收口数} 处 —— 上游结构变了，请复核`);

	变更.push(`后台面板：基址支持 PAGES_URL（${引用数} 处）、调用收口到 取静态页()（${收口数} 处）、可整份内嵌`);
}

源码 = 行.join('\n');

const 必备标记 = [
	安全标记,
	'恒定时间比较(',
	'校验会话令牌(',
	'登录失败上限',
	'默认加密秘钥',
	'env.SECRET || env.KEY',
	'function 静态页基址',
	'env.TOKEN || env.KEY ||',
	"默认反代IP = proxyIPs.join(',')",
	'按健康排序反代候选(',
	'标记反代成功(',
	'class TlsClient',
	'socks5Connect',
	'turnConnect',
	'sstpConnect',
	'处理叉HTTP请求',
	'处理gRPC请求',
	'处理WS请求'
];
const 缺失 = 必备标记.filter((标记) => !源码.includes(标记));
if (缺失.length) throw new Error(`构建产物缺少关键代码或安全补丁（上游可能已覆盖）：${缺失.join('、')}`);

if (!源码.endsWith('\n')) 源码 += '\n';
writeFileSync(工作文件, 源码, 'utf8');

const 输出字节 = Buffer.byteLength(源码, 'utf8');
const 输出行数 = 源码.split('\n').length;
console.log(`构建完成：${(原始字节 / 1048576).toFixed(2)} MB → ${(输出字节 / 1024).toFixed(0)} KB / ${输出行数} 行`);
if (变更.length) console.log(`本次变更：\n  - ${变更.join('\n  - ')}`);
else console.log('文件已是最新状态，无变更');

if (输出字节 > 体积上限) throw new Error(`产物 ${(输出字节 / 1024).toFixed(0)} KB 超过 ${体积上限 / 1024} KB 上限`);
if (输出字节 < 250 * 1024) throw new Error(`产物仅 ${(输出字节 / 1024).toFixed(0)} KB，疑似误删有效代码`);
