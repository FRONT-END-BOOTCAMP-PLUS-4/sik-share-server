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
    methods: ["GET", "POST"],
  },
});

// 소켓ID ↔ 유저ID 매핑 (in-memory, 재시작시 초기화됨)
const socketUserMap = {};
const userSocketMap = {};

io.on("connection", (socket) => {
  console.log("📡 클라이언트 연결됨");

  // ✅ 1. 채팅 목록 구독
  socket.on("subscribeChatList", ({ userId }) => {
    socket.join("chatList:" + userId);
    socketUserMap[socket.id] = userId;
    userSocketMap[userId] = socket.id;
    console.log(`🟢 ${socket.id}가 chatList:${userId} 구독`);
  });
  // (선택) 구독 해제
  socket.on("unsubscribeChatList", ({ userId }) => {
    socket.leave("chatList:" + userId);
  });

  // ====== 1:1 채팅 (share) ======
  socket.on("joinRoom", async ({ chatId, userId }) => {
    socket.join(chatId);
    socketUserMap[socket.id] = userId;
    userSocketMap[userId] = socket.id;
    console.log(`🟢 ${socket.id}가 1:1 방 ${chatId}에 입장 (유저: ${userId})`);

    // 내가 읽지 않은 메시지 조회
    const unreadMessages = await prisma.shareChatMessage.findMany({
      where: {
        shareChatId: parseInt(chatId),
        senderId: { not: userId },
        ShareChatMessageRead: { none: { userId } },
      },
      select: { id: true }
    });

    // 해당 메시지 읽음 row 생성
    await Promise.all(
      unreadMessages.map((msg) =>
        prisma.shareChatMessageRead
          .create({
            data: { messageId: msg.id, userId },
          })
          .catch(() => {}) // 중복 row 에러 무시
      )
    );

    // 🔥 unreadMessages의 id 목록을 받아 readCount = 0으로 일괄 업데이트
    const unreadIds = unreadMessages.map((msg) => msg.id);
    if (unreadIds.length > 0) {
      await prisma.shareChatMessage.updateMany({
        where: { id: { in: unreadIds } },
        data: { readCount: 0 },
      });
    }

    // 읽음 처리된 메시지 id만 해당 방 모두에게 emit
    io.to(chatId).emit("messagesRead", { readIds: unreadIds });
    console.log(`[joinRoom] 읽음처리된 메시지 IDs:`, unreadIds);

    // ✅ 목록방에 있는 상대방에게 실시간 안읽음 개수 0으로 전파
    const chat = await prisma.shareChat.findUnique({
      where: { id: parseInt(chatId) },
      include: { participants: true },
    });
    const other = chat.participants.find((p) => p.userId !== userId);
    if (other) {
      io.to("chatList:" + other.userId).emit("chatListUpdate", {
        chatId: Number(chatId),
        unreadCount: 0,
      });
    }
  });

  socket.on("chat message", async ({ chatId, senderId, content }) => {
    console.log(`✉️ [1:1] 방 ${chatId} 메시지: ${content}`);

    // 메시지 저장
    let savedMessage = await prisma.shareChatMessage.create({
      data: {
        senderId,
        shareChatId: parseInt(chatId),
        content,
      },
      include: {
        sender: true,
      },
    });

    // 상대방이 방에 접속 중이면 바로 읽음 처리
    const socketsInRoom = await io.in(chatId).fetchSockets();
    // 내 socket을 제외한 다른 사람의 userId 찾기
    const otherUserId = socketsInRoom
      .map((s) => socketUserMap[s.id])
      .find((id) => id && id !== senderId);

    if (otherUserId) {
      // 읽음 row 생성 (중복 에러 무시)
      await prisma.shareChatMessageRead
        .create({
          data: { messageId: savedMessage.id, userId: otherUserId },
        })
        .catch(() => {});
      // 바로 DB readCount도 0으로 변경 (실시간 반영)
      await prisma.shareChatMessage.update({
        where: { id: savedMessage.id },
        data: { readCount: 0 },
      });
      savedMessage.readCount = 0;
    }

    io.to(chatId).emit("chat message", savedMessage);

    // ✅ 목록방에 있는 상대방에게 실시간 안읽음 개수, 마지막 메시지 등 전파
    const chat = await prisma.shareChat.findUnique({
      where: { id: parseInt(chatId) },
      include: { participants: true },
    });
    const other = chat.participants.find((p) => p.userId !== senderId);
    if (other) {
      // 상대방의 unreadCount(실제 개수)를 다시 조회
      const unreadCount = await prisma.shareChatMessage.count({
        where: {
          shareChatId: parseInt(chatId),
          senderId: { not: other.userId },
          readCount: 1,
        },
      });
      io.to("chatList:" + other.userId).emit("chatListUpdate", {
        chatId: Number(chatId),
        unreadCount,
        lastMessage: savedMessage.content,
        lastMessageAt: savedMessage.createdAt,
      });
    }
  });

  // ====== 단체채팅 (groupBuy) ======
  socket.on("joinGroupRoom", async ({ chatId, userId }) => {
    socket.join(chatId);
    socketUserMap[socket.id] = userId;
    userSocketMap[userId] = socket.id;
    console.log(`🟢 ${socket.id}가 단체 방 ${chatId}에 입장 (유저: ${userId})`);
    // (단체 채팅 읽음처리, 추후 구현)
  });

  socket.on("groupbuy chat message", async ({ chatId, senderId, content }) => {
    console.log(`✉️ [단체] 방 ${chatId} 메시지: ${content}`);

    // 메시지 저장 (groupBuyChatMessage 테이블)
    let savedMessage = await prisma.groupBuyChatMessage.create({
      data: {
        senderId,
        groupBuyChatId: parseInt(chatId),
        content,
        count: 1,
      },
      include: {
        sender: true,
      },
    });

    // (추후 읽음 처리 확장 가능)
    io.to(chatId).emit("groupbuy chat message", savedMessage);
  });

  // ====== 공통: 퇴장 ======
  socket.on("leaveRoom", (chatId) => {
    socket.leave(chatId);
    const userId = socketUserMap[socket.id];
    if (userId) {
      delete userSocketMap[userId];
      delete socketUserMap[socket.id];
    }
    console.log(`🔴 ${socket.id}가 방 ${chatId}에서 퇴장`);
  });

  socket.on("disconnect", () => {
    const userId = socketUserMap[socket.id];
    if (userId) {
      delete userSocketMap[userId];
      delete socketUserMap[socket.id];
    }
    console.log(`🔌 ${socket.id} 연결 해제`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 서버가 http://localhost:${PORT}에서 실행 중`);
});
