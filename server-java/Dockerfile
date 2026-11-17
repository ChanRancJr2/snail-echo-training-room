FROM node:24-bookworm-slim AS web
WORKDIR /build
COPY product/package.json product/package-lock.json ./
RUN npm ci
COPY product/apps/web/ apps/web/
COPY product/packages/core/src/ packages/core/src/
ENV VITE_ECHO_TARGET=java
RUN npm run build:web

FROM maven:3.9-eclipse-temurin-21 AS api
WORKDIR /build
COPY server-java/pom.xml ./
COPY server-java/src/main/ src/main/
COPY --from=web /build/dist/web/ src/main/resources/static/
RUN mvn -B -ntp -Dmaven.test.skip=true package

FROM eclipse-temurin:21-jre-jammy
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/echo
COPY --from=api /build/target/training-room-api-*.jar app.jar
ENV SERVER_ADDRESS=0.0.0.0
USER 10001:10001
EXPOSE 3001
ENTRYPOINT ["java", "-jar", "/opt/echo/app.jar"]
