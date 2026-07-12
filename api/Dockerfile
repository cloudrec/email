FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ wget
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache wget
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
