// 面板自带的「随机优选」是在 104.16.0.0/13 里随机抽 IP、备注拼编号，既不测速也不查位置，
// 所以既看不出国家，也不可能"按你的网络"变快。这段补一条真正按本机网络筛的路径：
//   ① Worker 发候选 IP（内置 Cloudflare 官方网段，段内等距取点，不依赖任何第三方列表）
//   ② 浏览器并发对 IP:端口 发 HTTPS 请求，用"握手报错前的耗时"当真实 RTT
//      —— SNI 是 IP，证书必然不匹配，但 TCP+TLS 已经跑完才报错；死 IP 是一路超时。
//      已交叉验证：活 IP 395~537 ms 报证书错，假 IP 6s 超时，与 curl --resolve 基本吻合
//   ③ Worker 批量查归属地（ip-api.com 一次最多 100 条，结果在 KV 缓存 7 天）
//   ④ 面板按延迟排序、勾选，一键写进 ADD.txt 并关掉「随机IP」开关
const CF官方网段 = [
	'173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
	'141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
	'197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
	'104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
];
const 优选端口默认 = [443, 2053, 2083, 2087, 2096, 8443];
const 归属缓存键 = 'bestip_geo.json';
const 归属缓存有效期 = 7 * 86400;

function 段转范围(段) {
	const 片段 = String(段).trim().split('/');
	const 地址 = 片段[0], 位 = Number(片段[1]);
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(地址) || !Number.isInteger(位) || 位 < 8 || 位 > 32) return null;
	let 起始 = 0;
	for (const 部分 of 地址.split('.')) {
		const 值 = Number(部分);
		if (值 > 255) return null;
		起始 = ((起始 << 8) | 值) >>> 0;
	}
	return { 起始: 起始 >>> 0, 容量: Math.pow(2, 32 - 位), 位 };
}

function 整数转地址(值) {
	const 无符号 = 值 >>> 0;
	return [(无符号 >>> 24) & 255, (无符号 >>> 16) & 255, (无符号 >>> 8) & 255, 无符号 & 255].join('.');
}

// 段内等距取点：段首往往落在同一批边缘节点上，等距能把不同前缀摊开
function 生成候选地址(数量) {
	const 范围们 = CF官方网段.map(段转范围).filter(项 => 项 && 项.容量 > 1);
	if (!范围们.length) return [];
	const 总量 = Math.max(1, Math.min(300, Math.floor(Number(数量) || 60)));
	const 每段 = Math.max(1, Math.ceil(总量 / 范围们.length));
	const 结果 = [];
	for (const 范围 of 范围们) {
		const 步长 = Math.max(1, Math.floor(范围.容量 / (每段 + 1)));
		for (let 序 = 0; 序 < 每段 && 结果.length < 总量; 序++) {
			const 偏移 = Math.min(范围.容量 - 1, (序 + 1) * 步长);
			结果.push(整数转地址(范围.起始 + 偏移));
		}
	}
	return 结果;
}

// 归属地只用于订阅备注里的国家标注，返回 { 代码: { cc, country, city } }
async function 查地址归属(env, 地址们) {
	const 唯一 = [];
	for (const 地址 of 地址们) {
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(String(地址)) && !唯一.includes(地址)) 唯一.push(地址);
		if (唯一.length >= 100) break;
	}
	if (!唯一.length) return {};

	let 缓存 = {};
	try {
		const 原文 = await env.KV.get(归属缓存键);
		if (原文) 缓存 = JSON.parse(原文) || {};
	} catch (错误) { 缓存 = {}; }

	const 缺 = 唯一.filter(地址 => !缓存[地址] || !缓存[地址].cc);
	let 新增 = 0;
	if (缺.length) {
		try {
			const 响应 = await fetch('http://ip-api.com/batch?fields=status,country,countryCode,city,query&lang=zh-CN', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(缺)
			});
			if (响应.ok) {
				const 列表 = await 响应.json();
				for (const 条 of (Array.isArray(列表) ? 列表 : [])) {
					if (!条 || 条.status !== 'success' || !条.query) continue;
					缓存[条.query] = { cc: 条.countryCode || '', country: 条.country || '', city: 条.city || '' };
					新增++;
				}
			}
		} catch (错误) { /* 查询失败就只返回缓存里已有的，不阻断测速 */ }
	}

	if (新增 > 0) {
		const 全部键 = Object.keys(缓存);
		if (全部键.length > 400) {
			const 裁剪 = {};
			for (const 键 of 全部键.slice(-300)) 裁剪[键] = 缓存[键];
			缓存 = 裁剪;
		}
		try { await env.KV.put(归属缓存键, JSON.stringify(缓存), { expirationTtl: 归属缓存有效期 }); } catch (错误) { }
	}

	const 结果 = {};
	for (const 地址 of 唯一) if (缓存[地址]) 结果[地址] = 缓存[地址];
	return 结果;
}

// 前端脚本源在 patches/page-bestip.js，由 npm run sync:bestip 原样嵌进来。
// 用 String.raw 是为了让脚本里的正则转义（\d、\s）保持原样。
const 页面优选脚本 = String.raw`__前端脚本__`;

// 把测速脚本挂到 /admin 页面上。不改面板源码，所以上游更新面板也照样生效。
async function 注入优选脚本(响应) {
	try {
		if (!响应 || !响应.ok) return 响应;
		if (!(响应.headers.get('Content-Type') || '').includes('text/html')) return 响应;
		const 原文 = await 响应.text();
		const 头 = new Headers(响应.headers);
		// 正文长度和编码都变了，这几个头必须摘掉，否则浏览器按旧声明解析会出错
		头.delete('Content-Length');
		头.delete('Content-Encoding');
		头.delete('ETag');
		头.delete('Last-Modified');
		头.set('Cache-Control', 'no-store');
		// 已经挂过就不再重复挂。注意这里必须用读出来的正文重建响应：
		// 原响应的 body 已被读空，直接返回同一个对象会得到空白页
		if (原文.includes('/admin/bestip.js')) return new Response(原文, { status: 响应.status, headers: 头 });
		const 标签 = '<script src="/admin/bestip.js" defer></script>';
		const 位置 = 原文.lastIndexOf('</body>');
		const 正文 = 位置 > -1 ? 原文.slice(0, 位置) + 标签 + 原文.slice(位置) : 原文 + 标签;
		return new Response(正文, { status: 响应.status, headers: 头 });
	} catch (错误) {
		return 响应;
	}
}
