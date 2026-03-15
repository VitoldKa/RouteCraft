
############################
# Step 1 : frontend builder
############################
FROM node:22-alpine AS frontend-builder

ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION

WORKDIR /usr/src/app/data

RUN node build.js

WORKDIR /usr/src/app/frontend

# Copy only the files necessary for npm cache
COPY frontend/package*.json ./

RUN npm ci

# Copy the rest of the code and build
COPY frontend/ ./
RUN npm run build


############################
# Step 2 : backend builder
############################
FROM rust:alpine AS backend-builder

ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION

RUN apk add --no-cache musl-dev build-base pkgconfig

WORKDIR /usr/src/app/backend

# Copy Cargo files to take advantage of Docker cache
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release
RUN rm -rf src

# Copy the real code after the cache
COPY backend/ ./
RUN cargo build --release --target x86_64-unknown-linux-musl


############################
# Step 3 : Final image
############################
FROM alpine:latest

ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION
ARG GIT_SHA
ARG BUILD_DATE
ARG GIT_URL

WORKDIR /app

LABEL org.opencontainers.image.title="RouteCraft" \
    org.opencontainers.image.version=$APP_VERSION \
    org.opencontainers.image.revision=$GIT_SHA \
    org.opencontainers.image.created=$BUILD_DATE \
    org.opencontainers.image.source=$GIT_URL

COPY --from=backend-builder /usr/src/app/backend/target/x86_64-unknown-linux-musl/release/RouteCraft /app/RouteCraft

COPY --from=frontend-builder /usr/src/app/backend/static /app/static

EXPOSE 8080

CMD ["./backend"]
