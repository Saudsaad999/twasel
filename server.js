const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 3000;
const SUPABASE_URL = 'https://veeydctazdsjbcbymrbb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wEj9ef1Qkvfqx2OlVxikVA_m4p4Ubz3';
const dbClient = createClient(SUPABASE_URL, SUPABASE_KEY);

let sock;
let connectedPhone = '';
let isConnected = false;

function normalizePhone(val) {
    return String(val || '').replace(/\D/g, '');
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
            console.log('📌 امسح رمز QR Code من تطبيق الواتساب في جوالك:');
            qrcode.generate(qr, { small: true });
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
                console.log('🔒 تم تسجيل الخروج نهائياً. احذف مجلد auth_info_baileys ثم أعد التشغيل لربط حساب جديد.');
            }
        } else if (connection === 'open') {
            isConnected = true;
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
                if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

                const senderPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '');
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
                    const { data: newConv, error: insertErr } = await dbClient
                        .from('conversations')
                        .insert([{
                            ticket: '#T-' + Math.floor(1000 + Math.random() * 9000),
                            sender_name: pushName,
                            sender_contact: senderPhone,
                            channel_id: targetChannelId,
                            unread: true,
                            ai_summary: `رسالة واردة عبر الواتساب على الرقم (${connectedPhone || 'غير محدد'}).`
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
                    console.log(`📩 تم حفظ رسالة واردة من ${senderPhone} على القناة ${targetChannelId}`);
                }
            } catch (err) {
                console.error('❌ خطأ أثناء معالجة رسالة واردة:', err.message);
            }
        }
    });
}

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

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || !message || !String(message).trim()) {
        return res.status(400).json({
            success: false,
            error: 'رقم الجوال ونص الرسالة مطلوبان'
        });
    }

    try {
        const jid = `${cleanPhone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: String(message).trim() });
        res.json({
            success: true,
            sentFrom: connectedPhone,
            to: cleanPhone
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