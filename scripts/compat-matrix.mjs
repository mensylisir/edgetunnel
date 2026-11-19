// 订阅地址兼容性矩阵：对多种环境变量组合，逐一比对「上游原版」与「当前版本」算出的 UUID / token。
// 目的：回答"别人拿这个仓库去更新旧部署，订阅地址会不会变"——不能只测一种组合。
// 用法：node scripts/compat-matrix.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const 根目录 = dirname(dirname(fileURLToPath(import.meta.url)));
const 缓存目录 = join(根目录, '.cache');
const 上游引用 = '5b2aaf0';
const 域名 = 'tunnel.example.com';
const 默认加密秘钥 = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';

// 与 Worker 内 MD5MD5 同构
const 双MD5 = (文本) => {
	const 一 = createHash('md5').update(Buffer.from(String(文本), 'utf8')).digest('hex');
	return createHash('md5').update(Buffer.from(一.slice(7, 27), 'utf8')).digest('hex');
};
const 成UUID = (摘要) => [摘要.slice(0, 8), 摘要.slice(8, 12), '4' + 摘要.slice(13, 16), '8' + 摘要.slice(17, 20), 摘要.slice(20)].join('-');

const 原始digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
globalThis.crypto.subtle.digest = async (算法, 数据) => {
	const 名 = String(typeof 算法 === 'string' ? 算法 : (算法?.name || '')).toUpperCase();
	if (名 !== 'MD5') return 原始digest(算法, 数据);
	const 结果 = createHash('md5').update(new Uint8Array(数据)).digest();
	return 结果.buffer.slice(结果.byteOffset, 结果.byteOffset + 结果.byteLength);
};
globalThis.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } });

const 造KV = () => {
	const 表 = new Map();
	return {
		get: async (键) => (表.has(键) ? 表.get(键) : null),
		put: async (键, 值) => { 表.set(键, 值); },
		delete: async (键) => { 表.delete(键); },
		list: async () => ({ keys: [], list_complete: true })
	};
};
const 上下文 = { waitUntil() { }, passThroughOnException() { } };
const 造请求 = (路径) => ({
	url: 'https://' + 域名 + 路径,
	method: 'GET',
	headers: new Headers({ 'User-Agent': 'v2rayN/6.0', 'CF-Connecting-IP': '198.51.100.9' }),
	cf: { colo: 'HKG' },
	text: async () => ''
});

function 提取UUID(正文) {
	const 可读 = 正文.includes('vless://') ? 正文 : Buffer.from(正文, 'base64').toString('utf8');
	const 命中 = [...可读.matchAll(/vless:\/\/([0-9a-fA-F-]{36})@/g)].map((m) => m[1].toLowerCase());
	return [...new Set(命中)];
}

function 取上游文件() {
	const 目标 = join(缓存目录, '_worker.upstream.js');
	const 结果 = spawnSync('git', ['show', 上游引用 + ':_worker.js'], { cwd: 根目录, maxBuffer: 64 * 1024 * 1024 });
	if (结果.status !== 0) {
		if (existsSync(目标)) return 目标;
		throw new Error('取不到上游版本 ' + 上游引用 + ':_worker.js');
	}
	mkdirSync(缓存目录, { recursive: true });
	writeFileSync(目标, 结果.stdout);
	return 目标;
}

// 上游原版密码链（含 KEY / UUID 回退），当前版本密码链（不含）
const 密码链_上游 = (env) => env.ADMIN || env.admin || env.PASSWORD || env.password || env.pswd || env.TOKEN || env.KEY || env.UUID || env.uuid;
const 密码链_当前 = (env) => {
	const u = env.UUID || env.uuid;
	return env.ADMIN || env.admin || env.PASSWORD || env.password || env.pswd || env.TOKEN || env.KEY
		|| (u && uuid正则.test(u) ? '仅UUID占位-随机值' : u);
};
const 秘钥链 = (env) => env.SECRET || env.KEY || 默认加密秘钥;
const uuid正则 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

// 静态推导：给定 env 与密码链，算出订阅里会出现的 UUID
async function 推导UUID(env, 取密码) {
	const 管理员密码 = 取密码(env);
	const 摘要 = 双MD5(管理员密码 + 秘钥链(env));
	const envUUID = env.UUID || env.uuid;
	return (envUUID && uuid正则.test(envUUID)) ? envUUID.toLowerCase() : 成UUID(摘要);
}

const 用例 = [
	['ADMIN', { ADMIN: 'pass-admin-1' }],
	['PASSWORD', { PASSWORD: 'pass-admin-2' }],
	['TOKEN', { TOKEN: 'pass-admin-3' }],
	['只设 KEY', { KEY: 'key-only-secret-4' }],
	['只设 SECRET', { SECRET: 'secret-only-5' }],
	['ADMIN+KEY', { ADMIN: 'pass-admin-6', KEY: 'key-with-admin-6' }],
	['ADMIN+SECRET', { ADMIN: 'pass-admin-7', SECRET: 'secret-with-admin-7' }],
	['只设 UUID', { UUID: '3de3b793-296c-4e23-86c7-484463559628' }],
	['ADMIN+UUID', { ADMIN: 'pass-admin-8', UUID: '3de3b793-296c-4e23-86c7-484463559628' }],
	['UUID 格式非法', { UUID: 'not-a-valid-uuid' }],
	['KEY+UUID非法', { KEY: 'key-mixed-9', UUID: 'not-a-valid-uuid' }],
	['全空(默认密钥)', {}]
];

const 上游路径 = 取上游文件();
// 与 compat-uuid.mjs 一致：优先独立版，未 embed 时回退到 build 产物
const 当前路径 = (() => {
	for (const 路径 of [join(根目录, 'dist', 'standalone', '_worker.js'), join(根目录, '_worker.js')]) {
		if (existsSync(路径)) return 路径;
	}
	throw new Error('取不到当前版本：先跑 npm run build（或 npm run build && npm run mirror && npm run embed）');
})();
const 上游模块 = (await import(pathToFileURL(上游路径).href)).default;
const 当前模块 = (await import(pathToFileURL(当前路径).href)).default;

console.log('域名：' + 域名 + '\n');
const 表头 = ['场景', '上游UUID', '当前UUID', 'UUID一致', '上游/当前 状态', '订阅地址'];
console.log(表头.join(' | '));
console.log('-'.repeat(96));

const 记录 = [];
for (const [名, 基础env] of 用例) {
	const 上游UUID = await 推导UUID(基础env, 密码链_上游);
	const 当前UUID = await 推导UUID(基础env, 密码链_当前);

	const 跑 = async (模块, UUID) => {
		const token = 双MD5(域名 + UUID);
		const env = { ...基础env, KV: 造KV() };
		const 响应 = await 模块.fetch(造请求('/sub?token=' + token), env, 上下文);
		const 正文 = await 响应.text();
		return { 状态: 响应.status, 字节: 正文.length, UUID: 提取UUID(正文) };
	};

	const 上游结果 = await 跑(上游模块, 上游UUID);
	const 当前结果 = await 跑(当前模块, 当前UUID);

	// 真正决定"地址变没变"的：同一份 token 在两版下是否都拿到订阅
	const 上游token = 双MD5(域名 + 上游UUID);
	const 当前用旧token = await 当前模块.fetch(造请求('/sub?token=' + 上游token), { ...基础env, KV: 造KV() }, 上下文);
	const 旧token可用 = 当前用旧token.status === 200;

	const 一致 = 上游UUID === 当前UUID;
	const 上游可用 = 上游结果.状态 === 200;
	const 可用性一致 = 上游可用 === 旧token可用;
	const 结论 = 一致 && 可用性一致 ? '不变' : (一致 ? '订阅会断' : '会变');
	console.log([名, 上游UUID.slice(0, 8) + '…', 当前UUID.slice(0, 8) + '…', 一致 ? '是' : '否', 上游结果.状态 + '/' + 当前结果.状态 + ' 旧token' + (旧token可用 ? '可用' : '失效'), 结论].join(' | '));
	记录.push({ 名, 上游UUID, 当前UUID, 一致, 旧token可用, 上游可用, 上游结果, 当前结果, 基础env, 上游token });
}

console.log('');
const 破的点 = 记录.filter((r) => !r.一致 || r.上游可用 !== r.旧token可用);
if (!破的点.length) {
	console.log('结论：全部 ' + 记录.length + ' 种变量组合下订阅地址均不变。');
	process.exit(0);
}
console.log('发现 ' + 破的点.length + ' 种组合订阅地址会变：');
for (const r of 破的点) {
	console.log('  - ' + r.名 + '：上游 ' + r.上游UUID + ' → 当前 ' + r.当前UUID);
}
writeFileSync(join(缓存目录, 'compat-matrix.json'), JSON.stringify(记录.map(({ 名, 上游UUID, 当前UUID, 一致, 旧token可用 }) => ({ 名, 上游UUID, 当前UUID, 一致, 旧token可用 })), null, 2));
process.exit(1);
