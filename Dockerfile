# Stage 1: Build
FROM node:20.11.1 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

# Stage 2: Run
FROM node:20.11.1

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY --from=builder /app/dist ./dist

# Create data folder
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/main"]