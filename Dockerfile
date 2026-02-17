FROM oven/bun:latest

WORKDIR /app

COPY SHARP/package*.json ./

RUN bun install

COPY SHARP/. .

EXPOSE 5000 5001

CMD [ "bun", "run", "main.js" ]
