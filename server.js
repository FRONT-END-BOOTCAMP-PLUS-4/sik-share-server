const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("🔌 클라이언트가 연결되었습니다.");

  socket.on("joinRoom", (chatId) => {
    socket.join(chatId);
    console.log(`🟢 ${socket.id}가 방 ${chatId}에 입장`);
  });

  socket.on("message", ({ chatId, ...message }) => {
    console.log(`📨 방 ${chatId}로부터 메시지 수신:`, message);

    io.to(chatId).emit("message", message);
  });

  socket.on("leaveRoom", (chatId) => {
    socket.leave(chatId);
    console.log(`🔴 ${socket.id}가 방 ${chatId}에서 퇴장`);
  });

  socket.on("disconnect", () => {
    console.log("❌ 클라이언트 연결 해제");
  });
});

server.listen(PORT, () => {
  console.log(`🚀 서버가 ${PORT}번 포트에서 실행 중입니다.`);
});
