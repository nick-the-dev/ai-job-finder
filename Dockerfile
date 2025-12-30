FROM node:20-slim

WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install backend dependencies
COPY package*.json ./
RUN npm ci

# Generate Prisma client
COPY prisma ./prisma/
RUN npx prisma generate

# Cache buster - change this to force rebuild
ARG BUILD_VERSION=v12

# Copy backend source code
COPY tsconfig.json ./
COPY src ./src/

# Build backend TypeScript
RUN npm run build

# Build admin UI (React + Vite)
COPY admin-ui/package*.json ./admin-ui/
RUN cd admin-ui && npm ci
COPY admin-ui ./admin-ui/
RUN cd admin-ui && npm run build

# Expose port
EXPOSE 3001

# Run database migrations and start server
# NOTE: Do NOT use --accept-data-loss - it can wipe user data!
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
