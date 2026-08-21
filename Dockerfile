# MY PRINT 24/7 WhatsApp Cloud Gateway Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code
COPY . .

# Expose standard HTTP port
EXPOSE 3001
ENV PORT=3001

CMD ["node", "server.js"]
