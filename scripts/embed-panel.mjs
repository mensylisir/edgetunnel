// 把后台面板整份内嵌进 _worker.js，产出「一个文件、零外部请求」的独立版本。
//
// 背景：默认构建里，/admin、/login、/noADMIN、/noKV 四个页面是运行时去 edt-pages.github.io
// 取的。把面板塞进脚本后，这几个页面直接从脚本内部返回，运行期不再请求任何第三方站点，
// 作者改页面、关仓库、投毒都影响不到你。
//
// 用法：
//   npm run mirror   # 先把四个页面镜像到 dist/panel（上游更新面板后重跑这一步）
//   npm run embed    # 生成 dist/standalone/_worker.js，并自检
//
// 代价：脚本从约 313 KB 涨到约 1.4 MB（未压缩上限 64 MiB，余量充足），面板不再自动跟随上游更新。

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const 根目录 = join(dirname(fileURLToPath(import.meta.url)), '..');
const 基础文件 = join(根目录, '_worker.js');
const 面板目录 = join(根目录, 'dist', 'panel');
const 输出目录 = join(根目录, 'dist', 'standalone');
const 输出文件 = join(输出目录, '_worker.js');

const 面板 = [
	['/admin', join(面板目录, 'admin', 'index.html')],
	['/login', join(面板目录, 'login', 'index.html')],
	['/noADMIN', join(面板目录, 'noADMIN', 'index.html')],
	['/noKV', join(面板目录, 'noKV', 'index.html')]
];

const 缺失 = 面板.filter(([, 路径]) => !existsSync(路径)).map(([键]) => 键);
if (缺失.length) {
	console.error(`缺少面板文件：${缺失.join('、')}\n先跑 npm run mirror 把页面镜像到 dist/panel。`);
	process.exit(1);
}

// JSON.stringify 生成的是合法 JS 字符串字面量，能安全处理反引号、${} 与引号；
// U+2028/U+2029 在 JSON 里合法、在老 JS 里非法，顺手转义掉。
const 转字符串 = (文本) => JSON.stringify(文本).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const 映射项 = 面板.map(([键, 路径]) => `\t${转字符串(键)}: ${转字符串(readFileSync(路径, 'utf8'))}`);

let 源码 = readFileSync(基础文件, 'utf8');
const 占位 = 'let 内嵌页面 = null;';
if (!源码.includes(占位)) {
	console.error('找不到内嵌占位 `let 内嵌页面 = null;` —— 基础 _worker.js 不是本仓库构建产物，先跑 npm run build。');
	process.exit(1);
}
源码 = 源码.replace(占位, `const 内嵌页面 = {\n${映射项.join(',\n')}\n};`);

mkdirSync(输出目录, { recursive: true });
writeFileSync(输出文件, 源码, 'utf8');

const 字节 = statSync(输出文件).size;
const 语法 = spawnSync(process.execPath, ['--check', 输出文件], { encoding: 'utf8' });
if (语法.status !== 0) {
	console.error('语法检查失败：' + (语法.stderr || '').split('\n')[0]);
	process.exit(1);
}

// 自检：导入产物、请求 /login，断言①返回的是内嵌面板 ②一次外部 fetch 都没有。
const 出站 = [];
globalThis.fetch = async (输入) => {
	出站.push(typeof 输入 === 'string' ? 输入 : (输入?.url || ''));
	return new Response('网络兜底响应', { status: 200 });
};

const 原始摘要 = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
const 摘要替身 = async (算法, 数据) => {
	const 名称 = String(typeof 算法 === 'string' ? 算法 : (算法?.name || '')).toUpperCase();
	if (名称 !== 'MD5') return 原始摘要(算法, 数据);
	const 结果 = createHash('md5').update(new Uint8Array(数据)).digest();
	return 结果.buffer.slice(结果.byteOffset, 结果.byteOffset + 结果.byteLength);
};
try { globalThis.crypto.subtle.digest = 摘要替身; } catch {
	Object.defineProperty(globalThis.crypto.subtle, 'digest', { value: 摘要替身, configurable: true });
}

const { default: 工作者 } = await import(pathToFileURL(输出文件).href);
const 建KV = () => {
	const 数据 = new Map();
	return { 数据, async get(k) { return 数据.has(k) ? 数据.get(k) : null; }, async put(k, v) { 数据.set(k, String(v)); }, async delete(k) { 数据.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
};
const 造请求 = (路径, 选项 = {}) => ({
	url: `https://tunnel.example.com${路径}`,
	method: 选项.方法 || 'GET',
	headers: new Headers({ 'User-Agent': 'embed-selfcheck/1.0', 'CF-Connecting-IP': '198.51.100.1', ...(选项.Cookie ? { Cookie: 选项.Cookie } : {}) }),
	cf: { colo: 'HKG' },
	text: async () => 选项.表单 || ''
});

const 环境 = { ADMIN: 'selfcheck-password', KV: 建KV() };
const 上下文 = { waitUntil() { }, passThroughOnException() { } };
const 读长度 = (名称) => readFileSync(join(面板目录, 名称, 'index.html'), 'utf8').length;

const 登录页 = await 工作者.fetch(造请求('/login'), 环境, 上下文);
const 登录页正文 = await 登录页.text();

// 拿到会话令牌后访问带查询串的 /admin，验证内嵌映射会剥掉 ?search 再查表。
const 登入 = await 工作者.fetch(造请求('/login', { 方法: 'POST', 表单: 'password=' + encodeURIComponent('selfcheck-password'), headers: {} }), 环境, 上下文);
const Cookie = (登入.headers.get('Set-Cookie') || '').split(';')[0];
const 后台页 = await 工作者.fetch(造请求('/admin?x=1', { Cookie }), 环境, 上下文);
const 后台页正文 = await 后台页.text();

const 检查 = [
	['/login 由脚本内部返回', 登录页.status === 200 && 登录页正文.length === 读长度('login')],
	// /admin 分支会在页面尾部追加一段运行期注入（版本号/配置注入），所以只比对前缀与关键字。
	['/admin 带查询串仍命中内嵌页', 后台页.status === 200 && 后台页正文.length >= 读长度('admin') && 后台页正文.includes('<title>管理后台')],
	['运行期零外部请求', 出站.length === 0]
];
const 失败 = 检查.filter(([, 通过]) => !通过);

console.log(`内嵌面板：${面板.length} 个页面，产物 ${(字节 / 1048576).toFixed(2)} MB（未压缩，上限 64 MiB）`);
for (const [名称, 通过] of 检查) console.log(`${通过 ? '通过' : '失败'}  ${名称}`);
if (失败.length) {
	console.error(`\n自检未通过，产物：${出站.join('、') || '（无出站）'}`);
	process.exit(1);
}
console.log(`\n产物：${输出文件}`);
console.log('部署：把 dist/standalone/_worker.js 作为 Pages 资产上传即可，无需设置 PAGES_URL。');
