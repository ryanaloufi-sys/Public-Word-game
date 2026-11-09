const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// بنك الأسئلة والمقارنات الشائعة (على طراز جوابك جوابهم)
const gameQuestionsBank = [
    {
        question: "شيء نفعله كل صباح قبل الذهاب للعمل أو المدرسة؟",
        answers: [
            { text: "شرب القهوة", points: 40 },
            { text: "الإفطار", points: 30 },
            { text: "تفريش الأسنان", points: 20 },
            { text: "الاستحمام", points: 10 }
        ]
    },
    {
        question: "فاكهة حمراء اللون ومحبوبة للجميع؟",
        answers: [
            { text: "التفاح", points: 45 },
            { text: "الفراولة", points: 30 },
            { text: "البطيخ", points: 15 },
            { text: "الرمان", points: 10 }
        ]
    },
    {
        question: "مكان يذهب إليه الناس في الإجازة الأسبوعية؟",
        answers: [
            { text: "المول", points: 35 },
            { text: "البحر", points: 30 },
            { text: "الحديقة", points: 20 },
            { text: "المطعم", points: 15 }
        ]
    }
];

const rooms = {};

io.on('connection', (socket) => {
    console.log(`🔌 انضم مستخدم جديد: ${socket.id}`);

    // دخول مباشر بالاسم بدون تسجيل تعقيدي
    socket.on('direct_join', (username) => {
        const cleanName = username ? username.trim() : `لاعب_${Math.floor(1000 + Math.random() * 9000)}`;
        socket.username = cleanName;
        socket.emit('join_success', { username: cleanName, score: 0 });
    });

    // إنشاء غرفة جديدة
    socket.on('create_room', () => {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            host: socket.username,
            players: [{ username: socket.username, score: 0, socketId: socket.id }],
            status: 'waiting',
            currentQuestionIndex: 0
        };
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('room_created', roomCode);
    });

    // الانضمام لغرفة صديق
    socket.on('join_room', (roomCode) => {
        const code = roomCode.trim().toUpperCase();
        const room = rooms[code];
        if (!room) return socket.emit('error_message', '❌ الغرفة غير موجودة!');
        if (room.status !== 'waiting') return socket.emit('error_message', '⚠️ اللعبة بدأت بالفعل!');

        room.players.push({ username: socket.username, score: 0, socketId: socket.id });
        socket.join(code);
        socket.roomCode = code;

        io.to(code).emit('update_room_players', room.players);
    });

    // بدء اللعبة
    socket.on('start_game', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        room.status = 'playing';
        sendNextQuestion(room);
    });

    // اللعب الفردي ضد البوت
    socket.on('start_solo_bot', () => {
        const roomCode = 'SOLO_' + Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            isSolo: true,
            players: [
                { username: socket.username, score: 0, socketId: socket.id },
                { username: '🤖 بوت جوابك جوابهم', score: 0, isBot: true }
            ],
            status: 'playing',
            currentQuestionIndex: 0
        };
        socket.join(roomCode);
        socket.roomCode = roomCode;
        sendNextQuestion(rooms[roomCode]);
    });

    // فحص الإجابة فورياً وإرسال النتيجة (صح/خطأ) للطراز الفوري
    socket.on('check_instant_answer', (answerText) => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        const currentQ = gameQuestionsBank[room.currentQuestionIndex - 1];
        if (!currentQ) return;

        const matched = currentQ.answers.find(a => a.text.toLowerCase().includes(answerText.toLowerCase().trim()));

        if (matched) {
            const player = room.players.find(p => p.socketId === socket.id || p.username === socket.username);
            if (player) player.score += matched.points;

            socket.emit('answer_check_result', { 
                isCorrect: true, 
                text: matched.text, 
                points: matched.points,
                updatedPlayers: room.players 
            });
        } else {
            socket.emit('answer_check_result', { isCorrect: false });
        }
    });

    socket.on('disconnect', () => {
        console.log(`🔌 انقطع الاتصال: ${socket.id}`);
    });
});

function sendNextQuestion(room) {
    if (room.currentQuestionIndex >= gameQuestionsBank.length) {
        io.to(room.code).emit('game_over', { players: room.players });
        return;
    }
    const q = gameQuestionsBank[room.currentQuestionIndex];
    io.to(room.code).emit('new_question', {
        question: q.question,
        questionNum: room.currentQuestionIndex + 1,
        total: gameQuestionsBank.length
    });
    room.currentQuestionIndex++;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل على البورت: ${PORT}`));
