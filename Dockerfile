FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
