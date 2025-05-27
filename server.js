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

const socketUserMap = {};
const userSocketMap = {};

io.on("connection", (socket) => {
  console.log("📡 클라이언트 연결됨");

  // ✅ 1. 채팅 목록 구독/해제
  socket.on("subscribeChatList", ({ userId }) => {
    socket.join("chatList:" + userId);
    socketUserMap[socket.id] = userId;
    userSocketMap[userId] = socket.id;
    console.log(`🟢 ${socket.id}가 chatList:${userId} 구독`);
  });
  socket.on("unsubscribeChatList", ({ userId }) => {
    socket.leave("chatList:" + userId);
  });

  // ====== 1:1 채팅 (share) ======
  socket.on("joinRoom", async ({ chatId, userId }) => {
    socket.join(chatId);
    socketUserMap[socket.id] = userId;
    userSocketMap[userId] = socket.id;
    console.log(`🟢 ${socket.id}가 1:1 방 ${chatId}에 입장 (유저: ${userId})`);

    const unreadMessages = await prisma.shareChatMessage.findMany({
      where: {
        shareChatId: parseInt(chatId),
        senderId: { not: userId },
        ShareChatMessageRead: { none: { userId } },
      },
      select: { id: true },
    });
    await Promise.all(
      unreadMessages.map((msg) =>
        prisma.shareChatMessageRead
          .create({ data: { messageId: msg.id, userId } })
          .catch(() => {})
      )
    );
    const unreadIds = unreadMessages.map((msg) => msg.id);
    if (unreadIds.length > 0) {
      await prisma.shareChatMessage.updateMany({
        where: { id: { in: unreadIds } },
        data: { readCount: 0 },
      });
    }
    io.to(chatId).emit("messagesRead", { readIds: unreadIds });
    console.log(`[joinRoom] 읽음처리된 메시지 IDs:`, unreadIds);

    const chat = await prisma.shareChat.findUnique({
      where: { id: parseInt(chatId) },
      include: { participants: true },
    });
    const other = chat.participants.find((p) => p.userId !== userId);
    if (other) {
      io.to("chatList:" + other.userId).emit("chatListUpdate", {
        chatId: Number(chatId),
        unreadCount: 0,
        type: "share",
      });
    }
  });

  socket.on("chat message", async ({ chatId, senderId, content }) => {
    console.log(`✉️ [1:1] 방 ${chatId} 메시지: ${content}`);

    let savedMessage = await prisma.shareChatMessage.create({
      data: {
        senderId,
        shareChatId: parseInt(chatId),
        content,
        count: 1,
      },
      include: { sender: true },
    });

    const socketsInRoom = await io.in(chatId).fetchSockets();
    const otherUserId = socketsInRoom
      .map((s) => socketUserMap[s.id])
      .find((id) => id && id !== senderId);

    if (otherUserId) {
      await prisma.shareChatMessageRead
        .create({ data: { messageId: savedMessage.id, userId: otherUserId } })
        .catch(() => {});
      await prisma.shareChatMessage.update({
        where: { id: savedMessage.id },
        data: { readCount: 0 },
      });
      savedMessage.readCount = 0;
    }
    io.to(chatId).emit("groupbuy chat message", { ...savedMessage, count: 1 });

    // 목록방에 있는 상대방에게 실시간 안읽음 개수, 마지막 메시지 등 전파
    const chat = await prisma.shareChat.findUnique({
      where: { id: parseInt(chatId) },
      include: { participants: true },
    });
    const other = chat.participants.find((p) => p.userId !== senderId);
    if (other) {
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
        type: "share",
      });
    }
  });

  // ====== 단체채팅 (groupBuy) ======
  socket.on("joinGroupRoom", async ({ chatId, userId }) => {
    socket.join(chatId);
    socketUserMap[socket.id] = userId;
    userSocketMap[userId] = socket.id;
    console.log(`🟢 ${socket.id}가 단체 방 ${chatId}에 입장 (유저: ${userId})`);

    // 1. 내가 안읽은 메시지들 찾기
    const unreadMessages = await prisma.groupBuyChatMessage.findMany({
      where: {
        groupBuyChatId: parseInt(chatId),
        senderId: { not: userId },
        GroupBuyChatMessageRead: { none: { userId } },
      },
      select: { id: true },
    });

    // 2. 읽음 처리 + count -1
    await Promise.all(
      unreadMessages.map(async (msg) => {
        await prisma.groupBuyChatMessageRead
          .create({ data: { messageId: msg.id, userId } })
          .catch(() => {});
        await prisma.groupBuyChatMessage.update({
          where: { id: msg.id },
          data: { count: { decrement: 1 } }, // 💙 count -1
        });
      })
    );
    const unreadIds = unreadMessages.map((msg) => msg.id);

    // 3. 읽음 처리된 메시지 id를 방 내 유저들에게 알림
    io.to(chatId).emit("messagesRead", { readIds: unreadIds });

    // 4. 목록방에 있는 다른 참여자들에게 unreadCount=0 등 알림
    const groupChat = await prisma.groupBuyChat.findUnique({
      where: { id: parseInt(chatId) },
      include: { participants: true },
    });
    for (const participant of groupChat.participants) {
      if (participant.userId !== userId) {
        io.to("chatList:" + participant.userId).emit("groupBuyChatListUpdate", {
          chatId: Number(chatId),
          unreadCount: 0,
          type: "together",
        });
      }
    }
  });

  socket.on("groupbuy chat message", async ({ chatId, senderId, content }) => {
    console.log(`✉️ [단체] 방 ${chatId} 메시지: ${content}`);

    // 참여자 수 구해서 count 초기값 설정 (본인 제외)
    const groupChat = await prisma.groupBuyChat.findUnique({
      where: { id: parseInt(chatId) },
      include: { participants: true },
    });
    const memberCount = groupChat.participants.length;
    const initialCount = Math.max(0, memberCount - 1);

    // 메시지 저장: count = 참여자수 - 1
    let savedMessage = await prisma.groupBuyChatMessage.create({
      data: {
        senderId,
        groupBuyChatId: parseInt(chatId),
        content,
        count: initialCount,
      },
      include: { sender: true },
    });

    io.to(chatId).emit("groupbuy chat message", savedMessage);

    // ✅ 모든 참여자에게 목록 갱신 emit (lastMessage, unreadCount 등)
    for (const participant of groupChat.participants) {
      // 해당 유저의 안읽음 개수
      const unreadCount = await prisma.groupBuyChatMessage.count({
        where: {
          groupBuyChatId: parseInt(chatId),
          senderId: { not: participant.userId },
          GroupBuyChatMessageRead: { none: { userId: participant.userId } },
        },
      });
      io.to("chatList:" + participant.userId).emit("groupBuyChatListUpdate", {
        chatId: Number(chatId),
        unreadCount,
        lastMessage: savedMessage.content,
        lastMessageAt: savedMessage.createdAt,
        type: "together",
        count: initialCount, // 💙 프론트에서 쓸 경우 count도 전달
      });
    }
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
