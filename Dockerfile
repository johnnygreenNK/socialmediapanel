# Playwright image ships Chromium + system deps already.
FROM mcr.microsoft.com/playwright:v1.50.1-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

# Profiles persist here (mount a volume).
RUN mkdir -p /data && chown -R pwuser:pwuser /app /data
USER pwuser

EXPOSE 8080
CMD ["node", "src/server.js"]
