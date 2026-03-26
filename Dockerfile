# Usamos una imagen ligera de Node.js
FROM node:20-slim

# Directorio de trabajo
WORKDIR /app

# Copiamos archivos de dependencias
COPY package*.json ./

# Instalamos dependencias
RUN npm install

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
