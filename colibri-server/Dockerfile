FROM node:20-alpine

WORKDIR /srv/colibri/

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Webserver
EXPOSE 9011
# TCP (Unity) Port
EXPOSE 9012
# Voice
EXPOSE 9013

CMD [ "npm", "start" ]

