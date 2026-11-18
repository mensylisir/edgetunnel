// 交付前核验：独立版是否真的零外部请求、面板是否内置、订阅地址是否稳定
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Node 的 crypto.subtle 不支持 MD5，这里补一个，行为与 Worker 运行时一致
const 原始digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
globalThis.crypto.subtle.digest = async (算法, 数据) => {
	const 名 = String(typeof 算法 === 'string' ? 算法 : 算法?.name || '').toUpperCase();
	if (名 !== 'MD5') return 原始digest(算法, 数据);
	const 结果 = createHash('md5').update(new Uint8Array(数据)).digest();
	return 结果.buffer.slice(结果.byteOffset, 结果.byteOffset + 结果.byteLength);
};

const 出站 = [];
globalThis.fetch = async (目标) => {
	出站.push(typeof 目标 === 'string' ? 目标 : 目标?.url);
	return new Response('外部响应');
};

const { default: 工作者 } = await import('../dist/standalone/_worker.js');

function 建KV() {
	const 数据 = new Map();
	return {
		数据,
		async get(键) { return 数据.has(键) ? 数据.get(键) : null; },
		async put(键, 值) { 数据.set(键, 值); },
		async delete(键) { 数据.delete(键); },
		async list() { return { keys: [...数据.keys()].map((name) => ({ name })), list_complete: true }; }
	};
}

const 环境 = { ADMIN: 'deliver-check-pass', KEY: 'deliver-check-key', KV: 建KV() };
const 上下文 = { waitUntil() { }, passThroughOnException() { } };
const 造请求 = (路径, 选项 = {}) => ({
	url: 'https://tunnel.example.com' + 路径,
	method: 选项.方法 || 'GET',
	headers: new Headers({
		'User-Agent': 'deliver-check/1.0',
		'CF-Connecting-IP': '198.51.100.7',
		...(选项.Cookie ? { Cookie: 选项.Cookie } : {})
	}),
	cf: { colo: 'HKG' },
	text: async () => 选项.正文 || ''
});

// 1. 登录拿会话
const 登录 = await 工作者.fetch(造请求('/login', { 方法: 'POST', 正文: 'password=' + encodeURIComponent(环境.ADMIN) }), 环境, 上下文);
const Cookie = (登录.headers.get('Set-Cookie') || '').split(';')[0];
console.log('登录:', 登录.status, Cookie ? '已下发会话' : '未下发会话');

// 2. 逐个页面检查是否由脚本内部返回，同时统计出站
const 页面 = [
	['/admin', 200, Cookie],
	['/login', 200, ''],
	['/noADMIN', 200, ''],
	['/noKV', 200, '']
];
for (const [路径, 期望, 令牌] of 页面) {
	出站.length = 0;
	const 响应 = await 工作者.fetch(造请求(路径, { Cookie: 令牌 }), 环境, 上下文);
	const 正文 = await 响应.text();
	const 有注入 = 正文.includes('/admin/bestip.js');
	const 是面板 = 正文.includes('<!DOCTYPE html');
	console.log(`${路径}: ${响应.status}（期望 ${期望}）正文 ${正文.length} 字节 | 面板内容 ${是面板 ? '是' : '否'} | 优选脚本 ${有注入 ? '已注入' : '非后台页'} | 出站 ${出站.length} 次${出站.length ? ' → ' + 出站[0] : ''}`);
}

// 3. 订阅地址兼容性：只配 ADMIN + KV 的老用户，升级后旧订阅地址必须仍然可用。
//    Worker 内的 MD5MD5 是“两次 MD5，第二次取第一次十六进制的 [7,27)”，这里必须同构，
//    否则算出的令牌和线上不一致，会误判成“地址变了”。
const 双MD5 = (文本) => {
	const 一 = createHash('md5').update(Buffer.from(文本, 'utf8')).digest('hex');
	return createHash('md5').update(Buffer.from(一.slice(7, 27), 'utf8')).digest('hex');
};
const 默认密钥全文 = /const 默认加密秘钥 = '([^']+)'/.exec(readFileSync(new URL('../dist/standalone/_worker.js', import.meta.url), 'utf8'))[1];
const 老环境 = { ADMIN: 'legacy-admin-pass', KV: 建KV() };
const 老摘要 = 双MD5(老环境.ADMIN + 默认密钥全文);
const 老UUID = [老摘要.slice(0, 8), 老摘要.slice(8, 12), '4' + 老摘要.slice(13, 16), '8' + 老摘要.slice(17, 20), 老摘要.slice(20)].join('-');
const 老令牌 = 双MD5('tunnel.example.com' + 老UUID);
const 老订阅 = await 工作者.fetch(造请求('/sub?token=' + 老令牌), 老环境, 上下文);
const 老正文 = await 老订阅.text();
const 命中伪装页 = 老正文.includes('Welcome to nginx');
console.log(`老部署（只 ADMIN+KV）旧订阅地址: ${老订阅.status} ${老正文.length} 字节 | 伪装页 ${命中伪装页 ? '是（地址已失效）' : '否'} | UUID ${老UUID}`);

// 4. 快速订阅令牌是否稳定（同一份 env 连续两次必须一致）
const 第一次 = await 工作者.fetch(造请求('/' + 环境.KEY), 环境, 上下文);
const 第二次 = await 工作者.fetch(造请求('/' + 环境.KEY), 环境, 上下文);
const 位置一 = 第一次.headers.get('Location') || '';
const 位置二 = 第二次.headers.get('Location') || '';
console.log('快速订阅:', 第一次.status, 位置一.slice(0, 60) + (位置一.length > 60 ? '…' : ''));
console.log('令牌稳定:', 位置一 === 位置二 && 位置一.includes('token=') ? '是' : '否');

if (老订阅.status !== 200 || 命中伪装页 || 老正文.length < 1000) {
	throw new Error('旧订阅地址在新版本上不可用 —— 兼容性承诺被破坏');
}
