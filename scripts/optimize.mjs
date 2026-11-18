// 本机实测优选：从这台机器的网络出发，逐个测 Cloudflare 边缘 IP 的握手延迟与落地机房（colo），
// 查清每个 IP 的国家归属，把带国家和延迟备注的结果写回 Worker 的 KV（ADD.txt），
// 并关掉「随机优选」，让订阅直接用实测最快的那批。
//
// 为什么必须在本地跑：Worker 跑在 Cloudflare 边缘，它到某个 IP 的距离和你到那个 IP 的距离是两回事；
// 只有你的设备到边缘 IP 的握手延迟，才是你实际用起来的速度依据。面板里的「随机优选」是随机抽样，
// 不测速、不看位置，所以你会看到一堆「CF官方优选N」、没有国家。
//
// 用法：
//   node scripts/optimize.mjs --host edt2.myfreedog.de5.net --dry        # 只测不写
//   node scripts/optimize.mjs --host edt2.myfreedog.de5.net --password 你的后台密码
//
// 参数：
//   --host      你的 Worker 域名（SNI 用它的证书，必须是已接入 Cloudflare 的域名）
//   --password  后台密码，用于登录后写入 KV；不填等同 --dry
//   --top       保留多少个最优 IP（默认 16）
//   --sample    候选 IP 数量（默认 200）
//   --ports     端口，逗号分隔（默认 443）
//   --timeout   单次探测超时毫秒（默认 4000）
//   --dry       只输出结果，不写 KV

import tls from 'node:tls';
import { setTimeout as 睡眠 } from 'node:timers/promises';

const 参数 = {};
for (let i = 2; i < process.argv.length; i++) {
	const 项 = process.argv[i];
	if (!项.startsWith('--')) continue;
	const 键 = 项.slice(2);
	const 下一个 = process.argv[i + 1];
	if (下一个 && !下一个.startsWith('--')) { 参数[键] = 下一个; i++; }
	else 参数[键] = true;
}

const 域名 = 参数.host || process.env.EDGETUNNEL_HOST;
if (!域名) {
	console.error('缺少 --host 你的域名（例如 --host edt2.myfreedog.de5.net）');
	process.exit(1);
}
const 密码 = 参数.password || process.env.EDGETUNNEL_PASSWORD || '';
const 保留数 = Number(参数.top || 16);
const 候选数 = Number(参数.sample || 200);
const 端口们 = String(参数.ports || '443').split(',').map((值) => Number(值.trim())).filter(Boolean);
const 超时 = Number(参数.timeout || 4000);
const 只测 = Boolean(参数.dry) || !密码;
const 并发 = Math.min(32, Number(参数.concurrency || 16));

// Cloudflare 官方 IPv4 段（www.cloudflare.com/ips-v4），取不到就用内置副本。
const 内置段 = [
	'173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
	'141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
	'197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
	'104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
];

// 机房代码 → 位置。优选用的是 Cloudflare 任播 IP，真正决定「节点在哪」的是请求落地到哪个机房（colo），
// 不是 IP 的注册地：同一个 IP 在丹佛落地就从美国出网，在香港落地就从香港出网。
// 这张表覆盖主要机房，查不到的再用 IP 注册地兜底（会标注「注册地」以免误解）。
const 机房位置 = {
	HKG: ['中国香港', '香港'], TPE: ['中国台湾', '台北'], KHH: ['中国台湾', '高雄'],
	NRT: ['日本', '东京'], KIX: ['日本', '大阪'], ICN: ['韩国', '首尔'],
	SIN: ['新加坡', '新加坡'], BKK: ['泰国', '曼谷'], KUL: ['马来西亚', '吉隆坡'],
	CGK: ['印度尼西亚', '雅加达'], MNL: ['菲律宾', '马尼拉'], HAN: ['越南', '河内'], SGN: ['越南', '胡志明'],
	BOM: ['印度', '孟买'], DEL: ['印度', '新德里'], SYD: ['澳大利亚', '悉尼'], MEL: ['澳大利亚', '墨尔本'],
	AKL: ['新西兰', '奥克兰'],
	LAX: ['美国', '洛杉矶'], SFO: ['美国', '旧金山'], SEA: ['美国', '西雅图'], PDX: ['美国', '波特兰'],
	SLC: ['美国', '盐湖城'], DEN: ['美国', '丹佛'], DFW: ['美国', '达拉斯'], ORD: ['美国', '芝加哥'],
	MSP: ['美国', '明尼阿波利斯'], ATL: ['美国', '亚特兰大'], MIA: ['美国', '迈阿密'],
	IAD: ['美国', '华盛顿'], EWR: ['美国', '纽瓦克'], JFK: ['美国', '纽约'], BOS: ['美国', '波士顿'],
	YYZ: ['加拿大', '多伦多'], YVR: ['加拿大', '温哥华'], MEX: ['墨西哥', '墨西哥城'],
	GRU: ['巴西', '圣保罗'], EZE: ['阿根廷', '布宜诺斯艾利斯'], SCL: ['智利', '圣地亚哥'],
	LIM: ['秘鲁', '利马'], BOG: ['哥伦比亚', '波哥大'],
	LHR: ['英国', '伦敦'], LGW: ['英国', '伦敦'], MAN: ['英国', '曼彻斯特'],
	CDG: ['法国', '巴黎'], AMS: ['荷兰', '阿姆斯特丹'], FRA: ['德国', '法兰克福'],
	MUC: ['德国', '慕尼黑'], BER: ['德国', '柏林'], MAD: ['西班牙', '马德里'],
	BCN: ['西班牙', '巴塞罗那'], MXP: ['意大利', '米兰'], FCO: ['意大利', '罗马'],
	ZRH: ['瑞士', '苏黎世'], VIE: ['奥地利', '维也纳'], PRG: ['捷克', '布拉格'],
	WAW: ['波兰', '华沙'], ARN: ['瑞典', '斯德哥尔摩'], OSL: ['挪威', '奥斯陆'],
	CPH: ['丹麦', '哥本哈根'], HEL: ['芬兰', '赫尔辛基'], DUB: ['爱尔兰', '都柏林'], BRU: ['比利时', '布鲁塞尔'],
	IST: ['土耳其', '伊斯坦布尔'], TLV: ['以色列', '特拉维夫'], DXB: ['阿联酋', '迪拜'],
	DOH: ['卡塔尔', '多哈'], RUH: ['沙特', '利雅得'],
	JNB: ['南非', '约翰内斯堡'], CPT: ['南非', '开普敦'], LOS: ['尼日利亚', '拉各斯'],
	NBO: ['肯尼亚', '内罗毕'], CAI: ['埃及', '开罗']
};

// 常用国家/地区的中文名（IP 注册地兜底时用）。命名按中国官方口径。
const 国家中文 = {
	US: '美国', HK: '中国香港', TW: '中国台湾', MO: '中国澳门', JP: '日本', SG: '新加坡',
	KR: '韩国', DE: '德国', GB: '英国', NL: '荷兰', FR: '法国', CA: '加拿大', AU: '澳大利亚',
	IN: '印度', BR: '巴西', RU: '俄罗斯', IT: '意大利', ES: '西班牙', SE: '瑞典', CH: '瑞士',
	PL: '波兰', TR: '土耳其', AE: '阿联酋', IL: '以色列', ZA: '南非', MX: '墨西哥', AR: '阿根廷',
	TH: '泰国', VN: '越南', MY: '马来西亚', ID: '印度尼西亚', PH: '菲律宾', NZ: '新西兰', IE: '爱尔兰'
};

const 段转整数 = (段) => {
	const [网络, 位数] = 段.split('/');
	const 掩码 = Number(位数);
	const 起始 = 网络.split('.').reduce((值, 段值) => (值 << 8) + Number(段值), 0) >>> 0;
	return { 起始, 容量: 2 ** (32 - 掩码) };
};
const 整数转IP = (值) => [24, 16, 8, 0].map((移) => (值 >>> 移) & 255).join('.');

async function 取官方段() {
	try {
		const 响应 = await fetch('https://www.cloudflare.com/ips-v4', { signal: AbortSignal.timeout(8000) });
		if (!响应.ok) throw new Error('status ' + 响应.status);
		const 列表 = (await 响应.text()).split('\n').map((行) => 行.trim()).filter((行) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(行));
		if (列表.length >= 5) return 列表;
	} catch (错误) {
		process.stderr.write(`取官方 IP 段失败（${错误.message}），改用内置副本\n`);
	}
	return 内置段;
}

// 每个段内随机取点：段首地址往往落在同一台边缘上，随机取点才能覆盖更多机房。
// 每个候选都会被实测，随机不影响结论。
function 生成候选(段列表, 总量) {
	const 每段 = Math.max(1, Math.ceil(总量 / 段列表.length));
	const 结果 = [];
	for (const 段 of 段列表) {
		const { 起始, 容量 } = 段转整数(段);
		for (let k = 0; k < 每段; k++) 结果.push(整数转IP((起始 + Math.floor(Math.random() * 容量)) >>> 0));
	}
	return 结果;
}

// 单次探测：TCP+TLS 握手（SNI 与 Host 都是你的域名，证书必须校验通过）→ 取 cdn-cgi/trace 的 colo。
function 探测(地址, 端口) {
	return new Promise((解析) => {
		const 开始 = process.hrtime.bigint();
		let 握手毫秒 = null, 首字节毫秒 = null, 数据 = '', 已结束 = false, 套接字 = null;
		const 兜底 = setTimeout(() => 结束({ 错误: '超时' }), 超时);
		function 结束(结论) {
			if (已结束) return;
			已结束 = true;
			clearTimeout(兜底);
			if (套接字) { 套接字.removeAllListeners(); 套接字.destroy(); }
			解析({ 地址, 端口, 握手毫秒, 首字节毫秒, ...结论 });
		}
		try {
			套接字 = tls.connect({
				host: 地址, port: 端口, servername: 域名,
				rejectUnauthorized: true, ALPNProtocols: ['http/1.1']
			}, () => {
				握手毫秒 = Number(process.hrtime.bigint() - 开始) / 1e6;
				套接字.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${域名}\r\nUser-Agent: edgetunnel-optimize/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
			});
		} catch (错误) {
			return 结束({ 错误: 错误.message });
		}
		套接字.on('data', (块) => {
			if (首字节毫秒 === null) 首字节毫秒 = Number(process.hrtime.bigint() - 开始) / 1e6;
			数据 += 块.toString('utf8');
		});
		套接字.on('end', () => {
			const 机房 = /(?:^|\n)colo=([A-Z]{3})/.exec(数据);
			const 状态 = /^HTTP\/1\.[01] (\d{3})/.exec(数据);
			if (!状态 || 状态[1] !== '200') return 结束({ 错误: 'HTTP ' + (状态 ? 状态[1] : '无响应') });
			结束({ 机房: 机房 ? 机房[1] : null });
		});
		套接字.on('error', (错误) => 结束({ 错误: 错误.code || 错误.message }));
	});
}

async function 并发执行(任务们, 上限) {
	const 结果 = new Array(任务们.length);
	let 下一个 = 0, 完成 = 0;
	const 工人 = async () => {
		while (下一个 < 任务们.length) {
			const 索引 = 下一个++;
			结果[索引] = await 任务们[索引]();
			完成++;
			if (完成 % 50 === 0) process.stderr.write(`  已测 ${完成}/${任务们.length}\n`);
		}
	};
	await Promise.all(Array.from({ length: Math.min(上限, 任务们.length) }, 工人));
	return 结果;
}

// 批量查国家归属（ip-api.com 免费接口，每次最多 100 个 IP，不需要密钥）。
async function 查归属(地址们) {
	const 结果 = new Map();
	for (let 起点 = 0; 起点 < 地址们.length; 起点 += 100) {
		const 批 = 地址们.slice(起点, 起点 + 100);
		try {
			const 响应 = await fetch('http://ip-api.com/batch?fields=status,countryCode,query', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(批),
				signal: AbortSignal.timeout(15000)
			});
			if (!响应.ok) throw new Error('HTTP ' + 响应.status);
			for (const 项 of await 响应.json()) {
				if (项.status === 'success') 结果.set(项.query, 项.countryCode);
			}
		} catch (错误) {
			process.stderr.write(`查归属失败（${错误.message}），该批将只显示机房\n`);
		}
	}
	return 结果;
}

const 段列表 = await 取官方段();
const 候选 = 生成候选(段列表, 候选数);
const 任务 = [];
for (const 地址 of 候选) for (const 端口 of 端口们) 任务.push(() => 探测(地址, 端口));

process.stderr.write(`候选 ${任务.length} 个（${候选.length} IP × ${端口们.length} 端口），并发 ${并发}，单次超时 ${超时} ms\n`);
const 首轮 = await 并发执行(任务, 并发);
let 可用 = 首轮.filter((项) => !项.错误 && 项.握手毫秒 !== null);
const 失败项 = 首轮.filter((项) => 项.错误);
// 失败项补测一次：并发握手下经常是瞬时重置，不是真的不通。补测数量设上限，避免拖长整体耗时。
if (失败项.length) {
	const 补测项 = 失败项.slice(0, 60);
	process.stderr.write(`补测 ${补测项.length}/${失败项.length} 个失败项 …\n`);
	const 补测 = await 并发执行(补测项.map((项) => () => 探测(项.地址, 项.端口)), Math.max(4, Math.floor(并发 / 2)));
	可用 = 可用.concat(补测.filter((项) => !项.错误 && 项.握手毫秒 !== null));
}
console.log(`\n候选 ${首轮.length} 个：存活 ${可用.length}，不通 ${首轮.length - 可用.length}`);

// 前列复测两轮取中位数，压掉单次抖动。
可用.sort((甲, 乙) => 甲.握手毫秒 - 乙.握手毫秒);
const 复测目标 = 可用.slice(0, Math.min(保留数 * 2, 24, 可用.length));
const 中位 = new Map();
for (const 项 of 复测目标) {
	const 样本 = [项.握手毫秒];
	for (let 轮 = 0; 轮 < 2; 轮++) {
		await 睡眠(20);
		const 结果 = await 探测(项.地址, 项.端口);
		if (!结果.错误 && 结果.握手毫秒 !== null) 样本.push(结果.握手毫秒);
	}
	样本.sort((甲, 乙) => 甲 - 乙);
	中位.set(`${项.地址}:${项.端口}`, 样本[Math.floor(样本.length / 2)]);
}

const 排名 = 可用.map((项) => ({
	...项,
	中位握手: 中位.has(`${项.地址}:${项.端口}`) ? 中位.get(`${项.地址}:${项.端口}`) : 项.握手毫秒
})).sort((甲, 乙) => 甲.中位握手 - 乙.中位握手);

const 入选 = 排名.slice(0, 保留数);

// 只对机房表里查不到的代码去查 IP 注册地，能省则省。
const 待查 = [...new Set(入选.filter((项) => !机房位置[项.机房]).map((项) => 项.地址))];
const 归属 = 待查.length ? await 查归属(待查) : new Map();

const 取位置 = (项) => {
	const 表中 = 机房位置[项.机房];
	if (表中) return { 国家: 表中[0], 城市: 表中[1] };
	const 代码 = 归属.get(项.地址);
	return { 国家: 代码 ? (国家中文[代码] || 代码) : '未知', 城市: '注册地' };
};

console.log('\n排名  地址                     位置                 机房   握手    首字节');
入选.forEach((项, 索引) => {
	const { 国家, 城市 } = 取位置(项);
	const 端点 = (项.地址 + ':' + 项.端口).padEnd(22);
	const 位置文本 = (国家 + (城市 && 城市 !== '注册地' ? '·' + 城市 : '')).padEnd(18);
	console.log(
		String(索引 + 1).padStart(3) + '  ' + 端点 + '  ' + 位置文本 +
		'  ' + String(项.机房 || '?').padEnd(5) + '  ' +
		项.中位握手.toFixed(0).padStart(4) + ' ms  ' + (项.首字节毫秒 || 0).toFixed(0).padStart(4) + ' ms'
	);
});

const 国家统计 = {};
for (const 项 of 入选) {
	const { 国家 } = 取位置(项);
	国家统计[国家] = (国家统计[国家] || 0) + 1;
}
console.log('\n国家分布：' + Object.entries(国家统计).map(([名, 数]) => `${名}×${数}`).join('  '));

// 备注格式：国家·城市/机房·延迟ms。国家与城市取自实测落地机房（colo），
// 这才是流量真正出网的位置；机房表查不到时才回落到 IP 注册地。
const 行们 = 入选.map((项) => {
	const { 国家, 城市 } = 取位置(项);
	const 地点 = 城市 && 城市 !== '注册地' ? 城市 : (项.机房 || 'XX');
	return `${项.地址}:${项.端口}#${国家}·${地点}·${项.中位握手.toFixed(0)}ms`;
});
const 文本 = 行们.join('\n') + '\n';

if (只测) {
	console.log(`\n（只测模式，未写入）可直接粘进面板「自定义优选IP」的内容：\n\n${文本}`);
	process.exit(0);
}

const 基址 = `https://${域名}`;
const 登入 = await fetch(`${基址}/login`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'edgetunnel-optimize/1.0' },
	body: 'password=' + encodeURIComponent(密码)
});
if (登入.status !== 200) {
	console.error(`登录失败：HTTP ${登入.status}`);
	process.exit(1);
}
const Cookie = (登入.headers.get('set-cookie') || '').split(';')[0];
if (!Cookie.startsWith('auth=')) {
	console.error('登录未返回会话 Cookie，检查密码是否正确');
	process.exit(1);
}
const 头部 = { Cookie, 'User-Agent': 'edgetunnel-optimize/1.0' };

const 配置响应 = await fetch(`${基址}/admin/config.json`, { headers: 头部 });
if (!配置响应.ok) {
	console.error(`读取配置失败：HTTP ${配置响应.status}`);
	process.exit(1);
}
const 配置 = await 配置响应.json();
if (配置.优选订阅生成 && 配置.优选订阅生成.本地IP库) {
	配置.优选订阅生成.本地IP库.随机IP = false; // 关掉随机优选，订阅才会用 ADD.txt
	配置.优选订阅生成.local = true;
}
const 保存配置 = await fetch(`${基址}/admin/config.json`, {
	method: 'POST',
	headers: { ...头部, 'Content-Type': 'application/json' },
	body: JSON.stringify(配置)
});
if (!保存配置.ok) {
	console.error(`保存配置失败：HTTP ${保存配置.status} ${(await 保存配置.text()).slice(0, 200)}`);
	process.exit(1);
}

const 保存IP = await fetch(`${基址}/admin/ADD.txt`, {
	method: 'POST',
	headers: { ...头部, 'Content-Type': 'text/plain;charset=utf-8' },
	body: 文本
});
if (!保存IP.ok) {
	console.error(`写入优选 IP 失败：HTTP ${保存IP.status} ${(await 保存IP.text()).slice(0, 200)}`);
	process.exit(1);
}

const 回读 = await (await fetch(`${基址}/admin/ADD.txt`, { headers: 头部 })).text();
if (回读.trim() !== 文本.trim()) {
	console.error('回读内容与写入不一致，请到面板核对');
	process.exit(1);
}
console.log(`\n已写入 KV：${回读.trim().split('\n').length} 条，回读校验一致；随机优选已关闭，订阅将直接用这批实测 IP。`);
