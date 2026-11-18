// 面板测速的端到端验证（可选，需本机有 chromium + puppeteer-core）
//
//   node scripts/e2e-bestip.mjs            走系统代理（默认）
//   node scripts/e2e-bestip.mjs --no-proxy 绕过代理，数值更接近裸线路
//
// 它做的事：起一个本地服务，把真实面板 HTML + 注入标签一起返回，
// 用真实 chromium 打开、点开浮层、跑一次测速、写入订阅，然后打印排名与服务器收到的内容。
// 单测（npm test）覆盖不了浏览器行为，这个脚本才是"浮层真的能用"的证据。
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const 根 = join(dirname(fileURLToPath(import.meta.url)), '..');
const 截图目录 = join(根, '.cache');
mkdirSync(截图目录, { recursive: true });

const 找模块 = () => {
	const 候选 = [
		process.env.PUPPETEER_CORE,
		join(process.env.HOME || '', '.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'),
		'puppeteer-core'
	].filter(Boolean);
	for (const 路径 of 候选) {
		try { return 路径; } catch (错误) { continue; }
	}
	return 'puppeteer-core';
};

const puppeteer = (await import(找模块())).default;
const 面板 = readFileSync(join(根, 'dist/panel/admin/index.html'), 'utf8');
const 脚本 = readFileSync(join(根, 'patches/page-bestip.js'), 'utf8');

// 实测可用的地址，预期能测出几百毫秒的区分度
const 候选地址 = [
	'103.31.4.204', '104.24.204.204', '188.114.99.51', '162.159.153.152',
	'141.101.115.48', '172.65.153.153', '190.93.246.102', '103.21.244.204',
	'198.41.204.203', '104.19.51.50', '162.159.51.50', '104.27.51.48'
];
const 归属池 = [
	{ cc: 'JP', country: '日本', city: '东京' },
	{ cc: 'US', country: '美国', city: '洛杉矶' },
	{ cc: 'HK', country: '中国香港', city: '香港' },
	{ cc: 'SG', country: '新加坡', city: '新加坡' }
];
const 归属表 = {};
候选地址.forEach((地址, 序) => { 归属表[地址] = 归属池[序 % 归属池.length]; });

const 记录 = { ADD文本: null, 配置: null };

const 服务器 = createServer((请求, 响应) => {
	const 路径 = 请求.url.split('?')[0];

	if (路径 === '/admin' || 路径 === '/admin/') {
		const 标签 = '<script src="/admin/bestip.js" defer></script>';
		const 位置 = 面板.lastIndexOf('</body>');
		响应.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		响应.end(面板.slice(0, 位置) + 标签 + 面板.slice(位置));
		return;
	}
	if (路径 === '/admin/bestip.js') {
		响应.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
		响应.end(脚本);
		return;
	}
	if (路径 === '/admin/bestip/candidates') {
		响应.writeHead(200, { 'Content-Type': 'application/json' });
		响应.end(JSON.stringify({ 地址们: 候选地址, 端口们: [443, 2053, 2083] }));
		return;
	}
	if (路径 === '/admin/bestip/geo') {
		const 问 = new URL(请求.url, 'http://x').searchParams.get('ips') || '';
		const 答 = {};
		问.split(',').filter(Boolean).forEach((地址) => { if (归属表[地址]) 答[地址] = 归属表[地址]; });
		响应.writeHead(200, { 'Content-Type': 'application/json' });
		响应.end(JSON.stringify({ 归属: 答 }));
		return;
	}
	if (路径 === '/admin/ADD.txt') {
		if (请求.method === 'POST') {
			let 体 = '';
			请求.on('data', (块) => { 体 += 块; });
			请求.on('end', () => {
				记录.ADD文本 = 体;
				响应.writeHead(200, { 'Content-Type': 'application/json' });
				响应.end(JSON.stringify({ success: true }));
			});
			return;
		}
		响应.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
		响应.end(记录.ADD文本 || '');
		return;
	}
	if (路径 === '/admin/config.json') {
		if (请求.method === 'POST') {
			let 体 = '';
			请求.on('data', (块) => { 体 += 块; });
			请求.on('end', () => {
				记录.配置 = JSON.parse(体);
				响应.writeHead(200, { 'Content-Type': 'application/json' });
				响应.end(JSON.stringify({ success: true }));
			});
			return;
		}
		响应.writeHead(200, { 'Content-Type': 'application/json' });
		响应.end(JSON.stringify({
				UUID: '00000000-0000-4000-8000-000000000000',
				HOST: 'edt2.example.com',
				优选订阅生成: { local: true, 本地IP库: { 随机IP: true, 随机数量: 16, 指定端口: -1 } }
			}));
		return;
	}
	响应.writeHead(200, { 'Content-Type': 'application/json' });
	响应.end('{}');
});

await new Promise((完成) => 服务器.listen(0, '127.0.0.1', 完成));
const 端口 = 服务器.address().port;
console.log('本地服务 http://127.0.0.1:' + 端口 + '/admin');

const 无代理 = process.argv.includes('--no-proxy');
const 浏览器 = await puppeteer.launch({
	executablePath: '/usr/bin/chromium',
	headless: true,
	args: ['--no-sandbox', '--disable-dev-shm-usage', ...(无代理 ? ['--no-proxy-server'] : [])]
});
const 页 = await 浏览器.newPage();
await 页.setViewport({ width: 1280, height: 900 });

await 页.goto('http://127.0.0.1:' + 端口 + '/admin', { waitUntil: 'domcontentloaded', timeout: 30000 });
await 页.waitForFunction(() => !!document.getElementById('edt-bestip'), { timeout: 15000 });
console.log('✓ 浮层宿主已挂载');

const 点 = (编号) => 页.evaluate((器) => document.getElementById('edt-bestip').shadowRoot.getElementById(器).click(), 编号);

await 点('开关');
await 页.waitForFunction(() => document.getElementById('edt-bestip').shadowRoot.getElementById('wrap').classList.contains('on'), { timeout: 5000 });
console.log('✓ 面板已展开');

await 点('开始');
console.log('… 已点击开始测速');
await 页.waitForFunction(() => document.getElementById('edt-bestip').shadowRoot.querySelectorAll('.item').length > 0, { timeout: 90000 });
console.log('✓ 结果表已渲染');

const 结果 = await 页.evaluate(() => {
	const 根 = document.getElementById('edt-bestip').shadowRoot;
	return {
		行: [...根.querySelectorAll('.item')].map((项) => ({
			地址: 项.querySelector('.addr').textContent,
			位置: 项.querySelector('.loc').textContent,
			延迟: 项.querySelector('.ms').textContent,
			勾选: 项.querySelector('input').checked
		})),
		状态: 根.getElementById('状态').textContent,
		写入: 根.getElementById('写入').textContent
	};
});

console.log('\n状态：' + 结果.状态);
console.log('写入按钮：' + 结果.写入);
结果.行.forEach((项, 序) => {
	console.log('  ' + String(序 + 1).padStart(2) + '  ' + 项.地址.padEnd(20) + '  ' + 项.位置.padEnd(14) + '  ' + 项.延迟 + (项.勾选 ? '  ✓' : ''));
});

const 毫秒集 = 结果.行.map((项) => parseInt(项.延迟, 10)).filter((值) => isFinite(值));
if (毫秒集.length > 1) {
	const 极差 = Math.max(...毫秒集) - Math.min(...毫秒集);
	const 唯一值 = new Set(毫秒集).size;
	console.log('\n耗时 ' + Math.min(...毫秒集) + '~' + Math.max(...毫秒集) + ' ms，极差 ' + 极差 + ' ms，' + 唯一值 + ' 个不同取值');
	console.log('判定：' + (唯一值 > 1 && 极差 > 40 ? '排序有区分度 ✓' : '取值雷同，排序失真 ✗'));
}

await 页.screenshot({ path: join(截图目录, 'bestip-panel.png') });
console.log('截图：.cache/bestip-panel.png');

await 点('写入');
await 页.waitForFunction(() => {
	const 文 = document.getElementById('edt-bestip').shadowRoot.getElementById('状态').textContent;
	return 文.includes('已写入') || 文.includes('失败');
}, { timeout: 30000 });
const 写入后 = await 页.evaluate(() => document.getElementById('edt-bestip').shadowRoot.getElementById('状态').textContent);
console.log('\n写入结果：' + 写入后);
console.log('服务器收到 ADD.txt：');
(记录.ADD文本 || '(空)').trim().split('\n').forEach((行) => console.log('  ' + 行));
console.log('随机IP 被改为：' + (记录.配置?.优选订阅生成?.本地IP库?.随机IP ?? '(未收到)'));

await 页.screenshot({ path: join(截图目录, 'bestip-panel-done.png') });
await 浏览器.close();
服务器.close();
