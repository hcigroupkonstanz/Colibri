FROM node:13.10.1

WORKDIR /srv/colibri/

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Unity Port
EXPOSE 8001
# Webserver
EXPOSE 8002
# Voice
EXPOSE 8003

CMD [ "npm", "start" ]

