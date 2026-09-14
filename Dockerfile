FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data /app/seed \
  && if [ -f /app/data/playa.db ]; then cp /app/data/playa.db /app/seed/playa.db; fi \
  && if [ -f /app/data/Playa_CRM.xlsx ]; then cp /app/data/Playa_CRM.xlsx /app/seed/Playa_CRM.xlsx; fi

ENV NODE_ENV=production
ENV PORT=3847

EXPOSE 3847

# Run as root so Railway volume at /app/data is writable
CMD ["./entrypoint.sh"]
