const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const arabicLetters = ['أ', 'ب', 'ت', 'ج', 'ح', 'خ', 'د', 'ر', 'س', 'ش', 'ص', 'ط', 'ع', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'هـ', 'و', 'ي'];
const categories = ['إنسان', 'حيوان', 'نبات', 'جماد', 'بلاد'];

let waitingPlayers = []; // قائمة انتظار البحث عن لاعبين (زر لعب)
const rooms = {};

io.on('connection', (socket) => {
    console.log(`🔌 انصل اللاعب: ${socket.id}`);

    // الدخول المباشر بالاسم
    socket.on('direct_join', (username) => {
        socket.username = username ? username.trim() : `لاعب_${Math.floor(1000 + Math.random() * 9000)}`;
        socket.emit('join_success', { username: socket.username });
    });

    // 1. زر "لعب": البحث التلقائي عن لاعبين
    socket.on('find_match', (totalRounds) => {
        socket.totalRounds = parseInt(totalRounds) || 3;
        waitingPlayers.push(socket);

        // إذا تجمع لاعبين أو أكثر، نبدأ غرفة جديدة تلقائياً
        if (waitingPlayers.length >= 2) {
            const matchPlayers = waitingPlayers.splice(0, 2); // نأخذ لاعبين كمثال للبدء السريع
            const roomCode = 'ROOM_' + Math.random().toString(36).substring(2, 6).toUpperCase();
            
            rooms[roomCode] = {
                code: roomCode,
                players: matchPlayers.map(p => ({ socketId: p.id, username: p.username, score: 0, answers: {} })),
                totalRounds: matchPlayers[0].totalRounds,
                currentRound: 0,
                status: 'playing',
                timer: 60
            };

            matchPlayers.forEach(p => {
                p.join(roomCode);
                p.roomCode = roomCode;
            });

            io.to(roomCode).emit('match_found', { players: rooms[roomCode].players });
            startNewRound(roomCode);
        } else {
            socket.emit('waiting_for_players', '🔍 جاري البحث عن لاعبين آخرين...');
        }
    });

    // إلغاء البحث
    socket.on('cancel_search', () => {
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
    });

    // إنشاء غرفة خاصة بكود
    socket.on('create_private_room', (totalRounds) => {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            host: socket.username,
            players: [{ socketId: socket.id, username: socket.username, score: 0, answers: {} }],
            totalRounds: parseInt(totalRounds) || 3,
            currentRound: 0,
            status: 'waiting',
            timer: 60
        };
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('private_room_created', roomCode);
    });

    // الانضمام برمز الغرفة
    socket.on('join_private_room', (roomCode) => {
        const code = roomCode.trim().toUpperCase();
        const room = rooms[code];
        if (!room) return socket.emit('error_message', '❌ الغرفة غير موجودة!');
        if (room.status !== 'waiting') return socket.emit('error_message', '⚠️ اللعبة بدأت بالفعل!');

        room.players.push({ socketId: socket.id, username: socket.username, score: 0, answers: {} });
        socket.join(code);
        socket.roomCode = code;

        io.to(code).emit('update_room_players', room.players);
    });

    // بدء الغرفة الخاصة من قبل المضيف
    socket.on('start_private_game', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        room.status = 'playing';
        startNewRound(room.code);
    });

    // استقبال إجابات اللاعبين وفحصها ذكياً
    socket.on('submit_round_answers', ({ answers }) => {
        const room = rooms[socket.roomCode];
        if (!room || room.status !== 'playing') return;

        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;

        let roundScore = 0;
        const targetLetter = room.currentLetter;

        categories.forEach(cat => {
            const word = (answers[cat] || '').trim();
            // فحص ذكي: هل الكلمة تبدأ بالحرف المطلوب وليست فارغة؟
            if (word.length > 0 && word.startsWith(targetLetter)) {
                roundScore += 10; // 10 نقاط لكل إجابة صحيحة تبدأ بالحرف
            }
        });

        player.score += roundScore;
        player.hasSubmitted = true;

        // إرسال تحديث النقاط الفوري للجميع في نفس الغرفة
        io.to(room.code).emit('live_score_update', room.players);

        // إذا أنهى الجميع إجاباتهم، ننتقل للجولة التالية أو ننهي اللعبة
        if (room.players.every(p => p.hasSubmitted)) {
            endRound(room.code);
        }
    });

    socket.on('disconnect', () => {
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
        console.log(`🔌 انقطع الاتصال: ${socket.id}`);
    });
});

function startNewRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.currentRound >= room.totalRounds) {
        // انتهت جميع الجولات -> إعلان الترتيب النهائي وفوز الأوائل
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

    // مؤقت الجولة (60 ثانية)
    room.timerInterval = setTimeout(() => {
        endRound(roomCode);
    }, 60000);
}

function endRound(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return;
    clearTimeout(room.timerInterval);

    room.status = 'round_ended';
    io.to(roomCode).emit('round_ended', { players: room.players });

    // انتظار 4 ثوانٍ ثم بدء الجولة التالية
    setTimeout(() => {
        room.status = 'playing';
        startNewRound(roomCode);
    }, 4000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل بانتظام على البورت: ${PORT}`));
