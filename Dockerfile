FROM node:18

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY prisma ./prisma

COPY . .

RUN npx prisma generate

CMD npx prisma generate && node server.js