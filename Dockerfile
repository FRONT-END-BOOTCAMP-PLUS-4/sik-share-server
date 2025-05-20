FROM node:18

COPY package.json package-lock.json ./
RUN npm install

RUN npx prisma generate

CMD npx prisma generate && node server.js