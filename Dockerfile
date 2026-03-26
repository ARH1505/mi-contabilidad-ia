# Usamos una imagen ligera de Node.js
FROM node:20-slim

# Directorio de trabajo
WORKDIR /app

# Copiamos archivos de dependencias
COPY package*.json ./

# Instalamos dependencias
RUN npm install

# Instalamos dependencias del sistema para Puppeteer/Chromium
RUN apt-get update && apt-get install -y \
    libnss3 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Copiamos el resto del código
COPY . .

# Creamos una carpeta para la base de datos persistente (Volume)
RUN mkdir -p /data

# Variables de entorno por defecto
ENV PORT=3000
ENV DB_PATH=/data/contabilidad.db

# Exponemos el puerto
EXPOSE 3000

# Comando para iniciar la app
CMD ["npm", "start"]
