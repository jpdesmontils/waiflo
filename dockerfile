FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install Playwright browsers and required system dependencies.
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3001

CMD ["node", "server/index.js"]
