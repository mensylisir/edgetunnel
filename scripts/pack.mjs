// 打出两个可直接上传 Cloudflare Pages 的包，并校验包内文件与源码逐字节一致。
// 用法：node scripts/pack.mjs [--skip-embed]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const 根目录 = dirname(dirname(fileURLToPath(import.meta.url)));
const 产物目录 = join(根目录, 'dist');
const 独立版 = join(产物目录, 'standalone', '_worker.js');
const 跳过内嵌 = process.argv.includes('--skip-embed');

const 摘要 = (缓冲区) => createHash('sha256').update(缓冲区).digest('hex');
const 体积 = (字节) => `${(字节 / 1024).toFixed(0)} KB`;

function 跑(命令, 参数, 说明) {
	const 结果 = spawnSync(命令, 参数, { cwd: 根目录, stdio: 跳过内嵌 ? 'ignore' : 'inherit' });
	if (结果.status !== 0) throw new Error(`${说明}失败（退出码 ${结果.status}）`);
}

function 打包(源文件, 输出名) {
	const 输出 = join(产物目录, 输出名);
	rmSync(输出, { force: true });
	const 结果 = spawnSync('zip', ['-q', '-9', '-j', 输出, 源文件], { cwd: 根目录 });
	if (结果.status !== 0) throw new Error(`打包 ${输出名} 失败`);
	const 校验 = spawnSync('unzip', ['-p', 输出, '_worker.js'], { cwd: 根目录, maxBuffer: 64 * 1024 * 1024 });
	if (校验.status !== 0) throw new Error(`${输出名} 内没有 _worker.js`);
	const 磁盘 = readFileSync(源文件);
	if (摘要(校验.stdout) !== 摘要(磁盘)) throw new Error(`${输出名} 包内文件与磁盘源码不一致`);
	console.log(`${输出名.padEnd(28)} ${体积(statSync(输出).size).padStart(8)} | 脚本 ${体积(磁盘.length).padStart(9)} | 一致: 是`);
	return 输出;
}

mkdirSync(产物目录, { recursive: true });
if (!跳过内嵌) {
	跑(process.execPath, ['scripts/embed-panel.mjs'], '内嵌面板');
}
if (!existsSync(独立版)) throw new Error('缺少 dist/standalone/_worker.js，请先运行 npm run embed');

打包(join(根目录, '_worker.js'), 'edgetunnel-pages.zip');
打包(独立版, 'edgetunnel-standalone.zip');

const 面板包 = join(产物目录, 'edgetunnel-panel.zip');
if (existsSync(面板包)) console.log(`edgetunnel-panel.zip  ${体积(statSync(面板包).size).padStart(8)} | 自建静态站用（未本次重建）`);
console.log('\n上传口径：');
console.log('  edgetunnel-standalone.zip → 面板内置，运行期不取第三方页面');
console.log('  edgetunnel-pages.zip      → 面板仍从 PAGES_URL / 上游地址实时取');
