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

let matchmakingQueue = [];
const rooms = {};

io.on('connection', (socket) => {
    console.log(`🔌 متصل جديد: ${socket.id}`);

    socket.on('guest_login', () => {
        socket.username = `لاعب_${Math.floor(1000 + Math.random() * 9000)}`;
        socket.emit('auth_success', { username: socket.username, cash: 15, score: 100 });
    });

    // دخول صفحة الانتظار وتحديث العداد الحقيقي (X/5)
    socket.on('start_matchmaking', () => {
        matchmakingQueue.push(socket);
        
        // بث التحديث للجميع بداخل طابور الانتظار
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
                { socketId: socket.id, username: socket.username, score: 0, answers: {}, votes: {} },
                { socketId: 'b1', username: 'Ryan', score: 15, answers: { 'إنسان': 'أحمد', 'حيوان': 'أسد', 'نبات': 'أناناس', 'جماد': 'إبريق', 'بلاد': 'أردن' } },
                { socketId: 'b2', username: 'زيزو', score: 17, answers: { 'إنسان': 'أمين', 'حيوان': 'أرنب', 'نبات': 'أرز', 'جماد': 'إبرة', 'بلاد': 'إسبانيا' } },
                { socketId: 'b3', username: 'BBB', score: 12, answers: { 'إنسان': 'أنس', 'حيوان': 'أيل', 'نبات': 'أفوجادو', 'جماد': 'إسفنج', 'بلاد': 'ألمانيا' } },
                { socketId: 'b4', username: 'محمد', score: 12, answers: { 'إنسان': 'أسامة', 'حيوان': 'أفعى', 'نبات': 'إجاص', 'جماد': 'إسوارة', 'بلاد': 'إيطاليا' } }
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

    // تسليم الإجابات والانتقال لشاشة التصحيح الجماعي
    socket.on('submit_answers', (answers) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
            player.answers = answers;
            player.submitted = true;
        }

        // إذا سلم الجميع، أو انتهت الدقيقة، ننتقل لشاشة التصحيح
        socket.emit('wait_for_review', 'بانتظار مراجعة وتصحيح اللاعبين للإجابات...');
        io.to(room.code).emit('open_review_phase', room.players);
    });

    // استقبال تصويت لاعب على إجابة لاعب آخر
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

    // إنهاء مرحلة التقييم وحساب النقاط بناء على التصويت (10، 5، 0)
    socket.on('finish_review_phase', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.calculated) return;
        room.calculated = true;

        room.players.forEach(p => {
            let roundPoints = 0;
            categories.forEach(cat => {
                const v = (p.votes && p.votes[cat]) ? p.votes[cat] : { yes: 2, no: 0 }; // افتراضي للبوتات
                if (v.yes >= 2) roundPoints += 10;
                else if (v.yes === 1 && v.no === 1) roundPoints += 5;
                else roundPoints += 0;
            });
            p.score += roundPoints;
        });

        io.to(room.code).emit('round_score_summary', room.players);
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
