FROM node:20-slim

RUN npx playwright install --with-deps chromium

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "src/server.js"]
