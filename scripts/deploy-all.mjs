#!/usr/bin/env node
/**
 * 把 dist/standalone/_worker.js 部署到一个或多个 Cloudflare 账号下的 Pages 项目。
 *
 * 清单文件 deploy-targets.json **只写 name / accountId / project，绝不写 token**，
 * 所以它可以安全地提交进仓库，GitHub Actions 直接读它。
 *
 *   node scripts/deploy-all.mjs --dry-run          # 只校验配置
 *   node scripts/deploy-all.mjs                    # 逐个部署
 *   node scripts/deploy-all.mjs --only=hk,jp       # 只部署 name 命中的项
 *   node scripts/deploy-all.mjs --skip-missing     # token 缺失的项跳过（CI 用）
 *   node scripts/deploy-all.mjs --file=别的.json
 *
 * token 来源，按优先级：
 *   1. CF_TOKENS 环境变量：JSON 对象 { "name 或 project": "token", … }
 *      这是 GitHub Actions 里的用法 —— 一个 secret 装全部，清单留在仓库里。
 *   2. 项.tokenEnv：指向一个环境变量名（本地用，避免 token 落盘）
 *   3. 项.token：明文写在本地私有文件里（只允许出现在 git 未跟踪的文件中）
 *   4. CLOUDFLARE_API_TOKEN：单账号回退，仅当清单只有 1 项时生效
 *
 * 为什么每个账号单独建 token：一个能管 12 个账号的 token 泄漏了就是 12 个一起
 * 失守。每个账号一个只含 Account → Cloudflare Pages → Edit 的 token，泄漏面最小。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const 根目录 = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const 产物 = join(根目录, 'dist', 'standalone', '_worker.js');

const 参数 = process.argv.slice(2);
const 取值 = (名, 默认 = null) => {
	const 命中 = 参数.find((a) => a.startsWith(`--${名}=`));
	return 命中 ? 命中.slice(名.length + 3) : 默认;
};
const 有开关 = (名) => 参数.includes(`--${名}`);
const 试运行 = 有开关('dry-run');
const 强制 = 有开关('force');
const 跳过缺失 = 有开关('skip-missing');
const 配置文件 = resolve(根目录, 取值('file', 'deploy-targets.json'));

function 退出(码, 消息) {
	if (消息) console.error(消息);
	process.exit(码);
}

if (!existsSync(产物)) {
	退出(1, `缺少 ${产物}\n先跑：npm run embed（或 npm run build && npm run mirror && npm run embed）`);
}
if (!existsSync(配置文件)) {
	退出(1, `找不到清单文件 ${配置文件}`);
}

let 清单;
try {
	清单 = JSON.parse(readFileSync(配置文件, 'utf8'));
} catch (e) {
	退出(1, `${配置文件} 不是合法 JSON：${e.message}`);
}
if (!Array.isArray(清单) || 清单.length === 0) 退出(1, '清单应为非空数组，每项一个账号');

// ── 集中式令牌表：CF_TOKENS 是 {"name 或 project": "token"} 形式的 JSON ──────
let 令牌表 = null;
if (process.env.CF_TOKENS) {
	try {
		令牌表 = JSON.parse(process.env.CF_TOKENS);
	} catch (e) {
		退出(1, `环境变量 CF_TOKENS 不是合法 JSON：${e.message}\n期望形如 {"edt666":"cfut_xxx","备用-香港":"cfut_yyy"}`);
	}
	if (!令牌表 || typeof 令牌表 !== 'object' || Array.isArray(令牌表)) {
		退出(1, 'CF_TOKENS 应为 {"名称": "令牌"} 形式的对象');
	}
}

/**
 * 按 name 取令牌，取不到再按 project 取。
 * 允许改名而不必重配令牌 —— 只要 project 没变。
 */
function 从令牌表取(项) {
	if (!令牌表) return null;
	for (const 键 of [项.name, 项.project]) {
		if (!键) continue;
		const 值 = 令牌表[键];
		if (typeof 值 === 'string' && 值.trim()) return 值.trim();
	}
	return null;
}

function 解析令牌(项) {
	if (令牌表) {
		const 取到 = 从令牌表取(项);
		if (取到) return { 值: 取到, 来源: 'CF_TOKENS' };
	}
	if (项.tokenEnv && process.env[项.tokenEnv]) {
		return { 值: process.env[项.tokenEnv], 来源: `env:${项.tokenEnv}` };
	}
	if (项.token) return { 值: 项.token, 来源: '配置文件' };
	// 单账号回退：只配了 CLOUDFLARE_API_TOKEN 的老部署仍然能跑。
	// 用 accountId 精确匹配，避免把这个账号的令牌拿去推别的账号。
	if (process.env.CLOUDFLARE_API_TOKEN) {
		const 归属 = process.env.CLOUDFLARE_ACCOUNT_ID;
		if (!归属 || 归属 === 项.accountId) {
			return { 值: process.env.CLOUDFLARE_API_TOKEN, 来源: 'env:CLOUDFLARE_API_TOKEN' };
		}
	}
	return null;
}

// ── 安全闸：明文 token 不得出现在 git 已跟踪的文件里 ─────────────────────────
const 疑似真token = 清单.some(
	(项) => typeof 项.token === 'string' && 项.token.length >= 30 && !/REPLACE|示例|xxxx/i.test(项.token)
);
if (疑似真token) {
	const 跟踪检查 = spawnSync('git', ['ls-files', '--error-unmatch', 配置文件], { cwd: 根目录, stdio: 'ignore' });
	if (跟踪检查.status === 0 && !强制) {
		退出(
			1,
			`${配置文件} 里有明文 token，而这个文件已被 git 跟踪。\n` +
				'拒绝继续，避免令牌进入仓库。修法任选其一：\n' +
				'  1) 把 token 挪进 CF_TOKENS 环境变量（GitHub Actions 就是这么用的）\n' +
				'  2) 用 "tokenEnv": "环境变量名" 指向环境变量\n' +
				'  3) 把这份配置改名为 deploy-targets.local.json（它已被 .gitignore 忽略）\n' +
				'  4) 确认无风险时加 --force'
		);
	}
}

// ── 逐项校验 ────────────────────────────────────────────────────────────────
const 待部署 = [];
const 跳过 = [];
const 配置错误 = [];
const 只 = 取值('only');
const 只表 = 只 ? 只.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;

for (const [序, 项] of 清单.entries()) {
	const 号 = 项.name || `第${序 + 1}项`;
	if (只表 && !只表.includes(String(项.name || '').toLowerCase())) continue;

	const 问题 = [];
	if (!项.name) 问题.push('缺少 name（用于日志区分与令牌匹配）');
	if (!/^[0-9a-f]{32}$/i.test(String(项.accountId || ''))) 问题.push('accountId 应为 32 位十六进制');
	if (!项.project) 问题.push('缺少 project（Pages 项目名，同名项目才能保住订阅地址）');

	const 令牌 = 解析令牌(项);
	if (!令牌 && !问题.length) {
		// 令牌缺失单独处理：多账号时可能只配了一部分
		if (跳过缺失) {
			跳过.push({ 号, 原因: '没有可用的 token' });
			continue;
		}
		const 键名 = [...new Set([项.name, 项.project].filter(Boolean))].join('" 或 "');
		问题.push(
			令牌表
					? `CF_TOKENS 里没有 "${键名}" 这个键`
					: '缺少 token —— 在 CF_TOKENS 里加键，或用 tokenEnv / token'
			);
	}

	if (问题.length) {
		配置错误.push({ 号, 详情: 问题.join('；') });
		continue;
	}
	待部署.push({ ...项, _token: 令牌.值, _来源: 令牌.来源, _号: 号 });
}

if (配置错误.length) {
	for (const e of 配置错误) console.error(`✗ ${e.号}：${e.详情}`);
	console.error('');
}

if (跳过.length) {
	console.log(`跳过 ${跳过.length} 项（没有令牌）：`);
	for (const s of 跳过) console.log(`   - ${s.号}：${s.原因}`);
	console.log('');
}

if (待部署.length === 0) {
	退出(1, 跳过.length ? '没有可部署的目标：所有项都缺令牌' : '没有可部署的目标（检查清单或 --only 过滤）');
}

// 有配置错误却没开 --skip-missing：说明清单不完整，不能静悄悄只部署一部分
if (配置错误.length && !跳过缺失) {
	退出(1, `清单里有 ${配置错误.length} 项配置不完整，未部署任何东西。\n` +
		'补齐上面的令牌，或在 CI 里加 --skip-missing 明确表示"缺令牌的项可以跳过"。');
}

console.log(`产物：${产物}（${(readFileSync(产物).length / 1024 / 1024).toFixed(2)} MB）`);
console.log(`目标：${待部署.length} 个账号\n`);

if (试运行) {
	for (const 项 of 待部署) {
		console.log(
			`   ${项._号}  account=${项.accountId.slice(0, 8)}…  project=${项.project}  token=${项._token.slice(0, 6)}… (${项._来源})`
		);
	}
	console.log('\n--dry-run：以上配置齐全，未实际部署。');
	process.exit(0);
}

// ── 部署：在临时目录里跑，避免仓库根目录那份 Workers 用的 wrangler.toml 被误读 ──
const 临时 = mkdtempSync(join(tmpdir(), 'edt-deploy-'));
copyFileSync(产物, join(临时, '_worker.js'));

// CI 里预先全局装好 wrangler，12 次部署就不必反复走 npx 解析
const 有全局wrangler = spawnSync('wrangler', ['--version'], { stdio: 'ignore' }).status === 0;
const 部署命令 = 有全局wrangler ? 'wrangler' : 'npx';
const 部署前缀 = 有全局wrangler ? [] : ['--yes', 'wrangler@4'];

const 结果 = [];
for (const 项 of 待部署) {
	process.stdout.write(`→ ${项._号} … `);
	const 子进程 = spawnSync(
		部署命令,
		[...部署前缀, 'pages', 'deploy', '.', '--project-name', 项.project, '--commit-dirty=true'],
		{
			cwd: 临时,
			encoding: 'utf8',
			env: { ...process.env, CLOUDFLARE_API_TOKEN: 项._token, CLOUDFLARE_ACCOUNT_ID: 项.accountId },
		}
	);
	const 输出 = `${子进程.stdout || ''}${子进程.stderr || ''}`;
	const 成功 = 子进程.status === 0;
	const 地址 = (输出.match(/https:\/\/[a-z0-9-]+\.pages\.dev/g) || []).pop();
	console.log(成功 ? `成功${地址 ? ' ' + 地址 : ''}` : '失败');
	if (!成功) {
		// 只打有用的几行，避免 wrangler 的大段输出淹没摘要
		const 关键 = 输出
			.split('\n')
			.filter((行) => /error|Error|Authentication|forbidden|not found|permission/i.test(行))
			.slice(0, 6);
		console.log(关键.length ? 关键.map((l) => '    ' + l.trim()).join('\n') : 输出.slice(-600));
	}
	结果.push({ 号: 项._号, 成功 });
	// 账号之间稍作间隔，避免触发 API 速率限制
	if (项 !== 待部署[待部署.length - 1]) spawnSync('sleep', ['1']);
}

rmSync(临时, { recursive: true, force: true });

const 失败 = 结果.filter((r) => !r.成功);
console.log(`\n完成：成功 ${结果.length - 失败.length} / 共 ${结果.length}` + (跳过.length ? `，跳过 ${跳过.length}` : ''));
if (失败.length) {
	console.error('失败：' + 失败.map((f) => f.号).join('、'));
	process.exit(1);
}
