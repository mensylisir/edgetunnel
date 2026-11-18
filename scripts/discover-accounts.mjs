#!/usr/bin/env node
/**
 * 从一批 API token 反查「账号 ID + Pages 项目名」，直接生成 deploy-targets.json。
 *
 * 适用场景：多个 Cloudflare 账号是各自独立的邮箱登录，每个账号一个 token，
 * 谁也看不到谁 —— 手工抄 accountId 和项目名既费时又容易打错，而 project 名
 * 打错正是唯一会伤到订阅地址的错误。所以让 token 自己去问。
 *
 *   node scripts/discover-accounts.mjs                 # 读 .tokens.txt，只打印结果
 *   node scripts/discover-accounts.mjs --write         # 同时写入 deploy-targets.json
 *   node scripts/discover-accounts.mjs --tokens=别的.txt
 *
 * .tokens.txt 格式：一行一个 token，`#` 开头是注释。文件已在 .gitignore 里，
 * 若被 git 跟踪则拒绝运行（避免 token 进仓库）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const 根目录 = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const 参数 = process.argv.slice(2);
const 取值 = (名, 默认 = null) => {
	const 命中 = 参数.find((a) => a.startsWith(`--${名}=`));
	return 命中 ? 命中.slice(名.length + 3) : 默认;
};
const 写文件 = 参数.includes('--write');
const 令牌文件 = resolve(根目录, 取值('tokens', '.tokens.txt'));
const 清单文件 = resolve(根目录, 'deploy-targets.json');

const 退出 = (码, 消息) => {
	if (消息) console.error(消息);
	process.exit(码);
};

if (!existsSync(令牌文件)) {
	退出(1, `找不到 ${令牌文件}\n新建它，一行放一个 token（每个独立账号一个），例如：\n  cfut_aaa…\n  cfut_bbb…`);
}

// token 绝不能进仓库：文件已被跟踪就拒绝，与 deploy-all.mjs 的判据一致
const 已跟踪 = spawnSync('git', ['ls-files', '--error-unmatch', 令牌文件], { cwd: 根目录, stdio: 'ignore' });
if (已跟踪.status === 0) {
	退出(1, `${令牌文件} 已被 git 跟踪，拒绝运行。\n先执行 git rm --cached 把它移出仓库，并确认 .gitignore 里有它。`);
}

const 令牌们 = readFileSync(令牌文件, 'utf8')
	.split('\n')
	.map((行, 序) => ({ 值: 行.trim(), 序: 序 + 1 }))
	.filter((x) => x.值 && !x.值.startsWith('#'));

if (!令牌们.length) 退出(1, `${令牌文件} 里没有任何 token。`);

const 请求 = async (路径, 令牌) => {
	const 响应 = await fetch(`https://api.cloudflare.com/client/v4${路径}`, {
		headers: { Authorization: `Bearer ${令牌}` },
		signal: AbortSignal.timeout(20000),
	});
	const 正文 = await 响应.json().catch(() => ({}));
	return { 状态: 响应.status, 正文 };
};

const 目标 = [];
const 失败 = [];
const 提示 = [];

for (const [序, 令牌] of 令牌们.entries()) {
	process.stdout.write(`\n第 ${令牌.序} 个 token … `);

	const 账号响应 = await 请求('/accounts', 令牌.值);
	if (账号响应.状态 !== 200 || !账号响应.正文?.success) {
		const 话 = 账号响应.正文?.errors?.[0]?.message || `HTTP ${账号响应.状态}`;
		console.log(`✗ ${话}`);
		失败.push({ 序: 令牌.序, 原因: 话 });
		continue;
	}
	const 账号们 = 账号响应.正文.result || [];
	if (!账号们.length) {
		console.log('✗ 这个 token 看不到任何账号（权限里没选 Account Resources？）');
		失败.push({ 序: 令牌.序, 原因: '看不到任何账号' });
		continue;
	}
	console.log(`${账号们.length} 个账号`);

	for (const 账号 of 账号们) {
		const 项目响应 = await 请求(`/accounts/${账号.id}/pages/projects`, 令牌.值);
		if (项目响应.状态 !== 200) {
			const 话 = 项目响应.正文?.errors?.[0]?.message || `HTTP ${项目响应.状态}`;
			console.log(`   ✗ ${账号.name}：${话}（token 缺 Cloudflare Pages 权限？）`);
			失败.push({ 序: 令牌.序, 原因: `${账号.name}：${话}` });
			continue;
		}
		const 项目们 = 项目响应.正文.result || [];
		if (!项目们.length) {
			console.log(`   ! ${账号.name}：没有 Pages 项目（可能是 Workers 项目，不是 Pages）`);
			continue;
		}
		if (项目们.length > 1) {
			提示.push(`${账号.name} 有 ${项目们.length} 个 Pages 项目，全部列出了，用不到的删掉即可`);
		}
		for (const 项目 of 项目们) {
			const 域名 = (项目.domains || []).filter((d) => !d.endsWith('.pages.dev'));
			目标.push({
				name: 项目.name,
				accountId: 账号.id,
				project: 项目.name,
				_令牌: 令牌.值,
				_序: 令牌.序,
				_域名: 域名.join(', ') || '（仅 pages.dev）',
				_账号名: 账号.name,
			});
			console.log(`   ✓ ${项目.name.padEnd(22)} ${账号.id.slice(0, 8)}…  ${域名.length ? 域名.join(', ') : '（仅 pages.dev）'}`);
		}
	}
	// 账号之间稍作间隔，避免触发速率限制
	if (序 !== 令牌们.length - 1) spawnSync('sleep', ['1']);
}

console.log('');
for (const t of 提示) console.log(`! ${t}`);
if (失败.length) {
	for (const f of 失败) console.error(`✗ 第 ${f.序} 个 token：${f.原因}`);
}

if (!目标.length) 退出(1, '\n没有查到任何 Pages 项目，deploy-targets.json 未改动。');

// 跨账号同名项目（很常见，都叫 edt666）加序号区分，否则 CF_TOKENS 的键会互相覆盖
const 见过 = new Map();
for (const t of 目标) {
	const 次数 = (见过.get(t.name) || 0) + 1;
	见过.set(t.name, 次数);
	if (次数 > 1) t.name = `${t.name}-${次数}`;
}

// ── 对应关系总表：哪个账号 / 哪个项目 / 用第几行的 token ──
const 宽 = (s, n) => String(s).padEnd(n).slice(0, n);
console.log('\n── 对应关系（token 只显示前 8 位）──');
console.log(`${宽('#', 4)}${宽('name', 18)}${宽('accountId', 12)}${宽('project', 18)}${宽('token', 14)}${宽('来源', 10)}域名`);
for (const t of 目标) {
	console.log(
		`${宽(目标.indexOf(t) + 1, 4)}${宽(t.name, 18)}${宽(t.accountId.slice(0, 8) + '…', 12)}${宽(t.project, 18)}` +
			`${宽(t._令牌.slice(0, 8) + '…', 14)}${宽(`第${t._序}行`, 10)}${t._域名}`
	);
}

console.log('\n── 方案 A（推荐）：只配一个 secret，不要 deploy-targets.json ──');
const 全量 = {};
for (const t of 目标) 全量[t.name] = { token: t._令牌, accountId: t.accountId, project: t.project, domains: t._域名 === '（仅 pages.dev）' ? [] : t._域名.split(', ') };
console.log(JSON.stringify(全量) + '\n');
console.log('贴进 GitHub secret：Name = CF_TOKENS，Secret = 上面这一整行。');
console.log('账号、项目、令牌都在里面，不再需要第二个文件。\n');

console.log('── 方案 B：secret 只放令牌，账号与项目放 deploy-targets.json ──');
const 令牌json = {};
for (const t of 目标) 令牌json[t.name] = t._令牌;
console.log(JSON.stringify(令牌json) + '\n');

const 清单正文 = JSON.stringify(目标.map(({ _令牌, _序, _域名, _账号名, ...其余 }) => 其余), null, 2) + '\n';

if (写文件) {
	writeFileSync(清单文件, 清单正文);
	console.log(`已写入 ${清单文件}（${目标.length} 项，方案 B 用）`);
}
if (参数.includes('--write-secret')) {
	const 文件 = resolve(根目录, 'cf-tokens.local.json');
	writeFileSync(文件, JSON.stringify(全量, null, 2) + '\n');
	console.log(`已写入 ${文件}（方案 A 用：含明文 token，已被 .gitignore 忽略，别提交）`);
}
if (!写文件 && !参数.includes('--write-secret')) {
	console.log('加 --write 写 deploy-targets.json（方案 B）；加 --write-secret 把方案 A 的 JSON 存成文件方便复制。');
}

// 本地留一份带 token 的完整对照，方便自己查；文件名已被 .gitignore 忽略
if (参数.includes('--write-local')) {
	const 本地 = resolve(根目录, 'deploy-targets.local.json');
	const 带令牌 = 目标.map((t) => ({ name: t.name, accountId: t.accountId, project: t.project, token: t._令牌 }));
	writeFileSync(本地, JSON.stringify(带令牌, null, 2) + '\n');
	console.log(`已写入 ${本地}（含明文 token，已被 .gitignore 忽略，别提交、别外传）`);
}
