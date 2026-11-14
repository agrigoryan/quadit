# Quadit in one image: the server with the web app inside, plus git (for
# repository sync) and ffmpeg (for stills of video clips).
#
#   docker build -t quadit .
#   docker run -p 4780:4780 -v quadit-data:/data -e QUADIT_BASE_URL=http://localhost:4780 quadit

FROM node:24-alpine AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -tags web -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/quadit ./cmd/quadit

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata git ffmpeg \
    && adduser -D -u 10001 -h /data quadit
COPY --from=build /out/quadit /usr/local/bin/quadit
USER quadit
ENV QUADIT_DATA=/data QUADIT_LISTEN=:4780
VOLUME /data
EXPOSE 4780
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4780/healthz || exit 1
ENTRYPOINT ["quadit"]
CMD ["serve"]
