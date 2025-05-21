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

    await prisma.shareChatMessage.updateMany({
      where: {
        shareChatId: parseInt(chatId),
        senderId: { not: userId },
        readCount: 1,
      },
      data: {
        readCount: { decrement: 1 }
      },
    });
  }); 

  socket.on("chat message", async ({ chatId, senderId, content }) => {
    console.log(`✉️ 방 ${chatId} 메시지 수신: ${content}`);

    const savedMessage = await prisma.shareChatMessage.create({
      data: {
        senderId,
        shareChatId: parseInt(chatId),
        content,
      },
      include: {
        sender: true,
      }
    });

    console.log(
      `[emit] 방 ${chatId}에 메시지 발송:`,
      JSON.stringify(savedMessage, null, 2)
    );
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
