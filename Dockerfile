FROM node:18

WORKDIR /app

# 1. 의존성 설치
COPY package.json package-lock.json ./
RUN npm install

# 2. Prisma 스키마 복사
COPY prisma ./prisma

# 3. 전체 소스 복사
COPY . .

# 4. 빌드 단계에서도 generate 시도
RUN npx prisma generate

# 5. 실행 직전 다시 한번 generate 보장
CMD ["sh", "-c", "npx prisma generate && node server.js"]