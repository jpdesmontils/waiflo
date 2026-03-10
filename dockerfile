FROM node:20-bookworm

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm ci

# Install Playwright browsers and required system dependencies.
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3001

CMD ["node", "server/index.js"]
