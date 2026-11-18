# One image for both processes (server and worker); fly.toml picks the command for each.
# Runs anywhere that runs containers (Fly.io today; AWS Fargate or Azure Container Apps later).

# Build the admin web app (apps/admin) into static files.
FROM node:22-slim AS admin
WORKDIR /build/apps/admin
COPY apps/admin/package.json apps/admin/package-lock.json ./
RUN npm ci
COPY apps/admin/ ./
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# tsx (a dev dependency) runs the TypeScript directly, so dev dependencies are kept.
RUN npm ci --include=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY supabase ./supabase
COPY --from=admin /build/apps/admin/dist ./apps/admin/dist
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/server.ts"]
