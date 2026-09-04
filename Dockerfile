# docker-compose.yml has always declared `build: .` while no Dockerfile existed,
# so the compose stack could never actually build.
FROM node:22-alpine

# The feature-build pipeline shells out to git to clone repositories for analysis.
RUN apk add --no-cache git

WORKDIR /app

# Install dependencies first so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY migrations ./migrations

# Do not run as root.
RUN addgroup -S ulla && adduser -S ulla -G ulla && chown -R ulla:ulla /app
USER ulla

ENV NODE_ENV=production
EXPOSE 3000

# The image serves both tiers; docker-compose and the Procfile override this to run
# the receiver and the worker as separate processes.
CMD ["node", "src/solo_start.mjs"]
