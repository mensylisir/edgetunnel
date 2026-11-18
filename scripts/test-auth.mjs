import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Node 的 WebCrypto 不支持 MD5，而 Cloudflare Workers 支持；这里补一层只用于测试的 MD5 摘要实现。
const 原始摘要方法 = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
const 摘要替身 = async (算法, 数据) => {
	const 名称 = String(typeof 算法 === 'string' ? 算法 : (算法?.name || '')).toUpperCase();
	if (名称 !== 'MD5') return 原始摘要方法(算法, 数据);
	const 结果 = createHash('md5').update(new Uint8Array(数据)).digest();
	return 结果.buffer.slice(结果.byteOffset, 结果.byteOffset + 结果.byteLength);
};
try {
	globalThis.crypto.subtle.digest = 摘要替身;
} catch {
	Object.defineProperty(globalThis.crypto.subtle, 'digest', { value: 摘要替身, configurable: true });
}

const 出站请求 = [];
globalThis.fetch = async (输入) => {
	出站请求.push(typeof 输入 === 'string' ? 输入 : (输入?.url || ''));
	return new Response('<!doctype html><title>stub</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
};

const { default: 工作者 } = await import('../_worker.js');

const 管理员密码 = 'Correct-Horse-Battery-Staple';
const 上下文 = { waitUntil() { }, passThroughOnException() { } };

function 建KV() {
	const 数据 = new Map();
	return {
		数据,
		async get(键) { return 数据.has(键) ? 数据.get(键) : null; },
		async put(键, 值) { 数据.set(键, String(值)); },
		async delete(键) { 数据.delete(键); },
		async list() { return { keys: [...数据.keys()].map((name) => ({ name })), list_complete: true }; }
	};
}

const 建环境 = (覆盖 = {}) => ({ ADMIN: 管理员密码, KV: 建KV(), ...覆盖 });

function 造请求(路径, { 方法 = 'GET', 表单, Cookie, IP = '198.51.100.10', UA = 'TestAgent/1.0' } = {}) {
	const 头部 = new Headers({ 'User-Agent': UA, 'CF-Connecting-IP': IP });
	if (Cookie) 头部.set('Cookie', Cookie);
	if (表单) 头部.set('Content-Type', 'application/x-www-form-urlencoded');
	return { url: `https://tunnel.example.com${路径}`, method: 方法, headers: 头部, cf: { colo: 'HKG' }, text: async () => 表单 ?? '' };
}

const 执行 = (env, request) => 工作者.fetch(request, env, 上下文);
const 登出 = async (env, 密码, 选项 = {}) => 执行(env, 造请求('/login', { 方法: 'POST', 表单: 'password=' + encodeURIComponent(密码), ...选项 }));
const 取Cookie = (响应) => (响应.headers.get('Set-Cookie') || '').split(';')[0];

test('正确密码登录：返回成功并下发带到期时间的 HMAC 令牌', async () => {
	const 响应 = await 登出(建环境(), 管理员密码);
	assert.equal(响应.status, 200);
	assert.deepEqual(await 响应.json(), { success: true });
	const Cookie = 响应.headers.get('Set-Cookie') || '';
	assert.match(Cookie, /^auth=\d+\.[A-Za-z0-9_-]+; Path=\/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax$/);
});

test('会话令牌可复用：带 Cookie 访问 /login 直接跳转 /admin', async () => {
	const env = 建环境();
	const Cookie = 取Cookie(await 登出(env, 管理员密码));
	const 响应 = await 执行(env, 造请求('/login', { Cookie }));
	assert.equal(响应.status, 302);
	assert.equal(响应.headers.get('Location'), '/admin');
});

test('伪造签名被拒绝', async () => {
	const env = 建环境();
	const 到期 = Math.floor(Date.now() / 1000) + 3600;
	const 响应 = await 执行(env, 造请求('/login', { Cookie: `auth=${到期}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` }));
	assert.equal(响应.status, 200);
	assert.notEqual(响应.headers.get('Location'), '/admin');
});

test('过期令牌被拒绝', async () => {
	const env = 建环境();
	const 响应 = await 执行(env, 造请求('/login', { Cookie: 'auth=1000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }));
	assert.equal(响应.status, 200);
	assert.notEqual(响应.headers.get('Location'), '/admin');
});

test('连续 5 次错误密码后进入锁定，第 6 次返回 429', async () => {
	const env = 建环境();
	const 选项 = { IP: '203.0.113.5' };
	for (let 次数 = 1; 次数 <= 5; 次数++) {
		const 响应 = await 登出(env, 'wrong-' + 次数, 选项);
		assert.equal(响应.status, 200, `第 ${次数} 次错误应返回登录页`);
	}
	const 锁定响应 = await 登出(env, 管理员密码, 选项);
	assert.equal(锁定响应.status, 429);
	assert.ok(Number(锁定响应.headers.get('Retry-After')) > 0);
	const 正文 = await 锁定响应.json();
	assert.equal(正文.success, false);
});

test('锁定只针对来源 IP，不影响其他来源', async () => {
	const env = 建环境();
	for (let 次数 = 1; 次数 <= 5; 次数++) await 登出(env, 'wrong', { IP: '203.0.113.9' });
	const 响应 = await 登出(env, 管理员密码, { IP: '203.0.113.10' });
	assert.equal(响应.status, 200);
	assert.equal((await 响应.json()).success, true);
});

test('登录成功会清空失败计数', async () => {
	const env = 建环境();
	const 选项 = { IP: '203.0.113.20' };
	await 登出(env, 'wrong-1', 选项);
	await 登出(env, 'wrong-2', 选项);
	await 登出(env, 管理员密码, 选项);
	for (let 次数 = 1; 次数 <= 4; 次数++) assert.equal((await 登出(env, 'wrong-' + 次数, 选项)).status, 200);
	assert.equal([...env.KV.数据.keys()].some((键) => 键.startsWith('login_lock_')), false);
});

test('只配置 KEY 不配置 ADMIN 时不再把 KEY 当后台密码', async () => {
	const env = 建环境({ ADMIN: undefined, KEY: 'Only-Key-Configured' });
	const 响应 = await 执行(env, 造请求('/login'));
	assert.equal(响应.status, 404);
});

test('后台面板默认仍从上游静态页加载', async () => {
	出站请求.length = 0;
	await 执行(建环境(), 造请求('/login'));
	assert.ok(出站请求.includes('https://edt-pages.github.io/login'), `实际出站：${出站请求.join(', ')}`);
});

test('设置 PAGES_URL 后后台面板改从自建副本加载（含末尾斜杠归一）', async () => {
	出站请求.length = 0;
	await 执行(建环境({ PAGES_URL: 'https://panel.example.com/' }), 造请求('/login'));
	assert.ok(出站请求.includes('https://panel.example.com/login'), `实际出站：${出站请求.join(', ')}`);
	assert.equal(出站请求.some((地址) => 地址.includes('edt-pages.github.io')), false);
});

test('查询请求量不再接受 URL 传参中的 Cloudflare 凭证', async () => {
	const env = 建环境();
	const Cookie = 取Cookie(await 登出(env, 管理员密码));
	出站请求.length = 0;
	const 响应 = await 执行(env, 造请求('/admin/getCloudflareUsage?Email=leak%40example.com&GlobalAPIKey=plaintext-secret', { Cookie }));
	assert.equal(响应.status, 400);
	assert.equal(出站请求.filter((地址) => 地址.includes('api.cloudflare.com')).length, 0);
	const 正文 = await 响应.json();
	assert.match(正文.msg, /凭证/);
});
