# 주문 서버 이미지 (E8). 이 파일은 이 저장소에서 빌드·실행해 보지 못했다(이 PC에 Docker가 없다).
# 번들은 tests/server/bundle.test.ts가 실제로 node에서 기동해 검증하며, 이미지 빌드는 배포 환경에서 확인해야 한다.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
RUN node server/build.ts dist/server.mjs

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/server.mjs ./server.mjs
# 비밀(DATABASE_URL, SUPABASE_JWT_SECRET 또는 SUPABASE_JWT_KEYS)은 이미지에 넣지 않고 실행 환경에서 주입한다
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
