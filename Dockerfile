FROM node:18

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY prisma ./prisma

COPY . .

RUN npx prisma generate

CMD ["node", "server.js"]