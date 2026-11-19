const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = 'https://veeydctazdsjbcbymrbb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wEj9ef1Qkvfqx2OlVxikVA_m4p4Ubz3';
const dbClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// تشغيل القناتين المحدتين فقط
const ALLOWED_CHANNELS = ['p1', 'p2'];

// تخزين جلسات القناتين
const sessions = {};

function normalizePhone(val) {
    return String(val || '').replace(/\D/g, '');
}

function formatSaudiPhone(val) {
    let digits = normalizePhone(val);
    if (digits.startsWith('05') && digits.length === 10) {
        digits = '966' + digits.slice(1);
    }
    return digits;
}

async function startSessionForChannel(channel) {
    const channelId = channel.id;
    if (!sessions[channelId]) {
        sessions[channelId] = {
            id: channelId,
            name: channel.name || channelId,
            expectedPhone: formatSaudiPhone(channel.value),
            sock: null,
            isConnected: false,
            connectedPhone: '',
            latestQr: ''
        };
    }

    const session = sessions[channelId];
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_baileys/${channelId}`);

    const sock = makeWASocket({
        auth: state,
        browser: [`Tawasulna-${channelId}`, 'Chrome', '1.0.0']
    });

    session.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            session.latestQr = qr;
            console.log(`📌 باركود جاهز للقناة [${session.name} - ${channelId}] على /qr/${channelId}`);
        }

        if (connection === 'close') {
            session.isConnected = false;
            session.connectedPhone = '';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ انقطع الاتصال للقناة [${channelId}]، رمز الحالة:`, statusCode);
            if (shouldReconnect) {
                startSessionForChannel(channel);
            } else {
                session.latestQr = '';
                console.log(`🔒 تم تسجيل الخروج نهائياً للقناة [${channelId}]`);
            }
        } else if (connection === 'open') {
            session.isConnected = true;
            session.latestQr = '';
            session.connectedPhone = normalizePhone(sock.user?.id?.split(':')[0] || '');
            console.log(`✅ القناة [${session.name} - ${channelId}] متصلة بالرقم: ${session.connectedPhone}`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid || '';
                if (
                    remoteJid.endsWith('@g.us') ||
                    remoteJid.endsWith('@newsletter') ||
                    remoteJid === 'status@broadcast'
                ) {
                    continue;
                }

                const candidateJid =
                    (msg.key.remoteJidAlt && msg.key.remoteJidAlt.includes('@s.whatsapp.net') && msg.key.remoteJidAlt) ||
                    (msg.key.participant && msg.key.participant.includes('@s.whatsapp.net') && msg.key.participant) ||
                    (msg.key.senderPn && String(msg.key.senderPn).includes('@s.whatsapp.net') && msg.key.senderPn) ||
                    remoteJid;

                const isLidOnly = candidateJid.endsWith('@lid') && !remoteJid.includes('@s.whatsapp.net');
                const rawContact = candidateJid.replace('@s.whatsapp.net', '').replace('@lid', '');
                const senderPhone = formatSaudiPhone(rawContact) || rawContact;

                const messageText =
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    'رسالة مرفقة أو وسائط';

                const pushName = msg.pushName || `عميل واتساب (${senderPhone})`;

                // البحث عن محادثة لنفس المرسل على نفس القناة تحديداً
                let { data: convs, error: convErr } = await dbClient
                    .from('conversations')
                    .select('*')
                    .eq('sender_contact', senderPhone)
                    .eq('channel_id', channelId);

                if (convErr) {
                    console.error(`❌ خطأ في البحث عن المحادثة [${channelId}]:`, convErr.message);
                    continue;
                }

                let convId;
                if (convs && convs.length > 0) {
                    convId = convs[0].id;
                    await dbClient
                        .from('conversations')
                        .update({
                            unread: true,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', convId);
                } else {
                    const summaryNote = isLidOnly
                        ? `رسالة واردة عبر معرّف (LID: ${senderPhone}) على قناة ${session.name} (${session.connectedPhone || 'غير محدد'}).`
                        : `رسالة واردة عبر الواتساب على قناة ${session.name} (${session.connectedPhone || 'غير محدد'}).`;

                    const { data: newConv, error: insertErr } = await dbClient
                        .from('conversations')
                        .insert([{
                            ticket: '#T-' + Math.floor(1000 + Math.random() * 9000),
                            sender_name: pushName,
                            sender_contact: senderPhone,
                            channel_id: channelId,
                            unread: true,
                            ai_summary: summaryNote
                        }])
                        .select();

                    if (insertErr || !newConv || !newConv[0]) {
                        console.error(`❌ خطأ في إنشاء المحادثة [${channelId}]:`, insertErr?.message);
                        continue;
                    }
                    convId = newConv[0].id;
                }

                const { error: msgErr } = await dbClient
                    .from('messages')
                    .insert([{
                        conversation_id: convId,
                        from_type: 'customer',
                        text: messageText,
                        via_channel: channelId
                    }]);

                if (msgErr) {
                    console.error(`❌ خطأ في حفظ الرسالة [${channelId}]:`, msgErr.message);
                } else {
                    console.log(`📩 تم حفظ رسالة واردة من ${senderPhone} على القناة ${channelId}`);
                }
            } catch (err) {
                console.error(`❌ خطأ أثناء معالجة رسالة في قناة ${channelId}:`, err.message);
            }
        }
    });
}

async function initSelectedChannels() {
    const { data: channels, error } = await dbClient
        .from('channels')
        .select('*')
        .eq('type', 'phone');

    if (error || !channels) {
        console.error('❌ تعذر جلب القنوات من Supabase:', error?.message);
        return;
    }

    const filtered = channels
        .filter(ch => {
            const cleanVal = normalizePhone(ch.value);
            return ALLOWED_CHANNELS.includes(String(ch.id)) || ALLOWED_CHANNELS.includes(cleanVal);
        })
        .slice(0, 2);

    // ضمان وجود جلسة حتى لو لم يرجع صف من قاعدة البيانات لسبب ما
    for (const allowedId of ALLOWED_CHANNELS) {
        const found = filtered.find(c => String(c.id) === allowedId);
        if (found) {
            await startSessionForChannel(found);
        } else {
            await startSessionForChannel({ id: allowedId, name: allowedId, value: '' });
        }
    }
}

// عرض قائمة القناتين وروابط مسح الباركود لكل قناة
app.get('/qr', (req, res) => {
    const rows = Object.values(sessions).map(s => `
        <tr>
            <td style="padding:10px;border:1px solid #cbd5e1;">${s.id}</td>
            <td style="padding:10px;border:1px solid #cbd5e1;">${s.name}</td>
            <td style="padding:10px;border:1px solid #cbd5e1;">${s.expectedPhone || '-'}</td>
            <td style="padding:10px;border:1px solid #cbd5e1;">${s.isConnected ? `✅ متصل (${s.connectedPhone})` : '⏳ غير متصل'}</td>
            <td style="padding:10px;border:1px solid #cbd5e1;"><a href="/qr/${s.id}">فتح QR</a></td>
        </tr>
    `).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8" />
            <meta http-equiv="refresh" content="10" />
            <title>ربط قنوات الواتساب (p1 و p2)</title>
        </head>
        <body style="font-family:Arial,sans-serif;padding:30px;background:#f8fafc;color:#0f172a;">
            <h2>ربط قنوات الواتساب المفعّلة (p1 و p2)</h2>
            <table style="border-collapse:collapse;width:100%;background:#fff;">
                <thead>
                    <tr style="background:#f1f5f9;">
                        <th style="padding:10px;border:1px solid #cbd5e1;">المعرف</th>
                        <th style="padding:10px;border:1px solid #cbd5e1;">اسم القناة</th>
                        <th style="padding:10px;border:1px solid #cbd5e1;">الرقم المسجل</th>
                        <th style="padding:10px;border:1px solid #cbd5e1;">الحالة</th>
                        <th style="padding:10px;border:1px solid #cbd5e1;">الباركود</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </body>
        </html>
    `);
});

// باركود مستقل لكل قناة (مثل /qr/p1 أو /qr/p2)
app.get('/qr/:channelId', async (req, res) => {
    const session = sessions[req.params.channelId];
    if (!session) {
        return res.status(404).send('القناة غير مفعّلة أو غير موجودة');
    }

    if (session.isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head><meta charset="UTF-8" /><title>متصل</title></head>
            <body style="font-family:Arial,sans-serif;text-align:center;padding:50px;background:#f8fafc;">
                <div style="display:inline-block;background:#fff;padding:28px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,0.08);">
                    <p style="color:#15803d;font-size:19px;font-weight:bold;">✅ قناة (${session.name} - ${session.id}) متصلة بنجاح</p>
                    <p>الرقم المرتبط: ${session.connectedPhone || session.expectedPhone}</p>
                </div>
            </body>
            </html>
        `);
    }

    if (!session.latestQr) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head><meta charset="UTF-8" /><title>انتظار QR</title></head>
            <body style="font-family:Arial,sans-serif;text-align:center;padding:50px;background:#f8fafc;">
                <div style="display:inline-block;background:#fff;padding:28px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,0.08);">
                    <h3>⏳ جاري تجهيز رمز QR لقناة (${session.name} - ${session.id})...</h3>
                    <p>سيتم تحديث الصفحة تلقائياً خلال 3 ثوانٍ.</p>
                </div>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </body>
            </html>
        `);
    }

    const qrImageDataUrl = await QRCode.toDataURL(session.latestQr, { width: 320, margin: 2 });
    res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8" />
            <meta http-equiv="refresh" content="15" />
            <title>مسح باركود ${session.name}</title>
        </head>
        <body style="font-family:Arial,sans-serif;text-align:center;padding:40px;background:#f8fafc;color:#0f172a;">
            <div style="display:inline-block;background:#fff;padding:28px;border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,0.08);">
                <h2>امسح رمز QR لقناة: ${session.name} (${session.id})</h2>
                <p>الرقم المتوقع: ${session.expectedPhone || 'غير محدد'}</p>
                <img src="${qrImageDataUrl}" alt="WhatsApp QR Code" style="background:#fff;padding:12px;border-radius:12px;border:1px solid #e2e8f0;" />
                <p style="color:#475569;font-size:14px;">الأجهزة المرتبطة ← ربط جهاز. تتحدث الصفحة تلقائياً كل 15 ثانية.</p>
            </div>
        </body>
        </html>
    `);
});

// حالة القناتين (متوافق مع الواجهة الحالية ويعرض تفاصيل كل قناة)
app.get('/status', (req, res) => {
    const p1 = sessions['p1'];
    const p2 = sessions['p2'];
    const list = Object.values(sessions).map(s => ({
        channelId: s.id,
        name: s.name,
        connected: s.isConnected,
        phone: s.connectedPhone
    }));

    res.json({
        connected: list.some(x => x.connected),
        phone: (p1 && p1.connectedPhone) || (list.find(x => x.connected)?.phone) || '',
        channels: {
            p1: { connected: Boolean(p1?.isConnected), phone: p1?.connectedPhone || '' },
            p2: { connected: Boolean(p2?.isConnected), phone: p2?.connectedPhone || '' }
        },
        sessions: list
    });
});

// إرسال رسالة من القناة المحددة (channelId) أو من أول قناة متصلة إذا لم يُمرر channelId
app.post('/send-whatsapp', async (req, res) => {
    const { phone, message, channelId } = req.body;
    const session = (channelId && sessions[channelId]) || Object.values(sessions).find(s => s.isConnected);

    if (!session || !session.isConnected || !session.sock) {
        return res.status(400).json({
            success: false,
            error: 'القناة المطلوبة غير متصلة بالواتساب حالياً'
        });
    }

    const cleanPhone = formatSaudiPhone(phone);
    if (!cleanPhone || !message || !String(message).trim()) {
        return res.status(400).json({
            success: false,
            error: 'رقم الجوال ونص الرسالة مطلوبان'
        });
    }

    try {
        let targetJid = `${cleanPhone}@s.whatsapp.net`;
        if (typeof session.sock.onWhatsApp === 'function') {
            const results = await session.sock.onWhatsApp(cleanPhone);
            if (Array.isArray(results) && results.length > 0 && results[0].exists && results[0].jid) {
                targetJid = results[0].jid;
            }
        }

        await session.sock.sendMessage(targetJid, { text: String(message).trim() });
        res.json({
            success: true,
            channelId: session.id,
            sentFrom: session.connectedPhone,
            to: cleanPhone,
            jid: targetJid
        });
    } catch (error) {
        console.error(`❌ فشل إرسال رسالة الواتساب عبر قناة ${session.id}:`, error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 خادم تواصلنا (p1 و p2) شغال على البورت ${PORT}`);
    initSelectedChannels();
});
