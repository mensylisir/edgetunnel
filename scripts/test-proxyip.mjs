import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 直接截取产物里的健康记忆模块来测——测的就是线上跑的那份代码，不另写一份实现。
const 根目录 = dirname(dirname(fileURLToPath(import.meta.url)));
const 源码 = readFileSync(join(根目录, '_worker.js'), 'utf8');
const 起 = 源码.indexOf('// >>> PROXYIP 健康记忆');
const 止 = 源码.indexOf('// <<< PROXYIP 健康记忆');
if (起 < 0 || 止 < 0) throw new Error('_worker.js 里找不到 PROXYIP 健康记忆模块');

const 片段 = 源码.slice(起, 止);
const 建模块 = () => new Function(
	片段 + '\nreturn { 标记反代成功, 标记反代失败, 反代冷却中, 按健康排序反代候选, 反代健康表, 反代候选键 };'
)();

const 甲 = ['10.0.0.1', 443];
const 乙 = ['10.0.0.2', 443];
const 丙 = ['10.0.0.3', 443];
const 三候选 = [甲, 乙, 丙];

test('一次成功即粘住：即使不是列表第一个，排序后也排到最前', () => {
	const 健康 = 建模块();
	健康.标记反代成功(丙[0], 丙[1]);
	const 排序 = 健康.按健康排序反代候选(三候选);
	assert.deepEqual(排序[0], 丙, '成功的候选必须排第一，否则出口 IP 会漂回列表首位');
});

test('单次失败不冷却，且不打破粘住（偶发超时不该换 IP）', () => {
	const 健康 = 建模块();
	健康.标记反代成功(甲[0], 甲[1]);
	健康.标记反代失败(甲[0], 甲[1]);
	assert.equal(健康.反代冷却中(甲[0], 甲[1]), false, '第一次失败只记数，不进冷却');
	assert.deepEqual(健康.按健康排序反代候选(三候选)[0], 甲, '粘住关系必须保持');
});

test('连续两次失败才冷却，并让出粘住位', () => {
	const 健康 = 建模块();
	健康.标记反代成功(甲[0], 甲[1]);
	健康.标记反代失败(甲[0], 甲[1]);
	健康.标记反代失败(甲[0], 甲[1]);
	assert.equal(健康.反代冷却中(甲[0], 甲[1]), true, '连续两次失败应进入冷却');
	const 排序 = 健康.按健康排序反代候选(三候选);
	assert.deepEqual(排序[排序.length - 1], 甲, '冷却中的候选排到最后，但仍保留');
	assert.equal(排序.length, 3, '不能把冷却候选剔除，全挂了还得试');
});

test('成功后清除冷却状态，可重新被选用', () => {
	const 健康 = 建模块();
	健康.标记反代失败(甲[0], 甲[1]);
	健康.标记反代失败(甲[0], 甲[1]);
	assert.equal(健康.反代冷却中(甲[0], 甲[1]), true);
	健康.标记反代成功(甲[0], 甲[1]);
	assert.equal(健康.反代冷却中(甲[0], 甲[1]), false);
	assert.deepEqual(健康.按健康排序反代候选(三候选)[0], 甲);
});

test('排序是确定的：同一状态多次排序结果完全一致', () => {
	const 健康 = 建模块();
	健康.标记反代成功(乙[0], 乙[1]);
	const 第一次 = 健康.按健康排序反代候选(三候选);
	const 第二次 = 健康.按健康排序反代候选(三候选);
	const 第三次 = 健康.按健康排序反代候选(三候选);
	assert.deepEqual(第一次, 第二次);
	assert.deepEqual(第二次, 第三次);
	assert.deepEqual(第一次.map((项) => 项[0]), [乙[0], 甲[0], 丙[0]]);
});

test('无记录时保持配置原序（不打乱、不随机）', () => {
	const 健康 = 建模块();
	assert.deepEqual(健康.按健康排序反代候选(三候选), 三候选, '没有健康信息时不能重排');
});

test('单候选与空输入直接返回，不产生额外开销', () => {
	const 健康 = 建模块();
	assert.deepEqual(健康.按健康排序反代候选([甲]), [甲]);
	assert.deepEqual(健康.按健康排序反代候选([]), []);
	assert.deepEqual(健康.按健康排序反代候选(null), null);
});

test('PROXYIP 多地址必须全量下传，不能随机只取一个', () => {
	assert.equal(
		/proxyIPs\[Math\.floor\(Math\.random\(\) \* proxyIPs\.length\)\]/.test(源码),
		false,
		'仍存在随机取一个的写法：PROXYIP 里其余地址不会参与选择'
	);
	assert.ok(源码.includes("默认反代IP = proxyIPs.join(',')"), '应把全部候选拼起来交给 connectProxyIP');
});

test('健康表有容量上限，避免长期运行内存膨胀', () => {
	const 健康 = 建模块();
	for (let i = 0; i < 900; i++) 健康.标记反代成功('10.1.' + Math.floor(i / 250) + '.' + (i % 250), 443);
	assert.ok(健康.反代健康表.size <= 512, '实际 ' + 健康.反代健康表.size + ' 条');
});
