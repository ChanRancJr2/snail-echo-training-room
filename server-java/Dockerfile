FROM node:24-bookworm-slim AS web
WORKDIR /build
COPY product/package.json product/package-lock.json ./
RUN npm ci
COPY product/apps/web/ apps/web/
COPY product/packages/core/src/ packages/core/src/
ENV VITE_ECHO_TARGET=java
RUN npm run build:web

# CI can seed this context with the repository used by the preceding Maven tests.
FROM scratch AS maven-cache

FROM maven:3.9-eclipse-temurin-21 AS api
ARG MAVEN_OFFLINE=false
WORKDIR /build
COPY server-java/pom.xml ./
COPY server-java/src/main/ src/main/
COPY --from=web /build/dist/web/ src/main/resources/static/
COPY --from=web /build/apps/web/src/practice-materials.json src/main/resources/practice-materials.json
RUN --mount=type=cache,from=maven-cache,target=/root/.m2/repository,sharing=locked \
    if [ "$MAVEN_OFFLINE" = true ]; then set -- --offline; else set --; fi; \
    mvn -B -ntp "$@" -Dmaven.test.skip=true package

FROM eclipse-temurin:21-jre-jammy
RUN timeout 180s apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update \
    && timeout 240s apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/echo
COPY --from=api /build/target/training-room-api-*.jar app.jar
ENV SERVER_ADDRESS=0.0.0.0
USER 10001:10001
EXPOSE 3001
ENTRYPOINT ["java", "-jar", "/opt/echo/app.jar"]
