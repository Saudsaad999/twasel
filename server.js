const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcodeTerminal = require('qrcode-terminal');
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

let sock;
let connectedPhone = '';
let isConnected = false;
let latestQr = '';

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

async function resolveChannelIdByConnectedPhone(phone) {
    try {
        const { data: channels, error } = await dbClient
            .from('channels')
            .select('*')
            .eq('type', 'phone');

        if (!error && Array.isArray(channels) && channels.length > 0) {
            const cleanConnected = normalizePhone(phone);
            const matched = channels.find(ch => {
                const cleanCh = normalizePhone(ch.value);
                if (!cleanCh || !cleanConnected) return false;
                return cleanCh === cleanConnected || cleanCh.slice(-9) === cleanConnected.slice(-9);
            });
            if (matched) return matched.id;
            return channels[0].id;
        }
    } catch (err) {
        console.error('تعذر مطابقة القناة من جدول channels:', err.message);
    }
    return 'p1';
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        browser: ['Tawasulna', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQr = qr;
            console.log('📌 امسح رمز QR Code من تطبيق الواتساب في جوالك أو افتح /qr في المتصفح:');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            connectedPhone = '';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ انقطع الاتصال بالواتساب، رمز الحالة:', statusCode);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                latestQr = '';
                console.log('🔒 تم تسجيل الخروج نهائياً. احذف مجلد auth_info_baileys ثم أعد التشغيل لربط حساب جديد.');
            }
        } else if (connection === 'open') {
            isConnected = true;
            latestQr = '';
            connectedPhone = normalizePhone(sock.user?.id?.split(':')[0] || '');
            console.log('✅ متصل بالواتساب الفعلي بنجاح! الرقم المتصل:', connectedPhone);
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
                const targetChannelId = await resolveChannelIdByConnectedPhone(connectedPhone);

                let { data: convs, error: convErr } = await dbClient
                    .from('conversations')
                    .select('*')
                    .eq('sender_contact', senderPhone);

                if (convErr) {
                    console.error('❌ خطأ في البحث عن المحادثة:', convErr.message);
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
                        ? `رسالة واردة عبر معرّف واتساب (LID: ${senderPhone}) على الرقم (${connectedPhone || 'غير محدد'}).`
                        : `رسالة واردة عبر الواتساب على الرقم (${connectedPhone || 'غير محدد'}).`;

                    const { data: newConv, error: insertErr } = await dbClient
                        .from('conversations')
                        .insert([{
                            ticket: '#T-' + Math.floor(1000 + Math.random() * 9000),
                            sender_name: pushName,
                            sender_contact: senderPhone,
                            channel_id: targetChannelId,
                            unread: true,
                            ai_summary: summaryNote
                        }])
                        .select();

                    if (insertErr || !newConv || !newConv[0]) {
                        console.error('❌ خطأ في إنشاء المحادثة:', insertErr?.message);
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
                        via_channel: targetChannelId
                    }]);

                if (msgErr) {
                    console.error('❌ خطأ في حفظ الرسالة:', msgErr.message);
                } else {
                    console.log(`📩 تم حفظ رسالة واردة من ${senderPhone} (LID فقط: ${isLidOnly}) على القناة ${targetChannelId}`);
                }
            } catch (err) {
                console.error('❌ خطأ أثناء معالجة رسالة واردة:', err.message);
            }
        }
    });
}

// عرض باركود الواتساب كصورة واضحة في المتصفح
app.get('/qr', async (req, res) => {
    try {
        if (isConnected) {
            return res.send(`
                <!DOCTYPE html>
                <html lang="ar" dir="rtl">
                <head>
                    <meta charset="UTF-8" />
                    <title>حالة الواتساب</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f8fafc; }
                        .box { display: inline-block; background: #fff; padding: 28px; border-radius: 14px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
                        .ok { color: #15803d; font-size: 19px; font-weight: bold; }
                    </style>
                </head>
                <body>
                    <div class="box">
                        <p class="ok">✅ الواتساب متصل بنجاح</p>
                        <p>الرقم المرتبط: ${connectedPhone || 'غير محدد'}</p>
                    </div>
                </body>
                </html>
            `);
        }

        if (!latestQr) {
            return res.send(`
                <!DOCTYPE html>
                <html lang="ar" dir="rtl">
                <head>
                    <meta charset="UTF-8" />
                    <title>انتظار الباركود</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f8fafc; }
                        .box { display: inline-block; background: #fff; padding: 28px; border-radius: 14px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
                    </style>
                </head>
                <body>
                    <div class="box">
                        <h3>⏳ جاري تجهيز رمز QR...</h3>
                        <p>سيتم تحديث الصفحة تلقائياً خلال 3 ثوانٍ.</p>
                    </div>
                    <script>setTimeout(() => location.reload(), 3000);</script>
                </body>
                </html>
            `);
        }

        const qrImageDataUrl = await QRCode.toDataURL(latestQr, { width: 320, margin: 2 });

        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8" />
                <meta http-equiv="refresh" content="15" />
                <title>مسح باركود واتساب</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 40px; background: #f8fafc; color: #0f172a; }
                    .card { display: inline-block; background: #fff; padding: 28px; border-radius: 16px; box-shadow: 0 6px 24px rgba(0,0,0,0.08); }
                    img { background: #fff; padding: 12px; border-radius: 12px; border: 1px solid #e2e8f0; }
                    p { color: #475569; font-size: 14px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>امسح رمز QR من تطبيق الواتساب في جوالك</h2>
                    <img src="${qrImageDataUrl}" alt="WhatsApp QR Code" />
                    <p>الأجهزة المرتبطة ← ربط جهاز. تتحدث الصفحة تلقائياً كل 15 ثانية.</p>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('تعذر توليد صورة الباركود');
    }
});

// نقطة التحقق من حالة الاتصال والرقم المرتبط للواجهة
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        phone: connectedPhone
    });
});

// نقطة إرسال الرسائل الصادرة من لوحة تواصلنا إلى الواتساب
app.post('/send-whatsapp', async (req, res) => {
    const { phone, message } = req.body;

    if (!isConnected || !sock) {
        return res.status(400).json({
            success: false,
            error: 'الواتساب غير متصل حالياً، تأكد من الاتصال أولاً'
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

        if (typeof sock.onWhatsApp === 'function') {
            const results = await sock.onWhatsApp(cleanPhone);
            if (Array.isArray(results) && results.length > 0 && results[0].exists && results[0].jid) {
                targetJid = results[0].jid;
            }
        }

        await sock.sendMessage(targetJid, { text: String(message).trim() });
        res.json({
            success: true,
            sentFrom: connectedPhone,
            to: cleanPhone,
            jid: targetJid
        });
    } catch (error) {
        console.error('❌ فشل إرسال رسالة الواتساب:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 خادم الواتساب شغال على البورت ${PORT}`);
    connectToWhatsApp();
});
