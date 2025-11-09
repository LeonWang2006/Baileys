import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';

// 确保 auth 目录存在（用于保存登录状态）
const authDir = path.join(process.cwd(), 'auth');
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}

// 1. SOCKS5 代理配置（固定 7897 端口，与你的代理一致）
const proxyAgent = new SocksProxyAgent('socks5://127.0.0.1:7897', {
  rejectUnauthorized: false,  // 绕开代理证书拦截
  minVersion: 'TLSv1.2',      // 强制 TLS 1.2，避免代理兼容性问题
  maxVersion: 'TLSv1.2',
});

// 2. 初始化认证状态
const { state, saveCreds } = await useMultiFileAuthState(authDir);

// 3. 初始化 Baileys 连接
const initBaileys = async () => {
  const sock = makeWASocket({
    auth: state,
    agent: proxyAgent,          // 强制走 SOCKS5 代理
    logger: { level: 'debug' }, // 开启 debug 日志（便于排查）
    options: {
      connectTimeoutMs: 30000,  // 延长超时到 30 秒
      syncFullHistory: false,   // 关闭全量历史同步，加快连接
      markOnlineOnConnect: true,
    },
  });

  // 监听连接状态更新
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    // 生成 QR 码（扫码登录）
    if (qr) {
      console.log('📱 请用 WhatsApp 扫描以下 QR 码登录：');
      console.log(`QR 码图片路径：${path.join(authDir, 'qr.png')}`);
      // 若未自动生成图片，手动提示用工具解析 QR 字符串
      console.log(`QR 码字符串（可复制到 https://zxing.org/w/decode.jspx 生成图片）：${qr}`);
    }

    // 连接成功
    if (connection === 'open') {
      console.log('✅ WhatsApp 连接成功！');
      return;
    }

    // 连接断开
    if (connection === 'close') {
      const err = lastDisconnect?.error;
      if (err instanceof Boom) {
        const reason = err.output.statusCode;
        console.log(`❌ 连接断开，原因：${reason} - ${err.message}`);

        // 非登出错误，自动重连
        if (reason !== DisconnectReason.loggedOut) {
          console.log('🔄 3 秒后尝试重连...');
          setTimeout(initBaileys, 3000);
        } else {
          console.log('❌ 已登出，请删除 auth 目录后重新登录');
        }
      } else {
        console.log('❌ 连接断开，错误：', err?.message || '未知错误');
        console.log('🔄 3 秒后尝试重连...');
        setTimeout(initBaileys, 3000);
      }
    }
  });

  // 监听认证信息更新（保存登录状态，避免重复扫码）
  sock.ev.on('creds.update', saveCreds);

  // 监听错误日志
  sock.ev.on('error', (err) => {
    console.log('⚠️  错误：', err.message);
  });

  return sock;
};

// 启动 Baileys
initBaileys().catch((err) => {
  console.log('❌ 启动失败：', err.message);
});