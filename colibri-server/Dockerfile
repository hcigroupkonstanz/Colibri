FROM node:13.10.1

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

