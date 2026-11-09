const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const usersMemoryDB = [];
const arabicLetters = ['أ', 'ب', 'ت', 'ج', 'ح', 'خ', 'د', 'ر', 'س', 'ش', 'ص', 'ط', 'ع', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'هـ', 'و', 'ي'];
const categories = ['إنسان', 'حيوان', 'نبات', 'جماد', 'بلاد'];

let matchmakingQueue = [];
const rooms = {};

io.on('connection', (socket) => {
    console.log(`🔌 انضم مستخدم: ${socket.id}`);

    socket.on('auth_user', ({ identifier, password, username }) => {
        if (!identifier || !password) {
            return socket.emit('auth_error', 'يرجى إدخال البريد أو الجوال وكلمة المرور');
        }
        let user = usersMemoryDB.find(u => u.identifier === identifier);
        if (!user) {
            user = { identifier, password, username: username || 'لاعب جديد', cash: 15, score: 2414 };
            usersMemoryDB.push(user);
        } else if (user.password !== password) {
            return socket.emit('auth_error', 'كلمة المرور غير صحيحة!');
        }
        socket.username = user.username;
        socket.emit('auth_success', user);
    });

    socket.on('guest_login', () => {
        socket.username = `ضيف_${Math.floor(1000 + Math.random() * 9000)}`;
        socket.emit('auth_success', { username: socket.username, cash: 15, score: 100 });
    });

    socket.on('claim_daily', () => {
        socket.emit('daily_result', { success: true, cash: 25, msg: '🎉 حصلت على 10 كاش مكافأة يومية!' });
    });

    // زر "لعب": البحث بحد أقصى 5 لاعبين أو الدخول مع بوتات بعد 10 ثوانٍ
    socket.on('start_matchmaking', () => {
        matchmakingQueue.push(socket);

        socket.matchTimer = setTimeout(() => {
            const index = matchmakingQueue.indexOf(socket);
            if (index !== -1) {
                matchmakingQueue.splice(index, 1);
                createRoomWithBots(socket);
            }
        }, 10000);

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

    // زر "خاص": إنشاء غرفة خاصة حتى 7 لاعبين
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

    // الفحص الفوري للإجابة بزر الصح بجانب الخانة
    socket.on('verify_answer_box', ({ category, word, letter }) => {
        const clean = (word || '').trim();
        const isValid = clean.length >= 2 && clean.startsWith(letter);
        socket.emit('answer_box_result', { category, isValid });
    });

    socket.on('send_chat', (msg) => {
        if (!socket.roomCode || !rooms[socket.roomCode]) return;
        io.to(socket.roomCode).emit('new_chat', { username: socket.username, msg });
    });

    socket.on('disconnect', () => {
        if (socket.matchTimer) clearTimeout(socket.matchTimer);
        matchmakingQueue = matchmakingQueue.filter(p => p.id !== socket.id);
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
