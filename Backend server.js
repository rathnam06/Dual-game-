const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

const rooms = {};

function createRoom(gameType, creatorId) {
  const id = uuidv4().slice(0, 6).toUpperCase();
  rooms[id] = {
    id, gameType,
    players: [creatorId],
    state: null, turn: 0,
    started: false, chat: []
  };
  return rooms[id];
}

function initTTT() {
  return { board: Array(9).fill(null), winner: null, draw: false };
}

function checkTTT(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

function initC4() {
  return { board: Array(6).fill(null).map(() => Array(7).fill(null)), winner: null, draw: false };
}

function dropC4(board, col, player) {
  for (let r = 5; r >= 0; r--) {
    if (!board[r][col]) { board[r][col] = player; return r; }
  }
  return -1;
}

function checkC4(board, r, c, player) {
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  for (const [dr,dc] of dirs) {
    let count = 1;
    for (let d = 1; d < 4; d++) {
      const nr = r+dr*d, nc = c+dc*d;
      if (nr<0||nr>5||nc<0||nc>6||board[nr][nc]!==player) break;
      count++;
    }
    for (let d = 1; d < 4; d++) {
      const nr = r-dr*d, nc = c-dc*d;
      if (nr<0||nr>5||nc<0||nc>6||board[nr][nc]!==player) break;
      count++;
    }
    if (count >= 4) return true;
  }
  return false;
}

function initChess() {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  const backRow = ['R','N','B','Q','K','B','N','R'];
  for (let c = 0; c < 8; c++) {
    b[0][c] = { type: backRow[c], color: 'b' };
    b[1][c] = { type: 'P', color: 'b' };
    b[6][c] = { type: 'P', color: 'w' };
    b[7][c] = { type: backRow[c], color: 'w' };
  }
  return { board: b, winner: null, lastMove: null };
}

function initBattleship() {
  return {
    players: [
      { grid: Array(10).fill(null).map(() => Array(10).fill(0)), ships: [], ready: false, hits: 0 },
      { grid: Array(10).fill(null).map(() => Array(10).fill(0)), ships: [], ready: false, hits: 0 }
    ],
    phase: 'placement', winner: null
  };
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create_room', ({ gameType }) => {
    const room = createRoom(gameType, socket.id);
    socket.join(room.id);
    socket.emit('room_created', { roomId: room.id, playerIndex: 0 });
  });

  socket.on('join_room', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Room not found');
    if (room.players.length >= 2) return socket.emit('error', 'Room is full');
    room.players.push(socket.id);
    socket.join(roomId);

    if (room.gameType === 'ttt') room.state = initTTT();
    else if (room.gameType === 'c4') room.state = initC4();
    else if (room.gameType === 'chess') room.state = initChess();
    else if (room.gameType === 'battleship') room.state = initBattleship();

    room.started = true;
    io.to(roomId).emit('game_start', {
      roomId, gameType: room.gameType,
      state: room.state, players: room.players, turn: room.turn
    });
    socket.emit('room_joined', { roomId, playerIndex: 1 });
  });

  socket.on('ttt_move', ({ roomId, index }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;
    const pi = room.players.indexOf(socket.id);
    if (pi !== room.turn) return;
    const s = room.state;
    if (s.board[index] || s.winner) return;
    s.board[index] = pi === 0 ? 'X' : 'O';
    s.winner = checkTTT(s.board);
    s.draw = !s.winner && s.board.every(Boolean);
    room.turn = 1 - room.turn;
    io.to(roomId).emit('ttt_update', { state: s, turn: room.turn });
  });

  socket.on('c4_move', ({ roomId, col }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;
    const pi = room.players.indexOf(socket.id);
    if (pi !== room.turn) return;
    const s = room.state;
    if (s.winner) return;
    const row = dropC4(s.board, col, pi === 0 ? 'R' : 'Y');
    if (row === -1) return;
    if (checkC4(s.board, row, col, pi === 0 ? 'R' : 'Y')) {
      s.winner = pi === 0 ? 'R' : 'Y';
    }
    s.draw = !s.winner && s.board[0].every(Boolean);
    room.turn = 1 - room.turn;
    io.to(roomId).emit('c4_update', { state: s, turn: room.turn });
  });

  socket.on('chess_move', ({ roomId, from, to, promotion }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;
    const pi = room.players.indexOf(socket.id);
    if (pi !== room.turn) return;
    const s = room.state;
    const piece = s.board[from.r][from.c];
    if (!piece || piece.color !== (pi === 0 ? 'w' : 'b')) return;
    const captured = s.board[to.r][to.c];
    s.board[to.r][to.c] = promotion ? { type: promotion, color: piece.color } : piece;
    s.board[from.r][from.c] = null;
    s.lastMove = { from, to };
    if (captured && captured.type === 'K') s.winner = pi === 0 ? 'w' : 'b';
    room.turn = 1 - room.turn;
    io.to(roomId).emit('chess_update', { state: s, turn: room.turn });
  });

  socket.on('bs_place', ({ roomId, ships }) => {
    const room = rooms[roomId];
    if (!room) return;
    const pi = room.players.indexOf(socket.id);
    const s = room.state;
    s.players[pi].ships = ships;
    s.players[pi].ready = true;
    if (s.players.every(p => p.ready)) {
      s.phase = 'battle';
      io.to(roomId).emit('bs_update', {
        state: sanitizeBattleship(s, 0),
        state1: sanitizeBattleship(s, 1),
        turn: room.turn, phase: 'battle'
      });
    } else {
      socket.emit('bs_waiting');
    }
  });

  socket.on('bs_fire', ({ roomId, r, c }) => {
    const room = rooms[roomId];
    if (!room) return;
    const pi = room.players.indexOf(socket.id);
    if (pi !== room.turn) return;
    const s = room.state;
    const target = s.players[1 - pi];
    if (target.grid[r][c] !== 0) return;
    const hit = target.ships.some(ship =>
      ship.cells.some(cell => cell.r === r && cell.c === c)
    );
    target.grid[r][c] = hit ? 2 : 1;
    if (hit) target.hits++;
    const totalShipCells = target.ships.reduce((a, s) => a + s.cells.length, 0);
    if (target.hits >= totalShipCells) s.winner = pi;
    room.turn = 1 - room.turn;
    io.to(roomId).emit('bs_fire_result', {
      shooter: pi, r, c, hit,
      winner: s.winner,
      turn: room.turn,
      grid: target.grid
    });
  });

  socket.on('chat', ({ roomId, message, name }) => {
    const room = rooms[roomId];
    if (!room) return;
    const msg = { name: name || 'Player', message, time: Date.now() };
    room.chat.push(msg);
    io.to(roomId).emit('chat_message', msg);
  });

  socket.on('rematch', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.gameType === 'ttt') room.state = initTTT();
    else if (room.gameType === 'c4') room.state = initC4();
    else if (room.gameType === 'chess') room.state = initChess();
    else if (room.gameType === 'battleship') room.state = initBattleship();
    room.turn = 0;
    io.to(roomId).emit('game_start', {
      roomId, gameType: room.gameType,
      state: room.state, players: room.players, turn: room.turn
    });
  });

  socket.on('disconnect', () => {
    for (const [id, room] of Object.entries(rooms)) {
      if (room.players.includes(socket.id)) {
        io.to(id).emit('player_left');
      }
    }
  });
});

function sanitizeBattleship(s, forPlayer) {
  return {
    myGrid: s.players[forPlayer].grid,
    myShips: s.players[forPlayer].ships,
    enemyGrid: s.players[1 - forPlayer].grid,
    ready: s.players[forPlayer].ready,
    enemyReady: s.players[1 - forPlayer].ready
  };
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Game server running on port ${PORT}`));
