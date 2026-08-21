# MY PRINT 24/7 WhatsApp Cloud Gateway Dockerfile
FROM node:20-slim

WORKDIR /app

# Install git, curl and required build tools for Baileys
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Expose standard HTTP port
EXPOSE 3001
ENV PORT=3001

CMD ["node", "server.js"]
