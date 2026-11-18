#!/usr/bin/env bash
# One-time, explicitly scoped VPS cleanup after V1.2.1 acceptance.
set -euo pipefail

release=/opt/echo-java-v1.2.1
recovery=/opt/echo-recovery/v121-cutover
image=sha256:0b41295f2e83c0525aa536222605814e436bae8aaf25339e55f02b07d336083b
test "$(id -u)" = 0
test "$(realpath -e "$release")" = "$release"
test "$(realpath -e "$recovery")" = "$recovery"
test -f "$release/acceptance-passed"
test "$(docker inspect echo-java-v121-api-1 --format '{{.Image}}')" = "$image"
test "$(docker inspect echo-java-v121-api-1 --format '{{.State.Health.Status}}')" = healthy
curl --fail --silent --show-error --max-time 10 https://47.239.63.61.sslip.io/health/live
(cd "$recovery" && sha256sum --check SHA256SUMS --quiet)

containers=(
  echo-java-v12-api-1 echo-java-v12-storage-1 echo-java-v12-mysql-1
  echo-java-demo-mysql-1
  echo-java-v121-staging-api-1 echo-java-v121-staging-storage-1 echo-java-v121-staging-mysql-1
)
volumes=(
  echo-java-v12_java-mysql echo-java-v12_java-storage echo-java-demo_java-mysql
  semantic-retell-v2_postgres-data semantic-retell-v2_minio-data semantic-retell-v2_redis-data
  echo-java-v121-staging_java-mysql echo-java-v121-staging_java-storage
)
networks=(echo-java-demo_default echo-java-v12_default semantic-retell-v2_default echo-java-v121-staging_default)
images=(
  echo-java:1.2.1-rc3-stage echo-java:1.2.1-rc3 echo-java:1.2.1-rc
  echo-java:1.2.0 echo-java:sync-review-20261116
  semantic-retell-v2-worker:latest semantic-retell-v2-app:latest
  redis:7-alpine postgres:16-alpine
)
directories=(
  /opt/echo-java-demo /opt/echo-java-v1.2.0 /opt/echo-java-v1.2.0-staging
  /opt/semantic-retell /opt/semantic-retell-v2 /srv/echo-demo /srv/echo-product
  /opt/echo-java-v1.2.1-staging
)

# Complete all preconditions before deleting the first object.
for volume in "${volumes[@]}"; do
  test -s "$recovery/$volume.tgz"
done
test -s "$recovery/legacy-standalone-data.tgz"
test -s "$recovery/recovery-settings.tgz"
test -s "$recovery/legacy-extra-settings.tgz"
test -s "$recovery/staging-settings.tgz"
for container in "${containers[@]}"; do
  if docker inspect "$container" >/dev/null 2>&1; then
    test "$(docker inspect "$container" --format '{{.State.Running}}')" = false
  fi
done
for directory in "${directories[@]}"; do
  case "$directory" in
    /opt/echo-java-demo|/opt/echo-java-v1.2.0|/opt/echo-java-v1.2.0-staging|/opt/semantic-retell|/opt/semantic-retell-v2|/srv/echo-demo|/srv/echo-product|/opt/echo-java-v1.2.1-staging) ;;
    *) echo 'Unexpected cleanup directory' >&2; exit 1 ;;
  esac
  test ! -L "$directory"
  if test -e "$directory"; then test "$(realpath -e "$directory")" = "$directory"; fi
done

date -u '+Cleanup started: %Y-%m-%dT%H:%M:%SZ'
df -B1 /
for container in "${containers[@]}"; do
  if docker inspect "$container" >/dev/null 2>&1; then docker rm "$container"; fi
done
for volume in "${volumes[@]}"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    test -z "$(docker ps -aq --filter "volume=$volume")"
    docker volume rm "$volume"
  fi
done
for network in "${networks[@]}"; do
  if docker network inspect "$network" >/dev/null 2>&1; then docker network rm "$network"; fi
done
for old_image in "${images[@]}"; do
  if docker image inspect "$old_image" >/dev/null 2>&1; then docker image rm "$old_image"; fi
done
for directory in "${directories[@]}"; do
  if test -d "$directory"; then rm -rf -- "$directory"; printf 'Removed directory: %s\n' "$directory"; fi
done

# All inventoried cache entries predate this release (last used 13 days ago).
# Production uses an imported immutable image. Retain any cache used in the last week.
docker builder prune --all --force --filter until=168h
test "$(docker inspect echo-java-v121-api-1 --format '{{.Image}}')" = "$image"
curl --fail --silent --show-error --max-time 10 https://47.239.63.61.sslip.io/health/live
docker ps -a --format '{{.Names}} {{.Status}} {{.Image}}'
docker volume ls --format '{{.Name}}'
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}'
df -B1 /
date -u '+Cleanup finished: %Y-%m-%dT%H:%M:%SZ'
