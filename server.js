const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/word_game_db';
mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('✅ تم الاتصال بقاعدة بيانات MongoDB بنجاح'))
  .catch(err => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

const userSchema = new mongoose.Schema({
    identifier: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    username: { type: String, required: true },
    score: { type: Number, default: 2414 },
    cash: { type: Number, default: 15 },
    lastDailyClaim: { type: String, default: '' }
});
const User = mongoose.model('User', userSchema);

const arabicLetters = ['أ', 'ب', 'ت', 'ج', 'ح', 'خ', 'د', 'ر', 'س', 'ش', 'ص', 'ط', 'ع', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'هـ', 'و', 'ي'];
const categories = ['إنسان', 'حيوان', 'نبات', 'جماد', 'بلاد'];

let matchmakingQueue = [];
const rooms = {};

io.on('connection', (socket) => {
    console.log(`🔌 انضم مستخدم: ${socket.id}`);

    // تسجيل الدخول أو إنشاء حساب
    socket.on('auth_user', async ({ identifier, password, username }) => {
        try {
            if (!identifier || !password) return socket.emit('auth_error', 'أدخل البريد/الجوال وكلمة المرور');
            let user = await User.findOne({ identifier });
            if (!user) {
                const hashedPassword = await bcrypt.hash(password, 10);
                user = new User({ identifier, password: hashedPassword, username: username || 'لاعب جديد' });
                await user.save();
            } else {
                const isMatch = await bcrypt.compare(password, user.password);
                if (!isMatch) return socket.emit('auth_error', 'كلمة المرور غير صحيحة!');
            }
            socket.userId = user._id;
            socket.username = user.username;
            socket.emit('auth_success', { username: user.username, score: user.score, cash: user.cash });
        } catch (e) {
            socket.emit('auth_error', 'خطأ في الخادم');
        }
    });

    // مطالبة المكافأة اليومية
    socket.on('claim_daily', async () => {
        if (!socket.userId) return;
        const user = await User.findById(socket.userId);
        const today = new Date().toDateString();
        if (user.lastDailyClaim === today) {
            return socket.emit('daily_result', { success: false, msg: 'لقد استلمت مكافأتك اليومية مسبقاً!' });
        }
        user.cash += 10;
        user.lastDailyClaim = today;
        await user.save();
        socket.emit('daily_result', { success: true, cash: user.cash, msg: '🎉 حصلت على 10 كاش مكافأة يومية!' });
    });

    // زر "لعب": البحث السريع بحد أقصى 5 مستخدمين أو الدخول مع بوتات بعد 10 ثوانٍ
    socket.on('start_matchmaking', () => {
        matchmakingQueue.push(socket);

        socket.matchTimer = setTimeout(() => {
            const index = matchmakingQueue.indexOf(socket);
            if (index !== -1) {
                matchmakingQueue.splice(index, 1);
                createRoomWithBots(socket);
            }
        }, 10000); // 10 ثواني مهلة

        if (matchmakingQueue.length >= 5) {
            const group = matchmakingQueue.splice(0, 5);
            group.forEach(p => clearTimeout(p.matchTimer));
            setupRoomForGroup(group);
        }
    });

    function createRoomWithBots(socket) {
        const roomCode = 'BOT_' + Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            players: [
                { socketId: socket.id, username: socket.username, score: 0, isBot: false },
                { socketId: 'b1', username: 'Ryan', score: 15, isBot: true },
                { socketId: 'b2', username: 'زيزو', score: 17, isBot: true },
                { socketId: 'b3', username: 'BBB', score: 12, isBot: true },
                { socketId: 'b4', username: 'محمد', score: 12, isBot: true }
            ],
            currentRound: 1,
            totalRounds: 3,
            status: 'playing'
        };
        socket.join(roomCode);
        socket.roomCode = roomCode;
        io.to(roomCode).emit('match_started', rooms[roomCode].players);
        startRoundTimer(roomCode);
    }

    function setupRoomForGroup(group) {
        group.forEach(p => clearTimeout(p.matchTimer));
        const roomCode = 'GRP_' + Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            players: group.map(p => ({ socketId: p.id, username: p.username, score: 0, isBot: false })),
            currentRound: 1,
            totalRounds: 3,
            status: 'playing'
        };
        group.forEach(p => { p.join(roomCode); p.roomCode = roomCode; });
        io.to(roomCode).emit('match_started', rooms[roomCode].players);
        startRoundTimer(roomCode);
    }

    // زر "خاص": إنشاء غرفة خاصة كحد أقصى 7 لاعبين
    socket.on('create_private_room', () => {
        const roomCode = 'PRIV_' + Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            host: socket.username,
            players: [{ socketId: socket.id, username: socket.username, score: 0, isBot: false }],
            maxPlayers: 7,
            status: 'waiting'
        };
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('private_room_created', roomCode);
    });

    socket.on('join_private_room', (code) => {
        const room = rooms[code.trim().toUpperCase()];
        if (!room) return socket.emit('error_msg', 'الغرفة غير موجودة');
        if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', 'الغرفة ممتلئة (الحد الأقصى 7)');
        
        room.players.push({ socketId: socket.id, username: socket.username, score: 0, isBot: false });
        socket.join(room.code);
        socket.roomCode = room.code;
        io.to(room.code).emit('update_room_players', room.players);
    });

    // دعوة صديق (إرسال إشعار خارجي محاكى)
    socket.on('invite_friend', ({ friendPhone }) => {
        socket.emit('invite_sent', `📤 تم إرسال إشعار ورسالة نصية إلى ${friendPhone} بنجاح للدخول معك في الغرفة!`);
    });

    // الشات العام داخل الغرفة
    socket.on('send_chat', (msg) => {
        if (!socket.roomCode || !rooms[socket.roomCode]) return;
        io.to(socket.roomCode).emit('new_chat', { username: socket.username, msg });
    });

    // التحقق الفوري من الإجابة (صح / خطأ بجانب الخانة)
    socket.on('verify_answer_box', ({ category, word, letter }) => {
        const clean = (word || '').trim();
        const isValid = clean.length >= 2 && clean.startsWith(letter);
        socket.emit('answer_box_result', { category, isValid });
    });

    socket.on('disconnect', () => {
        if (socket.matchTimer) clearTimeout(socket.matchTimer);
        matchmakingQueue = matchmakingQueue.filter(p => p.id !== socket.id);
        console.log(`🔌 انقطع الاتصال: ${socket.id}`);
    });
});

function startRoundTimer(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    room.currentLetter = arabicLetters[Math.floor(Math.random() * arabicLetters.length)];
    
    io.to(roomCode).emit('start_round_data', {
        round: room.currentRound,
        total: room.totalRounds,
        letter: room.currentLetter,
        categories: categories,
        players: room.players
    });

    room.timer = setTimeout(() => {
        room.currentRound++;
        if (room.currentRound > room.totalRounds) {
            room.players.sort((a,b) => b.score - a.score);
            io.to(roomCode).emit('game_over', room.players);
            delete rooms[roomCode];
        } else {
            startRoundTimer(roomCode);
        }
    }, 60000); // 60 ثانية للجولة
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل على البورت: ${PORT}`));
