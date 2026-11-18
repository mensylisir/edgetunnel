import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const 根目录 = join(dirname(fileURLToPath(import.meta.url)), '..');

// Node 的 WebCrypto 不支持 MD5，Worker 运行时支持；补一层只用于测试的实现。
const 原始摘要 = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
const 摘要替身 = async (算法, 数据) => {
	const 名称 = String(typeof 算法 === 'string' ? 算法 : (算法?.name || '')).toUpperCase();
	if (名称 !== 'MD5') return 原始摘要(算法, 数据);
	const 结果 = createHash('md5').update(new Uint8Array(数据)).digest();
	return 结果.buffer.slice(结果.byteOffset, 结果.byteOffset + 结果.byteLength);
};
try {
	globalThis.crypto.subtle.digest = 摘要替身;
} catch {
	Object.defineProperty(globalThis.crypto.subtle, 'digest', { value: 摘要替身, configurable: true });
}

// 出站请求全部打桩，并记录，用于断言"哪一步真的往外发了请求"
const 出站 = [];
let 出站桩 = async () => new Response(
	'<!doctype html><html><head><title>面板</title></head><body><div id="app">admin</div></body></html>',
	{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
);
globalThis.fetch = async (输入, 选项) => {
	const 地址 = typeof 输入 === 'string' ? 输入 : (输入?.url || '');
	出站.push({ 地址, 选项 });
	return 出站桩(地址, 选项);
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

function 造请求(路径, { 方法 = 'GET', 表单, Cookie, IP = '198.51.100.10', UA = 'TestAgent/1.0', 正文 } = {}) {
	const 头部 = new Headers({ 'User-Agent': UA, 'CF-Connecting-IP': IP });
	if (Cookie) 头部.set('Cookie', Cookie);
	if (表单) 头部.set('Content-Type', 'application/x-www-form-urlencoded');
	if (正文) 头部.set('Content-Type', 'application/json');
	const 请求 = {
		url: `https://tunnel.example.com${路径}`,
		method: 方法,
		headers: 头部,
		cf: { colo: 'HKG' },
		text: async () => 表单 ?? 正文 ?? ''
	};
	if (正文) 请求.json = async () => JSON.parse(正文);
	return 请求;
}

const 执行 = (env, request) => 工作者.fetch(request, env, 上下文);
const 登录 = async (env) => {
	const 响应 = await 执行(env, 造请求('/login', { 方法: 'POST', 表单: 'password=' + encodeURIComponent(管理员密码) }));
	return (响应.headers.get('Set-Cookie') || '').split(';')[0];
};

const 段转范围 = (段) => {
	const [地址, 位] = 段.split('/');
	const 起始 = 地址.split('.').reduce((累加, 片段) => ((累加 << 8) | Number(片段)) >>> 0, 0) >>> 0;
	return { 起始, 容量: Math.pow(2, 32 - Number(位)) };
};
const 官方段 = [
	'173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
	'141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
	'197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
	'104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
].map(段转范围);
const 在官方段内 = (地址) => {
	const 值 = 地址.split('.').reduce((累加, 片段) => ((累加 << 8) | Number(片段)) >>> 0, 0) >>> 0;
	return 官方段.some((范围) => 值 >= 范围.起始 && 值 < 范围.起始 + 范围.容量);
};

test('登录后打开 /admin，面板尾部被挂上测速脚本', async () => {
	出站.length = 0;
	const env = 建环境();
	const Cookie = await 登录(env);
	const 响应 = await 执行(env, 造请求('/admin', { Cookie }));
	assert.equal(响应.status, 200);
	const 正文 = await 响应.text();
	assert.match(正文, /<script src="\/admin\/bestip\.js" defer><\/script>/);
	assert.equal(正文.split('/admin/bestip.js').length - 1, 1, '脚本标签只应出现一次');
	assert.ok(正文.indexOf('bestip.js') < 正文.indexOf('</body>'), '标签必须在 </body> 之前');
	assert.equal(响应.headers.get('Content-Encoding'), null, '正文已重新编码，不能保留旧的 Content-Encoding');
});

test('注入不会重复：响应里已有脚本标签时原样返回', async () => {
	const env = 建环境();
	const Cookie = await 登录(env);
	出站桩 = async () => new Response(
		'<!doctype html><html><body><script src="/admin/bestip.js" defer></script></body></html>',
		{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
	);
	const 响应 = await 执行(env, 造请求('/admin', { Cookie }));
	const 正文 = await 响应.text();
	assert.equal(正文.split('/admin/bestip.js').length - 1, 1);
	出站桩 = async () => new Response(
		'<!doctype html><html><head><title>面板</title></head><body><div id="app">admin</div></body></html>',
		{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
	);
});

test('/admin/bestip.js 返回的脚本与 patches/page-bestip.js 逐字节一致', async () => {
	const env = 建环境();
	const Cookie = await 登录(env);
	const 响应 = await 执行(env, 造请求('/admin/bestip.js', { Cookie }));
	assert.equal(响应.status, 200);
	assert.match(响应.headers.get('Content-Type'), /javascript/);
	const 正文 = await 响应.text();
	const 源 = readFileSync(join(根目录, 'patches', 'page-bestip.js'), 'utf8');
	assert.equal(正文.trim(), 源.trim(), '内嵌脚本与源文件不一致，跑一次 npm run sync:bestip');
});

test('未登录拿不到脚本与候选（不会把测速入口暴露给外部）', async () => {
	const env = 建环境();
	for (const 路径 of ['/admin/bestip.js', '/admin/bestip/candidates', '/admin/bestip/geo']) {
		const 响应 = await 执行(env, 造请求(路径));
		assert.equal(响应.status, 302, 路径 + ' 未登录应跳转登录页');
		assert.equal(响应.headers.get('Location'), '/login');
	}
});

test('候选接口返回指定数量、合法且落在官方网段内的不重复地址', async () => {
	const env = 建环境();
	const Cookie = await 登录(env);
	const 响应 = await 执行(env, 造请求('/admin/bestip/candidates?count=60&ports=443,2053', { Cookie }));
	assert.equal(响应.status, 200);
	const 数据 = await 响应.json();
	assert.equal(数据.地址们.length, 60);
	assert.deepEqual(数据.端口们, [443, 2053]);
	assert.equal(new Set(数据.地址们).size, 60, '地址不应重复');
	for (const 地址 of 数据.地址们) {
		assert.match(地址, /^\d{1,3}(\.\d{1,3}){3}$/);
		assert.ok(在官方段内(地址), 地址 + ' 不在 Cloudflare 官方网段内');
	}
});

test('候选数量受限：过大被压到 300，非法端口回落默认', async () => {
	const env = 建环境();
	const Cookie = await 登录(env);
	const 大 = await (await 执行(env, 造请求('/admin/bestip/candidates?count=999', { Cookie }))).json();
	assert.ok(大.地址们.length <= 300 && 大.地址们.length > 60);
	assert.deepEqual(大.端口们, [443, 2053, 2083, 2087, 2096, 8443]);

	const 非法 = await (await 执行(env, 造请求('/admin/bestip/candidates?count=20&ports=abc,-1,99999', { Cookie }))).json();
	assert.deepEqual(非法.端口们, [443, 2053, 2083, 2087, 2096, 8443], '非法端口应全部被过滤');
});

test('归属地查询会缓存：第二次查同一批不再出站', async () => {
	const env = 建环境();
	const Cookie = await 登录(env);
	let 调用 = 0;
	出站桩 = async (地址) => {
		if (!地址.includes('ip-api.com')) return new Response('x', { status: 200 });
		调用++;
		return new Response(JSON.stringify([
			{ status: 'success', country: '美国', countryCode: 'US', city: '洛杉矶', query: '104.16.132.229' },
			{ status: 'fail', country: '', countryCode: '', city: '', query: '1.2.3.4' }
		]), { status: 200, headers: { 'Content-Type': 'application/json' } });
	};

	const 第一批 = await (await 执行(env, 造请求('/admin/bestip/geo?ips=104.16.132.229', { Cookie }))).json();
	assert.deepEqual(第一批.归属['104.16.132.229'], { cc: 'US', country: '美国', city: '洛杉矶' });
	assert.equal(调用, 1);

	const 第二批 = await (await 执行(env, 造请求('/admin/bestip/geo?ips=104.16.132.229', { Cookie }))).json();
	assert.deepEqual(第二批.归属['104.16.132.229'], { cc: 'US', country: '美国', city: '洛杉矶' });
	assert.equal(调用, 1, '命中 KV 缓存后不应再调外部接口');

	assert.equal(await env.KV.get('bestip_geo.json') !== null, true, '归属地应写进 KV 缓存');

	出站桩 = async () => new Response(
		'<!doctype html><html><head><title>面板</title></head><body><div id="app">admin</div></body></html>',
		{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
	);
});

test('归属地查询失败不影响接口可用，返回空对象而不是 500', async () => {
	const env = 建环境();
	const Cookie = await 登录(env);
	出站桩 = async (地址) => {
		if (地址.includes('ip-api.com')) throw new Error('网络不可达');
		return new Response('x', { status: 200 });
	};
	const 响应 = await 执行(env, 造请求('/admin/bestip/geo?ips=203.0.113.9', { Cookie }));
	assert.equal(响应.status, 200);
	assert.deepEqual(await 响应.json(), { 归属: {} });
	出站桩 = async () => new Response(
		'<!doctype html><html><head><title>面板</title></head><body><div id="app">admin</div></body></html>',
		{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
	);
});

test('测速脚本写入的备注格式是「国家·延迟ms」', () => {
	const 源 = readFileSync(join(根目录, 'patches', 'page-bestip.js'), 'utf8');
	assert.match(源, /return 名 \+ '·' \+ 项\.ms \+ 'ms';/);
	assert.match(源, /'https:\/\/' \+ ip \+ ':' \+ 端口 \+ '\/cdn-cgi\/trace\?r='/);
	assert.match(源, /mode: 'no-cors'/);
});

// 回归：探测结果少写 键 字段时，复测样本表与勾选状态都会索引到 undefined，
// 结果就是所有候选共用一个中位数 —— 界面上每行延迟一模一样，排序彻底失真。
test('探测结果必须带唯一键，且复测与勾选都以它为索引', () => {
	const 源 = readFileSync(join(根目录, 'patches', 'page-bestip.js'), 'utf8');
	assert.match(源, /落定\(\{ 键: ip \+ ':' \+ 端口/, '探测结果必须带唯一键');
	assert.match(源, /样本表\[项\.键\]/, '复测样本表必须按唯一键聚合');
	assert.match(源, /视图\.选中\[项\.键\]/, '勾选状态必须按唯一键记录');
	assert.match(源, /data-键="' \+ 转义\(项\.键\)/, '复选框必须以唯一键作为 data 属性');
});
