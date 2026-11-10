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
    console.log(`🔌 اتصال جديد: ${socket.id}`);

    socket.on('register_user', ({ identifier, password, username }) => {
        if (!identifier || !password || !username) return socket.emit('auth_error', 'يرجى إكمال جميع الحقول');
        if (usersMemoryDB.find(u => u.identifier === identifier)) {
            return socket.emit('auth_error', 'الحساب مسجل مسبقاً، سجل دخولك!');
        }
        const newUser = { identifier, password, username, cash: 15, score: 2414 };
        usersMemoryDB.push(newUser);
        socket.username = username;
        socket.emit('auth_success', newUser);
    });

    socket.on('login_user', ({ identifier, password }) => {
        if (!identifier || !password) return socket.emit('auth_error', 'أدخل بيانات الدخول كاملة');
        const user = usersMemoryDB.find(u => u.identifier === identifier && u.password === password);
        if (!user) return socket.emit('auth_error', 'بيانات الدخول غير صحيحة!');
        socket.username = user.username;
        socket.emit('auth_success', user);
    });

    socket.on('guest_login', () => {
        socket.username = `ضيف_${Math.floor(1000 + Math.random() * 9000)}`;
        socket.emit('auth_success', { username: socket.username, cash: 15, score: 100 });
    });

    // البحث السريع بحد أقصى 5 لاعبين والعداد التنازلي
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
        const count = matchmakingQueue.length;
        matchmakingQueue.forEach(p => {
            p.emit('queue_update', { count, max: 5 });
        });
    }

    function createRoomWithBots(socket) {
        const roomCode = 'BOT_' + Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            players: [
                { socketId: socket.id, username: socket.username, score: 0, answers: {}, votes: {}, isBot: false },
                { socketId: 'b1', username: 'Ryan', score: 15, answers: { 'إنسان': 'أحمد', 'حيوان': 'أسد', 'نبات': 'أناناس', 'جماد': 'إبريق', 'بلاد': 'أردن' }, isBot: true },
                { socketId: 'b2', username: 'زيزو', score: 17, answers: { 'إنسان': 'أمين', 'حيوان': 'أرنب', 'نبات': 'أرز', 'جماد': 'إبرة', 'بلاد': 'إسبانيا' }, isBot: true },
                { socketId: 'b3', username: 'BBB', score: 12, answers: { 'إنسان': 'أنس', 'حيوان': 'أيل', 'نبات': 'أفوجادو', 'جماد': 'إسفنج', 'بلاد': 'ألمانيا' }, isBot: true },
                { socketId: 'b4', username: 'محمد', score: 12, answers: { 'إنسان': 'أسامة', 'حيوان': 'أفعى', 'نبات': 'إجاص', 'جماد': 'إسوارة', 'بلاد': 'إيطاليا' }, isBot: true }
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
            players: group.map(p => ({ socketId: p.id, username: p.username, score: 0, answers: {}, votes: {}, isBot: false })),
            currentRound: 1,
            totalRounds: 3
        };
        group.forEach(p => { p.join(roomCode); p.roomCode = roomCode; });
        io.to(roomCode).emit('match_started', rooms[roomCode].players);
        startRound(roomCode);
    }

    // إنشاء غرفة خاصة (حتى 7 لاعبين)
    socket.on('create_private_room', () => {
        const roomCode = 'PRIV_' + Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomCode] = {
            code: roomCode,
            host: socket.username,
            players: [{ socketId: socket.id, username: socket.username, score: 0, answers: {}, votes: {}, isBot: false }],
            maxPlayers: 7
        };
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('private_room_created', roomCode);
    });

    socket.on('join_private_room', (code) => {
        const room = rooms[code.trim().toUpperCase()];
        if (!room) return socket.emit('error_msg', 'الغرفة غير موجودة');
        if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', 'الغرفة ممتلئة (الحد الأقصى 7)');
        
        room.players.push({ socketId: socket.id, username: socket.username, score: 0, answers: {}, votes: {}, isBot: false });
        socket.join(room.code);
        socket.roomCode = room.code;
        io.to(room.code).emit('update_room_players', room.players);
    });

    // تسليم الإجابات والانتقال لشاشة التصحيح الجماعي
    socket.on('submit_answers', (answers) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
            player.answers = answers;
            player.submitted = true;
        }
        io.to(room.code).emit('open_review_phase', room.players);
    });

    // استقبال تصويت اللاعبين
    socket.on('vote_answer', ({ targetSocketId, category, isApproved }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const target = room.players.find(p => p.socketId === targetSocketId);
        if (target) {
            if (!target.votes) target.votes = {};
            if (!target.votes[category]) target.votes[category] = { yes: 0, no: 0 };
            if (isApproved) target.votes[category].yes++;
            else target.votes[category].no++;
        }
    });

    // حساب النقاط واعتماد النتيجة وانتقال للجولة التالية
    socket.on('finish_review_phase', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.calculated) return;
        room.calculated = true;

        room.players.forEach(p => {
            let roundPoints = 0;
            categories.forEach(cat => {
                const v = (p.votes && p.votes[cat]) ? p.votes[cat] : { yes: 2, no: 0 };
                if (v.yes >= 2) roundPoints += 10;
                else if (v.yes === 1 && v.no === 1) roundPoints += 5;
                else roundPoints += 0;
            });
            p.score += roundPoints;
        });

        room.currentRound++;
        if (room.currentRound > room.totalRounds) {
            room.players.sort((a,b) => b.score - a.score);
            io.to(room.code).emit('game_over', room.players);
            delete rooms[room.code];
        } else {
            startRound(room.code);
        }
    });

    socket.on('disconnect', () => {
        matchmakingQueue = matchmakingQueue.filter(p => p.id !== socket.id);
        broadcastQueueCount();
    });
});

function startRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    room.calculated = false;
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
