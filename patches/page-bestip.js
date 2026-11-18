/* 面板内优选测速（本 fork 新增）
 *
 * 面板自带的「随机优选」是从 104.16.0.0/13 里随机抽 IP，备注拼个编号，
 * 既不测速也不查位置 —— 所以既看不出国家，也不可能"按你的网络"变快。
 *
 * 这里把测速搬进浏览器：请求 https://IP:端口/ 时 SNI 是 IP，证书必然不匹配，
 * 但 TCP+TLS 握手已经跑完才会报错，这个"报错前的耗时"就是本机到该 IP 的真实 RTT；
 * 死 IP 是一路超时，两者区分得开（node / curl 交叉验证：活 IP 395~537ms 报证书错，
 * 假 IP 6s 超时；与 curl --resolve 的 time_appconnect 基本吻合）。
 *
 * 测完按延迟排序，位置由 Worker 批量查归属地（ip-api.com，结果缓存 7 天），
 * 勾选后一键写进 ADD.txt 并关掉「随机IP」开关。
 *
 * 本文件会被 String.raw 原样嵌进 _worker.js，因此：
 *   - 全文不得出现反引号
 *   - 全文不得出现美元符加大括号
 */
(function () {
	'use strict';
	if (window.__edtBestipLoaded) return;
	window.__edtBestipLoaded = true;

	var 国家中文 = {
		US: '美国', HK: '中国香港', TW: '中国台湾', MO: '中国澳门', JP: '日本', SG: '新加坡',
		KR: '韩国', DE: '德国', GB: '英国', NL: '荷兰', FR: '法国', CA: '加拿大', AU: '澳大利亚',
		IN: '印度', BR: '巴西', RU: '俄罗斯', IT: '意大利', ES: '西班牙', SE: '瑞典', CH: '瑞士',
		PL: '波兰', TR: '土耳其', AE: '阿联酋', IL: '以色列', ZA: '南非', MX: '墨西哥', AR: '阿根廷',
		TH: '泰国', VN: '越南', MY: '马来西亚', ID: '印度尼西亚', PH: '菲律宾', NZ: '新西兰',
		IE: '爱尔兰', BE: '比利时', AT: '奥地利', DK: '丹麦', NO: '挪威', FI: '芬兰', PT: '葡萄牙',
		CZ: '捷克', RO: '罗马尼亚', UA: '乌克兰', CL: '智利', CO: '哥伦比亚', PE: '秘鲁',
		SA: '沙特阿拉伯', EG: '埃及', NG: '尼日利亚', KE: '肯尼亚', PK: '巴基斯坦', BD: '孟加拉国',
		LK: '斯里兰卡', NP: '尼泊尔', KH: '柬埔寨', MM: '缅甸', MN: '蒙古', KZ: '哈萨克斯坦'
	};

	var 最大并发 = 16;
	var 单次超时 = 4000;
	var 复测次数 = 2;

	var 视图 = { 结果: [], 选中: {}, 运行中: false, 中止: false, 归属: {} };

	function 取变量(名, 兜底) {
		var 源 = [document.documentElement, document.body];
		for (var 序 = 0; 序 < 源.length; 序++) {
			if (!源[序]) continue;
			var 值 = getComputedStyle(源[序]).getPropertyValue(名);
			if (值 && 值.trim()) return 值.trim();
		}
		return 兜底;
	}

	function 转义(文本) {
		return String(文本 == null ? '' : 文本).replace(/[&<>"']/g, function (符) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[符];
		});
	}

	function 取整数(值, 兜底, 下限, 上限) {
		var 数 = parseInt(值, 10);
		if (!isFinite(数)) return 兜底;
		return Math.max(下限, Math.min(上限, 数));
	}

	function 解析端口(文本) {
		var 段 = String(文本 || '').split(/[^0-9]+/).filter(Boolean).map(Number).filter(function (值) {
			return 值 > 0 && 值 < 65536;
		});
		return 段.length ? 段.slice(0, 6) : [443, 2053, 2083];
	}

	function 中位数(样本) {
		var 有效 = 样本.filter(function (值) { return typeof 值 === 'number' && isFinite(值); });
		if (!有效.length) return null;
		有效.sort(function (甲, 乙) { return 甲 - 乙; });
		var 中 = Math.floor(有效.length / 2);
		return 有效.length % 2 ? 有效[中] : Math.round((有效[中 - 1] + 有效[中]) / 2);
	}

	// 一次探测：返回 { ip, port, ms, 原因 }。原因 ok 表示真的拿到了响应（罕见），
	// tls 表示握手完成但证书不匹配（正常），timeout 表示不可达。
	function 探测(ip, 端口, 超时) {
		return new Promise(function (落定) {
			var 起点 = performance.now();
			var 已停 = false;
			var 控制器 = window.AbortController ? new AbortController() : null;
			var 计时 = setTimeout(function () {
				if (控制器) { try { 控制器.abort(); } catch (错) { } }
				收尾('timeout');
			}, 超时);

			function 收尾(原因) {
				if (已停) return;
				已停 = true;
				clearTimeout(计时);
				// 键必须逐条唯一：复测样本表、勾选状态都以它为索引，漏掉就会让所有候选共用一个键
				落定({ 键: ip + ':' + 端口, ip: ip, port: 端口, ms: Math.round(performance.now() - 起点), 原因: 原因 });
			}

			var 选项 = { mode: 'no-cors', cache: 'no-store', credentials: 'omit' };
			if (控制器) 选项.signal = 控制器.signal;

			fetch('https://' + ip + ':' + 端口 + '/cdn-cgi/trace?r=' + Math.random().toString(36).slice(2), 选项)
				.then(function () { 收尾('ok'); })
				.catch(function (错) {
					收尾(错 && 错.name === 'AbortError' ? 'timeout' : 'tls');
				});
		});
	}

	async function 并发跑(任务们, 上限, 每完成) {
		var 游标 = 0;
		var 工人数 = Math.max(1, Math.min(上限, 任务们.length));
		var 工人们 = [];
		for (var 序 = 0; 序 < 工人数; 序++) {
			工人们.push((async function () {
				for (;;) {
					if (视图.中止) return;
					var 当前 = 游标++;
					if (当前 >= 任务们.length) return;
					var 结果 = await 任务们[当前]();
					if (每完成) 每完成(结果, 当前);
				}
			})());
		}
		await Promise.all(工人们);
	}

	// ── 界面 ──
	var 样式 = [
		':host{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:block;}',
		'*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}',
		'.stack{display:flex;flex-direction:column;align-items:flex-end;gap:10px;}',
		'.fab{border:0;border-radius:999px;padding:11px 18px;font-size:13px;font-weight:600;color:#fff;cursor:pointer;',
		'background:linear-gradient(135deg,#2563eb,#1d4ed8);box-shadow:0 6px 18px rgba(37,99,235,.32);letter-spacing:.3px;}',
		'.fab:hover{filter:brightness(1.06);}',
		'.wrap{display:none;width:392px;max-width:calc(100vw - 32px);border-radius:14px;overflow:hidden;',
		'background:var(--卡面,#fff);color:var(--正文,#1f2937);border:1px solid var(--边线,#e5e7eb);',
		'box-shadow:0 14px 44px rgba(15,23,42,.22);}',
		'.wrap.on{display:block;}',
		'.hd{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid var(--边线,#e5e7eb);}',
		'.hd b{font-size:14px;font-weight:700;}',
		'.x{border:0;background:transparent;color:var(--次要,#666);font-size:19px;line-height:1;cursor:pointer;padding:2px 4px;}',
		'.note{padding:10px 15px 0;font-size:11.5px;line-height:1.6;color:var(--次要,#6b7280);}',
		'.row{display:flex;gap:8px;padding:11px 15px 0;}',
		'.row.end{padding-top:12px;padding-bottom:13px;}',
		'.fld{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0;}',
		'.fld span{font-size:11px;color:var(--次要,#6b7280);}',
		'.fld input{width:100%;padding:6px 8px;font-size:12.5px;border-radius:7px;',
		'border:1px solid var(--边线,#d1d5db);background:var(--输入底,#f9fafb);color:var(--正文,#1f2937);}',
		'.fld input:focus{outline:2px solid rgba(37,99,235,.35);outline-offset:0;}',
		'button.act{flex:1;border:1px solid var(--边线,#d1d5db);background:var(--输入底,#f3f4f6);color:var(--正文,#1f2937);',
		'padding:8px 10px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;}',
		'button.act:disabled{opacity:.45;cursor:not-allowed;}',
		'button.act.pri{background:#2563eb;border-color:#2563eb;color:#fff;}',
		'button.act.pri:hover:not(:disabled){background:#1d4ed8;}',
		'.bar{height:3px;margin:11px 15px 0;border-radius:2px;background:var(--输入底,#eef2f7);overflow:hidden;display:none;}',
		'.bar.on{display:block;}',
		'.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3b82f6,#2563eb);transition:width .2s;}',
		'.stat{padding:8px 15px 0;font-size:11.5px;color:var(--次要,#6b7280);min-height:16px;}',
		'.list{max-height:308px;overflow:auto;margin:9px 15px 0;}',
		'.list:empty{display:none;}',
		'.item{display:grid;grid-template-columns:16px 20px 1fr 92px 58px;align-items:center;gap:6px;',
		'padding:6px 2px;border-bottom:1px solid var(--边线,#f1f5f9);font-size:12px;cursor:pointer;}',
		'.item:hover{background:var(--悬停,#f8fafc);}',
		'.item input{width:14px;height:14px;accent-color:#2563eb;cursor:pointer;}',
		'.idx{font-size:10.5px;color:var(--次要,#9ca3af);text-align:right;}',
		'.addr{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;}',
		'.loc{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
		'.ms{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;font-size:11.5px;}',
		'.ms.good{color:#15803d;} .ms.mid{color:#b45309;} .ms.bad{color:#b91c1c;}',
		'.empty{padding:14px 0;text-align:center;font-size:11.5px;color:var(--次要,#9ca3af);}',
		'.foot{padding:10px 15px 13px;font-size:11px;color:var(--次要,#9ca3af);}'
	].join('');

	var 面板HTML = [
		'<div class="stack">',
		'<div class="wrap" id="wrap">',
		'<div class="hd"><b>按本机网络优选</b><button class="x" id="关闭" title="收起">&times;</button></div>',
		'<div class="note">用这台浏览器实测各 IP 的握手耗时，按你的网络排序，备注写成「国家·延迟」。',
		'控制台出现一批证书错误是正常的：这里故意用 IP 直连，靠"报错前的耗时"当延迟。</div>',
		'<div class="row">',
		'<div class="fld"><span>候选 IP</span><input id="数量" type="number" value="60" min="10" max="300"></div>',
		'<div class="fld" style="flex:1.4"><span>端口</span><input id="端口" type="text" value="443,2053,2083"></div>',
		'<div class="fld" style="flex:.8"><span>保留</span><input id="保留" type="number" value="10" min="1" max="60"></div>',
		'</div>',
		'<div class="row end">',
		'<button class="act pri" id="开始">开始测速</button>',
		'<button class="act" id="停止" disabled>停止</button>',
		'<button class="act" id="写入" disabled>写入订阅</button>',
		'</div>',
		'<div class="bar" id="进度条"><i id="进度"></i></div>',
		'<div class="stat" id="状态">就绪</div>',
		'<div class="list" id="列表"></div>',
		'<div class="foot" id="脚注">国家取自 IP 归属地数据库，不是你实际落地的机房；延迟是本机到该 IP 的握手时间。',
		'浏览器若挂着代理，测出的耗时会含代理开销 —— 要测真实线路请先关掉代理。</div>',
		'</div>',
		'<button class="fab" id="开关">&#9889; 优选测速</button>',
		'</div>'
	].join('');

	var 宿主 = document.createElement('div');
	宿主.id = 'edt-bestip';
	document.body.appendChild(宿主);
	var 影子 = 宿主.attachShadow({ mode: 'open' });
	影子.innerHTML = '<style>' + 样式 + '</style>' + 面板HTML;

	var 元素 = {
		面板: 影子.getElementById('wrap'),
		开关: 影子.getElementById('开关'),
		关闭: 影子.getElementById('关闭'),
		数量: 影子.getElementById('数量'),
		端口: 影子.getElementById('端口'),
		保留: 影子.getElementById('保留'),
		开始: 影子.getElementById('开始'),
		停止: 影子.getElementById('停止'),
		写入: 影子.getElementById('写入'),
		进度条: 影子.getElementById('进度条'),
		进度: 影子.getElementById('进度'),
		状态: 影子.getElementById('状态'),
		列表: 影子.getElementById('列表')
	};

	function 状态(文本) { 元素.状态.textContent = 文本; }

	function 进度(百分比) {
		元素.进度条.classList.add('on');
		元素.进度.style.width = Math.max(0, Math.min(100, 百分比)) + '%';
	}

	function 位置名(项) {
		var 归属 = 视图.归属[项.ip];
		if (!归属) return '未知';
		var 代码 = String(归属.cc || '').toUpperCase();
		var 名 = 国家中文[代码] || 归属.country || 代码 || '未知';
		if (归属.city) 名 += '·' + 归属.city;
		return 名;
	}

	function 备注(项) {
		var 归属 = 视图.归属[项.ip];
		var 代码 = 归属 ? String(归属.cc || '').toUpperCase() : '';
		var 名 = 国家中文[代码] || (归属 && 归属.country) || 'CF';
		return 名 + '·' + 项.ms + 'ms';
	}

	function 档位(毫秒) {
		if (毫秒 < 150) return 'good';
		if (毫秒 < 350) return 'mid';
		return 'bad';
	}

	function 渲染() {
		if (!视图.结果.length) { 元素.列表.innerHTML = ''; return; }
		var 片段 = [];
		视图.结果.forEach(function (项, 序) {
			片段.push(
					'<label class="item">' +
					'<input type="checkbox" data-键="' + 转义(项.键) + '"' + (视图.选中[项.键] ? ' checked' : '') + '>' +
					'<span class="idx">' + (序 + 1) + '</span>' +
					'<span class="addr">' + 转义(项.ip + ':' + 项.port) + '</span>' +
					'<span class="loc">' + 转义(位置名(项)) + '</span>' +
					'<span class="ms ' + 档位(项.ms) + '">' + 项.ms + 'ms</span>' +
					'</label>'
				);
			});
		元素.列表.innerHTML = 片段.join('');
		var 已选 = Object.keys(视图.选中).filter(function (键) { return 视图.选中[键]; }).length;
		元素.写入.disabled = 视图.运行中 || 已选 === 0;
		元素.写入.textContent = 已选 ? '写入订阅（' + 已选 + '）' : '写入订阅';
	}

	元素.列表.addEventListener('change', function (事件) {
		var 目标 = 事件.target;
		if (!目标 || 目标.tagName !== 'INPUT') return;
		var 键 = 目标.getAttribute('data-键');
		if (!键) return;
		视图.选中[键] = 目标.checked;
		渲染();
	});

	元素.开关.addEventListener('click', function () {
		var 展开 = !元素.面板.classList.contains('on');
		元素.面板.classList.toggle('on', 展开);
		元素.开关.textContent = 展开 ? '\u00d7 收起' : '\u26a1 优选测速';
	});

	元素.关闭.addEventListener('click', function () {
		元素.面板.classList.remove('on');
		元素.开关.textContent = '\u26a1 优选测速';
	});

	async function 拉候选(数量, 端口们) {
		var 响应 = await fetch('/admin/bestip/candidates?count=' + 数量 + '&ports=' + 端口们.join(','), {
			credentials: 'same-origin', cache: 'no-store'
		});
		if (!响应.ok) throw new Error('候选接口返回 ' + 响应.status);
		var 数据 = await 响应.json();
		if (!数据 || !数据.地址们 || !数据.地址们.length) throw new Error('候选为空，请检查 Worker 是否已更新');
		return 数据.地址们;
	}

	async function 查归属(地址们) {
		var 唯 = [];
		地址们.forEach(function (地址) { if (唯.indexOf(地址) < 0) 唯.push(地址); });
		for (var 起 = 0; 起 < 唯.length; 起 += 40) {
			var 批 = 唯.slice(起, 起 + 40);
			try {
				var 响应 = await fetch('/admin/bestip/geo?ips=' + encodeURIComponent(批.join(',')), {
					credentials: 'same-origin', cache: 'no-store'
				});
				if (!响应.ok) continue;
				var 数据 = await 响应.json();
				var 表 = (数据 && 数据.归属) || {};
				for (var 键 in 表) {
					if (Object.prototype.hasOwnProperty.call(表, 键)) 视图.归属[键] = 表[键];
				}
			} catch (错) { /* 单批失败不影响整体 */ }
		}
	}

	function 存活(项) {
		return 项 && 项.原因 !== 'timeout' && 项.ms < 单次超时 - 250;
	}

	async function 开始() {
		if (视图.运行中) return;
		视图.运行中 = true;
		视图.中止 = false;
		视图.结果 = [];
		视图.选中 = {};
		视图.归属 = {};
		元素.开始.disabled = true;
		元素.停止.disabled = false;
		渲染();

		var 数量 = 取整数(元素.数量.value, 60, 10, 300);
		var 端口们 = 解析端口(元素.端口.value);
		var 保留 = 取整数(元素.保留.value, 10, 1, 60);

		var 地址们;
		try {
			状态('正在生成候选 …');
			进度(4);
			地址们 = await 拉候选(数量, 端口们);
		} catch (错) {
			状态('候选获取失败：' + 错.message);
			视图.运行中 = false;
			元素.开始.disabled = false;
			元素.停止.disabled = true;
			return;
		}

		var 任务们 = 地址们.map(function (地址, 序) {
			var 端口 = 端口们[序 % 端口们.length];
			return function () { return 探测(地址, 端口, 单次超时); };
		});

		var 完成 = 0;
		var 全部 = [];
		状态('测速中 0/' + 任务们.length);
		await 并发跑(任务们, 最大并发, function (结果) {
			完成++;
			全部.push(结果);
			if (完成 % 4 === 0 || 完成 === 任务们.length) {
				var 活 = 全部.filter(存活).length;
				状态('测速中 ' + 完成 + '/' + 任务们.length + ' · 可用 ' + 活);
				进度(4 + 任务们.length ? 6 + (完成 / 任务们.length) * 72 : 6);
			}
		});

		if (视图.中止) {
			状态('已停止');
			视图.运行中 = false;
			元素.开始.disabled = false;
			元素.停止.disabled = true;
			return;
		}

		var 排序 = 全部.filter(存活).sort(function (甲, 乙) { return 甲.ms - 乙.ms; });
		if (!排序.length) {
			状态('没有探测到可用 IP。可能是本机网络屏蔽了这些地址，换个网络或加大候选数再试。');
			进度(100);
			视图.运行中 = false;
			元素.开始.disabled = false;
			元素.停止.disabled = true;
			return;
		}

		// 复测：首轮很快不代表稳定，对靠前的候选多测几次取中位数
		var 复测池 = 排序.slice(0, Math.min(保留 * 2, 排序.length));
		var 样本表 = {};
		复测池.forEach(function (项) { 样本表[项.键] = [项.ms]; });
		var 复测任务 = [];
		复测池.forEach(function (项) {
			for (var 轮 = 0; 轮 < 复测次数; 轮++) {
				复测任务.push(function () {
					return 探测(项.ip, 项.port, 单次超时).then(function (再) {
						if (存活(再)) 样本表[项.键].push(再.ms);
						return 再;
					});
				});
			}
		});
		状态('复测靠前的 ' + 复测池.length + ' 个候选 …');
		await 并发跑(复测任务, 8, null);

		复测池.forEach(function (项) {
			var 中位 = 中位数(样本表[项.键]);
			// 三次里至少两次通才算稳定，否则视为侥幸命中
			if (中位 !== null && 样本表[项.键].length >= 3) 项.ms = 中位;
			else 项.不稳 = true;
		});

		排序 = 排序.filter(function (项) { return !项.不稳; }).sort(function (甲, 乙) { return 甲.ms - 乙.ms; });
		var 入选 = 排序.slice(0, 保留);

		状态('查询归属地 …');
		进度(92);
		await 查归属(入选.map(function (项) { return 项.ip; }));

		视图.结果 = 入选;
		入选.forEach(function (项, 序) { 视图.选中[项.键] = true; });
		渲染();
		进度(100);

		var 国家集 = {};
		入选.forEach(function (项) {
			var 归属 = 视图.归属[项.ip];
			var 代码 = 归属 ? (国家中文[String(归属.cc || '').toUpperCase()] || 归属.country || '未知') : '未知';
			国家集[代码] = (国家集[代码] || 0) + 1;
		});
		var 分布 = Object.keys(国家集).map(function (键) { return 键 + '×' + 国家集[键]; }).join('  ');
		var 不足 = 入选.length < 保留 ? '；可用不足 ' + 保留 + ' 个，把候选数调大再测一次会更稳' : '';
		状态('完成：实测 ' + 任务们.length + ' 个，可用 ' + 全部.filter(存活).length + ' 个，入选 ' + 入选.length + ' 个' + (分布 ? '（' + 分布 + '）' : '') + 不足);

		视图.运行中 = false;
		元素.开始.disabled = false;
		元素.停止.disabled = true;
		渲染();
	}

	async function 写入() {
		var 选中项 = 视图.结果.filter(function (项) { return 视图.选中[项.键]; });
		if (!选中项.length) { 状态('先勾选要写入的节点'); return; }
		元素.写入.disabled = true;
		try {
			状态('正在关闭「随机IP」开关 …');
			var 配置响应 = await fetch('/admin/config.json', { credentials: 'same-origin', cache: 'no-store' });
			if (!配置响应.ok) throw new Error('读取配置失败 ' + 配置响应.status);
			var 配置 = await 配置响应.json();
			if (!配置.优选订阅生成) 配置.优选订阅生成 = {};
			if (!配置.优选订阅生成.本地IP库) 配置.优选订阅生成.本地IP库 = {};
			配置.优选订阅生成.本地IP库.随机IP = false;

			var 保存 = await fetch('/admin/config.json', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(配置)
			});
			if (!保存.ok) throw new Error('保存配置失败 ' + 保存.status);

			状态('正在写入优选列表 …');
			var 文本 = 选中项.map(function (项) {
				return 项.ip + ':' + 项.port + '#' + 备注(项);
			}).join('\n') + '\n';

			var 写入响应 = await fetch('/admin/ADD.txt', {
				method: 'POST',
				credentials: 'same-origin',
				body: 文本
			});
			if (!写入响应.ok) throw new Error('写入优选列表失败 ' + 写入响应.status);

			var 回读 = await (await fetch('/admin/ADD.txt', { credentials: 'same-origin', cache: 'no-store' })).text();
			if (回读.trim() !== 文本.trim()) throw new Error('回读校验不一致，写入可能未生效');

			状态('已写入 ' + 选中项.length + ' 个节点，订阅已切换到这份列表。回去刷新一下订阅即可。');
		} catch (错) {
			状态('写入失败：' + 错.message);
		} finally {
			元素.写入.disabled = 视图.结果.length === 0;
			渲染();
		}
	}

	元素.开始.addEventListener('click', 开始);
	元素.停止.addEventListener('click', function () { 视图.中止 = true; 状态('正在停止 …'); });
	元素.写入.addEventListener('click', 写入);
})();
