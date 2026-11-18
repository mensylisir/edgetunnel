///////////////////////////////////////////////////////安全加固（本 fork 新增）///////////////////////////////////////////////
const 默认加密秘钥 = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';
const 登录失败上限 = 5, 登录锁定时长 = 600, 会话有效期 = 86400;
let 已提示默认密钥 = false;

function 提示默认密钥(当前密钥) {
	if (已提示默认密钥 || 当前密钥 !== 默认加密秘钥) return;
	已提示默认密钥 = true;
	console.warn('[edgetunnel] 未设置 SECRET/KEY，正在使用默认加密密钥，节点 UUID 可被离线推算。请在环境变量中配置 SECRET。');
}

// 恒定时间比较：避免按字符提前返回造成的时序侧信道
function 恒定时间比较(甲, 乙) {
	if (typeof 甲 !== 'string' || typeof 乙 !== 'string') return false;
	let 差异 = 甲.length ^ 乙.length;
	const 长度 = Math.max(甲.length, 乙.length);
	for (let 索引 = 0; 索引 < 长度; 索引++) 差异 |= (甲.charCodeAt(索引) || 0) ^ (乙.charCodeAt(索引) || 0);
	return 差异 === 0;
}

function 字节转BASE64URL(字节) {
	let 二进制 = '';
	for (const 值 of 字节) 二进制 += String.fromCharCode(值);
	return btoa(二进制).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 会话令牌 = 到期时间戳.HMAC-SHA256(UA|到期时间)，密钥由管理员密码与加密秘钥共同派生
async function 会话签名(UA, 到期时间, 管理员密码, 加密秘钥) {
	const 签名密钥 = await crypto.subtle.importKey('raw', new TextEncoder().encode(`edgetunnel-session|${加密秘钥}|${管理员密码}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const 摘要 = await crypto.subtle.sign('HMAC', 签名密钥, new TextEncoder().encode(`${UA}|${到期时间}`));
	return 字节转BASE64URL(new Uint8Array(摘要));
}

async function 生成会话令牌(UA, 管理员密码, 加密秘钥, 有效期 = 会话有效期) {
	const 到期时间 = Math.floor(Date.now() / 1000) + 有效期;
	return `${到期时间}.${await 会话签名(UA, 到期时间, 管理员密码, 加密秘钥)}`;
}

async function 校验会话令牌(令牌, UA, 管理员密码, 加密秘钥) {
	if (typeof 令牌 !== 'string' || !令牌) return false;
	const 分隔位置 = 令牌.indexOf('.');
	if (分隔位置 <= 0) return false;
	const 到期时间 = Number(令牌.slice(0, 分隔位置)), 签名 = 令牌.slice(分隔位置 + 1);
	if (!Number.isFinite(到期时间) || 到期时间 * 1000 <= Date.now()) return false;
	return 恒定时间比较(签名, await 会话签名(UA, 到期时间, 管理员密码, 加密秘钥));
}

function 读取会话令牌(request) {
	const cookies = request.headers.get('Cookie') || '';
	const 命中 = cookies.split(';').map(片段 => 片段.trim()).find(片段 => 片段.startsWith('auth='));
	return 命中 ? 命中.slice(5) : '';
}

// 登录限流：按访问 IP 的散列计数，连续失败达上限后锁定时长写进 KV
async function 登录限流剩余秒(env, 请求标识) {
	const 锁定值 = await env.KV.get(`login_lock_${请求标识}`);
	if (!锁定值) return 0;
	const 剩余 = 登录锁定时长 - Math.floor((Date.now() - Number(锁定值)) / 1000);
	return 剩余 > 0 ? 剩余 : 0;
}

async function 记录登录失败(env, 请求标识) {
	const 失败键 = `login_fail_${请求标识}`;
	const 次数 = Number(await env.KV.get(失败键) || 0) + 1;
	if (次数 >= 登录失败上限) {
		await env.KV.put(`login_lock_${请求标识}`, String(Date.now()), { expirationTtl: 登录锁定时长 });
		await env.KV.delete(失败键);
		return 登录失败上限;
	}
	await env.KV.put(失败键, String(次数), { expirationTtl: 登录锁定时长 });
	return 次数;
}

async function 清除登录失败(env, 请求标识) {
	await env.KV.delete(`login_fail_${请求标识}`);
	await env.KV.delete(`login_lock_${请求标识}`);
}
