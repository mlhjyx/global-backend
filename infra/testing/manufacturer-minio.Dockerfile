# CI-only disposable fixture. No local checkout/secrets enter the empty context.
# Official RELEASE.2025-09-07T16-13-09Z -> 07c3a429bfed433e49018cb0f78a52145d4bedeb.
FROM docker.io/library/golang@sha256:ab1d1823abb55a9504d2e3e003b75b36dbeb1cbcc4c92593d85a84ee46becc6c AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly \
    GOSUMDB=sum.golang.org GOPROXY=https://proxy.golang.org MINIO_RELEASE=RELEASE
WORKDIR /src
RUN git init . \
 && git remote add origin https://github.com/minio/minio.git \
 && git fetch --depth=1 origin 07c3a429bfed433e49018cb0f78a52145d4bedeb \
 && git checkout --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = 07c3a429bfed433e49018cb0f78a52145d4bedeb
RUN go mod download \
 && go mod verify \
 && git diff --exit-code -- go.mod go.sum
RUN mkdir /out \
 && go build -tags kqueue -trimpath \
      -ldflags "$(go run buildscripts/gen-ldflags.go 2025-09-07T16:13:09Z)" \
      -o /out/minio . \
 && git diff --exit-code -- go.mod go.sum \
 && /out/minio --version > /out/version.txt \
 && grep -F 'RELEASE.2025-09-07T16-13-09Z' /out/version.txt \
 && grep -F 'commit-id=07c3a429bfed433e49018cb0f78a52145d4bedeb' /out/version.txt

FROM docker.io/library/debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
ENV MINIO_UPDATE=off
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="07c3a429bfed433e49018cb0f78a52145d4bedeb" \
      org.opencontainers.image.version="RELEASE.2025-09-07T16-13-09Z"
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /src/LICENSE /src/NOTICE /usr/share/licenses/minio/
ENTRYPOINT ["/usr/local/bin/minio"]
