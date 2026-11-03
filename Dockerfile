FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/wmy.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
