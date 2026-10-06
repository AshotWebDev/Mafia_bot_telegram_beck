require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: "https://mafia-bot-telegram-5a6g.vercel.app/"
}));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "https://mafia-bot-telegram-5a6g.vercel.app/"
  }
});

const games = new Map();

const roles = {
  DON: "don",
  MAFIA: "mafia",
  SHERIFF: "sheriff",
  CIVILIAN: "civilian"
};

function roleLabel(role) {
  return {
    don: "👑 Դոն",
    mafia: "⚫ Մաֆիա",
    sheriff: "🕵️ Շերիֆ",
    civilian: "🔴 Քաղաքացի"
  }[role];
}

function createRoom() {
  return {
    id: Math.random().toString(36).slice(2, 8).toUpperCase(),
    phase: "lobby",
    day: 0,
    players: new Map(),
    votes: new Map(),
    night: {
      mafiaTarget: null,
      sheriffTarget: null
    }
  };
}

function publicGame(game, currentUserId) {
  const current = game.players.get(String(currentUserId));

  return {
    id: game.id,
    phase: game.phase,
    day: game.day,
    me: current ? {
      id: current.id,
      name: current.name,
      alive: current.alive,
      role: current.role,
      roleLabel: roleLabel(current.role)
    } : null,
    players: [...game.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      roleLabel: game.phase === "finished" || !current || !current.alive
        ? roleLabel(p.role)
        : p.id === current.id
          ? roleLabel(p.role)
          : null
    }))
  };
}

function assignRoles(game) {
  const players = [...game.players.values()];
  if (players.length < 5) throw new Error("Առնվազն 5 խաղացող է պետք։");

  let blackCount = players.length <= 7 ? 2 :
    players.length <= 10 ? 3 :
    players.length <= 13 ? 4 :
    Math.floor(players.length / 3);

  const list = [roles.DON, roles.SHERIFF];
  for (let i = 1; i < blackCount; i++) list.push(roles.MAFIA);
  while (list.length < players.length) list.push(roles.CIVILIAN);

  list.sort(() => Math.random() - 0.5);

  players.forEach((p, i) => {
    p.role = list[i];
    p.alive = true;
  });
}

function isBlack(p) {
  return p.role === roles.DON || p.role === roles.MAFIA;
}

function winner(game) {
  const alive = [...game.players.values()].filter(p => p.alive);
  const black = alive.filter(isBlack).length;
  const red = alive.length - black;

  if (black === 0) return "red";
  if (black >= red) return "black";
  return null;
}

function broadcast(game) {
  for (const p of game.players.values()) {
    io.to(`room:${game.id}`).emit("game:update", publicGame(game, p.id));
  }
}

app.get("/api/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/api/rooms", (req, res) => {
  const game = createRoom();
  games.set(game.id, game);
  res.json({ room: game.id });
});

app.get("/api/rooms/:room", (req, res) => {
  const game = games.get(req.params.room);
  if (!game) return res.status(404).json({ error: "Room not found" });

  res.json(publicGame(game, req.query.userId));
});

io.on("connection", socket => {
  socket.on("room:join", ({ room, user }) => {
    const game = games.get(room);
    if (!game) return socket.emit("error:message", "Խաղը չի գտնվել։");

    const id = String(user.id);

    if (!game.players.has(id)) {
      game.players.set(id, {
        id,
        name: user.name || "Player",
        role: null,
        alive: true
      });
    }

    socket.join(`room:${room}`);
    broadcast(game);
  });

  socket.on("game:start", ({ room, userId }) => {
    const game = games.get(room);
    if (!game) return;

    if (game.players.size < 5) {
      return socket.emit("error:message", "Առնվազն 5 խաղացող է պետք։");
    }

    if (game.owner && game.owner !== String(userId)) {
      return socket.emit("error:message", "Միայն ստեղծողը կարող է սկսել։");
    }

    if (!game.owner) game.owner = String(userId);

    assignRoles(game);
    game.phase = "night";
    game.day = 1;
    game.night = { mafiaTarget: null, sheriffTarget: null };

    broadcast(game);
  });

  socket.on("night:action", ({ room, userId, action, targetId }) => {
    const game = games.get(room);
    if (!game || game.phase !== "night") return;

    const player = game.players.get(String(userId));
    const target = game.players.get(String(targetId));

    if (!player || !target || !player.alive) return;

    if (action === "kill" && isBlack(player)) {
      game.night.mafiaTarget = String(targetId);
    }

    if (action === "check" && player.role === roles.SHERIFF) {
      game.night.sheriffTarget = String(targetId);

      const result = isBlack(target) ? "⚫ Սև է" : "🔴 Կարմիր է";
      socket.emit("private:result", {
        type: "sheriff",
        text: `${target.name} — ${result}`
      });
    }

    // MVP: resolve after both required actions have happened.
    const alive = [...game.players.values()].filter(p => p.alive);
    const sheriff = alive.find(p => p.role === roles.SHERIFF);
    const black = alive.find(p => p.role === roles.DON || p.role === roles.MAFIA);

    if (
      game.night.mafiaTarget &&
      (!sheriff || game.night.sheriffTarget)
    ) {
      const victim = game.players.get(game.night.mafiaTarget);
      if (victim) victim.alive = false;

      const win = winner(game);
      if (win) {
        game.phase = "finished";
      } else {
        game.phase = "day";
      }

      broadcast(game);
    }
  });

  socket.on("vote:start", ({ room }) => {
    const game = games.get(room);
    if (!game) return;
    game.phase = "voting";
    game.votes.clear();
    broadcast(game);
  });

  socket.on("vote:cast", ({ room, userId, targetId }) => {
    const game = games.get(room);
    if (!game || game.phase !== "voting") return;

    const voter = game.players.get(String(userId));
    const target = game.players.get(String(targetId));

    if (!voter || !target || !voter.alive || !target.alive) return;

    game.votes.set(String(userId), String(targetId));

    const alive = [...game.players.values()].filter(p => p.alive);

    if (game.votes.size >= alive.length) {
      const counts = {};

      for (const targetId of game.votes.values()) {
        counts[targetId] = (counts[targetId] || 0) + 1;
      }

      const max = Math.max(...Object.values(counts));
      const leaders = Object.entries(counts)
        .filter(([, count]) => count === max);

      if (leaders.length === 1) {
        const eliminated = game.players.get(leaders[0][0]);
        if (eliminated) eliminated.alive = false;
      }

      const win = winner(game);

      if (win) {
        game.phase = "finished";
      } else {
        game.day++;
        game.phase = "night";
        game.night = { mafiaTarget: null, sheriffTarget: null };
      }
    }

    broadcast(game);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Mafia server running on ${PORT}`);
});
