FROM node:20-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    DATA_DIR=/data

WORKDIR /app

COPY package.json server.js index.html ./

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 5173
VOLUME ["/data"]

CMD ["node", "server.js"]
