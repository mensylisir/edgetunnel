#!/usr/bin/env node
/**
 * 批量把 dist/standalone/_worker.js 部署到多个 Cloudflare 账号下的 Pages 项目。
 *
 *   node scripts/deploy-all.mjs --dry-run      # 只检查配置，不部署
 *   node scripts/deploy-all.mjs                # 依次部署
 *   node scripts/deploy-all.mjs --only=hk,jp   # 只部署 name 命中这几项
 *   node scripts/deploy-all.mjs --file=别的配置.json
 *
 * 配置文件默认 deploy-targets.json（已在 .gitignore 里），结构见 deploy-targets.example.json。
 * token 不要写进仓库：既可以用 tokenEnv 指向环境变量，也可以写在配置文件里
 * （配置文件本身必须被 git 忽略，脚本会检查这一点）。
 *
 * 为什么要逐个账号单独建 token：一个能管 12 个账号的 token 泄漏了就是 12 个一起
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
const 试运行 = 参数.includes('--dry-run');
const 强制 = 参数.includes('--force');
const 配置文件 = resolve(根目录, 取值('file', 'deploy-targets.json'));

function 退出(码, 消息) {
	if (消息) console.error(消息);
	process.exit(码);
}

if (!existsSync(产物)) {
	退出(1, `缺少 ${产物}\n先跑：npm run embed（或 npm run build && npm run mirror && npm run embed）`);
}
if (!existsSync(配置文件)) {
	退出(1, `找不到配置文件 ${配置文件}\n复制一份模板再填：cp deploy-targets.example.json deploy-targets.json`);
}

let 清单;
try {
	清单 = JSON.parse(readFileSync(配置文件, 'utf8'));
} catch (e) {
	退出(1, `配置文件不是合法 JSON：${e.message}`);
}
if (!Array.isArray(清单) || 清单.length === 0) 退出(1, '配置文件应为非空数组，每项一个账号');

// ── 安全闸：配置文件里出现真 token 时，它必须被 git 忽略 ─────────────────────
const 疑似真token = 清单.some(
	(项) => typeof 项.token === 'string' && 项.token.length >= 30 && !/REPLACE|示例|xxxx/i.test(项.token)
);
if (疑似真token) {
	const 忽略检查 = spawnSync('git', ['check-ignore', '-q', 配置文件], { cwd: 根目录 });
	if (忽略检查.status !== 0 && !强制) {
		退出(
				1,
				`${配置文件} 里有明文 token，但它没有被 git 忽略。\n` +
					'拒绝继续，避免令牌被提交到仓库。修法任选其一：\n' +
					'  1) 把 token 挪进环境变量，配置里改用 "tokenEnv": "环境变量名"\n' +
					'  2) 把这个文件名加进 .gitignore\n' +
					'  3) 确认无风险时加 --force'
			);
	}
}

// ── 校验每一项 ──────────────────────────────────────────────────────────────
const 待部署 = [];
const 只 = 取值('only');
for (const [序, 项] of 清单.entries()) {
	const 号 = 项.name || `第${序 + 1}项`;
	const 问题 = [];
	if (!项.name) 问题.push('缺少 name（只用于日志区分）');
	if (!/^[0-9a-f]{32}$/i.test(String(项.accountId || ''))) 问题.push('accountId 应为 32 位十六进制');
	if (!项.project) 问题.push('缺少 project（Pages 项目名，同名项目才能保住订阅地址）');
	const token = 项.tokenEnv ? process.env[项.tokenEnv] : 项.token;
	if (!token) 问题.push(项.tokenEnv ? `环境变量 ${项.tokenEnv} 为空` : '缺少 token 或 tokenEnv');
	if (问题.length) {
		console.error(`✗ ${号}：${问题.join('；')}`);
		continue;
	}
	if (只) {
		const 命中表 = 只.split(',').map((s) => s.trim().toLowerCase());
		if (!命中表.includes(String(项.name).toLowerCase())) continue;
	}
	待部署.push({ ...项, _token: token, _号: 号 });
}

if (待部署.length === 0) 退出(1, '没有可部署的目标（检查配置或 --only 过滤）');

console.log(`产物：${产物}（${(readFileSync(产物).length / 1024 / 1024).toFixed(2)} MB）`);
console.log(`目标：${待部署.length} 个账号\n`);

if (试运行) {
	for (const 项 of 待部署) {
		console.log(`   ${项._号}  account=${项.accountId.slice(0, 8)}…  project=${项.project}  token=${项._token.slice(0, 6)}…`);
	}
	console.log('\n--dry-run：以上配置齐全，未实际部署。');
	process.exit(0);
}

// ── 部署：在临时目录里跑，避免仓库根目录那份 Workers 用的 wrangler.toml 被误读 ──
const 临时 = mkdtempSync(join(tmpdir(), 'edt-deploy-'));
copyFileSync(产物, join(临时, '_worker.js'));

const 结果 = [];
for (const 项 of 待部署) {
	process.stdout.write(`→ ${项._号} … `);
	const 子进程 = spawnSync(
		'npx',
		['--yes', 'wrangler@4', 'pages', 'deploy', '.', '--project-name', 项.project, '--commit-dirty=true'],
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
console.log(`\n完成：成功 ${结果.length - 失败.length} / 共 ${结果.length}`);
if (失败.length) {
	console.error('失败：' + 失败.map((f) => f.号).join('、'));
	process.exit(1);
}
