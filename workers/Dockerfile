FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY healthcheck.mjs ./healthcheck.mjs
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "dist/index.js"]
