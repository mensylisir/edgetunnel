#!/usr/bin/env node
// 实测入口落地的机房（colo）会不会漂移。
//
// 请求 /cdn-cgi/trace 是 Cloudflare 的内置端点，不经过 Worker，
// 返回的 colo= 就是你这次实际落地的机房。同一个入口 IP 反复请求，
// 如果 colo 变了，说明 anycast 路由把你调度到了别的机房——也就是
// 出口区域会跟着变。
//
// 用法：
//   node scripts/colo-drift.mjs --host=edt2.myfreedog.de5.net
//   node scripts/colo-drift.mjs --host=你的域名 --interval=300 --count=48
//   node scripts/colo-drift.mjs --host=你的域名 --minutes=120

const 参数 = Object.fromEntries(
	process.argv.slice(2).map((项) => {
		const [键, ...值] = 项.replace(/^--/, '').split('=');
		return [键, 值.join('=') || 'true'];
	})
);

const 域名 = 参数.host || 参数.HOST;
if (!域名) {
	console.error('缺少 --host=<你的域名>，例如 --host=edt2.myfreedog.de5.net');
	process.exit(1);
}

const 间隔秒 = Math.max(5, Number(参数.interval) || 60);
const 总分钟 = Number(参数.minutes) || 0;
const 次数 = 参数.count ? Math.max(1, Number(参数.count)) : 总分钟 ? Math.ceil((总分钟 * 60) / 间隔秒) : 0;

const 记录 = [];
let 上次机房 = null;
let 切换次数 = 0;

function 时间() {
	return new Date().toLocaleString('zh-CN', { hour12: false });
}

async function 测一次() {
	const 开始 = Date.now();
	try {
		const 响应 = await fetch(`https://${域名}/cdn-cgi/trace`, {
			headers: { 'User-Agent': 'colo-drift/1.0' },
			signal: AbortSignal.timeout(15000)
		});
		const 正文 = await 响应.text();
		const 机房 = (正文.match(/^colo=(\S+)/m) || [])[1] || '?';
		const 出口IP = (正文.match(/^ip=(\S+)/m) || [])[1] || '?';
		const 耗时 = Date.now() - 开始;

		if (上次机房 !== null && 机房 !== 上次机房) {
			切换次数++;
			console.log(`  ⚠ 机房变了：${上次机房} → ${机房}`);
		}
		上次机房 = 机房;
		记录.push({ 机房, 耗时, 时刻: 时间() });
		console.log(`[${时间()}] colo=${机房}  ${耗时}ms  ip=${出口IP}`);
	} catch (错) {
		记录.push({ 机房: null, 耗时: null, 时刻: 时间() });
		console.log(`[${时间()}] 请求失败：${错.message}`);
	}
}

function 汇总() {
	const 有效 = 记录.filter((项) => 项.机房);
	if (!有效.length) {
		console.log('\n没有任何有效样本，检查域名是否可访问。');
		return;
	}
	const 分布 = new Map();
	for (const 项 of 有效) 分布.set(项.机房, (分布.get(项.机房) || 0) + 1);
	const 排序 = [...分布.entries()].sort((甲, 乙) => 乙[1] - 甲[1]);
	const 耗时 = 有效.map((项) => 项.耗时).sort((甲, 乙) => 甲 - 乙);

	console.log('\n===== 结果 =====');
	console.log(`样本 ${有效.length} 次（失败 ${记录.length - 有效.length} 次），间隔 ${间隔秒}s`);
	console.log(`机房分布：${排序.map(([机房, 次]) => `${机房} ${次}次 ${((次 / 有效.length) * 100).toFixed(1)}%`).join('  |  ')}`);
	console.log(`机房切换：${切换次数} 次`);
	console.log(`延迟：中位 ${耗时[Math.floor((耗时.length - 1) / 2)]}ms，最慢 ${耗时[耗时.length - 1]}ms`);

	if (切换次数 === 0) {
		console.log('\n结论：这段时间内机房完全没变。出口区域是稳定的，不用为漂移担心。');
	} else if (切换次数 <= 2) {
		console.log('\n结论：偶发漂移。对绝大多数使用场景够用；如果要求出口绝对固定，仍需要一台固定服务器。');
	} else {
		console.log('\n结论：漂移频繁。靠固定入口 IP 无法稳住出口，需要用固定 PROXYIP 或一台固定服务器做最后一跳。');
	}
}

(async () => {
	console.log(`目标 ${域名}，间隔 ${间隔秒}s${次数 ? `，共 ${次数} 次` : '，Ctrl+C 结束并汇总'}`);
	let 序号 = 0;
	const 循环 = async () => {
		await 测一次();
		序号++;
		if (次数 && 序号 >= 次数) {
			汇总();
			process.exit(0);
		}
		setTimeout(循环, 间隔秒 * 1000);
	};
	循环();
	process.on('SIGINT', () => {
		汇总();
		process.exit(0);
	});
})();
