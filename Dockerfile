FROM node:22-bookworm-slim

WORKDIR /opt/orbit-control-plane
COPY package.json ./
COPY src ./src
COPY public ./public
COPY connector ./connector
COPY deploy/docker-entrypoint.sh /entrypoint.sh

ENV NODE_ENV=production
ENV ORBIT_CP_DATA=/data
ENV ORBIT_CP_DOCKER=1
VOLUME /data
EXPOSE 8787

RUN chmod 0755 /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
