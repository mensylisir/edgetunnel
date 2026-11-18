import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const 根目录 = join(dirname(fileURLToPath(import.meta.url)), '..');
const 目标 = join(根目录, '_worker.js');
const 原始内容 = readFileSync(目标);
const 源码 = 原始内容.toString('utf8');
const 字节数 = 原始内容.length;
const 行数 = 源码.split('\n').length;

const 结果 = [];
const 记录 = (名称, 通过, 说明) => 结果.push({ 名称, 通过, 说明 });

记录('无 UTF-8 BOM', 原始内容[0] !== 0xef || 原始内容[1] !== 0xbb || 原始内容[2] !== 0xbf, `首字节 ${原始内容.subarray(0, 3).toString('hex')}`);
记录('体积在 250 KB ~ 900 KB', 字节数 >= 250 * 1024 && 字节数 <= 900 * 1024, `${(字节数 / 1024).toFixed(0)} KB`);
记录('行数 ≥ 6000', 行数 >= 6000, `${行数} 行`);

// 精确检测「整行开启、跨 500 行以上才关闭」的块注释：上游曾把整本塔纳赫塞进这样一个注释里。
// 不用正则正查 /\/\*[\s\S]{50000,}?\*\//，那会把 /** @type ... *\/ 之类的行内注释误判成巨型注释。
let 巨型注释行数 = 0, 注释起始 = -1;
const 全部行 = 源码.split('\n');
for (let 索引 = 0; 索引 < 全部行.length; 索引++) {
	const 内容 = 全部行[索引].trim();
	if (注释起始 === -1 && 内容.startsWith('/*')) { 注释起始 = 索引; continue; }
	if (注释起始 !== -1 && 内容.endsWith('*/')) {
		if (索引 - 注释起始 > 500) 巨型注释行数 = Math.max(巨型注释行数, 索引 - 注释起始);
		注释起始 = -1;
	}
}
记录('无跨 500 行的块注释', 巨型注释行数 === 0, 巨型注释行数 ? `存在 ${巨型注释行数} 行的巨型注释` : '未发现');
记录('无上游冗余注释内容', !源码.includes('Tanach with Nikkud') && !源码.includes('www.tanach.us'), '未发现塔纳赫注释残留');

const 语法 = spawnSync(process.execPath, ['--check', 目标], { encoding: 'utf8' });
记录('JS 语法检查', 语法.status === 0, 语法.status === 0 ? 'node --check 通过' : (语法.stderr || '').split('\n')[0]);

const 代码标记 = ['class TlsClient', 'socks5Connect', 'turnConnect', 'sstpConnect', '处理叉HTTP请求', '处理gRPC请求', '处理WS请求', '处理订阅'];
const 缺失代码 = 代码标记.filter((标记) => !源码.includes(标记));
记录('核心逻辑完整', 缺失代码.length === 0, 缺失代码.length ? `缺少：${缺失代码.join('、')}` : `${代码标记.length} 个关键符号齐备`);

const 补丁标记 = ['安全加固（本 fork 新增）', '恒定时间比较(', '生成会话令牌(', '校验会话令牌(', '登录失败上限', 'env.SECRET || env.KEY', 'function 静态页基址'];
const 缺失补丁 = 补丁标记.filter((标记) => !源码.includes(标记));
记录('安全补丁在位', 缺失补丁.length === 0, 缺失补丁.length ? `缺少：${缺失补丁.join('、')}` : `${补丁标记.length} 个补丁标记齐备`);

const 旧Cookie = 源码.includes('MD5MD5(UA + 加密秘钥 + 管理员密码)');
记录('旧静态 Cookie 已移除', !旧Cookie, 旧Cookie ? '仍存在 MD5(UA+KEY+ADMIN) 会话判定' : '已全部改为 HMAC 令牌校验');

const 密码回退 = /env\.TOKEN \|\| env\.KEY/.test(源码);
记录('密码不再回退到 KEY/UUID', !密码回退, 密码回退 ? '仍存在 env.TOKEN || env.KEY' : '仅接受 ADMIN/PASSWORD/pswd/TOKEN');

const 宽度 = Math.max(...结果.map((项) => 项.名称.length));
for (const 项 of 结果) console.log(`${项.通过 ? '通过' : '失败'}  ${项.名称.padEnd(宽度, '　')}  ${项.说明}`);

const 失败数 = 结果.filter((项) => !项.通过).length;
if (失败数) {
	console.error(`\n${失败数} 项检查未通过`);
	process.exit(1);
}
console.log(`\n全部 ${结果.length} 项检查通过`);
