FROM node:26-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app /app/data
USER node
ENV ARBITRAGE_HTTP_HOST=0.0.0.0
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/cli.ts", "serve", "--port", "3000"]
