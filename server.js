/**
 * MY PRINT — In-House WhatsApp Multi-Device Gateway Server
 * Built with @whiskeysockets/baileys for zero-third-party WhatsApp Web connectivity
 */

import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global Error Shield — Never crash the background service
process.on('uncaughtException', (err) => {
  console.warn('🛡️ Handled uncaughtException in WhatsApp Gateway:', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.warn('🛡️ Handled unhandledRejection in WhatsApp Gateway:', reason?.message || reason);
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const AUTH_FOLDER = path.join(__dirname, 'auth_info_baileys');
if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

let sock = null;
let currentQrDataUrl = null;
let currentQrRaw = null;
let connectionState = 'disconnected'; // 'disconnected' | 'connecting' | 'open'
let connectedUser = null;
let groupsList = [];
let isConnecting = false;
let reconnectTimer = null;

// Message store for resolving WhatsApp "Waiting for this message" Signal protocol retry requests
const sentMessagesCache = new Map();

// Initialize or reconnect WhatsApp Socket
async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.ws?.close();
      } catch (e) {}
      sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🚀 Starting Baileys v${version.join('.')}, latest: ${isLatest}`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      emitOwnEvents: false,
      getMessage: async (key) => {
        if (key && key.id && sentMessagesCache.has(key.id)) {
          return sentMessagesCache.get(key.id);
        }
        return { conversation: 'MY PRINT Order Alert' };
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Cache incoming & outgoing messages to answer retry decryption keys instantly
    sock.ev.on('messages.upsert', async (m) => {
      try {
        for (const msg of m.messages || []) {
          if (msg.key && msg.key.id && msg.message) {
            sentMessagesCache.set(msg.key.id, msg.message);
            if (sentMessagesCache.size > 3000) {
              const firstKey = sentMessagesCache.keys().next().value;
              sentMessagesCache.delete(firstKey);
            }
          }
        }
      } catch (e) {}
    });

    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          currentQrRaw = qr;
          try {
            currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
            connectionState = 'connecting';
            console.log('📱 New WhatsApp QR Code generated for scanning!');
          } catch (err) {
            console.error('Failed to render QR Code:', err);
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          console.log(
            `🔴 Connection closed (code: ${statusCode || 'unknown'}), reconnecting: ${shouldReconnect}`
          );

          connectionState = 'disconnected';
          currentQrDataUrl = null;
          currentQrRaw = null;

          if (shouldReconnect) {
            scheduleReconnect(3000);
          } else {
            console.log('⚠️ Device logged out. Cleaning old session...');
            connectedUser = null;
            try {
              fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
              fs.mkdirSync(AUTH_FOLDER, { recursive: true });
            } catch (e) {}
            scheduleReconnect(2000);
          }
        } else if (connection === 'open') {
          connectionState = 'open';
          currentQrDataUrl = null;
          currentQrRaw = null;
          connectedUser = sock.user || { id: 'Connected Device' };
          console.log(`🟢 WhatsApp Connected Successfully! Logged in as:`, connectedUser);

          // Fetch groups list safely
          setTimeout(async () => {
            try {
              if (sock && connectionState === 'open') {
                const fetchedGroups = await sock.groupFetchAllParticipating();
                groupsList = Object.values(fetchedGroups).map((g) => ({
                  id: g.id,
                  name: g.subject,
                  participantsCount: g.participants?.length || 0
                }));
                console.log(`👥 Loaded ${groupsList.length} WhatsApp groups.`);
              }
            } catch (gErr) {
              console.warn('Could not fetch groups list:', gErr?.message || gErr);
            }
          }, 3000);
        }
      } catch (err) {
        console.warn('Error in connection.update handler:', err?.message || err);
      }
    });
  } catch (err) {
    console.error('Error in connectToWhatsApp:', err?.message || err);
    scheduleReconnect(5000);
  } finally {
    isConnecting = false;
  }
}

function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectToWhatsApp();
  }, delayMs);
}

// -------------------------------------------------------------
// Health Check & Cloud Monitoring
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'MY PRINT 24/7 WhatsApp Cloud Gateway',
    state: connectionState,
    phone: connectedUser?.id || null,
    groupsCount: groupsList.length,
    uptime: Math.floor(process.uptime()) + ' seconds',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// -------------------------------------------------------------
// API Endpoints for React Admin Panel
// -------------------------------------------------------------

// 1. Get Live Status & QR Code
app.get('/api/whatsapp/status', async (req, res) => {
  let cleanPhone = '';
  if (connectedUser && connectedUser.id) {
    cleanPhone = connectedUser.id.split(':')[0].replace(/\D/g, '');
  }

  res.json({
    state: connectionState,
    qr: currentQrDataUrl,
    user: connectedUser
      ? {
          name: connectedUser.name || 'MY PRINT WhatsApp Admin',
          phone: cleanPhone ? `+${cleanPhone}` : connectedUser.id
        }
      : null,
    groupsCount: groupsList.length
  });
});

// 2. Trigger QR Generation / Connect
app.post('/api/whatsapp/connect', (req, res) => {
  if (connectionState === 'open') {
    return res.json({ success: true, message: 'Already connected', state: 'open' });
  }
  if (!sock || connectionState === 'disconnected') {
    connectToWhatsApp();
  }
  res.json({ success: true, message: 'Initializing connection...', state: connectionState });
});

// 3. Fetch All WhatsApp Groups (With optional search query)
app.get('/api/whatsapp/groups', async (req, res) => {
  const query = (req.query.q || req.query.search || '').toString().trim().toLowerCase();

  const filterGroups = (list) => {
    if (!query) return list;
    return list.filter((g) =>
      g.name.toLowerCase().includes(query) || g.id.toLowerCase().includes(query)
    );
  };

  if (connectionState !== 'open' || !sock) {
    // If not connected but we have cached groups from disk, return them
    const cachedFile = path.join(AUTH_FOLDER, 'groups_cache.json');
    if (fs.existsSync(cachedFile)) {
      try {
        const diskGroups = JSON.parse(fs.readFileSync(cachedFile, 'utf8'));
        if (Array.isArray(diskGroups) && diskGroups.length > 0) {
          groupsList = diskGroups;
          return res.json({ groups: filterGroups(groupsList), total: groupsList.length, cached: true });
        }
      } catch (e) {}
    }
    return res.status(400).json({ error: 'WhatsApp is not connected yet.', groups: [] });
  }

  try {
    if (groupsList.length === 0) {
      const fetchedGroups = await sock.groupFetchAllParticipating();
      groupsList = Object.values(fetchedGroups).map((g) => ({
        id: g.id,
        name: g.subject,
        participantsCount: g.participants?.length || 0
      }));
      // Save to disk cache
      try {
        fs.writeFileSync(path.join(AUTH_FOLDER, 'groups_cache.json'), JSON.stringify(groupsList), 'utf8');
      } catch (e) {}
    }

    res.json({
      groups: filterGroups(groupsList),
      total: groupsList.length,
      filtered: query ? filterGroups(groupsList).length : groupsList.length
    });
  } catch (err) {
    if (groupsList && groupsList.length > 0) {
      return res.json({ groups: filterGroups(groupsList), total: groupsList.length, cached: true });
    }
    res.status(500).json({ error: 'Failed to fetch groups', details: err?.message });
  }
});

// 4. Send Message (Direct Number or Group JID)
app.post('/api/whatsapp/send', async (req, res) => {
  if (connectionState !== 'open' || !sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp device is not connected. Please scan QR in Admin panel.'
    });
  }

  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, error: 'Missing `to` or `message` parameter.' });
  }

  try {
    let jid = to.toString().trim();

    // Check if it is a Group ID or a Phone Number
    if (!jid.includes('@')) {
      const cleanPhone = jid.replace(/\D/g, '');
      const fullPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
      jid = `${fullPhone}@s.whatsapp.net`;
    }

    console.log(`📤 Sending WhatsApp message to: ${jid}`);
    const result = await sock.sendMessage(jid, { text: message });

    if (result && result.key && result.key.id && result.message) {
      sentMessagesCache.set(result.key.id, result.message);
    }

    res.json({
      success: true,
      messageId: result?.key?.id,
      target: jid,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Failed to send message:', err?.message || err);
    res.status(500).json({ success: false, error: err?.message || 'Send failed' });
  }
});

// 5. Logout & Disconnect Device
app.post('/api/whatsapp/logout', async (req, res) => {
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {}
    }
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    connectionState = 'disconnected';
    connectedUser = null;
    currentQrDataUrl = null;
    groupsList = [];

    scheduleReconnect(1500);

    res.json({ success: true, message: 'Logged out successfully. Generating new QR...' });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Logout failed' });
  }
});

// Start Gateway
app.listen(PORT, () => {
  console.log(`⚡ MY PRINT WhatsApp Gateway Server running on http://localhost:${PORT}`);
  connectToWhatsApp();
});
