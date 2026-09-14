FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data /app/seed \
  && if [ -f /app/seed/playa.db ]; then true; \
     elif [ -f /app/data/playa.db ]; then cp /app/data/playa.db /app/seed/playa.db; fi \
  && if [ -f /app/seed/Playa_CRM.xlsx ]; then true; \
     elif [ -f /app/data/Playa_CRM.xlsx ]; then cp /app/data/Playa_CRM.xlsx /app/seed/Playa_CRM.xlsx; fi

ENV NODE_ENV=production
ENV PORT=3847

EXPOSE 3847

CMD ["./entrypoint.sh"]
