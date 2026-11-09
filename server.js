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

// جدول المستخدمين مع دعم البريد/الجوال ورصيد الكاش
const userSchema = new mongoose.Schema({
    identifier: { type: String, unique: true, required: true }, // بريد أو رقم جوال
    password: { type: String, required: true },
    username: { type: String, required: true },
    score: { type: Number, default: 0 },
    cash: { type: Number, default: 0 }, // 10 كاش لكل 100 نقطة
    hintsCount: { type: Number, default: 3 }
});
const User = mongoose.model('User', userSchema);

const arabicLetters = ['أ', 'ب', 'ت', 'ج', 'ح', 'خ', 'د', 'ر', 'س', 'ش', 'ص', 'ط', 'ع', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'هـ', 'و', 'ي'];
const categories = ['إنسان', 'حيوان', 'نبات', 'جماد', 'بلاد'];

// قاعدة بيانات ذكية مصغرة للتحقق المتقدم (يمكن اعتبارها محاكاة لفحص الذكاء الاصطناعي)
const smartDictionary = {
    'أ': { 'إنسان': ['أحمد', 'أمين', 'إبراهيم', 'أنس', 'أسامة'], 'حيوان': ['أسد', 'أرنب', 'أيل'], 'نبات': ['أناناس', 'أرز', 'بصل'], 'جماد': ['إبرة', 'إسفنج'], 'بلاد': ['أردن', 'إسبانيا', 'إيطاليا'] },
    'ب': { 'إنسان': ['بدر', 'باسم', 'بركات'], 'حيوان': ['بطريق',بقرة, 'بومة', 'فهد'], 'نبات': ['برتقال', 'بازلاء', 'بقدونس'], 'جماد': ['باب', 'برطمان'], 'بلاد': ['البحرين', 'بريطانيا', 'بلجيكا'] },
    'م': { 'إنسان': ['محمد', 'محمود', 'معاذ', 'مروان'], 'حيوان': ['ماعز', 'قرد', 'تمساح'], 'نبات': ['موز', 'مانجو', 'نعناع'], 'جماد': ['مفتاح', 'مكتب', 'مصباح'], 'بلاد': ['مصر', 'مغرب', 'موريتانيا'] }
    // يمكن توسيع القاموس أو ربطه بفحص دلالي
};

let waitingPlayers = [];
const rooms = {};

io.on('connection', (socket) => {
    console.log(`🔌 انضم مستخدم: ${socket.id}`);

    // تسجيل الدخول أو إنشاء حساب برقم الجوال أو البريد
    socket.on('auth_user', async ({ identifier, password, username }) => {
        try {
            if (!identifier || !password) return socket.emit('auth_error', 'يرجى أدخال البريد أو الجوال وكلمة المرور');
            
            let user = await User.findOne({ identifier });
            if (!user) {
                const hashedPassword = await bcrypt.hash(password, 10);
                user = new User({ 
                    identifier, 
                    password: hashedPassword, 
                    username: username || identifier.split('@')[0],
                    score: 0,
                    cash: 0 
                });
                await user.save();
            } else {
                const isMatch = await bcrypt.compare(password, user.password);
                if (!isMatch) return socket.emit('auth_error', 'كلمة المرور غير صحيحة!');
            }

            socket.userId = user._id;
            socket.username = user.username;
            socket.emit('auth_success', { username: user.username, score: user.score, cash: user.cash });
        } catch (e) {
            socket.emit('auth_error', 'خطأ في قاعدة البيانات');
        }
    });

    // نظام البحث عن لاعبين مع مهلة 10 ثوانٍ والتحول للبوتات
    socket.on('start_matchmaking', (roundsCount) => {
        socket.totalRounds = parseInt(roundsCount) || 3;
        waitingPlayers.push(socket);

        // ضبط مؤقت 10 ثوانٍ للبحث
        socket.matchTimeout = setTimeout(() => {
            // تحقق إذا كان اللاعب ما زال في قائمة الانتظار ولم يتم توزيعه لغرفة
            const index = waitingPlayers.indexOf(socket);
            if (index !== -1) {
                waitingPlayers.splice(index, 1);
                // إنشاء غرفة مع بوتات ذكية لعدم الانتظار طويلاً
                createRoomWithBots(socket, socket.totalRounds);
            }
        }, 10000);

        if (waitingPlayers.length >= 2) {
            // إيقاف مؤقتات الانتظار لهم وبدء غرفة جماعية حقيقية
            const matchGroup = waitingPlayers.splice(0, 2);
            matchGroup.forEach(p => clearTimeout(p.matchTimeout));
            
            const roomCode = 'ROOM_' + Math.random().toString(36).substring(2, 6).toUpperCase();
            rooms[roomCode] = {
                code: roomCode,
                players: matchGroup.map(p => ({ socketId: p.id, username: p.username, score: 0, isBot: false })),
                totalRounds: matchGroup[0].totalRounds,
                currentRound: 0,
                status: 'playing',
                timer: 60
            };

            matchGroup.forEach(p => {
                p.join(roomCode);
                p.roomCode = roomCode;
            });

            io.to(roomCode).emit('match_found', { players: rooms[roomCode].players });
            startNewRound(roomCode);
        }
    });

    function createRoomWithBots(playerSocket, totalRounds) {
        const roomCode = 'BOTROOM_' + Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            players: [
                { socketId: playerSocket.id, username: playerSocket.username, score: 0, isBot: false },
                { socketId: 'bot_1', username: '🤖 ذكي (بوت)', score: 0, isBot: true },
                { socketId: 'bot_2', username: '🤖 سريعة (بوت)', score: 0, isBot: true }
            ],
            totalRounds: totalRounds,
            currentRound: 0,
            status: 'playing',
            timer: 60
        };

        playerSocket.join(roomCode);
        playerSocket.roomCode = roomCode;

        playerSocket.emit('match_found', { players: rooms[roomCode].players });
        startNewRound(roomCode);
    }

    // الشات العام داخل غرفة اللعب
    socket.on('send_room_chat', (message) => {
        if (!socket.roomCode || !rooms[socket.roomCode]) return;
        io.to(socket.roomCode).emit('new_room_chat', { username: socket.username, message });
    });

    // الفحص الذكي الفوري للإجابة (زر التحقق أو الكتابة)
    socket.on('verify_answer', ({ category, word, letter }) => {
        const cleanWord = (word || '').trim();
        if (!cleanWord || !cleanWord.startsWith(letter)) {
            return socket.emit('answer_verification_result', { category, isValid: false, reason: 'لا تبدأ بالحرف المطلوب' });
        }

        // محاكاة الفحص الذكي للقاموس أو الذكاء الاصطناعي
        let isValid = false;
        if (smartDictionary[letter] && smartDictionary[letter][category]) {
            isValid = smartDictionary[letter][category].some(w => cleanWord.includes(w));
        } else {
            // فحص افتراضي متساهل طالما تبدأ بالحرف وطولها أكثر من حرفين
            isValid = cleanWord.length >= 2;
        }

        socket.emit('answer_verification_result', { category, isValid, word: cleanWord });
    });

    // استقبال تسليم إجابات الجولة وحساب النقاط والكاش
    socket.on('submit_round_answers', async ({ correctAnswersCount }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player || player.hasSubmitted) return;

        const roundEarnedScore = correctAnswersCount * 10; // 10 نقاط لكل إجابة صحيحة
        player.score += roundEarnedScore;
        player.hasSubmitted = true;

        // تحديث النقاط والكاش في قاعدة البيانات للمستخدم الحقيقي
        if (!player.isBot && socket.userId) {
            try {
                const userDoc = await User.findById(socket.userId);
                if (userDoc) {
                    userDoc.score += roundEarnedScore;
                    // تحويل كل 100 نقطة إلى 10 كاش
                    const newCashEarned = Math.floor(userDoc.score / 100) * 10 - userDoc.cash; 
                    if (newCashEarned > 0) {
                        userDoc.cash += newCashEarned;
                    }
                    await userDoc.save();
                    socket.emit('update_wallet', { score: userDoc.score, cash: userDoc.cash });
                }
            } catch(e) { console.error(e); }
        }

        // إذا كانت اللعبة تضم بوتات، نحاكي إجاباتهم
        room.players.forEach(p => {
            if (p.isBot && !p.hasSubmitted) {
                p.score += Math.floor(Math.random() * 30) + 10;
                p.hasSubmitted = true;
            }
        });

        // بث النقاط الحية لجميع اللاعبين في الغرفة
        io.to(room.code).emit('live_score_update', room.players);

        if (room.players.every(p => p.hasSubmitted)) {
            endRound(room.code);
        }
    });

    socket.on('disconnect', () => {
        if (socket.matchTimeout) clearTimeout(socket.matchTimeout);
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
        console.log(`🔌 قطع الاتصال: ${socket.id}`);
    });
});

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.currentRound >= room.totalRounds) {
        room.players.sort((a, b) => b.score - a.score);
        io.to(roomCode).emit('game_final_results', room.players);
        delete rooms[roomCode];
        return;
    }

    room.currentRound++;
    room.currentLetter = arabicLetters[Math.floor(Math.random() * arabicLetters.length)];
    room.players.forEach(p => p.hasSubmitted = false);

    io.to(roomCode).emit('start_round', {
        roundNum: room.currentRound,
        totalRounds: room.totalRounds,
        letter: room.currentLetter,
        categories: categories,
        players: room.players
    });

    // مؤقت الجولة دقيقة كاملة (60 ثانية)
    room.timerInterval = setTimeout(() => {
        endRound(roomCode);
    }, 60000);
}

function endRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    clearTimeout(room.timerInterval);

    io.to(roomCode).emit('round_ended', { players: room.players });

    setTimeout(() => {
        startNewRound(roomCode);
    }, 4000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل بانتظام على البورت: ${PORT}`));
