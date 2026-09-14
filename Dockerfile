FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data /app/seed \
  && if [ -f /app/data/playa.db ]; then cp /app/data/playa.db /app/seed/playa.db; fi \
  && if [ -f /app/data/Playa_CRM.xlsx ]; then cp /app/data/Playa_CRM.xlsx /app/seed/Playa_CRM.xlsx; fi \
  && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3847

USER node
EXPOSE 3847

CMD ["./entrypoint.sh"]
