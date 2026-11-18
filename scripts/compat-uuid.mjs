// 订阅地址兼容性 A/B 测试：上游原版与新版本在同一份 env 下必须产出同一个 UUID / token。
// 用法：node scripts/compat-uuid.mjs [--ref 5b2aaf0] [--admin 合成密码] [--host 域名]
// 任何不一致都以退出码 1 结束，可直接挂进 CI。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const 根目录 = dirname(dirname(fileURLToPath(import.meta.url)));
const 缓存目录 = join(根目录, '.cache');
const 参数 = process.argv.slice(2);
const 取参 = (名, 默认) => {
	const 位置 = 参数.indexOf('--' + 名);
	return 位置 > -1 && 参数[位置 + 1] ? 参数[位置 + 1] : 默认;
};
const 上游引用 = 取参('ref', '5b2aaf0');
const 合成密码 = 取参('admin', 'compat-admin-pass');
const 域名 = 取参('host', 'tunnel.example.com');

// 与 Worker 内 MD5MD5 同构：两次 MD5，第二次取第一次十六进制的 [7,27)
const 双MD5 = (文本) => {
	const 一 = createHash('md5').update(Buffer.from(文本, 'utf8')).digest('hex');
	return createHash('md5').update(Buffer.from(一.slice(7, 27), 'utf8')).digest('hex');
};

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

// 订阅正文是 base64 的节点列表，统一解码后再取 UUID
function 提取UUID(正文) {
	const 可读 = 正文.includes('vless://') ? 正文 : Buffer.from(正文, 'base64').toString('utf8');
	const 命中 = [...可读.matchAll(/vless:\/\/([0-9a-fA-F-]{36})@/g)].map((匹配) => 匹配[1].toLowerCase());
	return [...new Set(命中)];
}

function 取上游文件() {
	const 目标 = join(缓存目录, '_worker.upstream.js');
	const 结果 = spawnSync('git', ['show', 上游引用 + ':_worker.js'], { cwd: 根目录, maxBuffer: 64 * 1024 * 1024 });
	if (结果.status !== 0) {
		if (existsSync(目标)) {
			console.warn('取不到 git ' + 上游引用 + ':_worker.js，改用 .cache 里的缓存副本');
			return 目标;
		}
		throw new Error('取不到上游版本 ' + 上游引用 + ':_worker.js');
	}
	mkdirSync(缓存目录, { recursive: true });
	writeFileSync(目标, 结果.stdout);
	return 目标;
}

const 用例 = [
	['上游原版', 取上游文件()],
	['当前版本', join(根目录, 'dist', 'standalone', '_worker.js')]
];

const 摘要 = 双MD5(合成密码 + '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改');
const 默认推导UUID = [摘要.slice(0, 8), 摘要.slice(8, 12), '4' + 摘要.slice(13, 16), '8' + 摘要.slice(17, 20), 摘要.slice(20)].join('-');
const 令牌 = 双MD5(域名 + 默认推导UUID);

console.log('合成 ADMIN：' + 合成密码 + '（未设 KEY / SECRET / HOST）');
console.log('按公式推导 UUID：' + 默认推导UUID);
console.log('按公式推导 token：' + 令牌 + '\n');

const 结果表 = [];
for (const [名, 路径] of 用例) {
	if (!existsSync(路径)) throw new Error(名 + ' 的脚本不存在：' + 路径);
	const { default: 工作者 } = await import(pathToFileURL(路径).href);
	const 响应 = await 工作者.fetch(造请求('/sub?token=' + 令牌), { ADMIN: 合成密码, KV: 造KV() }, 上下文);
	const 正文 = await 响应.text();
	const 唯一 = 提取UUID(正文);
	结果表.push({ 名, 状态: 响应.status, 字节: 正文.length, UUID: 唯一 });
	console.log(名.padEnd(8) + ' 状态 ' + 响应.status + ' | 正文 ' + String(正文.length).padStart(5) + ' 字节 | UUID ' + JSON.stringify(唯一));
}

// ---------- 断言 1：两版必须产出同一个 UUID ----------
const [上游, 当前] = 结果表;
const 一致 = 上游.UUID.length === 1 && 当前.UUID.length === 1 && 上游.UUID[0] === 当前.UUID[0];
console.log('\n断言 1 同一 env 下两版 UUID 相同: ' + (一致 ? '通过' : '失败'));

// ---------- 断言 2：环境变量 UUID 能钉死节点 UUID（改 ADMIN 也不变） ----------
const 钉住 = '9c1b7a44-2f3e-4d51-8a64-1e0f2b3c4d5e';
const { default: 新工作者 } = await import(pathToFileURL(用例[1][1]).href);
const 钉住响应 = await 新工作者.fetch(造请求('/sub?token=' + 双MD5(域名 + 钉住)), { ADMIN: '换了一个密码', KV: 造KV(), UUID: 钉住 }, 上下文);
const 钉住UUID = 提取UUID(await 钉住响应.text());
const 钉住成立 = 钉住响应.status === 200 && 钉住UUID.length === 1 && 钉住UUID[0] === 钉住;
console.log('断言 2 环境变量 UUID 可钉死地址: ' + (钉住成立 ? '通过' : '失败') + '（订阅里为 ' + JSON.stringify(钉住UUID) + '）');

if (!一致 || !钉住成立) {
	console.error('\n兼容性断言未通过 —— 更新前必须先解决，否则订阅地址会变。');
	process.exit(1);
}
console.log('\n结论：同一份 ADMIN + KV（不设 KEY/SECRET/HOST）下，更新后订阅地址不变。');
