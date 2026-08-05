FROM node:20-alpine

WORKDIR /app

# better-sqlite3 has a native module: if no prebuilt binary matches this
# platform, node-gyp needs these to build it from source.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
RUN mkdir -p env data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
