// 把 patches/page-bestip*.js 同步进 _worker.js。
//
// 前端测速脚本有 20 KB 且有大量正则与引号，直接手写在 _worker.js 里没法维护，
// 所以拆成两个源文件：patches/page-bestip.js（浏览器端）、patches/page-bestip-worker.js（Worker 端）。
// 本脚本负责把它们合成一个区块写进 _worker.js，用固定的起止标记包裹，可重复执行。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const 根目录 = join(dirname(fileURLToPath(import.meta.url)), '..');
const 工作文件 = join(根目录, '_worker.js');
const 前端文件 = join(根目录, 'patches', 'page-bestip.js');
const 端上文件 = join(根目录, 'patches', 'page-bestip-worker.js');

const 起始标记 = '///////////////////////////////////////////////////////页面内优选测速（本 fork 新增）///////////////////////////////////////////////';
const 结束标记 = '///////////////////////////////////////////////////////页面内优选测速结束///////////////////////////////////////////////';

const 前端源码 = readFileSync(前端文件, 'utf8');
const 端上模板 = readFileSync(端上文件, 'utf8');

// String.raw 会用反引号包裹，所以前端源码里不能有反引号，也不能有 ${ —— 会把嵌入位置提前截断
if (前端源码.includes('`')) throw new Error('patches/page-bestip.js 含反引号，无法用 String.raw 嵌入');
if (前端源码.includes('${')) throw new Error('patches/page-bestip.js 含模板插值 ${，无法用 String.raw 嵌入');
if (!端上模板.includes('__前端脚本__')) throw new Error('patches/page-bestip-worker.js 缺少 __前端脚本__ 占位符');

// 用函数形式替换：前端源码里若有 $& / $' 之类，字符串形式会被当成替换模式解释
const 区块 = 起始标记 + '\n' + 端上模板.replace('__前端脚本__', () => '\n' + 前端源码 + '\n') + 结束标记 + '\n';

let 源码 = readFileSync(工作文件, 'utf8');
const 起 = 源码.indexOf(起始标记);
const 止 = 源码.indexOf(结束标记);

let 动作;
if (起 > -1 && 止 > 起) {
	const 原区块 = 源码.slice(起, 源码.indexOf('\n', 止) + 1);
	if (原区块 === 区块) {
		console.log('页面优选区块已是最新，无变更');
		process.exit(0);
	}
	源码 = 源码.slice(0, 起) + 区块 + 源码.slice(源码.indexOf('\n', 止) + 1);
	动作 = '替换已有区块';
} else {
	// 首次插入：放在「主程序入口」之前，确保这些函数在任何调用点之前完成定义（函数声明本来会提升，
	// 但常量是 TDZ 的，所以位置必须在 request 处理逻辑之前）
	const 锚点 = '///////////////////////////////////////////////////////主程序入口///////////////////////////////////////////////';
	const 位置 = 源码.indexOf(锚点);
	if (位置 < 0) throw new Error('找不到「主程序入口」锚点，_worker.js 结构已变化');
	源码 = 源码.slice(0, 位置) + 区块 + '\n' + 源码.slice(位置);
	动作 = '首次插入';
}

writeFileSync(工作文件, 源码, 'utf8');

const 摘要 = (文本) => createHash('sha256').update(文本, 'utf8').digest('hex').slice(0, 12);
console.log(`页面优选：${动作}；前端脚本 ${(Buffer.byteLength(前端源码) / 1024).toFixed(1)} KB（sha256 ${摘要(前端源码)}）`);
console.log(`_worker.js 现为 ${(Buffer.byteLength(源码) / 1024).toFixed(0)} KB / ${源码.split('\n').length} 行`);
