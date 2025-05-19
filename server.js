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
  console.log("클라이언트가 연결되었습니다.");

  socket.on("chat message", (msg) => {
    console.log("수신된 메시지:", msg);
    io.emit("메세지", msg);
  });

  socket.on("disconnect", () => {
    console.log("클라이언트 연결이 끊어졌습니다.");
  });
});

server.listen(PORT, () => {
  console.log(`서버가 ${PORT}번 포트에서 실행 중입니다.`);
});
