############################
# Step 1 : frontend builder
############################
FROM node:25-alpine AS frontend-builder

ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION

WORKDIR /usr/src/app/frontend

# Copy only the files necessary for npm cache
COPY frontend/package*.json ./

RUN npm ci

# Copy the rest of the code and build
COPY frontend/ ./
RUN npm run build


############################
# Step 2 : Rust chef base
############################
FROM rust:alpine AS chef

RUN apk add --no-cache musl-dev build-base pkgconfig
RUN cargo install cargo-chef

WORKDIR /app


############################
# Step 3 : planner
############################
FROM chef AS planner

COPY backend/ ./
RUN cargo chef prepare --recipe-path recipe.json


############################
# Step 4 : builder
############################
FROM chef AS builder

COPY --from=planner /app/recipe.json recipe.json

RUN cargo chef cook --release  --recipe-path recipe.json
COPY backend/ ./
RUN cargo build --release --bin RouteCraft


############################
# Step 5 : Final image
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

COPY --from=builder /app/target/release/RouteCraft /app/RouteCraft

COPY --from=frontend-builder /usr/src/app/backend/static /app/static

COPY ./spatial_cache /app/spatial_cache

EXPOSE 8080

CMD ["./RouteCraft"]
