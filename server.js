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
let unoQueue = [];
const rooms = {};

io.on('connection', (socket) => {
    console.log(`🔌 متصل جديد: ${socket.id}`);

    socket.on('register_user', ({ identifier, password, username }) => {
        if (!identifier || !password || !username) return socket.emit('auth_error', 'يرجى إكمال جميع الحقول');
        if (usersMemoryDB.find(u => u.identifier === identifier)) {
            return socket.emit('auth_error', 'الحساب مسجل مسبقاً!');
        }
        const newUser = { identifier, password, username, cash: 15, score: 2414 };
        usersMemoryDB.push(newUser);
        socket.username = username;
        socket.emit('auth_success', newUser);
    });

    socket.on('login_user', ({ identifier, password }) => {
        const user = usersMemoryDB.find(u => u.identifier === identifier && u.password === password);
        if (!user) return socket.emit('auth_error', 'بيانات الدخول غير صحيحة!');
        socket.username = user.username;
        socket.emit('auth_success', user);
    });

    socket.on('guest_login', () => {
        socket.username = `ضيف_${Math.floor(1000 + Math.random() * 9000)}`;
        socket.emit('auth_success', { username: socket.username, cash: 15, score: 100 });
    });

    // --- نظام إنسان حيوان نبات (جماعي + بوتات + غرف) ---
    socket.on('start_matchmaking', () => {
        matchmakingQueue.push(socket);
        broadcastQueueCount();

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

    function broadcastQueueCount() {
        matchmakingQueue.forEach(p => p.emit('queue_update', { count: matchmakingQueue.length, max: 5 }));
    }

    function createRoomWithBots(socket) {
        const roomCode = 'BOT_' + Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            players: [
                { socketId: socket.id, username: socket.username, score: 0, answers: {}, votes: {} },
                { socketId: 'b1', username: 'Ryan', score: 15, answers: { 'إنسان': 'أحمد', 'حيوان': 'أسد', 'نبات': 'أناناس', 'جماد': 'إبريق', 'بلاد': 'أردن' } },
                { socketId: 'b2', username: 'زيزو', score: 17, answers: { 'إنسان': 'أمين', 'حيوان': 'أرنب', 'نبات': 'أرز', 'جماد': 'إبرة', 'بلاد': 'إسبانيا' } }
            ],
            currentRound: 1,
            totalRounds: 3
        };
        socket.join(roomCode);
        socket.roomCode = roomCode;
        io.to(roomCode).emit('match_started', rooms[roomCode].players);
        startRound(roomCode);
    }

    function setupRoomForGroup(group) {
        group.forEach(p => clearTimeout(p.matchTimer));
        const roomCode = 'GRP_' + Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            players: group.map(p => ({ socketId: p.id, username: p.username, score: 0, answers: {}, votes: {} })),
            currentRound: 1,
            totalRounds: 3
        };
        group.forEach(p => { p.join(roomCode); p.roomCode = roomCode; });
        io.to(roomCode).emit('match_started', rooms[roomCode].players);
        startRound(roomCode);
    }

    // --- نظام الأونو الجماعي والغرف ---
    socket.on('uno_matchmaking', () => {
        unoQueue.push(socket);
        socket.unoTimer = setTimeout(() => {
            const index = unoQueue.indexOf(socket);
            if(index !== -1) {
                unoQueue.splice(index, 1);
                socket.emit('uno_start_game', { isBotGame: true, players: [socket.username, 'روبوت 1', 'روبوت 2'] });
            }
        }, 8000);

        if(unoQueue.length >= 3) {
            const group = unoQueue.splice(0, 3);
            group.forEach(p => clearTimeout(p.unoTimer));
            const playerNames = group.map(p => p.username);
            group.forEach(p => p.emit('uno_start_game', { isBotGame: false, players: playerNames }));
        }
    });

    socket.on('create_private_room', () => {
        const roomCode = 'PRIV_' + Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = { code: roomCode, host: socket.username, players: [socket.username], max: 7 };
        socket.join(roomCode);
        socket.emit('private_room_created', roomCode);
    });

    socket.on('join_private_room', (code) => {
        const room = rooms[code.trim().toUpperCase()];
        if (!room) return socket.emit('error_msg', 'الغرفة غير موجودة');
        room.players.push(socket.username);
        socket.join(room.code);
        io.to(room.code).emit('update_room_players', room.players);
    });

    socket.on('disconnect', () => {
        matchmakingQueue = matchmakingQueue.filter(p => p.id !== socket.id);
        unoQueue = unoQueue.filter(p => p.id !== socket.id);
        broadcastQueueCount();
    });
});

function startRound(roomCode) {
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
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل على البورت: ${PORT}`));
