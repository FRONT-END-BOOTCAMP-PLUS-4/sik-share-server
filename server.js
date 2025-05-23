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

  // ====== 1:1 채팅 (share) ======
  socket.on("joinRoom", async ({ chatId, userId }) => {
    socket.join(chatId);
    console.log(`🟢 ${socket.id}가 1:1 방 ${chatId}에 입장 (유저: ${userId})`);

    // 안읽은 메시지 readCount 0 처리
    await prisma.shareChatMessage.updateMany({
      where: {
        shareChatId: parseInt(chatId),
        senderId: { not: userId },
        readCount: 1,
      },
      data: { readCount: 0 },
    });

    // 읽음 처리된 메시지 id만 보내줌
    const readMessages = await prisma.shareChatMessage.findMany({
      where: {
        shareChatId: parseInt(chatId),
        senderId: { not: userId },
        readCount: 0,
      },
      select: { id: true }
    });
    const readIds = readMessages.map(msg => msg.id);
    socket.emit("messagesRead", { readIds });
    console.log(`[joinRoom] 읽음처리된 메시지 IDs:`, readIds);
  });

  socket.on("chat message", async ({ chatId, senderId, content }) => {
    console.log(`✉️ [1:1] 방 ${chatId} 메시지: ${content}`);

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

    // 현재 방에 나 말고 누가 접속중이면 바로 읽음처리
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

  // ====== 단체채팅 (groupBuy) ======
  socket.on("joinGroupRoom", async ({ chatId, userId }) => {
    socket.join(chatId);
    console.log(`🟢 ${socket.id}가 단체 방 ${chatId}에 입장 (유저: ${userId})`);

    // (단체 채팅 읽음처리, 추후 구현)
    // 현재는 기본 메시지 저장만 구현
  });

  socket.on("groupbuy chat message", async ({ chatId, senderId, content }) => {
    console.log(`✉️ [단체] 방 ${chatId} 메시지: ${content}`);

    // 메시지 저장 (groupBuyChatMessage 테이블)
    let savedMessage = await prisma.groupBuyChatMessage.create({
      data: {
        senderId,
        groupBuyChatId: parseInt(chatId),
        content,
        count: 1, // 읽음(추후)
      },
      include: {
        sender: true,
      }
    });

    // (추후 읽음 처리 확장 가능)
    io.to(chatId).emit("groupbuy chat message", savedMessage);
  });

  // ====== 공통: 퇴장 ======
  socket.on("leaveRoom", (chatId) => {
    socket.leave(chatId);
    console.log(`🔴 ${socket.id}가 방 ${chatId}에서 퇴장`);
  });
});

// 서버 실행
server.listen(PORT, () => {
  console.log(`🚀 서버가 http://localhost:${PORT}에서 실행 중`);
});
