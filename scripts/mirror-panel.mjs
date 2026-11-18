// 把后台面板镜像到本地，供自建静态托管使用。
//
// 面板是纯静态单页：四个路由（/admin、/login、/noADMIN、/noKV）各是一个 HTML 文件，
// 所有数据请求（/admin/config.json、/admin/init、/version …）都由浏览器打回你自己的 Worker 域名，
// 跟页面托管在哪没有关系。所以镜像下来换个宿主，功能不受影响。
//
// 用法：
//   node scripts/mirror-panel.mjs                  # 从上游 edt-pages.github.io 拉取到 dist/panel
//   node scripts/mirror-panel.mjs <源地址> <输出目录>
// 然后把这个目录作为一个静态站点部署（Cloudflare Pages / GitHub Pages 都行），
// 并在 Worker 上设环境变量 PAGES_URL = 你的面板地址。

import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const 根目录 = join(dirname(fileURLToPath(import.meta.url)), '..');
const 源地址 = (process.argv[2] || 'https://edt-pages.github.io').replace(/\/+$/, '');
const 输出目录 = process.argv[3] || join(根目录, 'dist', 'panel');

// 路由 → 最低体积（字节）。体积下限用来防止把 404 页面或错误提示当成面板存下来。
const 路由 = [
	['admin', 500 * 1024],
	['login', 1024],
	['noADMIN', 256],
	['noKV', 256]
];

let 失败数 = 0;
for (const [路由名, 最低体积] of 路由) {
	const 地址 = `${源地址}/${路由名}/`;
	process.stdout.write(`${路由名.padEnd(8)} ${地址} … `);
	try {
		const 响应 = await fetch(地址, { redirect: 'follow', headers: { 'User-Agent': 'edgetunnel-mirror/1.0' } });
		const 正文 = await 响应.text();
		const 字节 = Buffer.byteLength(正文, 'utf8');
		const 是HTML = /<html[\s>]/i.test(正文) || /<!doctype html/i.test(正文);
		if (响应.status !== 200 || !是HTML || 字节 < 最低体积) {
			失败数++;
			console.log(`失败（status=${响应.status}，${(字节 / 1024).toFixed(0)} KB，HTML=${是HTML}）`);
			continue;
		}
		const 目标目录 = join(输出目录, 路由名);
		mkdirSync(目标目录, { recursive: true });
		writeFileSync(join(目标目录, 'index.html'), 正文, 'utf8');
		console.log(`完成（${(字节 / 1024).toFixed(0)} KB）`);
	} catch (错误) {
		失败数++;
		console.log(`失败（${错误.message}）`);
	}
}

let 总字节 = 0, 文件数 = 0;
const 遍历 = (目录) => {
	for (const 名称 of readdirSync(目录)) {
		const 路径 = join(目录, 名称);
		if (statSync(路径).isDirectory()) 遍历(路径);
		else { 总字节 += statSync(路径).size; 文件数++; }
	}
};
if (失败数 === 0) 遍历(输出目录);

console.log('');
if (失败数) {
	console.error(`${失败数} 个页面未取到，镜像不完整，别拿去部署。`);
	process.exit(1);
}
console.log(`镜像完成：${文件数} 个文件 / ${(总字节 / 1024).toFixed(0)} KB → ${输出目录}`);
console.log('下一步：把这个目录部署成静态站点，然后在 Worker 里设 PAGES_URL = 站点地址（结尾不要带斜杠也无妨）。');
