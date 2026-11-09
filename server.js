const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// تقديم الملفات الثابتة من مجلد public
app.use(express.static('public'));
app.use(express.json());

// الاتصال بقاعدة البيانات (يدعم الاتصال السحابي عبر Render أو المحلي)
const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/word_game_db';

mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('✅ تم الاتصال بقاعدة بيانات MongoDB بنجاح'))
  .catch(err => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

// هيكل بيانات المستخدم (Schema)
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    score: { type: Number, default: 0 },
    lastLoginDate: { type: Date, default: null },
    winStreak: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    achievements: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// دوال تحديد الرتب والسلاسل
function getPlayerRank(score) {
    if (score >= 600) return '👑 أسطورة التحدي';
    if (score >= 300) return '⭐ خبير مخضرم';
    if (score >= 100) return '🎯 لاعب محترف';
    return '🌱 مبتدئ';
}

const rooms = {};

io.on('connection', (socket) => {
    console.log(`🔌 انضم مستخدم جديد: ${socket.id}`);

    // 1. تسجيل الدخول التقليدي مع معالجة آمنة للأخطاء
    socket.on('login', async ({ username, password }) => {
        try {
            if (!username || !password) {
                return socket.emit('auth_error', 'يرجى إدخال اسم المستخدم وكلمة المرور');
            }

            let user = await User.findOne({ username });
            if (!user) {
                const hashedPassword = await bcrypt.hash(password, 10);
                user = new User({ username, password: hashedPassword });
                await user.save();
            } else {
                const isMatch = await bcrypt.compare(password, user.password);
                if (!isMatch) {
                    return socket.emit('auth_error', 'كلمة المرور غير صحيحة!');
                }
            }
            socket.username = username;
            socket.emit('auth_success', { username, score: user.score, rank: getPlayerRank(user.score) });
        } catch (e) {
            console.error('❌ خطأ قاعدة البيانات:', e);
            socket.emit('auth_error', 'تعذر الاتصال بقاعدة البيانات! يمكنك استخدام خيار (اللعب كضيف).');
        }
    });

    // 2. تسجيل الدخول كضيف (بدون قاعدة بيانات لتجنب أي تعليق)
    socket.on('guest_login', () => {
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const guestName = `ضيف_${randomNum}`;
        socket.username = guestName;
        
        socket.emit('auth_success', { 
            username: guestName, 
            score: 0, 
            rank: '🌱 مبتدئ (ضيف)' 
        });
        console.log(`👤 انضم لاعب كضيف سريع: ${guestName}`);
    });

    // 3. مكافأة الدخول اليومي
    socket.on('claim_daily_reward', async () => {
        try {
            if (!socket.username || socket.username.startsWith('ضيف_')) {
                return socket.emit('daily_reward_result', { success: false, message: '⚠️ الحسابات الضيفة لا يمكنها استلام المكافآت اليومية.' });
            }

            const user = await User.findOne({ username: socket.username });
            if (!user) return;

            const today = new Date().toDateString();
            const lastLogin = user.lastLoginDate ? new Date(user.lastLoginDate).toDateString() : null;

            if (lastLogin === today) {
                return socket.emit('daily_reward_result', { success: false, message: '⏳ لقد استلمت مكافأتك اليومية مسبقاً!' });
            }

            user.score += 50;
            user.lastLoginDate = new Date();
            await user.save();

            socket.emit('daily_reward_result', { 
                success: true, 
                newScore: user.score, 
                rank: getPlayerRank(user.score),
                message: '🎉 مبروك! حصلت على 50 نقطة مكافأة الدخول اليومي!' 
            });
        } catch (error) {
            console.error(error);
        }
    });

    // 4. إنشاء الغرف (كلاسيكي، سريع، بقاء)
    socket.on('create_room', (gameMode = 'classic') => {
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        let timerDuration = 60;
        if (gameMode === 'blitz') timerDuration = 15;
        if (gameMode === 'survival') timerDuration = 20;

        rooms[roomCode] = {
            code: roomCode,
            host: socket.username,
            players: [{ username: socket.username, score: 0, status: 'active', socketId: socket.id }],
            status: 'waiting',
            gameMode: gameMode,
            currentLetter: '',
            currentGroup: null,
            timer: timerDuration,
            roundSubmittedPlayers: new Set()
        };

        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('room_created', { roomCode, gameMode });
    });

    // 5. الانضمام للغرفة
    socket.on('join_room', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error_message', 'الغرفة غير موجودة!');
        
        room.players.push({ username: socket.username, score: 0, status: 'active', socketId: socket.id });
        socket.join(roomCode);
        socket.roomCode = roomCode;

        io.to(roomCode).emit('update_room_players', room.players);
    });

    // 6. اللعب الفردي ضد البوت الذكي
    const botAnswersDB = {
        'أ': { 'إنسان': 'أحمد', 'حيوان': 'أسد', 'نبات': 'أرز', 'جماد': 'أبرة', 'بلد': 'ألمانيا' },
        'ب': { 'إنسان': 'بدر', 'حيوان': 'بطريق', 'نبات': 'برتقال', 'جماد': 'باب', 'بلد': 'البرازيل' },
        'ت': { 'إنسان': 'تامر', 'حيوان': 'تمساح', 'نبات': 'تين', 'جماد': 'تلفاز', 'بلد': 'تركيا' }
    };

    socket.on('start_solo_practice', () => {
        const roomCode = 'SOLO_' + Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            host: socket.username,
            isSolo: true,
            players: [
                { username: socket.username, score: 0, status: 'active', socketId: socket.id },
                { username: '🤖 البوت الذكي', score: 0, status: 'active', isBot: true }
            ],
            status: 'playing',
            currentLetter: 'أ',
            currentGroup: { title: 'تحدي التدريب الذكي', questions: ['اسم إنسان', 'اسم حيوان', 'اسم نبات', 'اسم جماد', 'اسم بلد'] },
            timer: 45
        };

        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('game_started', {
            letter: 'أ',
            group: rooms[roomCode].currentGroup,
            time: 45,
            isSolo: true
        });
    });

    // 7. تفاعلات الإيموجي
    socket.on('send_reaction', (emoji) => {
        if (socket.roomCode && rooms[socket.roomCode]) {
            io.to(socket.roomCode).emit('player_reaction', { username: socket.username, emoji });
        }
    });

    // 8. التعزيزات (Power-ups)
    socket.on('use_powerup', (type) => {
        const room = rooms[socket.roomCode];
        if (!room || room.status !== 'playing') return;

        if (type === 'freeze') {
            room.timer += 10;
            io.to(room.code).emit('time_extended', { newTimer: room.timer, username: socket.username });
        } else if (type === 'hint') {
            socket.emit('ai_hint_received', { message: `💡 تلميح ذكي: ابدأ بحرف (${room.currentLetter}) وتذكر الأسماء الشائعة.` });
        } else if (type === 'double') {
            socket.emit('powerup_activated', { message: '⭐ تم تفعيل مضاعفة النقاط لهذه الجولة!' });
        }
    });

    socket.on('disconnect', () => {
        console.log(`🔌 انقطع الاتصال: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل بانتظام على البورت: ${PORT}`));
