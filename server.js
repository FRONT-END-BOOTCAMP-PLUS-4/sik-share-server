const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");
const cors = require("cors");

const prisma = new PrismaClient();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("📡 클라이언트 연결됨");

  // ✅ joinRoom: chatId, userId 같이 받음!
  socket.on("joinRoom", async ({ chatId, userId }) => {
    socket.join(chatId);
    console.log(`🟢 ${socket.id}가 방 ${chatId}에 입장 (유저: ${userId})`);

    // 입장 시, 기존 안읽은 메시지 readCount를 0으로!
    const updateResult = await prisma.shareChatMessage.updateMany({
      where: {
        shareChatId: parseInt(chatId),
        senderId: { not: userId },
        readCount: 1,
      },
      data: {
        readCount: 0,
      },
    });
    console.log(`[joinRoom] readCount 업데이트 개수:`, updateResult.count);
  });

  // ✅ 메시지 수신 및 실시간 읽음처리
  socket.on("chat message", async ({ chatId, senderId, content }) => {
    console.log(`✉️ 방 ${chatId} 메시지 수신: ${content}`);

    // 메시지 저장
    let savedMessage = await prisma.shareChatMessage.create({
      data: {
        senderId,
        shareChatId: parseInt(chatId),
        content,
        readCount: 1, // 1: 안읽음
      },
      include: {
        sender: true,
      }
    });

    const socketsInRoom = await io.in(chatId).fetchSockets();

    const isOtherUserInRoom = socketsInRoom.some(s => s.id !== socket.id);
    if (isOtherUserInRoom) {
      await prisma.shareChatMessage.update({
        where: { id: savedMessage.id },
        data: { readCount: 0 }
      });
      savedMessage.readCount = 0;
    }

    io.to(chatId).emit("chat message", savedMessage);
  });

  socket.on("leaveRoom", (chatId) => {
    socket.leave(chatId);
    console.log(`🔴 ${socket.id}가 방 ${chatId}에서 퇴장`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 서버가 http://localhost:${PORT}에서 실행 중`);
});
